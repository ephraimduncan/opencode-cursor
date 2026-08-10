# Cursor Model Hang — Root Cause Analysis

Status: **Evidence baseline established; lifecycle and termination map complete.** This
document opens the hang investigation: it preserves the speculative uncommitted overlay that
predated this investigation, classifies every hunk with an explicit disposition, records
baseline-vs-overlay behavior, and then (Part 2) enumerates every open-SSE path and termination
route with source-linked matrices. No behavioral fix is implemented here; the matrices exist
so the termination-contract work lands directly against a complete map.

## Grounding fact: nothing upstream rescues a stuck request

OpenCode configures the OpenAI-compatible provider with **no timeout of any kind** — no
header timeout, no chunk timeout, no overall request timeout (`timeout: false` is forced
into the fetch; `headerTimeout` is not set for this provider class). Consequences:

- A request that stalls before response headers is a true hang — no error is ever surfaced.
- A streaming SSE response that never terminates is a true hang — OpenCode accepts a
  truncated body as `other` and keeps waiting.
- The plugin proxy owns the entire hang-bounding and termination contract. Any hunk that
  merely lengthens a bound or resets on activity without establishing a terminal guarantee
  does not fix a hang; it postpones the failure.

## Overlay provenance

Before this investigation began, the working tree carried **uncommitted, untested**
speculative edits authored outside any controlled process:

- `src/proxy.ts` — +81/-13 (timeout bumps in `src/h2-bridge.mjs` were expected to interact;
  proxy-side watchdog added)
- `src/h2-bridge.mjs` — +14/-6 (timeout bumps, defensive guards, stderr passthrough)

The complete, verbatim pre-disposition diff is preserved in
[`docs/overlay-baseline.patch`](./overlay-baseline.patch). Every line removed below remains
recoverable and reviewable from that artifact. Nothing was silently discarded.

> **Whitespace exemption (read before "tidying"):** `docs/overlay-baseline.patch` is excluded
> from git's whitespace checks via `.gitattributes` (`-whitespace`). A unified diff encodes a
> blank source line as a context line containing a single space, so `git diff --check` flags
> the file by design. Never reflow, reformat, or strip trailing whitespace from this artifact —
> doing so corrupts the evidence and breaks `git apply` fidelity.

## Hunk inventory and disposition

| # | File | Location | Change | Apparent intent | Hang mechanism affected | Verdict |
|---|---|---|---|---|---|---|
| H2-1 | `src/h2-bridge.mjs` | initial `setTimeout` | 30s → 60s + "peak load" comment | Give a slow server more time to accept the connection | None identified. Only postpones the error surfaced when the initial connect stalls; a stalled connect still hangs for 60s instead of 30s before the bridge self-terminates. | **Drop** (restore 30s) |
| H2-2 | `src/h2-bridge.mjs` | `resetTimeout` | 120s → 180s + "Grok 4.5" comment | Avoid killing a slow model during long thinking/tool pauses | None effective. This idle timer resets on **every** H2 data frame **and** every stdin write — the proxy writes a `ClientHeartbeat` every 5s, so heartbeat traffic defeats it indefinitely. It can never bound the leading unhandled-message-trickle hang. | **Drop** (restore 120s) |
| H2-3 | `src/h2-bridge.mjs` | `killBridge` | `client.destroy()` → `try { client.destroy(); } catch {}` | Defensive: a throw must not mask the `process.exit(1)` | None (defensive only). Harmless and correct; keeps the terminal exit unconditional. | **Keep** |
| H2-4 | `src/h2-bridge.mjs` | `client.on("error")` | `() =>` → `(err)` + write `err.message` to stderr | Surface silently-swallowed client errors to the parent | None directly (exit behavior unchanged), but it is **load-bearing for diagnosis**: with `stderr: "ignore"` these errors were invisible. Emission must become environment-gated, structured, and redacted. | **Keep, then rework** (redaction/diagnostics pass) |
| H2-5 | `src/h2-bridge.mjs` | `h2Stream.on("error")` | `() =>` → `(err)` + stderr write + `try { client.close(); } catch {}` | Surface stream errors; guard the close against throws | None directly (exit behavior unchanged); the guarded close is a correct defensive improvement. | **Keep** (guarded close) / **Keep, then rework** (stderr emission) |
| P-1 | `src/proxy.ts` | `spawnBridge` | `stderr: "ignore"` → `stderr: "pipe"` + continuous parent drain loop | Stop swallowing bridge errors; keep the child unblocked | **Load-bearing for backpressure**: a child writing to an undrained stderr pipe can block on the pipe and stall the whole request. The drain makes the pipe safe. Emission is unredacted today; must become gated/structured/redacted. | **Keep, then rework** |
| P-2 | `src/proxy.ts` | `Bun.serve` `idleTimeout` comment | Comment-only edit ("Grok 4.5" wording) | Cosmetic | None. | **Drop** (restore original comment) |
| P-3 | `src/proxy.ts` | `createBridgeStreamResponse` | 90s raw-byte watchdog (`setInterval` poll, `lastDataTime`, wrapped `processChunk` resetting on **any** inbound data) + timeout error/stop/done sequence | Force-close SSE after 90s without data; catch silent H2 close, silent disconnect, model stall | **Defeated by its own input.** It resets on any inbound byte, so server heartbeat/checkpoint/query trickle keeps a stalled request alive indefinitely. It can also kill a *legitimately slow* model that thinks silently for >90s (the exact Grok 4.5 behavior the overlay author worried about). Raw-byte activity must never defer termination forever, and slow-but-progressing traffic must never be terminated — this watchdog fails both sides of the requirement. | **Drop** (replaced by a semantic-progress/transport-liveness detector in the hardening pass) |
| P-4 | `src/proxy.ts` | `bridge.onClose` | `clearInterval(watchdog)` added | Cleanup for P-3 | None once P-3 is gone. | **Drop** (remove with P-3) |
| P-5 | `src/proxy.ts` | `bridge.onClose` | Restructure `} else if (code !== 0) {` into `} else { if (code !== 0) {...} }` + extended comments | Claim the `code === 0 && mcpExecReceived` case must keep the bridge alive for resume | **Behaviorally identical to baseline**: both forms error-close only when `mcpExecReceived && code !== 0`; both do nothing when `code === 0`. The new comments document pre-existing behavior, not a fix. Non-zero bridge-close handling must be reworked into one idempotent explicit-error terminal path (race-safe across frame/stream/process/timeout closes) — that belongs to the hardening pass, **not here**. | **Rework — deferred** (restore baseline shape now; reference below) |

