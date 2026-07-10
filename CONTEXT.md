# TableShot domain context

## Purpose

TableShot is a local data-archive workbench: a user selects MySQL tables, runs a small set of reviewed query templates, and stores visual evidence as PNG artifacts.

## Glossary

- **Connection** — the single in-memory MySQL pool currently owned by the local process.
- **Target table** — a table selected for inspection or batch work.
- **Trial table** — the current table used for field inspection, preview and a single template run.
- **Template** — a server-owned query definition identified by `templateId`; it owns SQL construction, field requirements, side effects and capture presentation.
- **Field inference** — detection of likely time or region columns from names, types and comments.
- **Field override** — a user-selected time/region field; the server still validates it against live metadata.
- **Run** — one single or batch execution identified by `runId`.
- **Artifact** — a PNG and its safe, repository-relative metadata produced within a run.
- **Capture session** — one bounded Chromium/CDP process profile reused by a single worker.
- **Statistics refresh** — an explicitly confirmed `ANALYZE TABLE`; never call it a read-only query.
- **Preview mode** — a fixture-only UI mode that must not call production APIs.

## Boundaries

- The browser sends structured commands, never SQL.
- The Node process is the policy boundary for templates, metadata validation, MySQL access and filesystem containment.
- MySQL is an external system and may be slow, unavailable or more privileged than intended; every operation needs limits and safe error handling.
- Chromium is an external process and must be isolated, timed out, capacity-limited and cleaned up.
- `captures/`, `logs/` and `tmp/` are sensitive local data stores, not source assets.
