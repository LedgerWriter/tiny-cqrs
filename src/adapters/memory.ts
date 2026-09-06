import { ConcurrencyConflictError } from '../errors.js';
import type { IdempotencyStore, StorageAdapter } from '../storage-adapter.js';
import type { Event, Outcome, StoredEvent } from '../types.js';

/**
 * Zero-dependency in-memory adapter. Used by this library's own tests, and a reasonable default
 * for local prototyping before you've picked a real database. `Stmt` is a plain callback, invoked
 * only after the event append succeeds — that's the whole "atomicity" story for this adapter
 * (safe because JS is single-threaded and nothing here awaits between the version check and the
 * write).
 */
export function createMemoryAdapter(): StorageAdapter<() => void> {
  const streams = new Map<string, StoredEvent<Event>[]>();
  const tenantLogs = new Map<string, StoredEvent<Event>[]>();
  let nextSequence = 1;

  const key = (tenantId: string, aggregateType: string, aggregateId: string) =>
    `${tenantId}::${aggregateType}::${aggregateId}`;

  return {
    async loadEvents<E extends Event>(tenantId: string, aggregateType: string, aggregateId: string) {
      const stream = streams.get(key(tenantId, aggregateType, aggregateId)) ?? [];
      return stream.slice() as StoredEvent<E>[];
    },

    async appendEvents<E extends Event>(
      tenantId: string,
      aggregateType: string,
      aggregateId: string,
      expectedVersion: number,
      events: readonly E[],
      projections: readonly (() => void)[] = [],
    ) {
      const k = key(tenantId, aggregateType, aggregateId);
      const stream = streams.get(k) ?? [];
      const currentVersion = stream.length === 0 ? 0 : (stream[stream.length - 1]?.version ?? 0);

      if (currentVersion !== expectedVersion) {
        throw new ConcurrencyConflictError(
          `expected version ${expectedVersion}, but aggregate is at ${currentVersion}`,
        );
      }

      const now = new Date().toISOString();
      const appended: StoredEvent<Event>[] = events.map((event, i) => ({
        tenantId,
        aggregateType,
        aggregateId,
        version: expectedVersion + i + 1,
        occurredAt: now,
        event,
      }));

      streams.set(k, [...stream, ...appended]);

      const logged = appended.map((e) => ({ ...e, sequence: String(nextSequence++) }));
      tenantLogs.set(tenantId, [...(tenantLogs.get(tenantId) ?? []), ...logged]);

      for (const project of projections) project();
    },

    async loadTenantLog(tenantId: string, options?: { after?: string; limit?: number }) {
      const log = tenantLogs.get(tenantId) ?? [];
      const afterIndex = options?.after
        ? log.findIndex((e) => e.sequence === options.after) + 1
        : 0;
      const slice = log.slice(afterIndex);
      return options?.limit ? slice.slice(0, options.limit) : slice;
    },
  };
}

/** Zero-dependency in-memory IdempotencyStore, for tests and local prototyping. */
export function createMemoryIdempotencyStore(): IdempotencyStore {
  const store = new Map<string, Outcome<unknown>>();
  const key = (tenantId: string, idempotencyKey: string) => `${tenantId}::${idempotencyKey}`;

  return {
    async get<T>(tenantId: string, idempotencyKey: string) {
      return store.get(key(tenantId, idempotencyKey)) as Outcome<T> | undefined;
    },
    async set<T>(tenantId: string, idempotencyKey: string, outcome: Outcome<T>) {
      store.set(key(tenantId, idempotencyKey), outcome);
    },
  };
}
