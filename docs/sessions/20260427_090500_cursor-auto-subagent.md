# Cursor auto subagent model registration

## Summary

Fixed the Cursor provider so `cursor/auto` is registered consistently for OpenCode subagent routing.

## Changes

- Added a canonical `auto` model entry to the Cursor provider model map in `src/index.ts`.
- Updated the local OpenAI-compatible proxy in `src/proxy.ts` to merge `auto` without duplicating it when Cursor discovery already returns an `auto` model.
- Updated `test/smoke.ts` to verify `auto` is present for provider registration and proxy `/v1/models` responses, including duplicate-prevention coverage.

## Verification

- `lsp_diagnostics` on `src/index.ts`: no diagnostics.
- `lsp_diagnostics` on `src/proxy.ts`: no diagnostics.
- `lsp_diagnostics` on `test/smoke.ts`: no diagnostics.
- `bun test/smoke.ts`: passed.
- `rtk npm run build`: passed.

## Notes

The root cause was a mismatch between the model requested by oh-my-openagent (`cursor/auto`) and the models registered in OpenCode's Cursor provider registry. The proxy exposed `auto` through `/v1/models`, but `provider.models` did not reliably include it, so subagent routing could fail before the proxy was called.
