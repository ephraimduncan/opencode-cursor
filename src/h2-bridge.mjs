#!/usr/bin/env node
/**
 * Dumb HTTP/2 bidirectional pipe for Cursor gRPC.
 *
 * Bun's node:http2 is broken. This Node script acts as a transparent
 * HTTP/2 proxy: it opens a single bidirectional stream and ferries
 * raw bytes between the parent process (via stdin/stdout) and Cursor.
 *
 * Protocol (length-prefixed framing over stdin/stdout):
 *   [4 bytes big-endian length][payload]
 *
 * First message on stdin is JSON config:
 *   { "accessToken": "...", "url": "...", "path": "...", "unary": false }
 *
 * When unary=true, the bridge uses application/proto (raw protobuf) instead
 * of application/connect+proto (Connect streaming). The single stdin message
 * is written as the request body and the stream is ended immediately.
 * After config, subsequent stdin messages are raw bytes to write to the H2 stream.
 * H2 response data is written to stdout using the same length-prefixed framing.
 */
import http2 from "node:http2";
import crypto from "node:crypto";

const CURSOR_CLIENT_VERSION = "cli-2026.01.09-231024f";

/** Write one length-prefixed message to stdout. */
function writeMessage(data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  process.stdout.write(lenBuf);
  process.stdout.write(data);
}

// --- Buffered stdin reader ---

let stdinBuf = Buffer.alloc(0);
let stdinResolve = null;
let stdinEnded = false;

process.stdin.on("data", (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk]);
  if (stdinResolve) {
    const r = stdinResolve;
    stdinResolve = null;
    r();
  }
});

process.stdin.on("end", () => {
  stdinEnded = true;
  if (stdinResolve) {
    const r = stdinResolve;
    stdinResolve = null;
    r();
  }
});

function waitForData() {
  return new Promise((resolve) => { stdinResolve = resolve; });
}

async function readExact(n) {
  while (stdinBuf.length < n) {
    if (stdinEnded) return null;
    await waitForData();
  }
  const result = stdinBuf.subarray(0, n);
  stdinBuf = stdinBuf.subarray(n);
  return Buffer.from(result);
}

async function readMessage() {
  const lenBuf = await readExact(4);
  if (!lenBuf) return null;
  const len = lenBuf.readUInt32BE(0);
  if (len === 0) return Buffer.alloc(0);
  return readExact(len);
}

// --- Main ---

const configBuf = await readMessage();
if (!configBuf) process.exit(1);

const config = JSON.parse(configBuf.toString("utf8"));
const { accessToken, url, path: rpcPath, unary } = config;

const client = http2.connect(url || "https://api2.cursor.sh");

/**
 * Report why the bridge is about to die. The parent process (proxy.ts)
 * pipes our stderr and logs it, so a dead bridge is diagnosable instead of
 * surfacing as an opaque "connection lost" / ECONNRESET to the caller.
 */
function reportFailure(reason) {
  process.stderr.write(`[h2-bridge] ${reason}\n`);
}

// Overridable for tests; production defaults are 30s / 120s.
const CONNECT_TIMEOUT_MS = Number(process.env.CURSOR_BRIDGE_CONNECT_TIMEOUT_MS) || 30_000;
const IDLE_TIMEOUT_MS = Number(process.env.CURSOR_BRIDGE_IDLE_TIMEOUT_MS) || 120_000;

// Guard against initial connection failure. Reset only on genuine upstream
// h2 activity (see the h2Stream "data" handler below) so long-running agent
// conversations (with tool call round-trips) survive, while a connection
// that Cursor has gone silent on (no response, no RST — a black hole) still
// gets detected and killed instead of hanging forever.
let timeout = setTimeout(
  () => killBridge(`no response within ${CONNECT_TIMEOUT_MS / 1000}s of connecting to Cursor`),
  CONNECT_TIMEOUT_MS,
);

function resetTimeout() {
  clearTimeout(timeout);
  timeout = setTimeout(
    () => killBridge(`idle for ${IDLE_TIMEOUT_MS / 1000}s without any H2 activity from Cursor`),
    IDLE_TIMEOUT_MS,
  );
}

function killBridge(reason) {
  clearTimeout(timeout);
  reportFailure(reason ?? "killed");
  client.destroy();
  process.exit(1);
}

client.on("error", (err) => {
  clearTimeout(timeout);
  reportFailure(`H2 client error: ${err?.message ?? err}`);
  process.exit(1);
});

const headers = {
  ":method": "POST",
  ":path": rpcPath || "/agent.v1.AgentService/Run",
  "content-type": unary ? "application/proto" : "application/connect+proto",
  te: "trailers",
  authorization: `Bearer ${accessToken}`,
  "x-ghost-mode": "true",
  "x-cursor-client-version": CURSOR_CLIENT_VERSION,
  "x-cursor-client-type": "cli",
  "x-request-id": crypto.randomUUID(),
};
if (!unary) {
  headers["connect-protocol-version"] = "1";
}
const h2Stream = client.request(headers);

// Forward H2 response data → stdout (length-prefixed)
h2Stream.on("data", (chunk) => {
  resetTimeout();
  writeMessage(chunk);
});

h2Stream.on("end", () => {
  clearTimeout(timeout);
  client.close();
  // Give stdout time to flush
  setTimeout(() => process.exit(0), 100);
});

h2Stream.on("error", (err) => {
  clearTimeout(timeout);
  reportFailure(`H2 stream error: ${err?.message ?? err}`);
  client.close();
  process.exit(1);
});

// Forward stdin → H2 stream (after config message)
if (unary) {
  // Unary mode: read a single body message, write it, and end the stream.
  const body = await readMessage();
  if (body && body.length > 0 && !h2Stream.closed && !h2Stream.destroyed) {
    h2Stream.end(body);
  } else {
    h2Stream.end();
  }
} else {
  // Streaming mode: forward all stdin messages as Connect frames.
  (async () => {
    while (true) {
      const msg = await readMessage();
      if (!msg || msg.length === 0) {
        // EOF or zero-length = done writing
        break;
      }
      if (!h2Stream.closed && !h2Stream.destroyed) {
        // Note: deliberately NOT calling resetTimeout() here. This loop also
        // forwards the parent's local keepalive heartbeat (every 5s) — that
        // only proves *we* are still writing, not that Cursor is still
        // listening. A silently black-holed connection (packets dropped,
        // no RST) would otherwise look perpetually "alive" to this timer
        // forever, since the heartbeat never stops. Only a genuine response
        // from Cursor (the h2Stream "data" handler below) should prove the
        // connection is actually alive.
        h2Stream.write(msg);
      }
    }

    if (!h2Stream.closed && !h2Stream.destroyed) {
      h2Stream.end();
    }
  })();
}
