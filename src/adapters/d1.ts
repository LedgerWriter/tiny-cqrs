import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { ConcurrencyConflictError } from '../errors.js';
import type { IdempotencyStore, StorageAdapter } from '../storage-adapter.js';
import type { Event, Outcome, StoredEvent } from '../types.js';

/**
 * Cloudflare D1 adapter. Requires the `event_store` table from schema/0001_event_store.sql
 * (mirrors ledgerwriter.com's original event_store schema — the
 * `UNIQUE(tenant_id, aggregate_id, version)`
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

/**
 * Cloudflare D1-backed IdempotencyStore. Requires the `idempotency_keys` table from
 * schema/0002_idempotency_keys.sql.
 *
 * Known limitation: this is check-then-act, not claim-then-act. It correctly de-duplicates the
 * case executeCommand's idempotency support exists for — a client retrying after a timeout, once
 * the first attempt has already finished — because by the time the retry's `get()` runs, `set()`
 * from the first attempt has already completed. It does NOT fully de-duplicate two requests with
 * the same key that race genuinely concurrently: both can see no cached outcome and both proceed
 * to run the command, and only one is guaranteed to win (the other likely hits a real
 * ConcurrencyConflictError from appendEvents, not a clean idempotent replay). A true claim step
 * (an upfront unique-constrained "reservation" row, checked and inserted atomically before the
 * command runs) would close that gap; not implemented here.
 */
export function createD1IdempotencyStore(db: D1Database): IdempotencyStore {
  return {
    async get<T>(tenantId: string, key: string): Promise<Outcome<T> | undefined> {
      const row = await db
        .prepare('SELECT outcome FROM idempotency_keys WHERE tenant_id = ? AND idempotency_key = ?')
        .bind(tenantId, key)
        .first<{ outcome: string }>();
      return row ? (JSON.parse(row.outcome) as Outcome<T>) : undefined;
    },

    async set<T>(tenantId: string, key: string, outcome: Outcome<T>): Promise<void> {
      await db
        .prepare(
          `INSERT INTO idempotency_keys (tenant_id, idempotency_key, outcome) VALUES (?, ?, ?)
           ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
        )
        .bind(tenantId, key, JSON.stringify(outcome))
        .run();
    },
  };
}
