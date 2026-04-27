# Explore subagent cursor/auto follow-up

Date: 2026-04-27
Repo: `C:\NEW PRG\opencode-cursor`

## User request

The user asked to diagnose why `explore` subagents failed with:

- `[Error: Connect error invalid_argument: Model details are required]`

The user explicitly rejected changing `explore.model` from `cursor/auto` to a fixed explicit model as a workaround. The fix must preserve AUTO as the user-facing model.

## Findings

- Three initial `explore` background tasks failed immediately before performing any search.
- The failure is from Cursor ConnectRPC, not from search logic, auth, or local tool execution.
- Active OMO config uses `explore.model = "cursor/auto"`.
- Previous change made `modelId === "auto"` omit `AgentRunRequest.modelDetails`.
- Cursor private `agent.v1.AgentService/Run` requires `modelDetails`.
- Public Cursor Cloud Agents REST API supports `model: "default"`/omitted model, but that does not apply to the private ConnectRPC protobuf path.
- External OSS examples consistently send `modelDetails` with an explicit model ID; examples using `requestedModel` still include `modelDetails`.

## Implemented fix

- `src/proxy.ts`
  - Added `resolveCursorRunModelId(modelId)`.
  - `cursor/auto` remains exposed in `/v1/models`.
  - Before building Cursor `ModelDetails`, `auto` resolves to the first discovered non-auto Cursor model from `proxyModels`.
  - Explicit model requests still pass through unchanged.

- `test/smoke.ts`
  - Added fake Cursor backend observation of `/agent.v1.AgentService/Run` request payloads.
  - Added smoke coverage that `model: "auto"` includes `modelDetails` and resolves to the first discovered model (`composer-2` in the fixture).
  - Confirms explicit `composer-2` still forwards unchanged.

- `dist/proxy.js`
  - Regenerated via `bun run build`.

## Verification performed

- `lsp_diagnostics` on `src/proxy.ts`: no diagnostics.
- `lsp_diagnostics` on `test/smoke.ts`: no diagnostics.
- `bun test/smoke.ts`: passed.
- `bun run build`: passed.

## Important unresolved runtime note

After the fix and build, an actual `explore` background task was launched in the same OpenCode session:

- Task ID: `bg_a60161ad`
- Result: `[Error: Connect error invalid_argument: Model details are required]`

Follow-up inspection showed `src/index.ts` already calls `startProxy(..., models)`, so the likely explanation is that the currently running OpenCode process/session still has the old plugin/proxy code loaded in memory. A fresh OpenCode restart/reload is needed before re-testing live `explore` behavior.

## Current git state at save time

Modified:

- `src/proxy.ts`
- `test/smoke.ts`

Untracked session docs observed:

- `docs/sessions/20260427_181800_cursor_auto_subagent_routing.md`
- `docs/sessions/20260427_185828_cursor_auto_model_request.md`
- `docs/sessions/20260427_193435_cursor_auto_discovered_model.md`
- this file

## Next recommended step

Restart OpenCode so the rebuilt local plugin `dist/` is loaded, then run a minimal `explore` task that searches for `resolveCursorRunModelId`. If it still fails with `Model details are required`, inspect the live loaded plugin path/version and active proxy process rather than changing `oh-my-openagent.jsonc` to an explicit model.
