# Cursor Auto Default Run Routing PR

## Summary

Prepared an upstream pull request for `ephraimduncan/opencode-cursor` from the fork branch `chrythjin:fix/cursor-auto-default-run-model`.

PR: https://github.com/ephraimduncan/opencode-cursor/pull/28

## Changes

- Updated `src/proxy.ts` so OpenAI-compatible `model: "auto"` is encoded for Cursor `AgentService/Run` as Cursor model id `default`.
- Added `requestedModel` to the Run request payload and kept `modelDetails` populated for compatibility.
- Preserved explicit model forwarding, such as `composer-2`, through both `requestedModel` and `modelDetails`.
- Updated `test/smoke.ts` to assert `auto` sends `default` and displays as `Auto`.

## Verification

- `bun install --frozen-lockfile`
- `bun run build`
- `bun test/smoke.ts`
- LSP diagnostics on `src/proxy.ts` and `test/smoke.ts`: no errors

## Notes

The PR intentionally does not use `GetDefaultModelForCli`, because that RPC returns a concrete CLI default model and is not the same as Cursor Auto routing. Sending `default` in the Run model fields lets Cursor make its own server-side routing decision.
