# tiny-cqrs

A tiny, storage-agnostic CQRS / event-sourcing core for TypeScript — a portability harness for
aggregate-local domain logic, so the same `fold`/`decide` functions run unmodified across
Cloudflare Durable Objects, D1, Node, and other storage substrates. Bring your own database, your
own domain types, your own deployment target.

No transport dependency (no HTTP framework coupling), no fp-ts, no plugin system to learn. `decide`
and `fold` are plain pure functions you write; `executeCommand` runs the load → fold → decide →
apply → append(+project) cycle around them, with optimistic concurrency and opt-in idempotency
built in.

This is the generic core. If you're building an accounting/finance-shaped ledger, see
[`ledger-kit`](https://github.com/LedgerWriter/ledger-kit), the first "flavor" package built on top of
this one — a flavor is just an ordinary package that imports `tiny-cqrs` and exports domain
helpers; there's no plugin API to implement.

Building your own flavor package? The informal convention is a `*-kit` suffix (`ledger-kit` sets
the precedent) purely so people can find it — that's a naming convention for discoverability, not
a plugin contract. Unlike, say, unified.js's plugins (which interoperate because every one conforms
to a shared transformer signature over a shared AST), flavor packages share no such contract: they're
just ordinary packages that happen to depend on `tiny-cqrs`. There's nothing here for two flavor
packages to compose with each other, and that's fine — a ledger and, say, a construction project
are different aggregates with nothing to share.

**Status:** pre-1.0 (currently v0.4.0). The core shape (`executeCommand`, `StorageAdapter`,
`Outcome`) is stable; expect additions rather than breaking changes, but semver 0.x means they're
still possible.

## Possibly useful / likely not

**Possibly useful when:**

- You want the same aggregate decision logic (`fold`/`decide`) to run unmodified across Cloudflare
  Durable Objects, D1, Node, and an in-memory store — locally in tests, then deployed to the edge,
  without a rewrite when the storage substrate changes.
- Your unit of consistency is a single aggregate identity (an order, a device, a ledger entry) and
  you want an explicit, reviewable version-check-and-append loop instead of assembling one from a
  database client by hand each time.
- You're deploying to a constrained runtime (a Cloudflare Worker, a resource-limited edge/IoT
  gateway) where a zero-runtime-dependency core, small bundle, and no framework lifecycle matter
  more than a batteries-included stack.
- You want idempotent retries (a client or gateway retrying after a timeout) without hand-rolling
  that check yourself.

**Likely not useful when:**

