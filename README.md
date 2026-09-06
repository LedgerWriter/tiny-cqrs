# tiny-cqrs

A tiny, storage-agnostic CQRS / event-sourcing core for TypeScript. Bring your own database, your
own domain types, your own deployment target.

No transport dependency (no HTTP framework coupling), no fp-ts, no plugin system to learn. `decide`
and `fold` are plain pure functions you write; `executeCommand` runs the load → fold → decide →
apply → append(+project) cycle around them, with optimistic concurrency and opt-in idempotency
built in.

This is the generic core. If you're building an accounting/finance-shaped ledger, see
[`ledger-kit`](https://github.com/LedgerWriter/ledger-kit), the first "flavor" package built on top of
this one — a flavor is just an ordinary package that imports `tiny-cqrs` and exports domain
helpers; there's no plugin API to implement.

**Status:** pre-1.0 (currently v0.2.0). The core shape (`executeCommand`, `StorageAdapter`,
`Outcome`) is stable; expect additions rather than breaking changes, but semver 0.x means they're
still possible.

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
`schema/0001_event_store.sql`) to run the exact same domain code against Cloudflare D1 — nothing
else changes.

For idempotent retries, also pass `idempotency: createD1IdempotencyStore(env.DB)` (same module,
schema in `schema/0002_idempotency_keys.sql`) and an `idempotencyKey` per call — see `Design` below.

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
  already succeeded. Both shipped adapters have a matching `IdempotencyStore`
  (`createMemoryIdempotencyStore`, `createD1IdempotencyStore`). **Known limitation**: these are
  check-then-act, not claim-then-act — they correctly de-duplicate a client retrying after the
  first attempt has already finished, but two requests with the same key that race genuinely
  concurrently aren't fully de-duplicated (the loser typically hits a real
  `ConcurrencyConflictError` rather than a clean idempotent replay). A true claim step would close
  that gap; not implemented yet.
- **A command that creates a new aggregate** (a random ID minted before the command runs) needs
  the idempotency check *before* that ID is generated, not just delegated to `executeCommand` —
  otherwise a retry mints a new ID every time and idempotency never actually applies. Check the
  store yourself first (`idempotency.get(tenantId, key)`) and only generate a new ID if it misses;
  still pass the same `idempotencyKey`/`idempotency` into `executeCommand` so the success outcome
  gets cached. `executeCommand` can't do this for you — it only sees the aggregate ID *after*
  you've already chosen it.
- **`executeCommand` is deliberately monadic.** `Outcome<T>` (`{ok:true,data}|{ok:false,code,message}`)
  is a minimal Either, and `executeCommand`'s body is a bind/Kleisli chain: idempotency check →
  load → decide → append, where each step either hands a value to the next or returns an `Outcome`
  that short-circuits the rest — the same shape as `Either.chain`/`flatMap`. It's written as plain
  sequential TypeScript rather than an actual `chain`-calling API on purpose: requiring fp-ts
  fluency to use this library would cut against "simple enough to embed locally." No transport type
  (no HTTP status code) anywhere in `Outcome`; map it to your framework's response type yourself.
- **Signing** (`tiny-cqrs/signing`, optional): Ed25519 sign/verify over any payload, for anyone who
  wants tamper-evident events. Not wired into `executeCommand` — sign what you choose to sign.

## Non-goals (v1)

Documented rather than silently missing: event schema upcasting/migration, snapshotting, async or
queued projections. If you need these today, layer them on top — the adapter and `executeCommand`
interfaces don't preclude it, they just don't provide it yet.

## Contributing

Bug reports, new storage adapters, and documentation fixes are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) for how to get set up and what's in vs. out of scope for this
repo specifically.

## License

Apache-2.0
