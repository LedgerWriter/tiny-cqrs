-- Schema required by createD1IdempotencyStore (src/adapters/d1.ts). Optional -- only needed if
-- you pass idempotencyKey to executeCommand with a D1-backed IdempotencyStore.
CREATE TABLE idempotency_keys (
  tenant_id       TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, idempotency_key)
);
