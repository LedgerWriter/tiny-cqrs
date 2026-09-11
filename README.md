# tiny-cqrs

A small, storage-agnostic CQRS and event-sourcing core for TypeScript.

`tiny-cqrs` provides the aggregate execution cycle:

```text
load → fold → decide → apply → append
```

The core supplies the mechanics around that cycle. Your application supplies the domain types, state transition functions, storage adapter, and deployment target.

The same `fold` and `decide` functions can run against Cloudflare Durable Objects, D1, Node, an in-memory store, or another storage substrate supported by an adapter.

## Why this exists

CQRS and event sourcing are useful when the history of an aggregate matters and domain decisions need to be made against a known version of that history.

The consistency loop is small:

```text
events
  ↓
fold
  ↓
state
  ↓
decide
  ↓
new events
  ↓
append
```

Applications often implement this loop themselves. `tiny-cqrs` provides a small core for running it without requiring a command bus, HTTP framework, database, deployment platform, or application framework.

The goal is not to provide a complete CQRS platform.

The goal is to provide a small execution core that can be inspected, tested, adapted, and used by other packages.

---

## Execution cycle

`executeCommand` performs the core command cycle:

1. Load the aggregate's event history.
2. Fold the events into current state.
3. Pass the state and command to `decide`.
4. Apply the resulting events to produce the next state.
5. Append the events using optimistic concurrency.
6. Optionally perform projection work supplied by the storage adapter.
7. Return a structured outcome.

Conceptually:

```ts
const state = fold(events)

const result = decide(state, command)

if (!result.ok) {
  return result
}

const nextState = result.events.reduce(apply, state)

await adapter.appendEvents({
  aggregateId,
  expectedVersion,
  events: result.events,
})

return {
  ok: true,
  data: nextState,
}
```

The actual implementation provides the surrounding version checks, tenant and aggregate scoping, idempotency support, and storage interaction.

---

## Domain logic stays outside the core

`tiny-cqrs` does not define your domain model.

You provide functions such as:

```ts
function fold(events: Event[]): State {
  // domain state reconstruction
}

function decide(
  state: State,
  command: Command,
): Outcome<Event[]> {
  // domain decision
}
```

These functions are ordinary TypeScript.

They do not depend on a database, HTTP framework, queue, or Cloudflare runtime.

This keeps domain decisions portable across storage and deployment environments.

---

## Storage

Storage is supplied through an adapter.

The core currently defines the storage operations required to:

* load an aggregate's events
* append events against an expected version
* report concurrency conflicts
* optionally perform projection writes
* optionally store completed command outcomes for idempotent retries

The adapter owns the platform-specific implementation.

For example:

```ts
const adapter = createD1Adapter(env.DB)
```

or:

```ts
const adapter = createMemoryAdapter()
```

The application does not need to change its domain `fold` or `decide` functions when the storage substrate changes.

---

## Optimistic concurrency

Commands operate against an expected aggregate version.

If another command has already advanced the aggregate, the append operation fails with a `ConcurrencyConflictError`.

This makes concurrent writes an expected command outcome rather than an unhandled database condition.

The core does not attempt to resolve competing domain decisions.

The application can decide whether to retry, present an error, or take another action.

---

## Idempotency

Idempotency can be supplied at the command boundary.

```ts
await executeCommand({
  adapter,
  aggregateId,
  command,
  idempotencyKey,
  idempotency: createD1IdempotencyStore(env.DB),
})
```

A completed retry can return the previously recorded outcome without running the domain decision again.

The current idempotency implementation uses a check-then-act model. It is not a general-purpose distributed claim protocol.

Applications that require stronger concurrent duplicate handling should provide an appropriate storage implementation.

---

## Tenant and aggregate scope

Stored events carry the information required to identify their scope:

```ts
{
  tenantId,
  aggregateType,
  aggregateId,
  version,
  occurredAt,
  event
}
```

The core uses tenant and aggregate identity as part of its storage contract.

It does not define what a tenant means to the application, nor does it provide an authorization system.

Authorization remains an application responsibility.

---

# Designed for extension

`tiny-cqrs` is intentionally small, but small does not mean closed.

Additional CQRS capabilities can be implemented as companion packages that depend on the core rather than being built into it.

Potential companion packages include:

* projections and projection checkpoints
* snapshot stores
* command dispatch
* query handling
* event publication
* event versioning and upcasting
* observability
* testing utilities
* workflow and process coordination
* additional storage adapters

For example:

```text
                 ┌─────────────────────┐
                 │     Application      │
                 │                     │
                 │ product rules       │
                 │ authorization       │
                 │ transport           │
                 │ workflows           │
                 └──────────┬──────────┘
                            │
             ┌──────────────┴──────────────┐
             │                             │
     ┌───────▼────────┐           ┌────────▼────────┐
     │   Extensions   │           │     Flavors      │
     │                │           │                  │
     │ projections    │           │ accounting       │
     │ snapshots      │           │ other domains    │
     │ observability  │           │                  │
     │ testing        │           │                  │
     └───────┬────────┘           └────────┬─────────┘
             │                             │
             └──────────────┬──────────────┘
                            │
                    ┌───────▼────────┐
                    │   tiny-cqrs    │
                    │                │
                    │ executeCommand │
                    │ storage        │
                    │ concurrency    │
                    │ idempotency    │
                    └────────────────┘
```

