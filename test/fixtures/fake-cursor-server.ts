import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
  HeartbeatUpdateSchema,
  InteractionUpdateSchema,
  TextDeltaUpdateSchema,
} from "../../src/proto/agent_pb";

const CONNECT_END_STREAM_FLAG = 0b00000010;

export type CursorScenario =
  | "clean-end-stream"
  | "error-end-stream"
  | "empty-end-stream"
  | "missing-end-stream"
  | "malformed-terminal"
  | "partial-frame"
  | "slow-semantic-progress"
  | "heartbeat-trickle"
  | "checkpoint-trickle"
  | "abrupt-session-close"
  | "frame-error"
  | "goaway"
  | "transport-death";

export const CURSOR_SCENARIOS: readonly CursorScenario[] = [
  "clean-end-stream",
  "error-end-stream",
  "empty-end-stream",
  "missing-end-stream",
  "malformed-terminal",
  "partial-frame",
  "slow-semantic-progress",
  "heartbeat-trickle",
  "checkpoint-trickle",
  "abrupt-session-close",
  "frame-error",
  "goaway",
  "transport-death",
] as const;

export interface FakeCursorServer {
  apiUrl: string;
  setScenario: (scenario: CursorScenario) => void;
  assertClean: () => void;
  close: () => Promise<void>;
  /** Test-only resource accounting hooks for proving cleanup assertions fire. */
  trackChild: (pid: number) => void;
  untrackChild: (pid: number) => void;
  trackBridgeEntry: (key: string) => void;
  untrackBridgeEntry: (key: string) => void;
}

/** Connect envelope: flags, four-byte big-endian payload size, then payload. */
export function frameConnectMessage(payload: Uint8Array, flags = 0): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = flags;
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

export function frameConnectEndStream(payload: Uint8Array): Buffer {
  return frameConnectMessage(payload, CONNECT_END_STREAM_FLAG);
}

/** Deliberately violates the advertised Connect payload length. */
export function frameMalformedConnectMessage(payload: Uint8Array, advertisedLength: number): Buffer {
  const frame = frameConnectMessage(payload);
  frame.writeUInt32BE(advertisedLength, 1);
  return frame;
}

function serverMessage(message: Parameters<typeof create>[1]): Buffer {
  return toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, message as never));
}

function textDelta(text: string): Buffer {
  return serverMessage({
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: {
          case: "textDelta",
          value: create(TextDeltaUpdateSchema, { text }),
        },
      }),
    },
  });
}

function heartbeat(): Buffer {
  return serverMessage({
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "heartbeat", value: create(HeartbeatUpdateSchema, {}) },
      }),
    },
  });
}

function checkpoint(): Buffer {
  return serverMessage({
    message: {
      case: "conversationCheckpointUpdate",
      value: create(ConversationStateStructureSchema, {}),
    },
  });
}

function isScenario(value: string): value is CursorScenario {
  return (CURSOR_SCENARIOS as readonly string[]).includes(value);
}

/**
 * A local Connect-over-H2 server with bounded failure sequences. The request header
 * x-fake-cursor-scenario selects a scenario; setScenario supplies the default.
 */