Net disposition: **4 hunks kept** (H2-3, H2-4, H2-5 guarded close, P-1), **5 hunks dropped or
restored** (H2-1, H2-2, P-2, P-3, P-4), **1 hunk deferred** (P-5). The kept hunks are exactly
the ones that are load-bearing or harmless: stderr draining (backpressure safety), defensive
close guards, and error passthrough (diagnosis). The dropped hunks are exactly the ones that
either lengthen a hang without fixing it or make termination decisions from raw bytes.

## Clean-baseline vs overlay behavior

Both trees (overlay and clean baseline) satisfy the repository verification:

| Check | With overlay | Clean baseline |
|---|---|---|
| `git diff --check` | pass | pass |
| `npx tsc -p tsconfig.json --noEmit` | pass (no errors) | pass (no errors) |
| `bun test/smoke.ts` | 7/7 pass | 7/7 pass |

> `bun test/smoke.ts` writes conversation cache data under `~/.cache/opencode-cursor` as a
> side effect. The suite exercises the plugin against a local fake Connect/HTTP2 backend; it
> does not contact Cursor.

Behavioral difference (code-level, from the stream-termination enumeration):

- **Baseline (HEAD):** no proxy-side watchdog. Open-SSE hangs are bounded only by the bridge
  idle timer (120s), which heartbeat traffic defeats. A silent-stall can hang until OpenCode
  gives up (never, for this provider) or the OS/network intervenes.
- **Overlay:** adds a 90s proxy watchdog that fires only after 90s with no inbound bytes, and
  raises the bridge idle to 180s. For the leading hang candidates — unhandled server message
  families (heartbeat/checkpoint/query trickle), missing end-stream, silent parse failures —
  the watchdog **still never fires** because any trickle resets it, and it **can** kill a slow
  model during a >90s silent thinking window. Net: it converted one unbounded hang class into
  two unchanged classes plus a new false-termination risk.
- **After disposition (current tree):** identical to baseline plus the kept overlay hunks
  (stderr pipe + drain, guarded destroys/closes, error passthrough). Termination behavior is
  exactly baseline; observability is strictly better.

## Known hang mechanisms (for reference)

Analysis prior to this document identified these confirmed code-level defects, ordered by
likelihood of causing the reported hang (full detail in the workflow research notes):

1. **Unbounded token refresh** — `refreshCursorToken` fetches the exchange endpoint with no
   abort signal inside the pre-header request path; a stalled exchange means `Bun.serve`
   never returns headers.
2. **Silent truncation reported as success** — bridge crash / H2 close without a Connect
   end-stream can emit a clean `finish_reason: "stop"`, which in a tool loop drives OpenCode
   retries (busy-loop).
3. **Empty end-stream misclassified as error** — `parseConnectEndStream` runs `JSON.parse`
   on a zero-byte body, so valid clean completions surface as visible errors.
4. **Heartbeat-defeated idle timer** — the bridge idle timer resets on every stdin write and
   H2 data frame; the proxy's 5s client heartbeat keeps it from ever firing.
5. **No bound in the non-streaming path** — `collectFullResponse` awaits bridge close with no
   timeout, so a dead-silent bridge hangs it indefinitely.

The dropped overlay hunks address **none** of these; the kept hunks improve observability of
1–5 without altering their behavior. Fixes land in later passes with harness evidence.

## Deferred work references

- **Non-zero bridge-close terminal path (was P-5):** rework `bridge.onClose` so bridge exit
  and HTTP/2 session/stream closure without a Connect end-stream always reach one idempotent
  explicit-error terminal sequence, never a clean `stop`, and never a duplicate terminal —
  while preserving the valid `mcpExecReceived` tool-call pause (SSE already closed by the
  tool-call frame; bridge retained for resume). Implemented in the hardening pass.
- **Semantic-progress stall detector (replaces P-3):** termination must be driven by the
  absence of *semantic* progress (output deltas, tool transitions, terminal frames) and by
   transport-liveness signals (HTTP/2 PING, session/stream lifecycle), never by raw-byte
   elapsed time. Implemented in the hardening pass.

