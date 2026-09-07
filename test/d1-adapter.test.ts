import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createD1Adapter, createD1IdempotencyStore } from '../src/adapters/d1.js';
import { DomainError } from '../src/errors.js';
import { executeCommand } from '../src/execute-command.js';

// Runs against a real D1 database (Miniflare/workerd), not the in-memory adapter — the D1
// adapter and D1 idempotency store previously had zero coverage of their own, only ever
// exercised indirectly through ledgerwriter.com's own test suite.

type Incremented = { type: 'Incremented'; amount: number };
interface CounterState {
  value: number;
}

const fold = (events: readonly Incremented[]): CounterState =>
  events.reduce((s, e) => ({ value: s.value + e.amount }), { value: 0 });

const decide = (state: CounterState, command: { amount: number }): Incremented[] => {
  if (command.amount <= 0) throw new DomainError('INVALID_AMOUNT');
  return [{ type: 'Incremented', amount: command.amount }];
};

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM event_store'),
    env.DB.prepare('DELETE FROM idempotency_keys'),
  ]);
});

describe('createD1Adapter', () => {
  it('appends events and loads them back in order', async () => {
    const store = createD1Adapter(env.DB);
    await store.appendEvents('t1', 'Counter', 'c1', 0, [{ type: 'Incremented', amount: 5 }]);
    await store.appendEvents('t1', 'Counter', 'c1', 1, [{ type: 'Incremented', amount: 3 }]);

    const history = await store.loadEvents<Incremented>('t1', 'Counter', 'c1');
    expect(history.map((h) => h.event.amount)).toEqual([5, 3]);
    expect(history.map((h) => h.version)).toEqual([1, 2]);
  });

  it('reports a real concurrency conflict as ConcurrencyConflictError, not a raw SQL error', async () => {
    const store = createD1Adapter(env.DB);
    await store.appendEvents('t1', 'Counter', 'c1', 0, [{ type: 'Incremented', amount: 1 }]);

    await expect(
      store.appendEvents('t1', 'Counter', 'c1', 0 /* stale */, [{ type: 'Incremented', amount: 2 }]),
    ).rejects.toThrow('optimistic concurrency conflict');
  });

  it("pins D1's raw UNIQUE-violation error string — if this ever fails, D1's wording changed and isConcurrencyConflict's regex in src/adapters/d1.ts needs updating before conflicts silently stop being recognized", async () => {
    const store = createD1Adapter(env.DB);
    await store.appendEvents('t1', 'Counter', 'c1', 0, [{ type: 'Incremented', amount: 1 }]);

    let raw: unknown;
    try {
      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO event_store (tenant_id, aggregate_type, aggregate_id, version, event_type, payload) VALUES (?, ?, ?, ?, ?, ?)',
        ).bind('t1', 'Counter', 'c1', 1, 'Incremented', '{}'),
      ]);
    } catch (err) {
      raw = err;
    }

    expect(raw).toBeInstanceOf(Error);
    expect((raw as Error).message).toMatch(/UNIQUE constraint failed/i);
  });

  it('loadTenantLog returns a chronological, cross-aggregate view scoped to one tenant', async () => {
    const store = createD1Adapter(env.DB);
    await store.appendEvents('t1', 'Counter', 'a', 0, [{ type: 'Incremented', amount: 1 }]);
    await store.appendEvents('t1', 'Counter', 'b', 0, [{ type: 'Incremented', amount: 2 }]);
    await store.appendEvents('t2', 'Counter', 'a', 0, [{ type: 'Incremented', amount: 99 }]);

    const log = await store.loadTenantLog?.('t1');
    expect(log?.map((e) => e.aggregateId)).toEqual(['a', 'b']);
    expect(log?.every((e) => e.tenantId === 't1')).toBe(true);
  });

  it('executeCommand runs end to end against real D1', async () => {
    const store = createD1Adapter(env.DB);
    const result = await executeCommand({
      store, fold, decide,
      tenantId: 't1', aggregateType: 'Counter', aggregateId: 'c1',
      command: { amount: 5 },
    });
    expect(result).toEqual({ ok: true, data: { events: [{ type: 'Incremented', amount: 5 }], state: { value: 5 } } });
  });
});

describe('createD1IdempotencyStore', () => {
  it('returns undefined for a key that was never set', async () => {
    const idempotency = createD1IdempotencyStore(env.DB);
    expect(await idempotency.get('t1', 'never-set')).toBeUndefined();
  });

  it('round-trips a stored outcome', async () => {
    const idempotency = createD1IdempotencyStore(env.DB);
    const outcome = { ok: true as const, data: { entryId: 'e1' } };
    await idempotency.set('t1', 'req-1', outcome);
    expect(await idempotency.get('t1', 'req-1')).toEqual(outcome);
  });

  it('scopes keys per tenant — the same key under a different tenant is a miss', async () => {
    const idempotency = createD1IdempotencyStore(env.DB);
    await idempotency.set('t1', 'req-1', { ok: true, data: {} });
    expect(await idempotency.get('t2', 'req-1')).toBeUndefined();
  });

  it('a retried executeCommand call against real D1 short-circuits before decide/append run again', async () => {
    const store = createD1Adapter(env.DB);
    const idempotency = createD1IdempotencyStore(env.DB);
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

    const second = await executeCommand(opts);
    expect(second).toEqual(first);
    expect(decideSpy).toHaveBeenCalledTimes(1);
  });
});
