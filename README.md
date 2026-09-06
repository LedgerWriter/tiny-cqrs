# tiny-cqrs

A tiny, storage-agnostic CQRS / event-sourcing core for TypeScript. Bring your own database, your
own domain types, your own deployment target.

No transport dependency (no HTTP framework coupling), no fp-ts, no plugin system to learn. `decide`
and `fold` are plain pure functions you write; `executeCommand` runs the load → fold → decide →
apply → append(+project) cycle around them, with optimistic concurrency and opt-in idempotency
built in.

This is the generic core. If you're building an accounting/finance-shaped ledger, see
[`ledger-kit`](../ledger-kit), the first "flavor" package built on top of this one — a flavor is
just an ordinary package that imports `tiny-cqrs` and exports domain helpers; there's no plugin API
to implement.

## Install

```
npm install tiny-cqrs
```

## Quick start

```ts
import { executeCommand, DomainError } from 'tiny-cqrs';
import { createMemoryAdapter } from 'tiny-cqrs/adapters/memory';

interface CounterState { value: number }
type Incremented = { type: 'Incremented'; amount: number };

const fold = (events: readonly Incremented[]): CounterState =>
  events.reduce((s, e) => ({ value: s.value + e.amount }), { value: 0 });

const decide = (state: CounterState, command: { amount: number }): Incremented[] => {
  if (command.amount <= 0) throw new DomainError('INVALID_AMOUNT');
  return [{ type: 'Incremented', amount: command.amount }];
};

const store = createMemoryAdapter();

const result = await executeCommand({
  store, fold, decide,
  tenantId: 'acme', aggregateType: 'Counter', aggregateId: 'c1',
  command: { amount: 5 },
});
// { ok: true, data: { events: [...], state: { value: 5 } } }
```

Swap `createMemoryAdapter()` for `createD1Adapter(env.DB)` (`tiny-cqrs/adapters/d1`, schema in
`schema/d1.sql`) to run the exact same domain code against Cloudflare D1 — nothing else changes.

## Design

- **`EventEnvelope`** (`StoredEvent<E>`): `tenantId`, `aggregateType`, `aggregateId`, `version`,
  `occurredAt` live alongside the event, not inside it — every event is tenant-scoped structurally,
  not by convention (your domain event types never need to redeclare `tenantId` themselves).
- **`StorageAdapter`**: two methods, `loadEvents` and `appendEvents`. `appendEvents` must throw
  `ConcurrencyConflictError` when the aggregate has moved past `expectedVersion` — that's the whole
  optimistic-concurrency contract. Ships with an in-memory adapter (zero dependencies) and a D1
  adapter.
- **`executeCommand`**: the load → fold → decide → apply → append cycle, generalized. If you pass
  `idempotencyKey` + an `IdempotencyStore`, a retried call with the same key returns the original
  outcome *without* re-running `decide` or touching the store — this is what makes a retry after a
  network timeout safe instead of surfacing a spurious `CONCURRENCY_CONFLICT` for a command that
  already succeeded.
- **`Outcome<T>`**: `{ok:true,data}|{ok:false,code,message}` — a minimal Either, not fp-ts. No
  transport type (no HTTP status code) anywhere in the library; map `Outcome` to your framework's
  response type in your own app.
- **Signing** (`tiny-cqrs/signing`, optional): Ed25519 sign/verify over any payload, for anyone who
  wants tamper-evident events. Not wired into `executeCommand` — sign what you choose to sign.

## Non-goals (v1)

Documented rather than silently missing: event schema upcasting/migration, snapshotting, async or
queued projections. If you need these today, layer them on top — the adapter and `executeCommand`
interfaces don't preclude it, they just don't provide it yet.

## License

Apache-2.0
