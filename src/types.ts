/** A raw domain event payload. Discriminated on `type`; nothing else is required. */
export type Event = { readonly type: string };

/**
 * An event as loaded back from storage. `event` is exactly what `decide()` returned — the
 * envelope fields (tenantId, aggregateId, version, ...) live alongside it, not inside it, so
 * domain event payload types never need to redeclare tenantId themselves.
 */
export interface StoredEvent<E extends Event> {
  readonly tenantId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly event: E;
  /** Tenant-wide chronological cursor, across all aggregates. Only set by loadTenantLog results. */
  readonly sequence?: string;
}

/** A minimal Either. No fp-ts — this library is meant to be usable without functional-programming fluency. */
export type Outcome<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: string; readonly message?: string };
