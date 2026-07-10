# Domain docs

How engineering skills should consume this repository's domain documentation.

## Before exploring

- Read `CONTEXT.md` at the repository root when it exists.
- Read ADRs under `docs/adr/` that touch the area being changed.
- If these files do not exist, proceed silently. Producer workflows create them lazily when domain terms or decisions are resolved.

## Layout

This is a single-context repository:

```text
/
├── CONTEXT.md
├── docs/adr/
└── public/ and lib/
```

## Vocabulary

Use the glossary vocabulary from `CONTEXT.md` in issue titles, tests, refactor proposals, and hypotheses. If a needed concept is missing, reconsider the term or note the gap for a documentation workflow.

## ADR conflicts

If a proposed change contradicts an existing ADR, surface the conflict explicitly rather than silently overriding it.
