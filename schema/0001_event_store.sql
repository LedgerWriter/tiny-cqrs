-- Schema required by src/adapters/d1.ts. Mirrors ledgerwriter.com's original event_store table.
CREATE TABLE event_store (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, aggregate_id, version)
);

-- The `id` autoincrement column doubles as a free cross-aggregate chronological index for a
-- single tenant (see the audit-log helper in ledger-kit) — no separate ordering table needed.
CREATE INDEX idx_event_store_stream ON event_store (tenant_id, aggregate_type, aggregate_id, version);
CREATE INDEX idx_event_store_tenant_chrono ON event_store (tenant_id, id);
