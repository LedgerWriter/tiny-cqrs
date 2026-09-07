import { describe, expect, it, vi } from 'vitest';
import { createMemoryAdapter, createMemoryIdempotencyStore } from '../src/adapters/memory.js';
import { DomainError } from '../src/errors.js';
import { executeCommand } from '../src/execute-command.js';

interface CounterState {
  value: number;
}
type Incremented = { type: 'Incremented'; amount: number };
type IncrementCommand = { amount: number };

const fold = (events: readonly Incremented[]): CounterState =>
  events.reduce((s, e) => ({ value: s.value + e.amount }), { value: 0 });

const decide = (state: CounterState, command: IncrementCommand): Incremented[] => {
  if (command.amount <= 0) throw new DomainError('INVALID_AMOUNT', 'amount must be positive');
  if (state.value + command.amount > 100) throw new DomainError('LIMIT_EXCEEDED');
  return [{ type: 'Incremented', amount: command.amount }];
};

describe('executeCommand', () => {
  it('loads, decides, and appends — state reflects the fold over all events', async () => {
    const store = createMemoryAdapter();
    const first = await executeCommand({
      store, fold, decide,
      tenantId: 't1', aggregateType: 'Counter', aggregateId: 'c1',
      command: { amount: 5 },
    });
    expect(first).toEqual({ ok: true, data: { events: [{ type: 'Incremented', amount: 5 }], state: { value: 5 } } });

    const second = await executeCommand({
      store, fold, decide,
      tenantId: 't1', aggregateType: 'Counter', aggregateId: 'c1',
      command: { amount: 3 },
    });
    expect(second).toEqual({ ok: true, data: { events: [{ type: 'Incremented', amount: 3 }], state: { value: 8 } } });
  });

  it('converts a DomainError thrown by decide into an Outcome failure, not an exception', async () => {
    const store = createMemoryAdapter();
    const result = await executeCommand({
      store, fold, decide,
      tenantId: 't1', aggregateType: 'Counter', aggregateId: 'c1',
      command: { amount: -1 },
    });
    expect(result).toEqual({ ok: false, code: 'INVALID_AMOUNT', message: 'amount must be positive' });
  });

  it('lets a non-DomainError thrown by decide propagate as a real exception', async () => {
    const store = createMemoryAdapter();
    const boom = () => { throw new Error('bug'); };
    await expect(
      executeCommand({
        store, fold, decide: boom as never,
        tenantId: 't1', aggregateType: 'Counter', aggregateId: 'c1',
        command: { amount: 1 },
      }),
    ).rejects.toThrow('bug');
  });

  it('reports a real concurrency conflict when two commands race on the same version', async () => {
    const store = createMemoryAdapter();
    // Two callers both load the aggregate at version 0 and both try to be "the" version-1 append.
    await store.appendEvents('t1', 'Counter', 'c1', 0, [{ type: 'Incremented', amount: 1 }]);

    await expect(
      store.appendEvents('t1', 'Counter', 'c1', 0 /* stale — real version is now 1 */, [
        { type: 'Incremented', amount: 2 },
      ]),
    ).rejects.toThrow('expected version 0');
  });

  it('executeCommand surfaces a real race as an Outcome failure, not an exception', async () => {
    const store = createMemoryAdapter();
    const run = () =>
      executeCommand({ store, fold, decide, tenantId: 't1', aggregateType: 'Counter', aggregateId: 'c1', command: { amount: 1 } });

    // Two concurrent callers both read the aggregate at version 0 before either has appended.
    const [a, b] = await Promise.all([run(), run()]);
    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, code: 'CONCURRENCY_CONFLICT', message: expect.any(String) }]);
  });

  it('retryOnConflict reloads fresh state and re-runs decide when a real race occurs, instead of surfacing CONCURRENCY_CONFLICT', async () => {
    const store = createMemoryAdapter();
    const decideSpy = vi.fn(decide);

    const run = () =>
      executeCommand({
        store, fold, decide: decideSpy,
        retryOnConflict: 3,
        tenantId: 't1', aggregateType: 'Counter', aggregateId: 'c1',
        command: { amount: 1 },
      });

    // Same race as the test above, but both callers now recover from it automatically.
    const [a, b] = await Promise.all([run(), run()]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // The loser's decide ran more than once against progressively fresher state -- proves this
    // is a genuine reload-and-redecide, not a blind append retry.
    expect(decideSpy.mock.calls.length).toBeGreaterThan(2);

    const finalValues = [a, b]
      .map((r) => (r.ok ? r.data.state.value : null))
      .sort((x, y) => (x ?? 0) - (y ?? 0));
    expect(finalValues).toEqual([1, 2]); // one landed first, the other retried on top of it
  });

  it('retryOnConflict still surfaces CONCURRENCY_CONFLICT once attempts are exhausted (default: no retry)', async () => {
    const store = createMemoryAdapter();
    const run = () =>
      executeCommand({ store, fold, decide, tenantId: 't1', aggregateType: 'Counter', aggregateId: 'c1', command: { amount: 1 } });

    const [a, b] = await Promise.all([run(), run()]);
    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, code: 'CONCURRENCY_CONFLICT', message: expect.any(String) }]);
  });

  it('a retried call with the same idempotencyKey short-circuits before decide/append run again — fixes the false-409-on-retry bug', async () => {
    const store = createMemoryAdapter();
    const idempotency = createMemoryIdempotencyStore();
    const decideSpy = vi.fn(decide);

    const opts = {
      store, idempotency, fold, decide: decideSpy,
      idempotencyKey: 'req-abc',
      tenantId: 't1', aggregateType: 'Counter', aggregateId: 'c1',
      command: { amount: 10 },
    };

    const first = await executeCommand(opts);
    expect(first.ok).toBe(true);
    expect(decideSpy).toHaveBeenCalledTimes(1);

    // A second call with the same key simulates a client retry after e.g. a network timeout on
    // the first (successful) response. Without the idempotency short-circuit, this would call
    // decide again against the now-advanced aggregate and, depending on the command, could either
    // double-apply or — the specific bug this fixes — spuriously hit CONCURRENCY_CONFLICT even
    // though the original request already succeeded.
    const second = await executeCommand(opts);
    expect(second).toEqual(first);
    expect(decideSpy).toHaveBeenCalledTimes(1); // not called again
  });

  it('retryOnConflict + idempotencyKey together do not double-post on a genuine race', async () => {
    const store = createMemoryAdapter();
    const idempotency = createMemoryIdempotencyStore();
    const decideSpy = vi.fn(decide);

    const run = () =>
      executeCommand({
        store, idempotency, fold, decide: decideSpy,
        retryOnConflict: 3,
        idempotencyKey: 'req-race',
        tenantId: 't1', aggregateType: 'Counter', aggregateId: 'c1',
        command: { amount: 1 },
      });

    // Two callers share the same idempotencyKey and race genuinely concurrently — both miss the
    // idempotency cache before either has appended. Without re-checking idempotency on each
    // retry attempt, the loser would reload state after its ConcurrencyConflictError and blindly
    // re-run decide on the same command, appending a second time.
    const [a, b] = await Promise.all([run(), run()]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a).toEqual(b); // both callers got back the exact same outcome — one append happened
    await expect(store.loadEvents('t1', 'Counter', 'c1')).resolves.toHaveLength(1); // not 2
  });

  it('a different idempotencyKey is not deduped — decide runs normally', async () => {
    const store = createMemoryAdapter();
    const idempotency = createMemoryIdempotencyStore();

    const first = await executeCommand({
      store, idempotency, fold, decide,
      idempotencyKey: 'req-1',
      tenantId: 't1', aggregateType: 'Counter', aggregateId: 'c1',
      command: { amount: 5 },
    });
    const second = await executeCommand({
      store, idempotency, fold, decide,
      idempotencyKey: 'req-2',
      tenantId: 't1', aggregateType: 'Counter', aggregateId: 'c1',
      command: { amount: 5 },
    });

    expect(first.ok && first.data.state).toEqual({ value: 5 });
    expect(second.ok && second.data.state).toEqual({ value: 10 });
  });

  it('runs projections atomically alongside the event append', async () => {
    const store = createMemoryAdapter();
    let projectedTotal = 0;

    await executeCommand({
      store, fold, decide,
      tenantId: 't1', aggregateType: 'Counter', aggregateId: 'c1',
      command: { amount: 7 },
      buildProjections: (newEvents, newState) => [() => { projectedTotal = newState.value; }],
    });

    expect(projectedTotal).toBe(7);
  });
});
