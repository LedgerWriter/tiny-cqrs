import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { ConcurrencyConflictError } from '../errors.js';
import type { StorageAdapter } from '../storage-adapter.js';
import type { Event, StoredEvent } from '../types.js';

/**
 * Cloudflare D1 adapter. Requires the `event_store` table from schema/d1.sql (mirrors
 * ledgerwriter.com's original event_store schema — the `UNIQUE(tenant_id, aggregate_id, version)`
 * index is the entire optimistic-concurrency mechanism: a conflicting append hits that constraint
 * and D1 reports it as an "UNIQUE constraint failed" error, which this adapter translates into
 * ConcurrencyConflictError so callers never see a raw SQL error message.
 */
export function createD1Adapter(db: D1Database): StorageAdapter<D1PreparedStatement> {
  return {
    async loadEvents<E extends Event>(tenantId: string, aggregateType: string, aggregateId: string) {
      const { results } = await db
        .prepare(
          `SELECT version, event_type, payload, created_at
             FROM event_store
            WHERE tenant_id = ? AND aggregate_type = ? AND aggregate_id = ?
            ORDER BY version ASC`,
        )
        .bind(tenantId, aggregateType, aggregateId)
        .all<{ version: number; event_type: string; payload: string; created_at: string }>();

      return results.map(
        (r): StoredEvent<E> => ({
          tenantId,
          aggregateType,
          aggregateId,
          version: r.version,
          occurredAt: r.created_at,
          event: JSON.parse(r.payload) as E,
        }),
      );
    },

    async appendEvents<E extends Event>(
      tenantId: string,
      aggregateType: string,
      aggregateId: string,
      expectedVersion: number,
      events: readonly E[],
      projections: readonly D1PreparedStatement[] = [],
    ) {
      const eventStmts = events.map((event, i) =>
        db
          .prepare(
            `INSERT INTO event_store (tenant_id, aggregate_type, aggregate_id, version, event_type, payload)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(tenantId, aggregateType, aggregateId, expectedVersion + i + 1, event.type, JSON.stringify(event)),
      );

      try {
        await db.batch([...eventStmts, ...projections]);
      } catch (err) {
        if (isConcurrencyConflict(err)) {
          throw new ConcurrencyConflictError();
        }
        throw err;
      }
    },

    async loadTenantLog(tenantId: string, options?: { after?: string; limit?: number }) {
      const limit = options?.limit ?? 100;
      const afterId = options?.after ? Number(options.after) : 0;

      const { results } = await db
        .prepare(
          `SELECT id, aggregate_type, aggregate_id, version, event_type, payload, created_at
             FROM event_store
            WHERE tenant_id = ? AND id > ?
            ORDER BY id ASC
            LIMIT ?`,
        )
        .bind(tenantId, afterId, limit)
        .all<{
          id: number;
          aggregate_type: string;
          aggregate_id: string;
          version: number;
          event_type: string;
          payload: string;
          created_at: string;
        }>();

      return results.map(
        (r): StoredEvent<Event> => ({
          tenantId,
          aggregateType: r.aggregate_type,
          aggregateId: r.aggregate_id,
          version: r.version,
          occurredAt: r.created_at,
          sequence: String(r.id),
          event: JSON.parse(r.payload) as Event,
        }),
      );
    },
  };
}

function isConcurrencyConflict(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}
