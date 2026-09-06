# Contributing to tiny-cqrs

Thanks for considering a contribution. This is a small, deliberately narrow library — read the
README's "Design" and "Non-goals" sections before proposing an addition. A lot of reasonable-
sounding features (event schema upcasting, snapshotting, async projections) are intentionally left
out of core; they belong in a layer built on top, not in this repo.

## Development

```
bun install
bun test          # everything, including D1-backed tests
bunx tsc --noEmit
```

`test/d1-adapter.test.ts` runs against a real Miniflare/workerd instance via
`@cloudflare/vitest-pool-workers` — no live Cloudflare account needed, `bun test` sets it up
automatically.

## Before opening a PR

- Add or update tests for any behavior change. `executeCommand`'s idempotency and concurrency
  semantics have failure modes that are easy to get subtly wrong — see
  `test/execute-command.test.ts` and `test/d1-adapter.test.ts` for the shape existing tests take
  (in particular, tests that prove a *retry* behaves correctly, not just a first attempt).
- Keep `tsc --noEmit` clean.
- A new storage adapter needs to satisfy the `StorageAdapter` contract in `src/storage-adapter.ts`
  and ship with its own test suite proving it does — `adapters/memory.ts` and `adapters/d1.ts` are
  the reference implementations.

## Scope

New adapters, bug fixes, and documentation improvements are welcome here. Domain-specific helpers
(accounting, construction, whatever) belong in their own "flavor" package that depends on
`tiny-cqrs` — see [`ledger-kit`](https://github.com/mnhpub/ledger-kit) for the reference example —
not in this repo.

## Reporting a security issue

Please use [GitHub's private vulnerability reporting](https://github.com/mnhpub/tiny-cqrs/security/advisories/new)
rather than a public issue.

## License

By contributing, you agree your contributions are licensed under this project's Apache-2.0 license.
