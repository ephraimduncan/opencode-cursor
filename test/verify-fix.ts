/**
 * Standalone reproduction for the "ECONNRESET: Connection lost while reading
 * the response" bug reported against the Cursor proxy, and verification that
 * this branch's fix addresses it:
 *
 * 1. Bridge stderr used to be ignored, so a dead bridge gave zero diagnostic
 *    signal. This test spawns a bridge against a Cursor mock that aborts the
 *    H2 stream mid-flight and asserts the real reason is now captured.
 * 2. Bun.serve's idleTimeout (255s) is tracked on the *local* SSE response,
 *    not the bridge<->Cursor connection. A long silent "thinking" stretch
 *    (no textDelta from Cursor) used to produce zero local bytes and would
 *    eventually idle-time-out. This test proves the new local SSE keepalive
 *    comment lines keep flowing during that silence, independent of
 *    upstream traffic.
 */
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { create, toBinary } from "@bufbuild/protobuf";
import { AgentServerMessageSchema, InteractionUpdateSchema, TextDeltaUpdateSchema } from "../src/proto/agent_pb";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("FAIL: " + msg);
}

function frameConnect(payload: Uint8Array, flags = 0): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = flags;
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
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
    // Plaintext h2c to match the plaintext http2.createServer() above —
    // using https:// here would fail the TLS handshake before the H2
    // preface is even exchanged, which would make every test "pass" by
    // coincidentally hitting a TLS error instead of exercising real H2
    // stream behavior.
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const chunks: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    chunks.push(args.map(String).join(" "));
  };
  try {
    const result = await fn();
    return { result, stderr: chunks.join("\n") };
  } finally {
    console.error = orig;
  }
}

async function test1_stderrIsSurfacedOnAbruptDisconnect() {
  console.log("[verify] 1/2: bridge stderr reaches the parent on an upstream reset...");
  const mock = await withMockCursor((stream) => {
    // Accept the stream, then destroy the raw socket mid-flight — a hard
    // reset much like a flaky network or an edge LB killing the H2 stream.
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    setTimeout(() => {
      stream.session?.destroy();
    }, 150);
  });

  process.env.CURSOR_API_URL = mock.url;
  // Force a fresh module graph so CURSOR_API_URL is picked up.
  const proxyModule = await import(`../src/proxy?t=${Date.now()}`);
  const port = await proxyModule.startProxy(async () => "test-token");

  const { result: res, stderr } = await captureStderr(async () =>
    fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
  );

  // Drain the SSE body so bridge.onClose fires and has a chance to log.
  // (With no pending tool call, a dead bridge still finishes the SSE
  // response gracefully with finish_reason "stop" — that part of the
  // behavior is unchanged. What this test verifies is the previously
  // silent `stderr: "ignore"` now surfaces the real reason.)
  await res.text();
  await new Promise((r) => setTimeout(r, 300));

  assert(
    /\[cursor-bridge pid=\d+\]/.test(stderr),
    `expected piped bridge stderr to be logged, got: ${JSON.stringify(stderr)}`,
  );
  assert(
    /H2 (client|stream) error|idle for|no response within/.test(stderr),
    `expected a real diagnostic reason in stderr, got: ${JSON.stringify(stderr)}`,
  );

  proxyModule.stopProxy();
  await mock.close();
  console.log("  stderr captured:", stderr.trim().split("\n").join(" | "));
  console.log("[verify] 1/2 PASSED — real failure reason is now visible (was previously silent)");
}

async function test2_localKeepaliveSurvivesSilence() {
  console.log("[verify] 2/2: local SSE keepalive flows during a silent upstream stretch...");
  const mock = await withMockCursor((stream) => {
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    // Simulate a long silent "thinking" stretch: no frame at all for longer
    // than one keepalive interval, then a real text delta, then end cleanly.
    setTimeout(() => {
      const msg = create(AgentServerMessageSchema, {
        message: {
          case: "interactionUpdate",
          value: create(InteractionUpdateSchema, {
            message: {
              case: "textDelta",
              value: create(TextDeltaUpdateSchema, { text: "hi" }),
            },
          }),
        },
      });
      stream.write(frameConnect(toBinary(AgentServerMessageSchema, msg)));
      stream.end(frameConnect(new TextEncoder().encode("{}"), 0b00000010));
    }, 1_200);
  });

  process.env.CURSOR_API_URL = mock.url;
  const proxyModule = await import(`../src/proxy?t=${Date.now()}`);
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

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let sawKeepaliveBeforeContent = false;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    full += chunk;
    if (chunk.includes(": keepalive") && !full.includes('"content":"hi"')) {
      sawKeepaliveBeforeContent = true;
    }
  }

  assert(
    sawKeepaliveBeforeContent,
    `expected a ": keepalive" SSE comment to arrive locally during the silent stretch before any model content, got: ${JSON.stringify(full.slice(0, 500))}`,
  );

  proxyModule.stopProxy();
  await mock.close();
  console.log("[verify] 2/2 PASSED — local connection stays warm during silent upstream turns");
}

async function main() {
  // Keepalive fires every 20s in the real plugin; shrink it for the test via
  // an env override so we don't need a multi-minute test run.
  process.env.CURSOR_PROXY_KEEPALIVE_MS = "500";
  await test1_stderrIsSurfacedOnAbruptDisconnect();
  await test2_localKeepaliveSurvivesSilence();
  console.log("\n✓ Fix verification passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n✗ Fix verification failed:", err);
    process.exit(1);
  });
