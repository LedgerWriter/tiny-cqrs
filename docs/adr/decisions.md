# Architecture Decision Records

Numbered, dated, never rewritten after the fact — a decision that turns out wrong gets a new ADR
that supersedes it, not a silent edit. Mirrors the convention used in
[Atomik CQRS](https://github.com/mnhpub/antiatomik-cqrs)'s own `docs/adr/decisions.md`, this
project's predecessor (see ADR-01).

## ADR-01: Build tiny-cqrs rather than continue Atomik, or adopt an existing TypeScript library

**Status:** Accepted — 2026-09-06

### Context

`ledgerwriter.com` had a working event-sourcing pattern for its `LedgerAccount` and `JournalEntry`
aggregates, but it was hand-rolled directly against Cloudflare D1 and duplicated near-identically
across all 7 command handlers: the same load → fold → decide → apply → batch shape, copy-pasted,
with no idempotency (a real bug — a client retry after a network timeout could surface a false
`CONCURRENCY_CONFLICT` for a command that had already succeeded).

This was not the first time this problem had been solved on this team. **Atomik CQRS**
(`github.com/mnhpub/antiatomik-cqrs`) is this same team's first attempt at extracting a portable
event-sourcing core, built in Zig, extracted from OpEngine (this org's own `emdash`/OP Engine
tenant). It is a real, working, publicly released project (Apache-2.0, v0.1.0+), not abandoned.

### Options considered

**1. Extend Atomik.** Rejected on a concrete, checked basis, not assumption: Atomik has no
Cloudflare D1 adapter, and its only proven edge-deployment path is Postgres via Hyperdrive. Its own
architecture already has precedent for a pure-TypeScript storage adapter where its native Zig
adapter can't run (`edge/persistence.ts`, written because `libpq` can't run in
`wasm32-freestanding`) — a D1 adapter could plausibly have followed that same pattern without
touching Zig at all. This was not evaluated deeply enough before deciding to build something new;
recorded here as a known gap in this decision's own diligence, not swept under the rug.

**2. Adopt an existing TypeScript event-sourcing library — specifically
[Emmett](https://github.com/event-driven-io/emmett).** This is the option that should have been
evaluated first and was not, until pushed on directly. Emmett is a genuinely strong candidate:
535 stars, actively maintained (commits the same day this ADR was written), an architecture nearly
identical to what this project ended up building (`Decider<State, Command, Event>` ≈
`decide`/`fold`; `EventStore` ≈ `StorageAdapter`), adapters for Postgres/MongoDB/SQLite/EventStoreDB,
and framework integrations including `emmett-honojs` — the exact web framework `ledgerwriter.com`
uses. It was named in an earlier competitive search this same day and not followed up on with real
diligence until directly challenged to do so.

Measured, not assumed, before rejecting it:
- Its Cloudflare D1 driver (`emmett-sqlite/src/cloudflare.ts`) exists only in the `beta` npm
  dist-tag (`0.43.0-beta.42`); the `latest` stable release (`0.42.4`) has zero D1 support.
- Installing it and building a minimal Worker (just instantiating the event store, no routes, no
  business logic) fails to bundle out of the box — their `dumbo` driver abstraction imports the
  Node-only `pg` package even on the D1-only path. It only bundles with a manual Wrangler `alias`
  workaround for a dependency that should never have been reachable.
- With that workaround, the minimal stub bundles to **1112.26 KiB / gzip 218.03 KiB** — larger than
  `ledgerwriter.com`'s *entire real application* (every route: ledger accounts, journal entries,
  tenant settings, subsidiaries, board, billing, auth, rate limiters, email) built on `tiny-cqrs`,
  which bundles to **649.94 KiB / gzip 116.26 KiB** (`wrangler deploy --dry-run`, both measured the
  same day).
- `emmett`'s idempotency story is convention-based (`decide` must return `[]` when the outcome is
  already reflected in state) plus automatic retry-on-version-conflict, not an explicit
  cache-and-replay key. A concrete case in `ledgerwriter.com`'s own domain
  (`decideRenameLedgerAccount` deliberately throws `NAME_UNCHANGED` rather than no-op on a repeat
  rename, which is correct product behavior) shows the convention-based approach does not
  automatically make every command retry-safe — an explicit idempotency key does, regardless of how
  `decide` happens to be written.

**3. Build a new, minimal TypeScript-native core.** Chosen.

### Decision

Build `tiny-cqrs`: zero required runtime dependencies, a `StorageAdapter` interface with in-memory
and D1 adapters shipped, an explicit idempotency-key/store mechanism (not convention-based),
optional Ed25519 signing, no transport dependency anywhere in the core.

### Consequences

- **Accepted cost:** this is now a second CQRS-shaped project this team maintains (alongside
  Atomik), and a third-party alternative (Emmett) that does more, with a larger community, was not
  adopted. That is a real, ongoing maintenance commitment being taken on deliberately, not by
  default.