The core should remain useful without these packages.

An extension should not require the core to understand its transport, framework lifecycle, or deployment model.

That boundary is a design goal, not a plugin API.

---

## Extensions versus flavors

There is a useful distinction between an **extension** and a **flavor**.

An extension adds infrastructure capability around the core.

Examples:

```text
tiny-cqrs
    ↓
projection support
```

```text
tiny-cqrs
    ↓
snapshot support
```

```text
tiny-cqrs
    ↓
observability
```

A flavor applies the core to a particular domain.

For example:

```text
tiny-cqrs
    ↓
ledger-kit
    ↓
accounting application
```

A flavor can provide domain types, invariants, helpers, and projections without requiring those concepts to become part of `tiny-cqrs`.

The `*-kit` naming convention is currently informal. It is not a plugin contract, and flavor packages do not need to share a common composition interface.

---

## Outcomes

The core returns structured outcomes rather than requiring a particular transport or framework.

```ts
type Outcome<T> =
  | {
      ok: true
      data: T
    }
  | {
      ok: false
      code: string
      message: string
    }
```

This allows the same command execution code to be used from an HTTP handler, a worker, a test, or another application boundary.

The core does not define HTTP responses, RPC envelopes, message formats, or framework-specific exceptions.

---

## Signing

An optional signing module is available separately:

```ts
import {
  signEvent,
  verifyEvent,
} from "tiny-cqrs/signing"
```

The signing module uses Ed25519.

Signing is not part of the `executeCommand` cycle. Applications can use it where signed commands or events are required.

---

## What is not included

`tiny-cqrs` does not attempt to provide:

* an HTTP API
* a command bus
* a handler registry
* a message broker
* authorization
* authentication
* tenant policy
* aggregate design
* accounting rules
* cross-aggregate transactions
* saga orchestration
* snapshotting
* event schema migration
* event upcasting
* asynchronous projection queues
* durable subscriber delivery
* application-level workflow management

Some of these may be appropriate for companion packages.

They do not belong in the core merely because they are associated with CQRS or event sourcing.

---

## Portability

Portability is one of the reasons for keeping the core small.

The domain functions:

```text
fold(events) → state
decide(state, command) → events
```

do not need to know whether events are stored in:

* Cloudflare D1
* Cloudflare Durable Objects
* Node
* an in-memory store
* another compatible storage implementation

The adapter supplies the storage-specific behaviour.

This is particularly useful when the same aggregate logic needs to operate across more than one runtime or storage substrate.

It is not a claim that every substrate has the same latency, throughput, consistency characteristics, or operational cost.

Those properties need to be measured for the deployment in question.

---

## Edge runtimes

`tiny-cqrs` is designed to work in constrained runtimes where a small dependency surface and limited framework assumptions are useful.

Cloudflare Workers and D1 are first-class targets in the current implementation.

A Durable Object can also provide aggregate-local serialization and in-memory state for workloads where that model is appropriate.

`tiny-cqrs` does not make a general performance claim about edge execution.

For production evaluation, measure the actual deployment:

* warm latency
* cold-start behaviour
* event replay cost
* storage write latency
* aggregate throughput
* contention
* idempotency-hit latency

Local emulation is useful for behavioural testing, but it is not a substitute for deployed measurements.

---

## Testing

The separation between `fold`, `decide`, and the storage adapter makes the domain model straightforward to test independently.

The core can also be tested against an in-memory adapter before being exercised against a production storage implementation.

For migrations between implementations, the previous implementation can be retained as a characterization reference and compared with the new implementation for the same command sequences.

Useful comparisons include:

* accepted and rejected commands
* resulting event sequences
* aggregate versions
* domain error codes
* concurrent command behaviour

These tests provide evidence about the cases they cover. They do not prove equivalence for cases that have not been tested.

---

## Current status

`tiny-cqrs` is currently pre-1.0.

The core shape around:

* `executeCommand`
* `StorageAdapter`
* `Outcome`

is established, but breaking changes remain possible while the package is in the 0.x series.

The project is deliberately small enough that its implementation can be read rather than treated as an opaque framework.

---

## Design principles

A few principles guide the project:

### Keep the consistency loop small

The core should focus on the aggregate command cycle and the guarantees it can actually provide.

### Keep domain decisions portable

`fold` and `decide` should not require a particular runtime, database, or framework.

### Prefer companion packages to core expansion

A capability that can depend on `tiny-cqrs` without requiring changes to the execution model should generally remain outside the core.

### Keep domain-specific concerns outside the generic core

Accounting, inventory, billing, legal workflows, and other domains can build on the core without becoming concepts understood by it.

### Make concurrency a normal outcome

Concurrent writes should have a defined result that applications can handle.

### Do not hide operational trade-offs

Portability does not imply identical performance or operational behaviour across storage substrates.

### Keep the implementation inspectable

The package should remain small enough for developers to understand what it does and what it does not do.

---

## Installation

```bash
npm install tiny-cqrs
```

## License

Apache-2.0
