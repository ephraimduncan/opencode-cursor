/**
 * Reproduces a real-world hang distinct from verify-fix.ts: a Cursor
 * connection that accepts the H2 stream but then sends absolutely nothing
 * back — no data, no error, no RST (a "black hole", e.g. a silently dropped
 * route) — while the parent proxy keeps sending its 5s local heartbeat the
 * whole time.
 *
 * Before this fix, `resetTimeout()` in h2-bridge.mjs was called from the
 * stdin-forwarding loop, which also carries the proxy's local heartbeat
 * writes. That meant every heartbeat re-armed the bridge's own idle-kill
 * timer even though it proves nothing about whether Cursor is still
 * listening — a silently black-holed connection would look perpetually
 * "alive" forever, hanging the whole session with zero recovery and zero
 * diagnostic signal.
 *
 * After the fix, only genuine upstream H2 data (the h2Stream "data" handler)
 * resets that timer, so a black-holed connection is still detected and
 * killed within CONNECT_TIMEOUT_MS, regardless of how many local heartbeats
 * fire in the meantime.
 *
 * Run with the bridge timeouts set at the OS/shell level (Bun.spawn's
 * default env inheritance snapshots the environment at Bun's own startup,
 * not live process.env mutations made afterward — see spawnBridge in
 * proxy.ts, which spawns h2-bridge.mjs with no explicit `env` override):
 *
 *   CURSOR_BRIDGE_CONNECT_TIMEOUT_MS=1500 CURSOR_BRIDGE_IDLE_TIMEOUT_MS=8000 \
 *     bun test/verify-blackhole-fix.ts
 */
import http2 from "node:http2";
import type { AddressInfo } from "node:net";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("FAIL: " + msg);
}

async function withMockCursor(
  onStream: (stream: http2.ServerHttp2Stream) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    const path = String(headers[":path"] ?? "");
    if (path !== "/agent.v1.AgentService/Run") {
      stream.respond({ ":status": 404 });
      stream.end();
      return;
    }
    onStream(stream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function main() {
  for (const must of [
    "CURSOR_BRIDGE_CONNECT_TIMEOUT_MS",
    "CURSOR_BRIDGE_IDLE_TIMEOUT_MS",
  ]) {
    if (!process.env[must]) {
      throw new Error(
        `Run this test with ${must} set in the shell env, e.g.: ` +
          `CURSOR_BRIDGE_CONNECT_TIMEOUT_MS=1500 CURSOR_BRIDGE_IDLE_TIMEOUT_MS=8000 bun ${process.argv[1]}`,
      );
    }
  }

  let acceptedButSilent = false;
  const mock = await withMockCursor((stream) => {
    // Accept the stream and then send absolutely nothing, ever — the
    // "black hole" case. The proxy's 5s heartbeat will still be written to
    // this bridge throughout; it must not matter.
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    acceptedButSilent = true;
  });
  process.env.CURSOR_API_URL = mock.url;

  const stderrChunks: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    stderrChunks.push(args.map(String).join(" "));
  };

  const proxyModule = await import(`../src/proxy?t=${Date.now()}`);
  let text = "";
  try {
    const port = await proxyModule.startProxy(async () => "test-token");

    const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    // Decisive window: IDLE_TIMEOUT_MS (set by the caller) is intentionally
    // larger than the proxy's hardcoded 5s bridge<->Cursor heartbeat
    // interval. With the bug, each heartbeat re-extends the bridge's
    // self-kill deadline indefinitely, so it would still be alive well past
    // CONNECT_TIMEOUT_MS. Fixed, nothing resets the timer (the mock never
    // sends data), so it must die at CONNECT_TIMEOUT_MS regardless.
    const deadlineMs = 4000;
    text = await Promise.race([
      res.text(),
      new Promise<string>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `TIMED OUT after ${deadlineMs}ms: request is still hanging well past its ` +
                  `own CONNECT_TIMEOUT_MS — a local heartbeat is masking the dead upstream ` +
                  `connection (the bug is NOT fixed)`,
              ),
            ),
          deadlineMs,
        ),
      ),
    ]);
  } finally {
    // Always restore, even on failure/timeout, so any error prints to the
    // real terminal instead of being silently swallowed into stderrChunks.
    console.error = origError;
  }

  assert(acceptedButSilent, "test setup: mock should have accepted the stream");
  const stderrText = stderrChunks.join("\n");
  assert(
    /no response within [\d.]+s of connecting to Cursor/.test(stderrText),
    `expected the connect-timeout reason in stderr despite ongoing local heartbeats, got: ${JSON.stringify(stderrText)}`,
  );

  proxyModule.stopProxy();
  await mock.close();
  console.log("[verify-blackhole] Black-holed upstream + local heartbeats: bridge still self-terminated and reported why:");
  console.log("  " + stderrText.trim());
  console.log("  SSE body finished with:", JSON.stringify(text.slice(0, 200)));
  console.log("\n✓ Black-hole hang fix verified");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n✗ Black-hole verification failed:", err);
    process.exit(1);
  });