- **What was gained:** a footprint measurably smaller than the nearest real alternative, no beta
  dependency, no reachable-by-accident Node-only import breaking the Workers bundler, and an
  idempotency mechanism that is correct independent of how any given `decide` function is written.
- **What was borrowed anyway, without adopting Emmett's dependencies:** automatic
  retry-on-conflict (`executeCommand`'s `retryOnConflict` option) is a direct, deliberate port of
  Emmett's `retry: {onVersionConflict}` idea, reimplemented in ~15 dependency-free lines rather than
  installed. The lesson taken was the *idea*, not the *package* — see ADR-02.
- **Revisit trigger, not a permanent verdict:** re-run this exact comparison (bundle size, the
  `dumbo`/`pg` bundling issue, the idempotency-key gap) when Emmett's D1 driver ships in a stable,
  non-beta release. Nothing here rules out adopting it later; it rules out adopting it *today*, for
  measured reasons that could change.

---

## ADR-02: Borrow ideas from competitors, never their dependencies

**Status:** Accepted — 2026-09-06

### Context

Studying Emmett (ADR-01) surfaced real, good ideas worth having in `tiny-cqrs` even though Emmett
itself wasn't adopted — automatic retry on a genuine version conflict, and the practice of writing
`decide` to no-op (`return []`) when a command's outcome is already reflected in state.

### Decision

Adopt the *ideas*, reimplemented minimally and dependency-free, never the *packages*. Concretely:
`executeCommand`'s optional `retryOnConflict` (a `while(true)` loop with an attempt counter, zero
new dependencies) instead of depending on `async-retry` the way Emmett does. The no-op-`decide`
practice is documented as guidance in the README, not built as a feature, since it requires no code
— it's a convention for how a consuming application writes its own `decide` function.

### Consequences

This is the discipline that keeps this project small on purpose. A pattern is free to borrow; a
dependency is not. Every future "should we add X because library Y has it" question gets asked
against this same test: can the idea be reimplemented in a handful of dependency-free lines, or
does taking it mean taking someone else's dependency tree too. If the latter, that's a much higher
bar to clear than "it would be convenient."

---

## ADR-03: Ship project initialization as `tiny-cqrs init`, inside the core package's `bin`

**Status:** Accepted — 2026-09-06

### Context

The runtime core deliberately does not prescribe a project layout, domain namespace, aggregate
vocabulary, or storage setup. That keeps `tiny-cqrs` small, but a new project still has to recreate
the same initial structure by hand: domain modules, event types, fold and decide functions, schema
files, and conformance tests.

An earlier draft of this ADR proposed a separate `create-tiny-cqrs` package (the `npm create`
convention). That was superseded before being built: a second npm package means a second version to
keep compatible with the runtime, a second place contributors look for the CLI, and a second publish
step for something that is, in practice, a couple hundred dependency-free lines. The generator does
not need its own release cadence to stay decoupled from the runtime's exports.

### Decision

Ship `init` as a `bin` entry on `tiny-cqrs` itself (`dist/cli.js`, built from `src/cli.ts`):

```text
npx tiny-cqrs init ledger --namespace com.example.ledger --storage memory
```

It collects: project name, domain namespace, storage target (`memory` or `d1`), and always includes
a minimal example aggregate (`Counter`) — one thing to delete, not a menu of options to choose from
in v1. It generates an editable starter project:

```text
src/domain/
  namespace.ts
  events.ts
  state.ts
  fold.ts
  decide.ts
schema/         (only when --storage d1)
test/
```

The generated project depends on `tiny-cqrs` as an ordinary dependency; the CLI is not imported by
generated code and does not appear in the generated `package.json` outside that one dependency.

The generator keeps these identifiers distinct, and the generated code demonstrates the distinction
rather than collapsing it: project namespace (bounded-context identity) vs. tenant ID (the
organizational data boundary) vs. aggregate type vs. aggregate ID vs. event type.

`src/cli.ts` is typed against a small hand-written `src/node-shims.d.ts` rather than `@types/node`:
the project's `tsconfig.json` already sets `types: ["@cloudflare/workers-types", ...]` for the
Workers-facing adapters, and Node's and Workers' global type sets collide on several ambient names
(`fetch`, `Response`, `Request`, ...). Pulling in all of `@types/node` for one Node-only CLI file
would reintroduce exactly the ambient-global conflict the core has otherwise avoided. The shim
declares only the handful of `node:fs/promises`/`node:path`/`process`/`console` members `cli.ts`
actually calls.

A future `add aggregate` command can be considered after real projects expose repeated scaffolding
needs; it is not part of the initial CLI contract.

### Alternatives considered

#### A separate `create-tiny-cqrs` package