export async function createFakeCursorServer(options: { deadlineMs?: number } = {}): Promise<FakeCursorServer> {
  const deadlineMs = options.deadlineMs ?? 100;
  const server = http2.createServer();
  const sessions = new Set<http2.ServerHttp2Session>();
  const streams = new Set<http2.ServerHttp2Stream>();
  const childPids = new Set<number>();
  const bridgeEntries = new Set<string>();
  let defaultScenario: CursorScenario = "clean-end-stream";

  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });

  server.on("stream", (stream, headers) => {
    streams.add(stream);
    stream.once("close", () => streams.delete(stream));
    stream.resume();
    if (headers[":path"] !== "/agent.v1.AgentService/Run") {
      stream.respond({ ":status": 404 });
      stream.end();
      return;
    }

    const requested = String(headers["x-fake-cursor-scenario"] ?? defaultScenario);
    const scenario = isScenario(requested) ? requested : defaultScenario;
    let completed = false;
    const timeout = setTimeout(() => {
      if (!completed && !stream.closed && !stream.destroyed) {
        stream.close(http2.constants.NGHTTP2_CANCEL);
      }
    }, deadlineMs);
    const finish = () => {
      completed = true;
      clearTimeout(timeout);
    };
    stream.once("close", finish);
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });

    const endWith = (body: Uint8Array) => stream.end(frameConnectEndStream(body));
    const trickle = (payload: Buffer) => {
      let sent = 0;
      const interval = setInterval(() => {
        if (stream.closed || stream.destroyed || ++sent > 3) {
          clearInterval(interval);
          if (!stream.closed && !stream.destroyed) stream.end();
          return;
        }
        stream.write(frameConnectMessage(payload));
      }, 10);
    };

    switch (scenario) {
      case "clean-end-stream":
        stream.end(Buffer.concat([frameConnectMessage(textDelta("complete")), frameConnectEndStream(new TextEncoder().encode("{}"))]));
        break;
      case "error-end-stream":
        endWith(new TextEncoder().encode(JSON.stringify({ error: { code: "unavailable", message: "fixture failure" } })));
        break;
      case "empty-end-stream":
        endWith(new Uint8Array());
        break;
      case "missing-end-stream":
        stream.end(frameConnectMessage(textDelta("truncated")));
        break;
      case "malformed-terminal":
        stream.end(frameMalformedConnectMessage(new TextEncoder().encode("{"), 9));
        break;
      case "partial-frame":
        stream.end(frameConnectMessage(textDelta("partial")).subarray(0, 7));
        break;
      case "slow-semantic-progress": {
        let part = 0;
        const interval = setInterval(() => {
          if (stream.closed || stream.destroyed) return clearInterval(interval);
          if (part < 3) stream.write(frameConnectMessage(textDelta(`part-${++part}`)));
          else {
            clearInterval(interval);
            endWith(new TextEncoder().encode("{}"));
          }
        }, 15);
        break;
      }
      case "heartbeat-trickle":
        trickle(heartbeat());
        break;
      case "checkpoint-trickle":
        trickle(checkpoint());
        break;
      case "abrupt-session-close":
        stream.write(frameConnectMessage(textDelta("before-close")));
        setTimeout(() => stream.session.destroy(), 10);
        break;
      case "frame-error":
        stream.write(frameConnectMessage(textDelta("before-reset")));
        setTimeout(() => stream.close(http2.constants.NGHTTP2_PROTOCOL_ERROR), 10);
        break;
      case "goaway":
        stream.write(frameConnectMessage(textDelta("before-goaway")));
        setTimeout(() => stream.session.goaway(http2.constants.NGHTTP2_NO_ERROR), 10);
        break;
      case "transport-death":
        setTimeout(() => stream.session.destroy(), 10);
        break;
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    apiUrl: `http://127.0.0.1:${port}`,
    setScenario(scenario) { defaultScenario = scenario; },
    trackChild(pid) { childPids.add(pid); },
    untrackChild(pid) { childPids.delete(pid); },
    trackBridgeEntry(key) { bridgeEntries.add(key); },
    untrackBridgeEntry(key) { bridgeEntries.delete(key); },
    assertClean() {
      const leaks = [
        sessions.size && `${sessions.size} H2 session(s)`,
        streams.size && `${streams.size} H2 stream(s)`,
        childPids.size && `${childPids.size} child process(es)`,
        bridgeEntries.size && `${bridgeEntries.size} bridge map entry(ies)`,
      ].filter(Boolean);
      if (leaks.length) throw new Error(`Fake Cursor fixture leaked ${leaks.join(", ")}`);
    },
    async close() {
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
      this.assertClean();
    },
  };
}
