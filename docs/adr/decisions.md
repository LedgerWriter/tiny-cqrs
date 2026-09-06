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