## Safe lifecycle diagnostics

Set `CURSOR_PROXY_DIAGNOSTICS=1` to emit one-line JSON lifecycle records to stderr. The default
is disabled. Every record contains a per-request `requestId` and monotonic `elapsedMs`; bridge
records carry the same ID and include the parent elapsed time at spawn for cross-process ordering.

The stage inventory is: `auth_access_start`, `auth_access_complete`, refresh start/complete/fail,
`proxy_entry`, `bridge_spawn`, `bridge_start`, `h2_connect`, `connect_stream`, first
`bridge_data`, first `connect_frame`, `end_stream`, `message_dispatch`, `tool_pause`,
`tool_resume`, first `sse_emission`, and `terminal`. Conditional tool stages appear only for
tool-call requests. Bridge timeout kills are distinguishable: `terminal` with
`errorName: "Timeout:connect"` (initial 30s connect bound) or `"Timeout:idle"` (120s activity
bound) versus `errorName` from a client/stream error and `exitCode` from normal exit. See
Part 2 §2.8 for the instrumentation added in this pass.

Diagnostics use a strict allowlist: source, stage, request ID, elapsed time, byte length, message
case, interaction case, tool count, status/exit code, and error class. They never serialize auth
tokens or headers, cookies, prompt/message text, tool arguments/results, or blob/checkpoint IDs.
The parent always drains child stderr even while diagnostics are disabled, preventing pipe
backpressure from stalling the bridge.

## Evidence sources

- Field notes: unhandled server-message families / raw-byte timer resets (leading hang
  hypothesis); every stream-termination path; timers/watchdogs and reset semantics;
  error-swallowing inventory; root-cause synthesis of the five defects; no-timeout provider
  semantics; bridge keying/liveness risks.
- Source locations: `src/proxy.ts` `createBridgeStreamResponse` / `parseConnectEndStream` /
  `collectFullResponse` / `spawnBridge`; `src/h2-bridge.mjs` timer and error handlers;
  `src/auth.ts` `refreshCursorToken`.
- Upstream: opencode-cursor issue #33 (busy loop after H2 socket close); opencode issues on
  provider timeout behavior; hardened-provider prior art (PING keepalive, stall budgets).

---

# Part 2 — Lifecycle and termination evidence map

This part enumerates every path that can leave an OpenCode SSE stream open, classified from
direct source reading of `src/proxy.ts`, `src/h2-bridge.mjs`, `src/native-tools.ts`, and the
generated `src/proto/agent_pb.ts`. It is the specification input for the termination-contract
work (which must make every request reach exactly one terminal outcome) and for the
controllable Connect/HTTP2 harness (which must exercise each row below that is marked as
needing runtime evidence). **No behavioral change is made here** — the only edits in this pass
are the diagnostic additions in §2.8.

## Classification legend

Every row carries one of:

| Class | Meaning |
|---|---|
| **terminates cleanly** | The path provably closes the SSE with `[DONE]` and no error content. |
| **terminates with error** | The path provably closes the SSE with an explicit error/stop sequence. |
| **HANGS** | The path can leave the request pending indefinitely, or bounded only by OS-level truncation. |
| **unknown-needs-runtime-evidence** | Source reading fixes the *mechanism*, but the trigger depends on server or runtime behavior that the controllable fixture must confirm. |

Classification basis is noted per row: **source-proven** (directly verifiable in the code
above) versus **runtime** (the code path is fixed, but the server-side sequence that activates
it is not yet captured).

## 2.1 Lifecycle matrix — streaming request, entry to completion

Each stage cites where it is reached in `src/proxy.ts` unless noted.

