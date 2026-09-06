import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from '../src/adapters/memory.js';

describe('loadTenantLog', () => {
  it('returns events across multiple aggregates in append order, scoped to one tenant', async () => {
    const store = createMemoryAdapter();
    await store.appendEvents('t1', 'Counter', 'a', 0, [{ type: 'Incremented', amount: 1 }]);
    await store.appendEvents('t1', 'Counter', 'b', 0, [{ type: 'Incremented', amount: 2 }]);
    await store.appendEvents('t2', 'Counter', 'a', 0, [{ type: 'Incremented', amount: 99 }]); // other tenant

    const log = await store.loadTenantLog?.('t1');
    expect(log?.map((e) => e.aggregateId)).toEqual(['a', 'b']);
    expect(log?.every((e) => e.tenantId === 't1')).toBe(true);
  });

  it('supports cursor-based pagination via `after`', async () => {
    const store = createMemoryAdapter();
    await store.appendEvents('t1', 'Counter', 'a', 0, [{ type: 'Incremented', amount: 1 }]);
    await store.appendEvents('t1', 'Counter', 'a', 1, [{ type: 'Incremented', amount: 2 }]);
    await store.appendEvents('t1', 'Counter', 'a', 2, [{ type: 'Incremented', amount: 3 }]);

    const first = await store.loadTenantLog?.('t1', { limit: 1 });
    expect(first).toHaveLength(1);

    const rest = await store.loadTenantLog?.('t1', { after: first?.[0]?.sequence });
    expect(rest?.map((e) => (e.event as { amount: number }).amount)).toEqual([2, 3]);
  });
});
