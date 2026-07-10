# ADR-0001: Server-owned query templates

## Status

Accepted

## Context

The original browser generated SQL and the server tried to recognize it with regular expressions. SQL that merely resembled a template could include additional expressions or file-writing clauses.

## Decision

Public APIs accept only `templateId`, database/table identifiers and role-specific fields. The server loads live metadata, validates fields, builds SQL from `TEMPLATE_REGISTRY`, quotes identifiers and executes all values with prepared statements. Public template metadata and SQL preview come from the same registry.

Arbitrary SQL validators and executors are not exported.

## Consequences

- Adding a template requires a server registry change and regression tests.
- The front end cannot operate with a locally duplicated SQL builder.
- Display SQL is derived separately and is never fed back into execution.
