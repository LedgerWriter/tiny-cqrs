/**
 * Throw this from `decide()` for any business-rule rejection. `code` is a stable, app-defined
 * string (e.g. "ACCOUNT_NOT_FOUND") — executeCommand turns it into an Outcome failure. Anything
 * thrown that is NOT a DomainError is treated as a genuine bug/infra failure and propagates.
 */
export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'DomainError';
    this.code = code;
  }
}

/** Thrown by a StorageAdapter's appendEvents when the aggregate has moved past expectedVersion. */
export class ConcurrencyConflictError extends Error {
  constructor(message = 'optimistic concurrency conflict') {
    super(message);
    this.name = 'ConcurrencyConflictError';
  }
}
