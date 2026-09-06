// Run with: bun run examples/counter.ts
// Proves tiny-cqrs works with zero Cloudflare/D1 dependency — just the in-memory adapter.
import { DomainError, executeCommand } from '../src/index.js';
import { createMemoryAdapter } from '../src/adapters/memory.js';

interface CounterState {
  value: number;
}
type Incremented = { type: 'Incremented'; amount: number };

const fold = (events: readonly Incremented[]): CounterState =>
  events.reduce((s, e) => ({ value: s.value + e.amount }), { value: 0 });

const decide = (state: CounterState, command: { amount: number }): Incremented[] => {
  if (command.amount <= 0) throw new DomainError('INVALID_AMOUNT', 'amount must be positive');
  return [{ type: 'Incremented', amount: command.amount }];
};

const store = createMemoryAdapter();

for (const amount of [5, 3, -1, 2]) {
  const result = await executeCommand({
    store,
    fold,
    decide,
    tenantId: 'acme',
    aggregateType: 'Counter',
    aggregateId: 'c1',
    command: { amount },
  });
  console.log(`increment(${amount}) ->`, result);
}