| # | Stage | Where | What happens | Outcome on stall here |
|---|---|---|---|---|
| L1 | Request entry | `Bun.serve` fetch, `proxy.ts:522-537` | URL parsed, method/path routed | 404 for unknown path |
| L2 | Diagnostic context + `proxy_entry` | `proxy.ts:536-538` | per-request correlation ID starts | n/a |
| L3 | Body parse | `proxy.ts:539` | `req.json()` → `ChatCompletionRequest` | 500 via outer catch (`proxy.ts:547-556`) |
| L4 | `auth_access_start` → token provider → `auth_access_complete` | `proxy.ts:543-545` | `proxyAccessTokenProvider()` awaited; the provider calls `resolveDiskAccessToken` (`src/index.ts:77-92`) which may call `refreshCursorToken` (`src/auth.ts:143-177`) | **HANGS pre-header** if the refresh fetch stalls — `refreshCursorToken` has no timeout (§2.7 M4); no Response is ever returned |
| L5 | Message parse / key derivation | `proxy.ts:590-609` | `parseMessages`, `deriveBridgeKey`/`deriveConversationKey` | 400 for no user message (`proxy.ts:594-604`) |
| L6 | Bridge reuse check | `proxy.ts:610-624` | live tool-resume, dead-bridge cleanup, or fresh request | see §2.6 |
| L7 | Conversation state load/persist | `proxy.ts:633-646` | memory map, disk-cache fallback, TTL eviction | n/a |
| L8 | Request build | `proxy.ts:650-655` | `buildCursorRequest` → protobuf `AgentClientMessage` | n/a |
| L9 | `handleStreamingResponse` → `startBridge` | `proxy.ts:1635-1648` → `1621-1633` | `spawnBridge` (`proxy.ts:306-430`), writes config + initial Connect frame, arms 5s heartbeat interval (`proxy.ts:1631`) | child boot failure → `bridge.onClose` (see T4/T5) |
| L10 | Bridge boot | `h2-bridge.mjs:82-107` | config read, `http2.connect` (`109`), 30s connect timer armed (`115`) | timeout kill → exit 1 (§2.3 T-T1) |
| L11 | H2 connect + stream open | `h2-bridge.mjs:109-148` | `connect` → `h2_connect` (`110`), `client.request` → `connect_stream` (`147-148`) | connect error → `terminal` + exit 1 (`130-134`) |
| L12 | SSE response start | `proxy.ts:1409-1423` | `createBridgeStreamResponse` returns `new Response(stream, SSE_HEADERS)` (`1613`) | headers sent; OpenCode now waits for body |
| L13 | First H2 data | `h2-bridge.mjs:151-155` | `bridge_data` + `resetTimeout` + forward to stdout | — |
| L14 | Connect frame parse | `proxy.ts:1475-1490` | `createConnectFrameParser` (`976-996`) → `connect_frame` → `fromBinary` | silent skip on parse failure (§2.5 F2) |
| L15 | Message dispatch | `proxy.ts:1483-1553` | `processServerMessage` (`1068-1102`) → per-case handling (§2.4) | ignored cases produce no SSE output (§2.4) |
| L16 | Text/thinking emission | `proxy.ts:1490-1498` | `onText` → `sendSSE` → `sse_emission` (`1426-1430`) | — |
| L17 | KV round-trip | `proxy.ts:1142-1173` | `getBlob`/`setBlob` → `sendFrame` → `bridge.write` | unhandled KV case → server waits (see M-row KV) |
| L18 | Checkpoint update | `proxy.ts:1536-1546` | `conversationCheckpointUpdate` → persist blob/checkpoint | n/a |
| L19 | Tool pause | `proxy.ts:1499-1535` | `mcpExec` → `tool_pause` → `tool_calls` SSE → `[DONE]` + `closeController` (`1533-1534`); bridge retained in `activeBridges` (`1523-1530`) | SSE closes; bridge leaks if never resumed (§2.2 T8) |
| L20 | Connect end-stream | `proxy.ts:1558-1580` | `end_stream` diagnostic; clean end-stream is a no-op (`1567`), error end-stream emits error + stop + usage + `[DONE]` + close + cleanup (`1568-1579`) | clean no-op relies on the bridge-exit cascade (§2.2 T1) |
| L21 | Bridge close | `proxy.ts:1585-1613` | `onClose(code)` → conversation persist → clean or error terminal (§2.2 T4/T5) | — |
| L22 | SSE close | `proxy.ts:1435-1440` | `closeController` → `terminal` + `controller.close()` | — |

**Non-streaming variant:** `handleNonStreamingResponse` (`proxy.ts:1730-1757`) awaits
`collectFullResponse` (`1768-1842`), which resolves **only** on `bridge.onClose` (`1823-1840`).
Its Connect end-stream handler is a no-op `() => {}` (`1820`). A silent bridge therefore hangs
the whole request pre-header (§2.2 T10).

## 2.2 Terminal matrix — every way a stream can end

