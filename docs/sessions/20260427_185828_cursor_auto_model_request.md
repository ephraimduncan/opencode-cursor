# Cursor auto model request handling

Date: 2026-04-27
Repo: `C:\NEW PRG\opencode-cursor`

## Problem

`explore` subagent runs failed with:

- `[Error: Connect error not_found: Error]`

Manual explicit Cursor model selection worked, but `cursor/auto` failed. Earlier work had added `auto` to the OpenCode-facing provider model list, but the proxy still forwarded the OpenAI request model string directly into Cursor's protobuf `ModelDetails.modelId`.

## Research summary

- Cursor Cloud Agents REST API documents model selection as optional:
  - explicit model ID for fixed model selection
  - `"default"` or omitted model for configured/default model selection
- Reverse-engineered/proxy implementations commonly pass explicit model IDs through `ModelDetails`.
- Upstream/related Cursor OpenAI proxy repos generally do not test `auto` semantics and pass `body.model` through verbatim.
- Local proto has `AgentRunRequest.modelDetails` and optional `requestedModel`; existing implementation used only `modelDetails`.

Conclusion: `cursor/auto` should remain an OpenCode-visible alias, but the Cursor `AgentService/Run` request should not send `ModelDetails.modelId = "auto"`. For `auto`, the proxy should omit explicit `modelDetails` so Cursor can resolve the default/automatic model path.

## Changes

- `src/proxy.ts`
  - Changed `buildCursorRequest()` so `modelDetails` is omitted when `modelId === "auto"`.
  - Explicit model IDs still populate `ModelDetails` exactly as before.

- `test/smoke.ts`
  - Added fake Cursor backend observation of `/agent.v1.AgentService/Run` Connect frames.
  - Added a smoke test proving:
    - `model: "auto"` omits `modelDetails`.
    - `model: "composer-2"` still forwards `modelDetails.modelId = "composer-2"`.

## Verification

- LSP diagnostics:
  - `src/proxy.ts`: no diagnostics
  - `test/smoke.ts`: no diagnostics
- `bun test/smoke.ts`: passed
- `bun run build`: passed (`tsc -p tsconfig.json && node scripts/copy-runtime.mjs`)

## Operational note

Running OpenCode sessions may need restart/reload to pick up rebuilt `dist/` output and the active provider/plugin behavior.
