# Session: Fix Cursor blob not found

## Context
User reported OpenCode Cursor plugin chat requests failing with `Connect error internal: Blob not found: ...` after sending simple messages like `hi`. Re-authentication did not fix it.

## Findings
- `src/`, `dist/`, `test/`, `package.json`, and `tsconfig.json` initially had no source diff from origin.
- OAuth/auth was ruled out by deleting `~/.local/share/opencode/auth.json`, re-authenticating, and observing the same error.
- Background research found Cursor AgentService treats many `ConversationStateStructure` bytes fields as KV blob IDs, not inline payloads. Prior turn bytes need to be stored in the blob store and referenced by SHA-256 blob id.
- The error payload contained previous conversation text/turn payload bytes, matching a missing turn blob reference.

## Changes
- Updated `src/proxy.ts` `buildCursorRequest()` to add a local `putBlob()` helper.
- System prompt, prior user message bytes, assistant step bytes, and turn structure bytes are now stored in `blobStore` and referenced by blob IDs.
- `handleKvMessage()` now accepts an optional `onBlobSet` callback.
- Streaming and non-streaming paths persist `setBlobArgs` blobs immediately into stored conversation blob state to avoid checkpoint/blobStore skew.
- Ran `bun run build`, which updates `dist/`.

## Verification
- `lsp_diagnostics` on `src/proxy.ts`: no diagnostics.
- `bun run build`: passed.
- `bun test/smoke.ts`: still fails at pre-existing model discovery assertion (`Expected provider models to come from successful discovery`), after earlier proxy/auth/array-content tests pass. This appears separate from the chat `Blob not found` fix.

## Follow-up
- User should retry real chat after build. If a new error appears, inspect whether it is a remaining nested blob reference or a separate h2/model-discovery issue.
