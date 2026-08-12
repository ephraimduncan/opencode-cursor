# Grok 4.6 Research Provenance and Prior-Art Survey

Status: **Record of verified Grok 4.6 facts, explicit uncertainty, and prior-art verdicts.**
Evidence was gathered on 2026-08-12 by the workflow's researcher and scout (Field Notes below);
repository gates were re-verified by Wave 1 Task 1.1 at the inherited tip. This document satisfies
must-have **MH-1** and **MH-2**. The origin PR #34 cancellation verdict and client-abort lifecycle
evidence are recorded in [§8](#8-origin-pr-34-verdict-adapted-client-abort-lifecycle).

## 1. Verified Grok 4.6 facts

Each row records the value, the authoritative source, and the Field Note that verified it.

| Fact | Value | Source |
|---|---|---|
| xAI API model id | `grok-4.6` | https://docs.x.ai/developers/release-notes (August 2026 entry); https://docs.x.ai/developers/grok-4-6; `fn_20260812_vaamzb8z` |
| Cursor-facing surface | "Grok 4.6" with **256K default context**, capabilities **Agent + Thinking** | https://docs.cursor.com/models; `fn_20260812_vaamzb8z` |
| xAI direct-API context window | 500,000 tokens | https://docs.x.ai/developers/grok-4-6; `fn_20260812_vaamzb8z` |
| Input modalities | text and image | https://docs.x.ai/developers/grok-4-6; `fn_20260812_vaamzb8z` |
| Output modality | text only; **no stated output limit** | https://docs.x.ai/developers/grok-4-6; `fn_20260812_vaamzb8z` |
| Short-context pricing per 1M tokens | $2.00 input / $6.00 output (below 200k prompt tokens; $0.50 cached-read) | https://docs.x.ai/developers/grok-4-6; `fn_20260812_vaamzb8z`; `fn_20260812_o13isq9e` |
| Reasoning effort | low, medium, high (default), through **xhigh** | https://docs.x.ai/developers/grok-4-6; `fn_20260812_vaamzb8z` |

Additional verified context from the same sources: knowledge cutoff February 1, 2026; Responses API
and Chat Completions API; tools function calling, web search, X search, and code execution;
distribution includes the xAI API, Grok Build, Cursor (all plans), OpenRouter, Vercel, and
Cloudflare (`fn_20260812_vaamzb8z`).

**Metadata surfaces.** Cursor-facing values (256K default context, Agent + Thinking) come from
`docs.cursor.com/models` and describe what Cursor's Connect API serves. xAI direct-API values (500K
context, pricing, reasoning effort) come from `docs.x.ai`. The plugin proxies Cursor's Connect API,
so catalog limits should mirror the Cursor-facing 256K value; the 500K API discrepancy is documented
rather than hidden (`fn_20260812_vaamzb8z`, `fn_20260812_o13isq9e`). The existing `/grok/i` cost
pattern already routes `grok-4.6` to the `grok-4.20` key (`fn_20260812_uejn0r60`), whose $2/$6 rates
match Grok 4.5/4.6 short-context pricing; `grok-4.20` itself is a different xAI model at $1.25/$2.50
(`fn_20260812_o13isq9e`, https://docs.x.ai/developers/models/grok-4.20-experimental-beta-0304).

## 2. Explicit uncertainty

These items are **not** asserted as verified. Each is labelled with its confidence grade from the
source Field Note.

- **Cursor-facing model id string: UNVERIFIED (inference).** Presumed `grok-4.6`, matching the xAI
  id and Cursor's docs path `/docs/models/grok-4-6`, but not yet confirmed against a live
  `GetUsableModels` response (`fn_20260812_vaamzb8z`, "INFERENCE / UNCERTAIN"). Spec assumption A1
  and the risk table treat a differing id as an open risk; live confirmation is scheduled for Wave 5.
  The fallback catalog entry is a best-effort resilience path, not the authoritative discovery path.
- **Billing pool: NO CLAIM MADE.** Whether Grok 4.6 on Cursor draws from the first-party pool or the
  API/third-party pool is UNCONFIRMED. Launch-day Reddit reports are anecdotal and internally
  inconsistent with Cursor's own grok page
  (https://www.reddit.com/r/cursor/comments/1vmmfgc/grok_46_thoughts_usage/, INFERENCE grade,
  `fn_20260812_vaamzb8z`). No plugin metadata depends on a pool, so this document makes no
  billing-pool claim.
- **Rollout cadence: uncertain.** Cursor's changelog had no dedicated Grok 4.6 entry as of the
  research date even though the models page lists the model; rollout may be gradual
  (`fn_20260812_vaamzb8z`).

## 3. Fork survey: no prior art to cherry-pick

Origin `ephraimduncan/opencode-cursor` plus **24 surveyed forks** were searched via GitHub API fork,
commit, and code-search queries run 2026-08-12. Result: **zero `grok-4.6` code hits anywhere**
(`fn_20260812_gz125m33`). Independent corroboration: `gh search commits "grok 4.6"` and
`gh search issues "grok 4.6"` returned empty; the 50-item origin PR list contains no Grok PRs; six
local remote-only branches carry zero grok references in `src/`; origin/main (`a37a6ba`, v0.1.1)
fallback models contain only `grok-code-fast-1` (`fn_20260812_zyc1iqd0`).

Verdict: **no cherry-pick exists.** Grok 4.6 catalog work is greenfield for this workflow. Upstream
issue #33, the acceptance-defining hang report, remains open (`fn_20260812_gz125m33`,
https://github.com/ephraimduncan/opencode-cursor/issues/33).

## 4. Adapted prior art: tanushshukla a067e099

Commit [a067e099](https://github.com/tanushshukla/opencode-cursor/commit/a067e099)
("fix: end OpenAI stream on Cursor turnEnded", +203/-30 in `proxy.ts`) is recorded as **adapted
prior art, with attribution**, for two behaviors (`fn_20260812_gz125m33`, `fn_20260812_b0tcb20c`):

- `turnEnded` as a clean terminal: finalize the SSE stream with `finish_reason: stop` plus `[DONE]`,
  tear down the parked bridge, and guard the later close handler against double-reporting.
- `interactionQuery` answers with typed rejections (web search / ask / plan / exa / VM) so the model
  can continue instead of waiting forever.

**Behavioral adoption is evidence-gated, not committed here.** This branch currently treats
`turnEnded` as non-terminal (`src/proxy.ts:1294-1296`) and errors on `interactionQuery`
(`src/proxy.ts:1233-1237`) (`fn_20260812_b0tcb20c`). Whether to adopt the fork's behavior is decided
by Wave 3 deterministic fixtures plus isolated live observation, per spec assumption A7; any
adaptation must preserve this fork's stricter abnormal-path contract, which the upstream commit does
not have (`fn_20260812_b0tcb20c`; BLUEPRINT, "Prior art and provenance"). This section records
provenance only.

## 5. Rejected upstream work: origin PR #36

Origin PR [#36](https://github.com/ephraimduncan/opencode-cursor/pull/36)
("fix: run on Node runtime (Desktop sidecar)", intellectronica, +19577/-97) replaces `Bun.*` with
`node:http` + `child_process` and changes module format. **Rejected as orthogonal**: the Bun runtime
is this workflow's constraint, the diff is large, and the conflict surface is high; it addresses no
Grok 4.6 or stall requirement here (`fn_20260812_gz125m33`, `fn_20260812_zyc1iqd0`).

## 6. Disposition of the 18 inherited stability commits

The branch carries 18 stability commits inherited from the earlier hang investigation (base
`origin/main` `a37a6ba`; tip `1ffca14`; +2505/-176; commit-level audit in `fn_20260812_fppld7hu`).
They are **already present in branch history**, so there is nothing to cherry-pick or reimplement.

Wave 1 Task 1.1 re-verified them at the inherited tip `1ffca14`
(`1ffca147b461ea044e041626eb1ccc7465169526`) on `chore/stability-baseline`: `npx tsc -p tsconfig.json
--noEmit` PASS, `bun test/smoke.ts` PASS with 48 required assertions and 2 documented quarantines,
`bun run build` PASS. That record is the **accepted floor** for this workflow, written by commit
`39c6a15` (`docs(baseline): record inherited stability floor`) into
[`docs/cursor-hang-root-cause.md`](./cursor-hang-root-cause.md) ("Baseline status at inherited tip")
and [`docs/overlay-baseline.note.md`](./overlay-baseline.note.md) (`fn_20260812_fppld7hu`;
`docs/cursor-hang-root-cause.md:42-65`).

Coverage those commits bring: bounded token refresh, strict Connect stream termination, an
idempotent terminal owner, a semantic-progress watchdog, HTTP/2 PING and session lifecycle handling,
tool-resume isolation, unary/non-streaming bounds, redacted lifecycle diagnostics, a fake
Connect/H2 fixture, and roughly 30 smoke assertions (`fn_20260812_fppld7hu`).

## 7. Overlay disposition

`docs/overlay-baseline.patch` is preserved as verbatim evidence and **MUST NOT be reapplied**; the
adjacent note and the RCA record the three-way split
([`docs/overlay-baseline.note.md`](./overlay-baseline.note.md);
`docs/cursor-hang-root-cause.md`, "Overlay provenance"):

- **Kept / already landed:** stderr draining, sanitized error reporting, defensive close and destroy
  guards.
- **Rejected:** the fixed timeout increases (30 to 60s connect; 120 to 180s idle).
- **Replaced:** the 90s raw-byte watchdog, superseded by semantic-progress plus H2 liveness.

## 8. Origin PR #34 verdict: ADAPT (client-abort lifecycle)

Origin PR [#34](https://github.com/ephraimduncan/opencode-cursor/pull/34)
("fix: handle cancelled SSE streams", noamkush, +4/-1) guards `sendSSE` with a `closed` flag to stop
`ERR_INVALID_STATE: Controller is already closed` when the client cancels
(`fn_20260812_gz125m33`). It is stall-adjacent to this fork's cancellation and termination path.

**Verdict: ADAPT.** PR #34 correctly identifies the caller-cancellation boundary, but its `closed`
guard alone is insufficient for this fork: it only suppresses a later `controller.enqueue`, leaving
the bridge child, Connect/H2 stream, heartbeat, semantic-progress watchdog, paused-bridge indexes,
and this fork's idempotent terminal owner outside its scope.

This fork already owns those resources through `createBridgeStreamResponse`'s idempotent terminal
owner: normal/error termination clears the semantic watchdog and heartbeat, removes matching
`activeBridges`/tool-call index entries, writes the one terminal SSE sequence, closes the controller,
and terminates the child. The bridge close callback persists current blobs and checkpoint state into
the existing `conversationStates` record, then cannot re-enter terminal cleanup. A paused bridge is
removed when its retained transport exits; durable conversation state is intentionally retained for
the TTL/disk-cache recovery contract.

Wave 1 Task 1.3 adapts PR #34's missing cancellation guard to this ownership model: controller
closed-state now belongs to the shared response owner and `ReadableStream.cancel()` marks it before
clearing the watchdog/heartbeat, removing matching paused indexes, and terminating the bridge. It
does **not** enqueue or close the already consumer-cancelled controller, so late bridge callbacks
cannot write or produce a second close. `test/smoke.ts` uses the deterministic `client-abort` fake
Connect scenario to read one SSE frame, cancel the reader, and prove fixture-observed H2/session
cleanup, with zero retained proxy-side active bridges verified by source inspection. Typecheck and
the full deterministic smoke suite pass (2026-08-12).

Evidence: origin PR [#34](https://github.com/ephraimduncan/opencode-cursor/pull/34) (+4/-1,
`closed` set by `cancel()`); `fn_20260812_gz125m33`; `src/proxy.ts:createBridgeStreamResponse`;
`test/fixtures/fake-cursor-server.ts:client-abort`; `test/smoke.ts:testClientAbortTeardown`.

## Verification performed for this document

- `bun run build` — PASS (documentation-only change; no source, tests, or dependencies touched).
- `git diff --check` — PASS for the new document.