Superseded (see Context) — real added packaging/versioning cost for no capability the `bin`-on-core
approach lacks, at this size.

#### Generate a full framework application

Rejected. The CLI should establish namespaces, files, schemas, and tests, not generate a command
bus, plugin system, transport layer, or mandatory application framework. The generated project must
remain understandable after the scaffolding tool is no longer involved.

#### Generate only a README or schema

Rejected as insufficient. The main value is making the domain boundary and the first executable
`fold`/`decide` path easy to start correctly, with tests that demonstrate the intended contract.

### Consequences

- New projects get consistent namespace, aggregate, tenant, and event conventions.
- The CLI ships in `tiny-cqrs`'s own `files`/`bin`, versioned and released together with the
  runtime — one version number to reason about, at the cost of the runtime package now containing
  (dev-time only) filesystem/CLI code alongside the pure core.
- Generated output is an API-shaped starting point, not a promise that future projects must retain
  the generated layout.
- The initial CLI should remain small until multiple real projects demonstrate that additional
  commands solve repeated work rather than adding ceremony.

---

## ADR-04: Keep event delivery and cache invalidation outside the core

**Status:** Accepted — 2026-09-06

### Context

Modern CQRS systems often add an event bus, subscriptions, queues, read-model refreshes, and cache
invalidation. These are useful application capabilities, but adding them to `tiny-cqrs` would turn
the small command-consistency kernel into a distributed messaging platform.

The committed event log is already the authoritative record. Its tenant-scoped chronological
sequence and optional `loadTenantLog` operation can support a durable delivery layer that tracks a
subscriber cursor. This avoids treating an external publish call as part of the aggregate command
transaction and avoids the dual-write problem.

Cache invalidation is a separate performance and consistency policy. CQRS may create read models,
but it does not imply that every application has a cache or that one invalidation strategy fits all
read models.

### Decision

Keep event buses, delivery transports, subscriber cursors, and cache invalidation out of the
required runtime core.

When durable subscribers are needed, add an optional delivery layer with this shape:

```text
executeCommand
  -> append committed events
event log
  -> subscriber reads after its cursor
subscriber
  -> handles the event idempotently
  -> advances its cursor
```

The event log remains canonical. A queue or broker may accelerate delivery, but it must not replace
the committed history. Subscribers must tolerate at-least-once delivery and must not cause the
originating command to fail when they are unavailable.

An eventual publisher API should therefore live in a separate package or application layer. A
post-commit callback may support best-effort local notifications, but it must be documented as
non-durable. A durable subscriber must read committed history or use an outbox written in the same
transaction as the event.

Do not add cache invalidation to the core. A projection that owns a cache may invalidate or version
its entries after consuming an event. That decision should be based on measured stale-read or
latency requirements, with tenant isolation, retries, and failure behavior defined by the owning
application.

### Alternatives considered

#### Add an in-process event bus to `executeCommand`

Rejected as a required feature. It couples command success to handler execution and cannot provide
durable delivery across process restarts without another persistence mechanism.

#### Publish directly to an external queue after appending

Rejected as the default. A crash between the database commit and publish loses delivery; publishing
before the commit can announce an event that never becomes durable. This is the dual-write problem.

#### Add a transactional outbox table now

Deferred, not rejected. The current event log already contains committed facts and a chronological
cursor. A separate outbox should be introduced only when a concrete broker or throughput requirement
shows that polling the event log is insufficient.

#### Add built-in cache invalidation

Rejected for the core. Cache ownership and consistency guarantees belong to the projection or
application that creates the cache.

### Consequences

- The runtime remains transport-independent and dependency-free.
- Event delivery can be added without changing `fold`, `decide`, or aggregate versioning.
- Subscribers must be idempotent and recoverable from a cursor or equivalent checkpoint.
- Read-model and cache freshness remain explicit application decisions.
- The decision should be revisited when a real consumer requires cross-process fan-out, external
  integration, or measured cache performance.

---

## ADR-05: `StorageAdapter` models a connectionless binding, not a wire-protocol client

**Status:** Accepted — 2026-09-06

### Context

ADR-01 rejected Emmett partly because of a bundling failure: its `dumbo` driver-abstraction layer
pulled in the Node-only `pg` package even on a D1-only path, requiring a manual Wrangler alias
workaround to bundle at all. The original write-up filed that under "packaging bug" and reached for
a "relational vs. document database" explanation for why it felt like the wrong shape. Both were
imprecise, and the imprecision briefly produced an uncharitable read — that Emmett's authors don't
understand CQRS well. They do; `Decider`/`EventStore` are sound designs. The mismatch is narrower
and sits one layer down, in the storage-adapter model, not the CQRS model.