| # | Trigger | Source route | Outcome | Classification |
|---|---|---|---|---|
| T1 | Connect end-stream with no `error` (clean, e.g. `{}`) | `parseConnectEndStream` → `null` (`proxy.ts:947-956`); handler `if (endError)` no-op (`1567`) | SSE closes only through the bridge-exit cascade T4. If the server ends the H2 stream, fine; if the server sends the envelope but keeps the stream open, nothing terminates. | **terminates cleanly via cascade / HANGS if stream not closed** — source-proven no-op; server behavior runtime |
| T2 | Connect end-stream with `error` JSON | `parseConnectEndStream` → `Error` (`950-955`); error branch (`1567-1579`) | Error content chunk + `stop` + usage + `[DONE]` + close + `bridge.end()` + map/timer cleanup | **terminates with error** — source-proven |
| T3 | Empty-body end-stream (zero bytes) | `JSON.parse("")` throws (`948-949`) → false `Error` (`957-958`) | Same error branch as T2. Per Connect spec a zero-byte end-stream means success, so a valid clean completion surfaces as an error. | **terminates with error (false positive)** — source-proven |
| T4 | Bridge exit code 0 (H2 stream `end` → `client.close()` → `exit(0)` after 100ms flush) | `h2-bridge.mjs:160-166`; `onClose` `proxy.ts:1585-1593` | If no exec received: clean `stop` + usage + `[DONE]` + close (`1594-1601`). If exec received: no SSE action (bridge retained for resume). | **terminates cleanly** — source-proven |
| T5 | Bridge exit code ≠ 0 (connect timeout, idle timeout, client error, stream error) | `h2-bridge.mjs:115/120` (killBridge), `130-134` (client error), `168-174` (stream error); `onClose` `proxy.ts:1585-1593` | If no exec received: **clean** `stop` + usage + `[DONE]` (`1594-1601`) — non-zero exit reported as clean success. If exec received: error `stop` + `[DONE]` + stale-entry delete (`1602-1609`). The clean branch matches upstream issue #33's silent-truncation/busy-loop symptom. | **terminates with error masked as clean success** — source-proven |
| T6 | H2 GOAWAY / session `close` without stream `end` or `error` | no `client.on("close")` handler in `h2-bridge.mjs`; stream may emit `error` (→ T5) or nothing | If nothing: idle timer never fires because the proxy's 5s heartbeat resets it via stdin (`proxy.ts:1631` → `h2-bridge.mjs:194-196`). Streaming SSE bounded only by Bun's 255s connection idle (`proxy.ts:521`) → truncated `other` body. | **HANGS (bounded ~255s streaming) / unknown-needs-runtime-evidence** — missing session-close handler source-proven; Node event sequence on GOAWAY runtime |
| T7 | Client abort (OpenCode cancels the SSE response) | `ReadableStream` has no `cancel()` handler (`proxy.ts:1422-1611`); `sendSSE` has no error guard (`1426-1430`) | Bridge not torn down; heartbeat interval keeps running (`1631`); bridge/H2 session leak until server ends the stream or process stop. OpenCode already aborted, so not an OpenCode-side hang — but a bridge/process leak and stale `activeBridges` entry. | **client-side terminates; bridge leaks** — source-proven leak; Bun enqueue-after-cancel behavior runtime |
| T8 | Tool pause with no resume | `proxy.ts:1523-1535`; no TTL/eviction for `activeBridges` (only `stopProxy` clears, `578-582`) | SSE closes cleanly; bridge + heartbeat timer + H2 session retained forever if the client never sends tool results. | **SSE terminates cleanly; bridge leaks indefinitely** — source-proven |
| T9 | Partial/malformed Connect frame at stream end | parser buffers partial data and waits (`proxy.ts:980-995`); child exit discards the pending buffer silently (reader loop ends `402-405`) → T4/T5 | Any text in the partial frame is lost; still reported clean (code 0) or masked error (code ≠ 0). | **silent truncation** — source-proven drop; frequency runtime |
| T10 | Silent stall (server sends nothing, never closes) | no data → no `resetTimeout` from H2, but the proxy's own 5s heartbeat resets the idle timer via stdin every 5s (`proxy.ts:1631` → `h2-bridge.mjs:194-196`) | Streaming: bounded only by Bun's 255s connection idle (`proxy.ts:521`) → truncated `other`. Pre-header (auth refresh L4, or non-streaming collect L-NS) and heartbeat-trickle stalls: **no bound at all**. | **HANGS** — source-proven (see §2.3 T-T2/T-T4) |

## 2.3 Timer matrix

| # | Timer | Where | Armed by | Reset by | On fire | Cleared by | Defeated by heartbeat? |
|---|---|---|---|---|---|---|---|
| T-T1 | Bridge initial connect bound (30s) | `h2-bridge.mjs:115` | bridge boot | *not* reset (one-shot until first `resetTimeout`) | `killBridge` → destroy + `exit(1)` (`123-127`) | first data/stdin write (`155`/`194-196`), stream `end`/`error`, client error | No — one-shot. Bounds a stalled connect, then surfaces as masked clean success (T5) |
| T-T2 | Bridge activity/idle bound (120s) | `h2-bridge.mjs:117-120` | first `resetTimeout` | **any** H2 data (`154-155`) and **any** stdin write (`194-196`) | `killBridge` → destroy + `exit(1)` | stream `end`/`error`, client error | **Yes — defeated indefinitely.** Proxy writes a ClientHeartbeat every 5s (`proxy.ts:1631`); server heartbeats also reset it. Effectively never fires while the proxy lives |
| T-T3 | Proxy client heartbeat interval (5s) | `proxy.ts:1631` | `startBridge` | n/a | writes a Connect `ClientHeartbeat` frame to the bridge | `bridge.onClose`, end-stream error branch, `stopProxy` | This is the *cause* of T-T2's defeat, not a termination bound |
| T-T4 | Bun.serve connection idle (255s max) | `proxy.ts:521` | server start | bytes flowing **on the SSE connection** | closes the HTTP connection → truncated SSE body (`other` error in OpenCode) | SSE writes | Not "defeated" but irrelevant to heartbeat trickle: ignored messages produce no SSE bytes, so the connection stays idle and this is the *only* streaming-stall bound |
| T-T5 | Unary RPC timeout (default 5s) | `proxy.ts:456-462` | `callCursorUnaryRpc` | n/a | kills the bridge proc; resolves with `timedOut: true` | bridge `onClose` | Not in the streaming path; discovery only |
| T-T6 | Conversation memory TTL (30min) | `proxy.ts:179` | conversation store | `lastAccessMs` updates | evicts `conversationStates` entry | n/a | Unrelated to request termination |
| T-T7 | Conversation disk TTL (7d) | `proxy.ts:183` | disk snapshot | — | prunes stale files at proxy start (`517`) | n/a | Unrelated |
| T-T8 | Non-streaming collect bound | **none** — `collectFullResponse` awaits `bridge.onClose` (`proxy.ts:1823-1840`) with no timeout and a no-op end-stream handler (`1820`) | — | — | — | — | Its only possible bound is T-T2, which is defeated. Pre-header HANG |
| T-T9 | Proxy-side stall watchdog | **none in baseline** — the 90s raw-byte watchdog (overlay P-3) was dropped (Part 1) | — | — | — | — | n/a |

