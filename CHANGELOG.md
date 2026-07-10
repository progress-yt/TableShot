# Changelog

## Unreleased

### Security

- Replaced client-provided SQL with server-owned structured templates and prepared statements.
- Restricted HTTP binding and browser origins to loopback.
- Added safe output containment, dot-segment rejection and atomic no-overwrite PNG publication.
- Added CSP and defensive response headers, request/content limits and private 5xx responses.
- Cached a fixed public-asset allowlist in memory, retired HTTP screenshot serving, and bound sensitive writes to validated file handles.
- Added bounded private failure logs and screenshot diagnostics, Unicode log normalization, and symlink/junction race regressions.

### Reliability

- Added atomic MySQL connection replacement, health checks, finite queues and query timeouts.
- Added browser session capacity, CDP/process/file timeouts and explicit cleanup policy.
- Added stopping-session accounting, bounded deadline queues, cancellable capture work and fail-closed atomic publication.
- Added unique run directories and explicit query/capture truncation metadata.
- Added request cancellation, stale-response protection, single/batch locks and accurate cancellation accounting.

### Developer experience

- Added Node test coverage, ESLint, syntax checks, CI, agent workflow configuration, domain documentation and ADRs.
- Enabled automatic `.env` loading through Node's `--env-file-if-exists` flag.
