# Cursor Model Hang — Root Cause Analysis

Status: **Evidence baseline established.** This document opens the hang investigation. It
preserves the speculative uncommitted overlay that predated this investigation, classifies
every hunk with an explicit disposition, and records baseline-vs-overlay behavior so that no
user work is silently discarded and no speculative change is silently accepted as "the fix."

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
`bridge_data`, first `connect_frame`, `message_dispatch`, `tool_pause`, `tool_resume`, first
`sse_emission`, and `terminal`. Conditional tool stages appear only for tool-call requests.

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
