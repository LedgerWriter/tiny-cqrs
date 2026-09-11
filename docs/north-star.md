# North Star: Lifetime Execution Portability

## Thesis

`tiny-cqrs` is not valuable because it implements CQRS or event sourcing. Those are established patterns. Its value is that it isolates the smallest useful consistency kernel and keeps almost everything else replaceable.

> `tiny-cqrs` makes important domain decisions portable, replayable, and independently verifiable across infrastructure lifetimes.

The practical version is:

> Make correctness portable while keeping infrastructure replaceable.

A domain decision should retain the same meaning when executed against a different database, in a different runtime, on a different deployment platform, or by a different implementation language.

## The Portable Execution Contract

The core contract is intentionally small:

```text
history + command
    -> fold(history)
    -> decide(state, command)
    -> new events
    -> append at expected version
```

In code, the domain remains two plain functions:

```text
fold(events)           -> state
decide(state, command) -> new events
```

The consistency kernel coordinates the rest:

```text
load
  -> fold
  -> decide
  -> fold resulting state
  -> append at expected version
  -> optionally commit projections atomically
```

This boundary keeps domain rules separate from storage, transport, deployment, retries, projections, and external integrations. The same model can run against an in-memory test store, D1, Durable Objects, Node, or a future adapter without rewriting the aggregate logic.

The package is the current TypeScript implementation of this contract. The longer-term ambition is that the contract should be understandable and implementable beyond this package.

## Why This Matters

Important software is increasingly delivered as a black box:

- the provider controls the implementation and data model
- rules can change without a durable explanation
- the audit trail is incomplete or shaped by the vendor
- migration is made expensive or impossible
- users are asked to trust decisions they cannot independently reconstruct

A portable execution contract changes the trust model:

```text
black-box software:
input -> opaque process -> output

portable contract:
input + prior evidence + declared rules
    -> reproducible decision + new evidence
```

This does not make every decision correct, and it does not prove that input data is honest. It makes the rules, evidence, result, and subsequent changes more visible and contestable. The goal is not to eliminate trust; it is to avoid making trust in one operator the only way to understand or verify an important decision.

## Lifetime Execution Portability

Portability is broader than running on Node and Cloudflare. It includes the lifetime of a system:

- changing storage engines or deployment platforms
- moving from a server to the edge
- reimplementing the kernel in another language
- replaying historical events after an implementation change
- reconstructing state for audit or dispute resolution
- migrating away from a vendor without changing the meaning of business rules

The durable unit is not the npm package. It is the contract:

```text
history + command + declared contract
    -> outcome + events + resulting state
```

A future implementation may need an explicit contract or behavior version so historical results remain attributable to the rules that produced them. That should begin with clear semantics, manifests, test vectors, and conformance documents before becoming runtime machinery.

## Smart-Contract Analogy

The useful connection to smart contracts is persistence of meaning, not blockchain infrastructure. A smart contract is valuable because its behavior is intended to survive the particular client or process invoking it. `tiny-cqrs` applies a related idea to domain execution: a decision should remain reproducible when its runtime, storage substrate, or original operator changes.

The project does not provide consensus, gas accounting, adversarial execution, or trustless deployment. It should therefore describe itself as a portable or verifiable execution contract, not as a blockchain smart-contract system.

## What Belongs in the Kernel

The durable public center is:

- `fold` / `decide`
- `StorageAdapter`
- `executeCommand`
- `EventEnvelope`
- `Outcome`
- expected-version concurrency
- explicit idempotency semantics
- optional tenant-wide chronological access

The absence of a command bus, handler registry, dependency container, transport envelope, projection daemon, and plugin manager is intentional. Those mechanisms may be useful in applications, but placing them in the kernel would make the contract less portable and introduce assumptions the core cannot own.

## Roadmap Implications

The highest-leverage work is making the contract explicit and testable.

### Specify the semantics

Document event ordering, version `0`, tenant boundaries, tenant-log cursors, empty event decisions, retry boundaries, idempotency races, projection failure behavior, timestamps, and the distinction between infrastructure errors and domain outcomes.

### Build adapter conformance

Every adapter should be testable against the same expectations: tenant isolation, aggregate ordering, expected-version rejection, atomic event-plus-projection writes, chronological tenant-log behavior, idempotency behavior, failure propagation, and replay equivalence.

### Add language-neutral test vectors

Canonical fixtures should describe inputs and expected behavior independently of TypeScript, allowing future Rust, Zig, Go, or other implementations to demonstrate behavioral compatibility.

### Keep evidence features composable

Signing, audit evidence, key identity, and historical attestations should remain optional layers. They should strengthen replay and verification without making cryptographic or distributed-systems infrastructure a prerequisite for using the core.

## Feature Filter

A proposed feature belongs in `tiny-cqrs` only when it makes the consistency contract more portable, more explicit, easier to replay or verify, easier to migrate across substrates or vendors, or stronger at the adapter boundary. Otherwise it probably belongs in an application package, a flavor package, or an external tool.

## What This Project Must Not Become

The project should not become a full CQRS application framework, general event bus, workflow or saga engine, projection platform, database abstraction that hides important guarantees, blockchain product, or vendor-specific deployment toolkit. The absence of those systems is part of the architecture.

## The Test for Success

The strongest test is not whether an application can call `executeCommand`. It is whether an important decision made today remains understandable, replayable, and portable after the storage engine, runtime, vendor, or implementation language has changed.

> Do not make people trust the box. Make the box's decisions portable enough to verify outside it.
