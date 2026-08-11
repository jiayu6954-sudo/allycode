## What does this PR do?

<!-- One sentence. Lead with the "why", not just the "what". -->

## Type of change

- [ ] Bug fix
- [ ] Integration test addition
- [ ] New feature
- [ ] Documentation update
- [ ] Refactor (no behavior change)

## Checklist

- [ ] `npm run typecheck` — zero errors
- [ ] `npm run typecheck:desktop` — zero errors
- [ ] `npm run lint` — zero errors
- [ ] `npm run test:run` — all tests pass
- [ ] `npm run build` — succeeds
- [ ] No new `any` types introduced without justification
- [ ] Error handling follows layered model (tools return `{content, isError}`, never throw)
- [ ] No speculative abstractions added for future use

## If this touches the Agent Loop, system prompt, or provider layer

- [ ] Manually tested end-to-end with a real API call
- [ ] Or: integration test added that covers the changed path

## Security review

- [ ] No credentials, local paths, private logs, or user data are included
- [ ] New IPC, network, filesystem, and command-execution behavior is documented

## Notes for reviewer

<!-- Anything non-obvious about the approach, known edge cases left open, or follow-up needed. -->
