import { ConcurrencyConflictError, DomainError } from './errors.js';
import type { IdempotencyStore, StorageAdapter } from './storage-adapter.js';
import type { Event, Outcome } from './types.js';

export interface ExecuteCommandOptions<S, E extends Event, C, Stmt> {
  store: StorageAdapter<Stmt>;
  /** Only needed together with idempotencyKey — most aggregates won't pass either. */
  idempotency?: IdempotencyStore;
  idempotencyKey?: string;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  /** Pure. Reduces prior events into the current aggregate state. */
  fold: (events: readonly E[]) => S;
  /** Pure. Validates the command against state and returns new events, or throws DomainError. */
  decide: (state: S, command: C) => readonly E[];
  command: C;
  /** Pure. Given the new events and the resulting state, build adapter-specific projection writes. */
  buildProjections?: (newEvents: readonly E[], newState: S) => readonly Stmt[];
}

export interface ExecuteCommandResult<E extends Event, S> {
  events: readonly E[];
  state: S;
}

/**
 * The load -> fold -> decide -> apply -> append(+project) pattern, generalized. If an
 * idempotencyKey is given, a repeat call with the same key short-circuits before touching the
 * store at all — decide/append never re-run, so a client retry after a network timeout gets back
 * the original outcome instead of a spurious CONCURRENCY_CONFLICT (the aggregate's version has
 * already moved on from the first, successful attempt).
 *
 * Deliberately monadic: Outcome<T> is a minimal Either, and this body is a bind/Kleisli chain —
 * idempotency check -> load -> decide -> append, each step either producing a value the next one
 * consumes or short-circuiting into a failure Outcome (an early `return` on an idempotency hit, a
 * caught DomainError, or a caught ConcurrencyConflictError — three different failure sources, one
 * Outcome shape). Written as plain sequential try/catch rather than an actual chain-calling API on
 * purpose — see the README's "Design" section for why.
 */
export async function executeCommand<S, E extends Event, C, Stmt = unknown>(
  opts: ExecuteCommandOptions<S, E, C, Stmt>,
): Promise<Outcome<ExecuteCommandResult<E, S>>> {
  if (opts.idempotencyKey && opts.idempotency) {
    const prior = await opts.idempotency.get<ExecuteCommandResult<E, S>>(opts.tenantId, opts.idempotencyKey);
    if (prior) return prior;
  }

  const history = await opts.store.loadEvents<E>(opts.tenantId, opts.aggregateType, opts.aggregateId);
  const priorState = opts.fold(history.map((h) => h.event));
  const expectedVersion = history.length === 0 ? 0 : (history[history.length - 1]?.version ?? 0);

  let newEvents: readonly E[];
  try {
    newEvents = opts.decide(priorState, opts.command);
  } catch (err) {
    if (err instanceof DomainError) {
      return { ok: false, code: err.code, message: err.message };
    }
    throw err; // not a domain rejection — a genuine bug, let it propagate
  }

  const newState = opts.fold([...history.map((h) => h.event), ...newEvents]);

  try {
    await opts.store.appendEvents(
      opts.tenantId,
      opts.aggregateType,
      opts.aggregateId,
      expectedVersion,
      newEvents,
      opts.buildProjections?.(newEvents, newState),
    );
  } catch (err) {
    if (err instanceof ConcurrencyConflictError) {
      return { ok: false, code: 'CONCURRENCY_CONFLICT', message: err.message };
    }
    throw err; // genuine infra failure — not a domain outcome
  }

  const outcome: Outcome<ExecuteCommandResult<E, S>> = { ok: true, data: { events: newEvents, state: newState } };
  if (opts.idempotencyKey && opts.idempotency) {
    await opts.idempotency.set(opts.tenantId, opts.idempotencyKey, outcome);
  }
  return outcome;
}