## 2.4 Message matrix

Cases read from the generated `src/proto/agent_pb.ts`. "Ignored" means the message is decoded
successfully and then no branch matches — no SSE output, no response frame, no terminal.

### AgentServerMessage — 6 cases (`agent_pb.ts:3666-3709`), dispatch in `proxy.ts:1079-1101`

| Case | proto field | Disposition | Consequence of ignoring (where applicable) |
|---|---|---|---|
| `interactionUpdate` | 1 | **handled** → `handleInteractionUpdate` (`proxy.ts:1081-1082`) | — |
| `execServerMessage` | 2 | **handled** → `handleExecMessage` (`proxy.ts:1085-1092`, `1175-1353`) | — |
| `execServerControlMessage` | 5 | **ignored** — no branch in `processServerMessage`. Carries `abort` (`agent_pb.ts:3567-3574`) | A server-side abort signal is dropped. If the server aborts its turn and then waits for the client to acknowledge/close, the stream never terminates. Whether Cursor sends this in the failing models is runtime. |
| `conversationCheckpointUpdate` | 3 | **handled** (`proxy.ts:1093-1101`): token details + checkpoint persist | — |
| `kvServerMessage` | 4 | **handled** → `handleKvMessage` (`proxy.ts:1142-1173`) for `getBlobArgs`/`setBlobArgs` only | Other KV cases fall through silently; if the server blocks on an unanswered KV request the stream stalls. Cursor uses only the two blob cases today — runtime to confirm none others occur. |
| `interactionQuery` | 7 | **ignored** — no branch. Carries web-search/ask-question/switch-mode/exa/plan/VM queries (`agent_pb.ts:3300-3350`) | The proxy never answers with `interactionResponse` (the client-side schema case exists at `agent_pb.ts:3629-3635`). If the server waits for an interaction response, the request HANGS; if it proceeds, the feature is silently broken. Runtime to confirm whether these fire in the failing models. |

### InteractionUpdate — 17 cases (`agent_pb.ts:3157-3277`), dispatch in `proxy.ts:1104-1123`

| Case | proto field | Disposition | Consequence of ignoring |
|---|---|---|---|
| `textDelta` | 1 | **handled** → content SSE (`proxy.ts:1111-1113`) | — |
| `partialToolCall` | 7 | ignored — by comment policy (`1120-1122`); tool calls flow through exec messages | Safe while Cursor uses exec-based tools; if any model emits interaction tool calls instead, the call is never surfaced and output can stall. Runtime. |
| `toolCallDelta` | 15 | ignored (same policy) | same as above |
| `toolCallStarted` | 2 | ignored (same policy) | same as above |
| `toolCallCompleted` | 3 | ignored (same policy) | same as above |
| `thinkingDelta` | 4 | **handled** → reasoning SSE (`proxy.ts:1114-1116`) | — |
| `thinkingCompleted` | 5 | ignored | minor; no semantic output |
| `userMessageAppended` | 6 | ignored | Model-side transcript append (e.g. ask-question flows) is dropped; if the server waits on a relayed user response the stream can stall. Runtime. |
| `tokenDelta` | 8 | **handled** → usage (`proxy.ts:1117-1119`) | — |
| `summary` | 9 | ignored | long-context compaction text is dropped from the transcript; not a hang by itself |
| `summaryStarted` | 10 | ignored | minor |
| `summaryCompleted` | 11 | ignored | minor |
| `shellOutputDelta` | 12 | ignored | background-shell stream output not relayed; proxy rejects `backgroundShellSpawnArgs` (`proxy.ts:1301-1316`) so likely unused. Runtime. |
| `heartbeat` | 13 | ignored — but its transport arrival resets the bridge idle timer via `h2Stream.on("data")` (`h2-bridge.mjs:154-155`) | **The trickle hazard**: server heartbeats keep the only bridge-side bound (T-T2) from firing while producing zero semantic progress. |
| `turnEnded` | 14 | **ignored** | If the server signals turn completion here and does not immediately end the H2 stream, the proxy never terminates — a leading hang candidate. Whether Cursor sends `turnEnded` and whether it precedes stream end is runtime; the silent drop is source-proven. |
| `stepStarted` | 16 | ignored | minor |
| `stepCompleted` | 17 | ignored | minor |

Summary: **3 of 17** `InteractionUpdate` cases produce output (`textDelta`, `thinkingDelta`,
`tokenDelta`); **4 of 6** `AgentServerMessage` cases are dispatched. All other cases are
silently discarded while any of them — even `heartbeat` — resets the bridge idle timer.

### ExecServerMessage handling (`proxy.ts:1175-1353`, cases at `agent_pb.ts:6882-7002`)

Every known exec case is answered: `requestContextArgs` builds context; `mcpArgs` pauses for a
tool result; native args (`readArgs`, `lsArgs`, `grepArgs`, `writeArgs`, `deleteArgs`,
`shellArgs`/`shellStreamArgs`, `backgroundShellSpawnArgs`, `writeShellStdinArgs`, `fetchArgs`,
`diagnosticsArgs`) are redirected or rejected; `listMcpResourcesExecArgs`,
`readMcpResourceExecArgs`, `recordScreenArgs`, `computerUseArgs` get an empty `McpResult`
(`proxy.ts:1339-1349`). **Unknown exec cases** log `[proxy] unhandled exec` and send nothing
(`1351-1353`) — the server waits on an unanswered exec → stall risk. Runtime to confirm any
newer exec case reaches the wire.

