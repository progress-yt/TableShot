# ADR-0003: Run-scoped, non-overwriting artifacts

## Status

Accepted

## Context

Fixed task/table/template paths silently overwrote earlier screenshots, while user-controlled dot segments could escape the capture root.

## Decision

Every execution has a validated `runId`. Artifacts live under `captures/<runId>/<task>/<table>/`. Each path component is validated, the resolved and real paths must remain inside controlled roots, and a completed PNG is published atomically without replacing an existing file. The server returns the run root as `folderPath`; screenshot bytes are not served over HTTP and are opened through the local folder workflow. New sensitive artifacts use owner-only permissions on POSIX systems.

## Consequences

- Re-running creates a new archive instead of replacing history.
- Clients use server-returned paths and never reconstruct filesystem locations.
- Automatic capture deletion is opt-in because archives are user data.
- Filesystems without same-directory hard-link publication fail closed instead of exposing a partially copied PNG.