The real distinction: Cloudflare D1's binding is connectionless and HTTP-native —
`env.DB.prepare(sql).bind(...).run()` is a single RPC into the Workers runtime, with no socket, no
connection pool, and no protocol handshake, because the Workers sandbox has no persistent process to
hold one open. `pg` is a wire-protocol client for Postgres: it assumes a connection lifecycle
(dial, auth, keep-alive, pool checkout/checkin) that D1 does not have and cannot have inside that
sandbox. `dumbo` unifies both under one generic "SQL client" interface, so the D1-only path still
statically imports the wire-protocol machinery `pg` provides — not because of a coding mistake, but
because the abstraction was shaped around connection-oriented clients first and D1 was fit into it
after. Going through that shape imposes ceremony and compute a connectionless binding never needed.

This is close to an industry-wide default assumption, not an Emmett-specific one — "a database is
something you open a connection to" predates wire-protocol RDBMS clients themselves (the same
assumption shows up as far back as sequential mag-tape and punch-card access patterns: a job holds
the medium for its duration). Connectionless, HTTP-native bindings like D1 are a genuine break from
that default, recent enough that most existing storage-adapter abstractions — Emmett's included —
were not designed with them as a first-class case.

### Decision

Keep `StorageAdapter` shaped as plain async calls with no connection lifecycle implied —
`loadEvents(...)` / `appendEvents(...)` — so the D1 adapter is a direct, ceremony-free wrapper over
the binding, and so a future wire-protocol backend (Postgres, etc.) can implement the same interface
by managing its own connection lifecycle internally, without that lifecycle leaking into the
interface every adapter must implement.

This was already the shape `StorageAdapter` had; it was not initially justified on this specific
architectural ground. This ADR records that ground explicitly so the reasoning isn't lost, and so a
future contributor proposing a generic "SQL client" storage adapter is pointed here first.

### Consequences

- No adapter is required to simulate connection semantics it doesn't have, or to import a
  wire-protocol client library it doesn't use.
- A Postgres (or other wire-protocol) adapter remains straightforward to add later — it owns its own
  connection/pool internally — without changing the interface every other adapter implements.
- Revisit trigger: unchanged from ADR-01 — re-run the Emmett comparison if/when its storage-adapter
  layer (`dumbo`) is redesigned to treat connectionless bindings as first-class rather than fitting
  them through a connection-oriented interface, not merely when D1 support leaves beta.

---

## ADR-06: Make lifetime execution portability the project's governing objective

**Status:** Accepted — 2026-09-07

### Context

CQRS and event sourcing describe established techniques, but they do not by themselves explain why
this small library should exist. The distinctive value of `tiny-cqrs` is the boundary around the
smallest useful consistency kernel: pure `fold`/`decide` functions, a minimal storage contract, and
one command execution path that owns versioning, idempotency, retry, and outcome semantics.

That boundary makes domain decisions portable across storage substrates and runtimes. It also points
to a larger concern: important software is increasingly delivered as a black box whose rules,
evidence, and execution environment are controlled by one provider. Users may be asked to trust a
decision they cannot independently replay, verify, migrate, or contest.

The project should therefore be guided by a durable architectural objective rather than by the
category label "CQRS library." The useful analogy is to a smart contract's persistence of meaning
across invoking clients, but without claiming blockchain properties such as consensus, gas, or
trustless deployment.

### Decision

Treat lifetime execution portability as the project's governing objective:

> `tiny-cqrs` makes important domain decisions portable, replayable, and independently verifiable
> across infrastructure lifetimes.

The package remains the TypeScript reference implementation of a portable execution contract:

```text
history + command + declared contract
    -> outcome + events + resulting state
```

The public center remains `fold`/`decide`, `StorageAdapter`, `executeCommand`, the event envelope,
`Outcome`, expected-version concurrency, and explicit idempotency semantics. The absence of a
command bus, handler registry, dependency container, transport envelope, projection daemon, and
plugin manager remains intentional.

Future work should prioritize explicit semantics, adapter conformance tests, language-neutral test
vectors, replay, and optional evidence features such as signing. A feature belongs in the core only
when it makes the consistency contract more portable, explicit, replayable, verifiable, migratable,
or stronger at the adapter boundary.

### Consequences

- CQRS is an implementation context, not the project's primary identity.
- Portability includes storage and runtime migration, replay after code changes, and eventual
  reimplementation in another language.
- Documentation must distinguish guarantees enforced by the core from requirements placed on pure
  domain functions and storage adapters.
- Conformance and test vectors are higher-leverage than accumulating framework integrations or
  storage adapters with loosely defined behavior.
- Signing, audit evidence, and historical attestations should remain composable optional layers.
- The project must resist becoming a full application framework, event bus, workflow engine,
  projection platform, blockchain product, or vendor-specific deployment toolkit.

The expanded rationale and roadmap live in [`docs/north-star.md`](../north-star.md).
