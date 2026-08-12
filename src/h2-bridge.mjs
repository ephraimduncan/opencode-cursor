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
const DEFAULT_PING_INTERVAL_MS = 15_000;
const DEFAULT_PING_TIMEOUT_MS = 10_000;
const DEFAULT_SESSION_TIMEOUT_MS = 120_000;
const MAX_PING_INTERVAL_MS = 300_000;
const MAX_PING_TIMEOUT_MS = 60_000;
const MAX_SESSION_TIMEOUT_MS = 600_000;

function boundedDuration(name, fallback, maximum) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

/** Write one typed length-prefixed message to stdout. */
function writeMessage(kind, data) {
  const payload = Buffer.concat([Buffer.from([kind]), Buffer.from(data)]);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(payload.length, 0);
  process.stdout.write(lenBuf);
  process.stdout.write(payload);
}

function writeTransportStatus(transport) {
  writeMessage(1, Buffer.from(JSON.stringify({ transport })));
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
const { accessToken, url, path: rpcPath, unary, diagnostic: diagnosticContext, diagnosticsEnabled } = config;
const diagnosticStartedAt = performance.now();
const emittedStages = new Set();

// This is deliberately an allowlist. Transport errors, headers, payloads,
// and request configuration values are never serialized.
function emitDiagnostic(stage, details = {}) {
  if (!diagnosticsEnabled || !diagnosticContext?.requestId || emittedStages.has(stage)) return;
  emittedStages.add(stage);
  const event = {
    source: "bridge",
    stage,
    requestId: diagnosticContext.requestId,
    elapsedMs: Math.round(performance.now() - diagnosticStartedAt),
    parentElapsedMs: diagnosticContext.elapsedMs,
  };
  for (const key of ["byteLength", "exitCode"])
    if (typeof details[key] === "number") event[key] = details[key];
  if (typeof details.status === "string") event.status = details.status;
  if (typeof details.errorName === "string") event.errorName = details.errorName;
  try { process.stderr.write(`${JSON.stringify(event)}\n`); } catch {}
}
emitDiagnostic("bridge_start");

const client = http2.connect(url || "https://api2.cursor.sh");
const pingIntervalMs = boundedDuration(
  "CURSOR_BRIDGE_PING_INTERVAL_MS", DEFAULT_PING_INTERVAL_MS, MAX_PING_INTERVAL_MS,
);
const pingTimeoutMs = boundedDuration(
  "CURSOR_BRIDGE_PING_TIMEOUT_MS", DEFAULT_PING_TIMEOUT_MS, MAX_PING_TIMEOUT_MS,
);
const sessionTimeoutMs = boundedDuration(
  "CURSOR_BRIDGE_SESSION_TIMEOUT_MS", DEFAULT_SESSION_TIMEOUT_MS, MAX_SESSION_TIMEOUT_MS,
);
let pingInterval;
let pingTimeout;
let cleanExit = false;

function clearLivenessTimers() {
  clearTimeout(timeout);
  if (pingInterval) clearInterval(pingInterval);
  if (pingTimeout) clearTimeout(pingTimeout);
  pingInterval = undefined;
  pingTimeout = undefined;
}

function sendPing() {
  if (failed || cleanExit || pingTimeout) return;
  try {
    pingTimeout = setTimeout(() => failBridge("PingTimeout"), pingTimeoutMs);
    client.ping((error) => {
      if (pingTimeout) clearTimeout(pingTimeout);
      pingTimeout = undefined;
      if (error) failBridge("PingFailure");
    });
  } catch {
    failBridge("PingFailure");
  }
}

client.on("connect", () => {
  emitDiagnostic("h2_connect");
  writeTransportStatus("writable");
  // PING validates the HTTP/2/TCP path, not model output. A 15s cadence and
  // 10s response window leave normal multi-minute model thinking untouched.
  pingInterval = setInterval(sendPing, pingIntervalMs);
});

// Guard against initial connection failure. Reset on any h2 activity
// so long-running agent conversations (with tool call round-trips) survive.
let timeoutReason = "connect";
let timeout = setTimeout(() => killBridge(timeoutReason), 30_000);

function resetTimeout() {
  clearTimeout(timeout);
  timeoutReason = "idle";
  timeout = setTimeout(() => killBridge(timeoutReason), 120_000);
}

function killBridge(reason = "connect") {
  failBridge(`Timeout:${reason}`);
}

let failed = false;
function failBridge(errorName) {
  if (failed || cleanExit) return;
  failed = true;
  writeTransportStatus("failed");
  clearLivenessTimers();
  emitDiagnostic("terminal", { errorName, exitCode: 1 });
  try { client.destroy(); } catch {}
  process.exit(1);
}

client.on("error", () => failBridge("Http2SessionError"));

client.on("goaway", () => failBridge("Http2Goaway"));
client.on("frameError", () => failBridge("Http2FrameError"));
client.on("timeout", () => failBridge("Http2SessionTimeout"));
client.on("close", () => {
  if (!cleanExit) failBridge("Http2SessionClose");
});
client.setTimeout(sessionTimeoutMs);

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
emitDiagnostic("connect_stream");

const CONNECT_END_STREAM_FLAG = 0b00000010;
let connectFrameBuffer = Buffer.alloc(0);
let sawConnectEndStream = false;

function observeConnectFrames(chunk) {
  if (unary) return;
  connectFrameBuffer = Buffer.concat([connectFrameBuffer, chunk]);
  while (connectFrameBuffer.length >= 5) {
    const flags = connectFrameBuffer[0];
    const messageLength = connectFrameBuffer.readUInt32BE(1);
    if (connectFrameBuffer.length < 5 + messageLength) return;
    connectFrameBuffer = connectFrameBuffer.subarray(5 + messageLength);
    if (flags & CONNECT_END_STREAM_FLAG) sawConnectEndStream = true;
  }
}

// Forward H2 response data → stdout (length-prefixed)
h2Stream.on("data", (chunk) => {
  resetTimeout();
  observeConnectFrames(chunk);
  emitDiagnostic("bridge_data", { byteLength: chunk.length });
  writeMessage(0, chunk);
});

h2Stream.on("end", () => {
  clearLivenessTimers();
  if (!unary && !sawConnectEndStream) {
    failBridge("ConnectProtocolError");
  }
  cleanExit = true;
  writeTransportStatus("closed");
  emitDiagnostic("terminal", { exitCode: 0 });
  client.close();
  // Give stdout time to flush
  setTimeout(() => process.exit(0), 100);
});

h2Stream.on("error", (err) => {
  failBridge("Http2StreamError");
});
h2Stream.on("aborted", () => failBridge("Http2StreamAborted"));
h2Stream.on("close", () => {
  if (!cleanExit) failBridge("Http2StreamClose");
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
      if (h2Stream.closed || h2Stream.destroyed) {
        failBridge("BridgeWriteError");
        return;
      }
      try {
        resetTimeout();
        h2Stream.write(msg);
      } catch (error) {
        failBridge(error?.name || "BridgeWriteError");
        return;
      }
    }

    if (!h2Stream.closed && !h2Stream.destroyed) {
      h2Stream.end();
    }
  })();
}