- You'll only ever run against one storage backend, forever — the portability this buys costs some
  indirection you don't need. Wiring your database client directly, or using a raw Durable Object,
  is simpler and has less overhead; see [What the edge changes](#what-the-edge-changes) — this
  project makes no raw-performance claim over that.
- You need cross-aggregate transactions or saga/choreography orchestration — the consistency
  guarantee here is scoped to one aggregate at a time; nothing coordinates multiple aggregates in a
  single unit of work.
- You need snapshotting, event schema upcasting/migration, or async/queued projections today —
  these are explicit [non-goals](#non-goals-v1) for v1; you'd have to build them on top.
- You need concurrent-duplicate-safe idempotency (two identical requests racing at the same instant,
  not a retry after a timeout) — the current stores are check-then-act, not claim-then-act (see
  [Design](#design)); the losing request typically hits a real conflict rather than a clean
  idempotent replay.
- You want a full application framework (command bus, handler registry, transport/message
  envelopes) — that's deliberately absent; you supply the transport and wire this in yourself.

## Why this exists

CQRS and event sourcing become expensive when a small consistency loop is repeated across every
command handler and then surrounded by a framework: command buses, handler registries, transport
types, plugin systems, message envelopes, projection runners, retry libraries, and database-specific
code.

`tiny-cqrs` extracts the repeated mechanics without turning them into a platform. The business
model remains two plain functions:

```text
fold(events)           -> state
decide(state, command) -> new events
```

The core owns only the invariants it can actually guarantee: aggregate version checks, tenant and
aggregate scoping, domain-error boundaries, atomic projection writes supplied by the adapter, and
optional replay of a completed request by idempotency key. The application still owns its domain
language, transport, deployment, projections, and external integrations.

That is the project's central engineering claim:

> A complex architectural problem becomes easier to keep correct when the irreducible consistency
> loop is explicit and optional concerns are kept outside it.

This is not a claim that event sourcing solves distributed systems. Snapshotting, event evolution,
durable subscriber delivery, and cache policy remain real problems. It is a claim that they should
not be prerequisites for a small aggregate decision model.

## Code size is an architectural benefit

The small code surface is not just a nice number. It reduces the number of assumptions an application
must inherit and the number of places where correctness can diverge:

- **Less runtime surface:** zero required runtime dependencies means fewer transitive packages,
  fewer reachable platform imports, and less code to bundle, audit, patch, and load.
- **Smaller deployment units:** edge platforms charge and constrain startup, transfer, memory, and
  CPU. A storage-agnostic core can be included without pulling in a database client, message broker,
  HTTP framework, or Node-only compatibility layer.
- **Fewer ambient assumptions:** the core does not require a process-wide container, event loop
  service, global configuration registry, or framework lifecycle. This makes its behavior easier to
  reason about in short-lived isolates and constrained runtimes.
- **A smaller review surface:** the important guarantees are concentrated in `executeCommand`, the
  storage contract, and the event envelope. A reviewer can inspect the consistency path instead of
  reconstructing it from a network of conventions and extension points.
- **Lower duplication:** every command uses the same tested load → fold → decide → append path,
  while domain code stays local to the aggregate that owns the rule.

The goal is not minimum lines at any cost. The goal is minimum mechanism consistent with explicit
correctness guarantees. Removing a feature from the core is good engineering when it removes an
assumption that the core cannot reliably enforce.

## Edge and IoT fit

The same boundaries make the project useful across environments with very different constraints.

For edge applications, TypeScript and Cloudflare D1 are first-class targets: the domain functions
are pure, the core has no transport coupling, and the adapter supplies the platform-specific atomic
append. The in-memory adapter provides a zero-dependency local model, while the D1 adapter uses the
same domain code in a Worker. A command does not need a long-lived process or a central application
server to reconstruct an aggregate, enforce its invariant, and append a versioned event.

For IoT and embedded systems, the important benefit is the portable contract rather than assuming
that every device runs this npm package directly. A device can emit a compact command or event
record to an edge gateway, and the gateway can use the same `fold`/`decide` model to validate and
record it. A native or Zig implementation can implement the same contract for devices that need
smaller binaries, predictable memory, or a C-compatible interface; the TypeScript implementation
remains the natural choice at the edge boundary.

This supports a layered topology without changing the domain model:

```text
device or local controller
  -> command/event record
edge gateway or Worker
  -> fold, decide, version check, append
durable store
  -> optional projections and subscribers
```

Intermittent connectivity makes explicit idempotency especially valuable. A device or gateway can
retry a command after a timeout using the same key, while the aggregate version check protects
against a genuinely different command racing with it. The current idempotency store is intentionally
documented as check-then-act; deployments that need concurrent duplicate claiming can add that
stronger operation at the storage boundary.

The architectural principle is the same at every tier: keep the domain decision portable, keep
platform concerns in adapters, and make delivery or caching optional layers. That is how a small
implementation extends quality architecture principles rather than merely shrinking an existing
framework.

### What the edge changes

`tiny-cqrs` is not a new CQRS primitive. CQRS, event sourcing, aggregate-local consistency,
optimistic concurrency, and idempotency are established techniques. The edge-oriented value is
the execution contract that lets the same pure domain logic run against different substrates,
including Cloudflare Durable Objects and D1.

For an aggregate-local command, a Durable Object can keep the aggregate's hot state in memory and
serialize commands for that identity. This can avoid a public network hop to a regional application
server, avoid a database read before every decision, and partition contention by aggregate ID. The
client still may have to travel to the Durable Object's location; edge ingress does not mean that
state is replicated in every PoP, and this project makes no latency or throughput claim without
deployed measurements.

Raw Durable Objects are therefore the smallest and most direct choice when one aggregate identity
is the whole problem. `tiny-cqrs` adds code and some execution overhead in exchange for a shared
command/event/storage contract, local development, D1 support, reusable optimistic concurrency,
and explicit completed-retry behavior. Its value is portability and consistency across substrates,
not a demonstrated raw-Durable-Object performance win.

For production decisions, measure warm and cold object latency, hydration and replay cost, storage
write latency, throughput per aggregate, contention, and idempotency-hit latency. Use a deployed
staging test for Cloudflare claims; local Workers emulation is behavioral evidence, not production
network evidence.

The comparative experiment and its evidence are recorded in
[`exp/docs/experiment.md`](exp/docs/experiment.md).

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

## Design decisions

Why this exists instead of extending [Atomik CQRS](https://github.com/mnhpub/antiatomik-cqrs)
(this project's own predecessor) or adopting an existing TypeScript library, with the actual
numbers behind that call: [docs/adr/decisions.md](docs/adr/decisions.md).

## Contributing

Bug reports, new storage adapters, and documentation fixes are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) for how to get set up and what's in vs. out of scope for this
repo specifically.

## License

Apache-2.0
