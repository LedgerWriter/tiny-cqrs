import type { Event, Outcome, StoredEvent } from './types.js';

/**
 * Everything a storage backend must provide. `Stmt` is adapter-specific (a D1PreparedStatement
 * for the D1 adapter, a plain callback for the in-memory one) — it's how projection writes ride
 * along atomically with the event append, without the core knowing anything about SQL.
 */
export interface StorageAdapter<Stmt = unknown> {
  loadEvents<E extends Event>(
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
  ): Promise<StoredEvent<E>[]>;

  /**
   * Appends `events` starting at `expectedVersion + 1`. Must throw ConcurrencyConflictError
   * (not just any Error) if the aggregate's current version no longer matches `expectedVersion`.
   * `projections`, if given, must commit atomically with the event append.
   */
  appendEvents<E extends Event>(
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
    expectedVersion: number,
    events: readonly E[],
    projections?: readonly Stmt[],
  ): Promise<void>;

  /**
   * Optional: a tenant-wide chronological view across every aggregate, for building an audit log
   * without a separate table (see ledger-kit's audit-log helper). `after` is a `sequence` value
   * from a previously returned event; omit for the start of the log. Adapters that can't easily
   * support cross-aggregate ordering may simply not implement this.
   */
  loadTenantLog?(
    tenantId: string,
    options?: { after?: string; limit?: number },
  ): Promise<StoredEvent<Event>[]>;
}

/** Optional. Only needed if you pass `idempotencyKey` to executeCommand. */
export interface IdempotencyStore {
  get<T>(tenantId: string, key: string): Promise<Outcome<T> | undefined>;
  set<T>(tenantId: string, key: string, outcome: Outcome<T>): Promise<void>;
}