## 2.5 Parse/write failure matrix

| # | Failure | Where | What actually happens | Classification |
|---|---|---|---|---|
| F1 | Partial Connect frame at stream end | `proxy.ts:980-995` buffers; reader loop exits at `402-405` | pending bytes discarded silently; cascade to T4/T5 | **silent truncation** — source-proven |
| F2 | `fromBinary` protobuf parse failure | `proxy.ts:1554-1556` catch → skip; also `1812-1814` | frame silently dropped, stream stays open; if the dropped frame was terminal → HANG | **HANGS (potential)** — source-proven silent drop |
| F3 | End-stream body not valid JSON / empty | `proxy.ts:947-960` | false `Error` → T3 error terminal | **terminates with error (false positive)** — source-proven |
| F4 | Unknown message case decodes fine | `proxy.ts:1079-1101` falls through | silently ignored (§2.4) | **HANGS (potential)** — source-proven |
| F5 | `bridge.write` to a dead/exiting child | `proxy.ts:411-413` try/catch | throw swallowed; frame lost silently → resumed stream may wait forever | **HANGS (potential)** — source-proven |
| F6 | Write to closed/destroyed H2 stream | `h2-bridge.mjs:194-196` guard skip | frame dropped silently; process stays alive so the parent believes the bridge is healthy | **HANGS (potential)** — source-proven |
| F7 | SSE enqueue on a cancelled/errored stream | `proxy.ts:1426-1430` no guard; no `cancel()` handler | after client abort the bridge is never torn down (§2.2 T7) | **leak** — source-proven; Bun enqueue-after-cancel behavior runtime |
| F8 | Child stdout pipe write backpressure | `h2-bridge.mjs:27-32` | `process.stdout.write` without drain handling; parent drains continuously (`proxy.ts:334-369`), so risk is low | **low risk** — source-proven |

## 2.6 Resume matrix

Bridge retention starts at tool pause (`proxy.ts:1523-1530`); lookup and eligibility at
`proxy.ts:610-624`; actual resume at `handleToolResultResume` (`proxy.ts:1651-1732`).

| # | Scenario | Route | Outcome | Classification |
|---|---|---|---|---|
| R1 | Live healthy resume | `activeBridges.get` → `alive` true → `handleToolResultResume` (`proxy.ts:615-617`) | mcpResult/native frames sent per `pendingExec` (`1661-1721`); a new `createBridgeStreamResponse` streams the rest (`1723-1727`) | **terminates cleanly when transport healthy** — source-proven |
| R2 | Process-alive but transport-dead bridge resume | eligibility checks only `alive` = process existence (`proxy.ts:410`, `615`) | writes silently dropped at F6 (`h2-bridge.mjs:194-196`) → resumed SSE never receives data → HANG (bounded ~255s streaming truncation) | **HANGS (risk)** — liveness gap source-proven; frequency runtime |
| R3 | Dead-bridge resume (process exited) | `alive` false → cleanup + `bridge.end()` + fresh request (`proxy.ts:619-624`) with `resumeAction` over reconstructed history (`909-911`) | context preserved; fresh bridge path | **terminates via fresh path** — source-proven |
| R4 | Bridge-key collision | `deriveBridgeKey` = sha256(model + first 200 chars of first user message) (`proxy.ts:1374-1381`) | two conversations with the same model+opening map to one `activeBridges` slot; the second pause overwrites the first entry without ending the first bridge (`1523-1530`) and `pendingExecs` are shared | **collision risk** — keying source-proven; consequences runtime |
| R5 | Dropped write during resume (child mid-exit race) | F5/F6 | result frame lost silently → resumed stream never progresses | **HANGS (risk)** — source-proven |
| R6 | Pause with no resume (abandoned tool call) | no TTL on `activeBridges`; only `stopProxy` clears (`578-582`) | bridge + heartbeat + H2 session leak indefinitely (§2.2 T8) | **leak** — source-proven |

## 2.7 Verdicts on the five known mechanisms

Status is against direct source reading in this part.

1. **`parseConnectEndStream` clean no-op + empty-body false error — CONFIRMED (source).**
   `proxy.ts:947-960` returns `null` for JSON without `error`; the caller is `if (endError)`
   (`proxy.ts:1567`) so a clean end-stream is a no-op and termination depends entirely on the
   bridge-exit cascade (T4). A zero-byte body makes `JSON.parse` throw → false error (T3).
2. **Unhandled message families + raw-byte timer resets — CONFIRMED (source).** 4 of 6
   `AgentServerMessage` and 3 of 17 `InteractionUpdate` cases are dispatched (§2.4);
   `turnEnded` and `heartbeat` are dropped, and **any** inbound byte plus the proxy's own 5s
   heartbeat defeats the only bridge-side idle bound (T-T2). The *hang outcome* of dropped
   `turnEnded`/`interactionQuery` depends on whether the server waits (runtime), but the
   silent drops themselves are source-proven.
