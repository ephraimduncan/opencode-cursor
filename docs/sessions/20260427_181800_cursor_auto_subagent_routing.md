# Cursor auto model subagent routing fix

Date: 2026-04-27
Repo: C:\NEW PRG\opencode-cursor

## Problem

Sisyphus/explore subagent tests failed with model routing errors:

- `Connect error not_found: Error`
- `Model not found: cursor-acp/auto`

Prior sessions showed `oh-my-openagent.jsonc` routed `explore`/`sisyphus-junior` through `cursor/auto`, while `quick` still used `cursor-acp/auto`. The active OpenCode provider config only contains the `cursor` provider stub and does not define a live `cursor-acp` provider.

## Changes

- `src/index.ts`
  - Added a provider-side `auto` Cursor model definition.
  - Changed provider model registration to merge `auto` into `provider.models` exactly once.

- `src/proxy.ts`
  - Added proxy-side `auto` model merge for `/v1/models` output.
  - Prevents duplicate `auto` entries if discovery already returns `auto`.

- `test/smoke.ts`
  - Added assertions that `provider.models` includes `auto` after refresh-before-discovery.
  - Added fallback/success discovery checks for `auto`.
  - Added proxy `/v1/models` checks that `auto` is exposed exactly once.

- `C:\Users\U-N-00658\.config\opencode\oh-my-openagent.jsonc`
  - Changed `categories.quick.model` from `cursor-acp/auto` to `cursor/auto`.

## Verification

- LSP diagnostics:
  - `src/index.ts`: no diagnostics
  - `src/proxy.ts`: no diagnostics
  - `test/smoke.ts`: no diagnostics

- `bun test/smoke.ts`
  - Passed: all smoke tests, including refresh/discovery/proxy model list checks.

- `bun run build`
  - Passed: `tsc -p tsconfig.json && node scripts/copy-runtime.mjs`.

- Config checks:
  - Active `oh-my-openagent.jsonc` parses as JSON.
  - Active `oh-my-openagent.jsonc` now has only `cursor/auto` references for explore, sisyphus-junior, and quick.
  - `cursor-acp/auto` remains only in backup config files.

- Oracle review:
  - PASS for code/config fix, with one caveat: already-running OpenCode sessions can keep old provider/category config in memory.

## Remaining operational note

The current running OpenCode session still returned old routing symptoms after the fix, which is consistent with runtime config/provider registry caching. Fresh OpenCode session verification is required to prove live subagent routing after reload.
