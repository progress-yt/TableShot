# Contributing

## Setup

Use Node.js 22 or 24:

```bash
npm ci
npm run verify
```

Use a non-sensitive test database for manual checks. Never commit `.env`, credentials, certificates, screenshots, logs or failure HTML.

## Workflow

1. Record larger work under `.scratch/<feature>/` using the conventions in `docs/agents/issue-tracker.md`.
2. Add a deterministic failing regression test at the real bug seam.
3. Make the smallest implementation change that turns it green.
4. Run `npm run verify`.
5. Update README, ADRs and `CONTEXT.md` when behavior, boundaries or vocabulary change.

## Security-sensitive changes

- Do not add arbitrary SQL execution.
- Do not permit non-loopback HTTP binding.
- Keep SQL generation in the server template registry.
- Use prepared statements for values and validated quoting for identifiers.
- Resolve and verify final filesystem paths before writing.
- Put explicit hard limits and timeouts on database, browser and batch work.