3. **Non-zero bridge exit reported as clean success — CONFIRMED (source).**
   `proxy.ts:1594-1601` emits `finish_reason: "stop"` + `[DONE]` for `code !== 0` whenever no
   exec was received; matches upstream issue #33.
4. **Unbounded token refresh — CONFIRMED (source).** `refreshCursorToken`
   (`auth.ts:143-177`) fetches with no `AbortSignal`/timeout and is awaited before headers in
   the streaming path (`proxy.ts:543-545`) and in `collectFullResponse`'s caller — a stalled
   exchange is a pre-header hang.
5. **Bridge reuse checks only process aliveness — CONFIRMED (source).** Eligibility is
   `activeBridge.bridge.alive` (`proxy.ts:615`), which is `!exited` (`proxy.ts:410`); a live
   child with a dead H2 session/stream accepts resume and silently drops writes
   (`h2-bridge.mjs:194-196`). The failure *frequency* needs runtime evidence, but the
   liveness gap itself is source-proven.

**Mechanisms that still require runtime evidence from the controllable fixture:**
whether Cursor sends `turnEnded` (and whether it precedes stream end), `execServerControlMessage
abort`, or `interactionQuery` cases in the failing models; the server's behavior after a clean
end-stream envelope (does the H2 stream always end?); Node's event sequence on GOAWAY/session
close (T6); and Bun's SSE enqueue behavior after client abort (T7).

## 2.8 Instrumentation gaps closed in this pass

Only two diagnostics-only edits were made while mapping; both are gated, allowlisted, and
change no termination or protocol behavior:

1. **`end_stream` stage** (`src/proxy.ts:1560-1564`, stage/field plumbing in
   `src/auth.ts:24,30,66`). Previously the Connect end-stream event was invisible: a clean
   end-stream produced no diagnostic and an empty/failed one was only visible through the
   resulting error terminal. The new event carries `byteLength` and `status: "clean"|"error"`
   only — no payload — so an operator can now distinguish "end-stream received cleanly but
   stream still open" (no `terminal` after it) from "no end-stream at all".
2. **Bridge timeout-kill cause** (`src/h2-bridge.mjs:115-127`). Timeout kills previously
   exited with **no** bridge-side diagnostic, so a 30s connect timeout, a 120s idle timeout,
   a client error, and a stream error were indistinguishable in the proxy's `terminal`
   record. `killBridge` now emits `terminal` with `errorName: "Timeout:connect"` or
   `"Timeout:idle"` plus `exitCode: 1`.

## 2.9 Diagnostic capture instructions

**Enable:** set `CURSOR_PROXY_DIAGNOSTICS=1` in the environment of the OpenCode process (the
flag is read at `src/auth.ts:33-35`). Diagnostics are off by default; the child stderr pipe is
always drained regardless of the flag so disabling cannot reintroduce backpressure.

**Reproduce a hang:** with the flag set, start OpenCode with a Cursor model, send a request
that exhibits the symptom, and wait past the stall. Capture the process stderr to a file:
`opencode 2>cursor-diag.log`.

**Correlation:** every line for one request shares the same `requestId`. Bridge lines carry
`parentElapsedMs` (the proxy-side elapsed time at spawn) alongside their own `elapsedMs`, so
proxy and child records can be ordered across the process boundary.

**Read the output to identify the stalled stage:**

| Last stage(s) observed | Interpretation |
|---|---|
| `auth_access_start` … no `auth_access_complete` | stalled in the token provider / `refreshCursorToken` — pre-header hang (M4) |
| `bridge_spawn` … no `bridge_start` | child failed to boot or read config |
| `bridge_start` … no `h2_connect` | stalled connecting to `api2.cursor.sh`; expect `terminal exitCode 1` after 30s (`errorName: "Timeout:connect"`), then the masked-clean T5 path |
| `h2_connect` + `connect_stream` … no `bridge_data` | server accepted the stream but sends nothing — **the silent-stall signature** (T10); heartbeats keep the bridge timer defeated, so only Bun's 255s idle (streaming) or nothing (pre-header) bounds it |
| repeated `bridge_data` … no `connect_frame`/`message_dispatch` | bytes flow but no valid Connect frame parses (F1/F2) |
| repeated `message_dispatch` with `interactionCase: "heartbeat"`/`"turnEnded"`/`"stepCompleted"` and no `textDelta` | ignored-message trickle — semantic progress absent while timers keep resetting (§2.4 heartbeat/turnEnded rows) |
| `tool_pause` … no `tool_resume` | tool-call pause awaiting results (T8) |
| `end_stream` with `status: "clean"` … no `terminal` afterwards | clean end-stream was a no-op and the stream is being kept open (T1) — check whether the bridge ever exits |
| `terminal` with `exitCode: 1` (or `errorName: "Timeout:idle"`) followed by a clean `sse_emission` + `terminal` | masked non-zero bridge failure reported as clean success (T5) |
| `terminal` with `exitCode: 0` after `end_stream` | the normal clean cascade (T1→T4) |

**Emitted-only-allowlist reminder:** stages, request ID, elapsed time, byte lengths, message
case names, tool counts, status/exit codes, and error class names. Tokens, authorization
headers, prompt text, tool arguments/results, and blob/checkpoint IDs are never serialized
(`src/auth.ts:48-67`; parent drain filter `src/proxy.ts:344-365`).
