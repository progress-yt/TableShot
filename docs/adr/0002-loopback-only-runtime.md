# ADR-0002: Loopback-only runtime

## Status

Accepted

## Context

TableShot has one in-memory database connection and no multi-user identity model. Exposing it on a network would expose connection replacement, schema access, screenshots and explicit maintenance operations.

## Decision

The HTTP server only binds the numeric loopback addresses `127.0.0.1` or `::1`. `localhost` is deliberately not a valid bind configuration because DNS or hosts-file resolution can redirect a name away from loopback. Requests validate Host, Origin and Fetch Metadata when present. Remote deployment flags are intentionally unsupported.

## Consequences

- The product remains a single-user desktop-style tool.
- Network deployment requires a different architecture with authentication, per-user state, TLS and artifact authorization; it must not be enabled by a configuration shortcut.
