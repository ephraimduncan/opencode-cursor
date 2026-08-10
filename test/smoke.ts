import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
  ExecServerControlMessageSchema,
  GetBlobArgsSchema,
  GetUsableModelsResponseSchema,
  HeartbeatUpdateSchema,
  InteractionQuerySchema,
  InteractionUpdateSchema,
  KvServerMessageSchema,
  ModelDetailsSchema,
  TextDeltaUpdateSchema,
  TurnEndedUpdateSchema,
} from "../src/proto/agent_pb";
import {
  CURSOR_SCENARIOS,
  createFakeCursorServer,
  type CursorScenario,
} from "./fixtures/fake-cursor-server";

type DiscoveryMode = "success" | "empty" | "auth-error";

interface TestModules {
  startProxy: typeof import("../src/proxy").startProxy;
  stopProxy: typeof import("../src/proxy").stopProxy;
  getProxyPort: typeof import("../src/proxy").getProxyPort;
  getActiveBridgeCount: typeof import("../src/proxy").getActiveBridgeCount;
  generateCursorAuthParams: typeof import("../src/auth").generateCursorAuthParams;
  getTokenExpiry: typeof import("../src/auth").getTokenExpiry;
  CursorAuthPlugin: typeof import("../src/index").CursorAuthPlugin;
  getCursorModels: typeof import("../src/models").getCursorModels;
  clearModelCache: typeof import("../src/models").clearModelCache;
  processServerMessage: typeof import("../src/proxy").processServerMessage;
}

interface TestCursorBackend {
  apiUrl: string;
  refreshUrl: string;
  setDiscoveryMode: (mode: DiscoveryMode) => void;
  setDiscoveredModels: (models: Array<{ id: string; name: string; reasoning?: boolean }>) => void;
  resetObservations: () => void;
  getDiscoveryAuthHeaders: () => string[];
  getDiscoveryRequestBodies: () => Uint8Array[];
  getRefreshAuthHeaders: () => string[];
  close: () => Promise<void>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertArrayEqual(
  actual: readonly string[],
  expected: readonly string[],
  message: string,
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

function makeJwt(expiresAtSeconds: number): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ exp: expiresAtSeconds }));
  return `${header}.${payload}.fakesig`;
}

function frameConnectUnaryMessage(payload: Uint8Array): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

function frameConnectEndStream(payload: Uint8Array): Buffer {
  const frame = frameConnectUnaryMessage(payload);
  frame[0] = 0b00000010;
  return frame;
}

async function captureDiagnosticOutput<T>(operation: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    return { result: await operation(), lines };
  } finally {
    console.error = original;
  }
}

async function createTestCursorBackend(): Promise<TestCursorBackend> {
  let discoveryMode: DiscoveryMode = "success";
  let discoveredModels: Array<{ id: string; name: string; reasoning?: boolean }> = [
    { id: "composer-2", name: "Composer 2", reasoning: true },
  ];
  const discoveryAuthHeaders: string[] = [];
  const discoveryRequestBodies: Uint8Array[] = [];
  const refreshAuthHeaders: string[] = [];

  const refreshServer = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/auth/exchange_user_api_key") {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const authHeader = req.headers.authorization ?? "";
    refreshAuthHeaders.push(authHeader);

    if (authHeader !== "Bearer valid-refresh") {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("bad refresh token");
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        accessToken: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        refreshToken: "valid-refresh",
      }),
    );
  });
  await new Promise<void>((resolve) => refreshServer.listen(0, "127.0.0.1", resolve));
  const refreshPort = (refreshServer.address() as AddressInfo).port;

  const apiServer = http2.createServer();
  apiServer.on("stream", (stream, headers) => {
    const path = String(headers[":path"] ?? "");
    const authHeader = String(headers.authorization ?? "");
    if (path === "/agent.v1.AgentService/Run") {
      stream.respond({
        ":status": 200,
        "content-type": "application/connect+proto",
      });
      stream.end(Buffer.concat([
        frameConnectUnaryMessage(new Uint8Array()),
        frameConnectEndStream(new TextEncoder().encode("{}")),
      ]));
      return;
    }

    const chunks: Buffer[] = [];

    stream.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    stream.on("end", () => {
      if (path === "/agent.v1.AgentService/GetUsableModels") {
        discoveryAuthHeaders.push(authHeader);
        discoveryRequestBodies.push(new Uint8Array(Buffer.concat(chunks)));

        if (discoveryMode === "auth-error") {
          stream.respond({
            ":status": 401,
            "content-type": "application/json",
          });
          stream.end(
            JSON.stringify({ code: "unauthenticated", message: "expired token" }),
          );
          return;
        }

        const responseBody = discoveryMode === "empty"
          ? frameConnectUnaryMessage(new Uint8Array())
          : frameConnectUnaryMessage(
              toBinary(
                GetUsableModelsResponseSchema,
                create(GetUsableModelsResponseSchema, {
                  models: discoveredModels.map((model) =>
                    create(ModelDetailsSchema, {
                      modelId: model.id,
                      displayModelId: model.id,
                      displayName: model.name,
                      displayNameShort: model.name,
                      aliases: [],
                    }),
                  ),
                }),
              ),
            );
        stream.respond({
          ":status": 200,
          "content-type": "application/connect+proto",
        });
        stream.end(responseBody);
        return;
      }

      stream.respond({ ":status": 404 });
      stream.end();
    });
  });
  await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
  const apiPort = (apiServer.address() as AddressInfo).port;

  return {
    apiUrl: `http://127.0.0.1:${apiPort}`,
    refreshUrl: `http://127.0.0.1:${refreshPort}/auth/exchange_user_api_key`,
    setDiscoveryMode(mode) {
      discoveryMode = mode;
    },
    setDiscoveredModels(models) {
      discoveredModels = models;
    },
    resetObservations() {
      discoveryAuthHeaders.length = 0;
      discoveryRequestBodies.length = 0;
      refreshAuthHeaders.length = 0;
    },
    getDiscoveryAuthHeaders() {
      return [...discoveryAuthHeaders];
    },
    getDiscoveryRequestBodies() {
      return discoveryRequestBodies.map((body) => new Uint8Array(body));
    },
    getRefreshAuthHeaders() {
      return [...refreshAuthHeaders];
    },
    async close() {
      await Promise.all([
        new Promise<void>((resolve, reject) =>
          apiServer.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve, reject) =>
          refreshServer.close((error) => (error ? reject(error) : resolve())),
        ),
      ]);
    },
  };
}

async function loadModules(): Promise<TestModules> {
  const proxy = await import("../src/proxy");
  const auth = await import("../src/auth");
  const index = await import("../src/index");
  const models = await import("../src/models");
  return {
    startProxy: proxy.startProxy,
    stopProxy: proxy.stopProxy,
    getProxyPort: proxy.getProxyPort,
    getActiveBridgeCount: proxy.getActiveBridgeCount,
    generateCursorAuthParams: auth.generateCursorAuthParams,
    getTokenExpiry: auth.getTokenExpiry,
    CursorAuthPlugin: index.CursorAuthPlugin,
    getCursorModels: models.getCursorModels,
    clearModelCache: models.clearModelCache,
    processServerMessage: proxy.processServerMessage,
  };
}

async function testProxyStartStop(modules: TestModules) {
  console.log("[test] Starting proxy...");
  const port = await modules.startProxy(async () => "test-token");
  console.log(`[test] Proxy started on port ${port}`);

  if (port < 1) {
    throw new Error(`Expected a valid port number, got ${port}`);
  }
  if (modules.getProxyPort() !== port) {
    throw new Error("getProxyPort() mismatch");
  }

  const modelsRes = await fetch(`http://localhost:${port}/v1/models`);
  if (!modelsRes.ok) {
    throw new Error(`/v1/models returned ${modelsRes.status}`);
  }
  const modelsBody = await modelsRes.json();
  if (modelsBody.object !== "list") {
    throw new Error(`Expected object=list, got ${modelsBody.object}`);
  }
  if (!Array.isArray(modelsBody.data) || modelsBody.data.length !== 0) {
    throw new Error(`Expected empty model list data array, got ${JSON.stringify(modelsBody.data)}`);
  }
  console.log("[test] /v1/models OK");

  const badRes = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test", messages: [] }),
  });
  if (badRes.status !== 400) {
    throw new Error(`Expected 400 for missing user message, got ${badRes.status}`);
  }
  const badBody = await badRes.json();
  if (!badBody.error?.message?.includes("No user message")) {
    throw new Error(`Expected 'No user message' error, got: ${badBody.error?.message}`);
  }
  console.log("[test] Missing user message validation OK");

  const notFoundRes = await fetch(`http://localhost:${port}/unknown`);
  if (notFoundRes.status !== 404) {
    throw new Error(`Expected 404, got ${notFoundRes.status}`);
  }
  console.log("[test] 404 handling OK");

  modules.stopProxy();
  if (modules.getProxyPort() !== undefined) {
    throw new Error("Proxy port should be undefined after stop");
  }
  console.log("[test] Proxy stop OK");
}

async function testAuthParams(modules: TestModules) {
  console.log("[test] Generating auth params...");
  const params = await modules.generateCursorAuthParams();

  if (!params.verifier || !params.challenge || !params.uuid || !params.loginUrl) {
    throw new Error("Missing auth params");
  }
  if (!params.loginUrl.includes("cursor.com/loginDeepControl")) {
    throw new Error(`Unexpected login URL: ${params.loginUrl}`);
  }
  if (!params.loginUrl.includes(params.uuid)) {
    throw new Error("Login URL missing UUID");
  }

  const data = new TextEncoder().encode(params.verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const expectedChallenge = Buffer.from(hashBuffer).toString("base64url");
  if (params.challenge !== expectedChallenge) {
    throw new Error(
      `PKCE challenge mismatch: expected ${expectedChallenge}, got ${params.challenge}`,
    );
  }

  console.log("[test] Auth params OK");
}

async function testTokenExpiry(modules: TestModules) {
  console.log("[test] Testing token expiry parsing...");

  const futureExp = Math.floor(Date.now() / 1000) + 7200;
  const fakeJwt = makeJwt(futureExp);

  const expiry = modules.getTokenExpiry(fakeJwt);
  const expectedMin = futureExp * 1000 - 5 * 60 * 1000 - 1000;
  const expectedMax = futureExp * 1000 - 5 * 60 * 1000 + 1000;

  if (expiry < expectedMin || expiry > expectedMax) {
    throw new Error(`Token expiry ${expiry} out of expected range [${expectedMin}, ${expectedMax}]`);
  }

  const fallbackExpiry = modules.getTokenExpiry("not-a-jwt");
  const now = Date.now();
  const expectedFallback = now + 3600 * 1000;
  if (Math.abs(fallbackExpiry - expectedFallback) > 5000) {
    throw new Error(
      `Fallback expiry off by ${Math.abs(fallbackExpiry - expectedFallback)}ms, expected ~1h from now`,
    );
  }

  console.log("[test] Token expiry OK");
}

async function testPluginShape(modules: TestModules) {
  console.log("[test] Checking plugin export shape...");

  const fakeInput = {
    client: { auth: { set: async () => {} } },
  } as any;
  const hooks = await modules.CursorAuthPlugin(fakeInput);

  if (!hooks.auth) {
    throw new Error("Plugin hooks missing 'auth'");
  }
  if (hooks.auth.provider !== "cursor") {
    throw new Error(`Expected provider 'cursor', got '${hooks.auth.provider}'`);
  }
  if (typeof hooks.auth.loader !== "function") {
    throw new Error("Plugin hooks.auth.loader is not a function");
  }
  if (!Array.isArray(hooks.auth.methods) || hooks.auth.methods.length === 0) {
    throw new Error("Plugin hooks.auth.methods missing or empty");
  }
  if (hooks.auth.methods[0].type !== "oauth") {
    throw new Error(`Expected method type 'oauth', got '${hooks.auth.methods[0].type}'`);
  }
  if (typeof hooks.auth.methods[0].authorize !== "function") {
    throw new Error("Plugin auth method missing authorize function");
  }

  console.log("[test] Plugin shape OK");
}

async function testArrayContentParsing(modules: TestModules) {
  console.log("[test] Testing array content (plan-mode) parsing...");
  const port = await modules.startProxy(async () => "test-token");

  const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "test",
      stream: false,
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "You are a helpful assistant." },
            { type: "text", text: "Plan mode is active." },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "lazy-load recharts" },
            { type: "text", text: "work on a plan" },
          ],
        },
      ],
    }),
  });

  if (res.status === 400) {
    const body = await res.json();
    if (body.error?.message?.includes("No user message")) {
      throw new Error(
        "Array content not normalized — plan mode messages lost",
      );
    }
  }
  assertEqual(res.status, 200, "Empty protobuf frames must be ignored without failing a non-streaming response");

  modules.stopProxy();
  console.log("[test] Array content parsing OK");
}

async function testNonStreamingProtocolErrorsAreStructured() {
  console.log("[test] Testing non-streaming protocol error handling...");
  const fixture = await createFakeCursorServer({ deadlineMs: 1_000 });
  fixture.setScenario("malformed-server-message");
  try {
    const result = await runScenarioSubprocess(fixture.apiUrl, `
      import { startProxy, stopProxy } from "./src/proxy.ts";
      const port = await startProxy(async () => "test-token");
      const response = await fetch("http://localhost:" + port + "/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "test", stream: false, messages: [{ role: "user", content: "malformed non-streaming response" }] }),
      });
      const body = await response.json();
      stopProxy();
      console.log(JSON.stringify({ status: response.status, body }));
      process.exit(0);
    `);
    assertEqual(result.status, 500, "Non-streaming protocol errors must return a structured server error");
    const body = result.body as { error?: { message?: string } };
    assert(
      body.error?.message?.includes("Failed to process Cursor server message"),
      "Non-streaming protocol errors must preserve the terminal error message",
    );
  } finally {
    await fixture.close();
  }
  console.log("[test] Non-streaming protocol errors return structured responses");
}

async function runFakeScenario(apiUrl: string, scenario: CursorScenario): Promise<Buffer> {
  const session = http2.connect(apiUrl);
  const stream = session.request({
    ":method": "POST",
    ":path": "/agent.v1.AgentService/Run",
    "x-fake-cursor-scenario": scenario,
  });
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.close(http2.constants.NGHTTP2_CANCEL);
      session.destroy();
      reject(new Error(`Fixture scenario exceeded its deadline: ${scenario}`));
    }, 500);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      session.destroy();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.once("end", () => finish());
    stream.once("close", () => finish());
    stream.once("error", () => finish());
    stream.end();
  });
}

async function testFakeCursorScenarioHarness() {
  console.log("[test] Testing bounded fake Cursor scenario harness...");
  const fixture = await createFakeCursorServer({ deadlineMs: 100 });
  try {
    for (const scenario of CURSOR_SCENARIOS) {
      fixture.setScenario(scenario);
      await runFakeScenario(fixture.apiUrl, scenario);
    }

    fixture.trackChild(4242);
    let caughtLeak = false;
    try {
      fixture.assertClean();
    } catch (error) {
      caughtLeak = error instanceof Error && error.message.includes("child process");
    }
    assert(caughtLeak, "Fixture cleanup assertion did not detect a deliberately leaked child");
    fixture.untrackChild(4242);
    fixture.trackBridgeEntry("deliberate-leak");
    let caughtBridgeLeak = false;
    try {
      fixture.assertClean();
    } catch (error) {
      caughtBridgeLeak = error instanceof Error && error.message.includes("bridge map entry");
    }
    assert(caughtBridgeLeak, "Fixture cleanup assertion did not detect a deliberately leaked bridge entry");
    fixture.untrackBridgeEntry("deliberate-leak");
    await Bun.sleep(25);
    fixture.assertClean();
  } finally {
    await fixture.close();
  }
  console.log(`[test] Fake Cursor scenarios selectable (${CURSOR_SCENARIOS.length}) and cleanup assertions OK`);
}

interface SseObservation {
  body: string;
  timedOut: boolean;
}

function doneCount(body: string): number {
  return body.split("data: [DONE]").length - 1;
}

async function observeProxyScenario(
  scenario: CursorScenario,
  deadlineMs = 125,
  environment: Record<string, string> = {},
): Promise<SseObservation> {
  const fixture = await createFakeCursorServer({ deadlineMs: 1_000 });
  fixture.setScenario(scenario);
  const childScript = `
    import { startProxy, stopProxy } from "./src/proxy.ts";
    const port = await startProxy(async () => "test-token");
    const response = await fetch("http://localhost:" + port + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test", stream: true, messages: [{ role: "user", content: "reproduce termination behavior" }] }),
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = "";
    const drain = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return { body, timedOut: false };
        body += decoder.decode(value, { stream: true });
      }
    })();
    const result = await Promise.race([
      drain,
      new Promise((resolve) => setTimeout(() => resolve({ body, timedOut: true }), ${deadlineMs})),
    ]);
    void reader.cancel().catch(() => {});
    stopProxy();
    console.log(JSON.stringify(result));
  `;
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", childScript],
    cwd: process.cwd(),
    env: { ...process.env, CURSOR_API_URL: fixture.apiUrl, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assertEqual(exitCode, 0, `Scenario subprocess failed (${scenario}): ${stderr}`);
    return JSON.parse(stdout.trim()) as SseObservation;
  } finally {
    await fixture.close();
  }
}

async function expectKnownFailure(
  label: string,
  expectedBehavior: () => Promise<void>,
  observed: () => string,
) {
  try {
    await expectedBehavior();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[known-failure] ${label}: ${observed()} (${message})`);
    return;
  }
  throw new Error(`Known failure unexpectedly passed: ${label}; remove its quarantine and make it required`);
}

async function testStreamingTerminationKnownFailures() {
  console.log("[test] Reproducing quarantined streaming termination failures...");

  const cleanEnd = await observeProxyScenario("clean-end-stream-kept-open");
  assert(!cleanEnd.timedOut && cleanEnd.body.includes("data: [DONE]"), "Clean end-stream must finish in the local H2 fixture");
  assertEqual(doneCount(cleanEnd.body), 1, "Clean end-stream must emit exactly one [DONE]");
  console.log("[test] Valid end-stream does not reproduce as an open SSE: bridge exit cascades to [DONE]");

  const errorEnd = await observeProxyScenario("error-end-stream");
  assert(errorEnd.body.includes("Connect error unavailable: fixture failure"), "Connect end-stream errors must preserve their code and message");
  assertEqual(doneCount(errorEnd.body), 1, "Connect end-stream errors must emit exactly one [DONE]");
  console.log("[test] Connect end-stream errors propagate exactly once");

  const emptyEnd = await observeProxyScenario("empty-end-stream");
  assert(!emptyEnd.timedOut, "Empty end-stream must terminate");
  assert(!emptyEnd.body.includes("[Error:"), "Empty end-stream must not emit an error");
  assertEqual(doneCount(emptyEnd.body), 1, "Empty end-stream must emit exactly one [DONE]");
  console.log("[test] Empty end-stream completes cleanly exactly once");

  const missingEnd = await observeProxyScenario("missing-end-stream");
  assert(missingEnd.body.includes("[Error:"), "Missing end-stream must be surfaced as an error");
  assertEqual(doneCount(missingEnd.body), 1, "Missing end-stream must emit exactly one [DONE]");
  console.log("[test] Missing end-stream is an explicit error exactly once");

  const bridgeExit = await observeProxyScenario("frame-error");
  assert(bridgeExit.body.includes("[Error:"), "Bridge exit must be surfaced as an error");
  assertEqual(doneCount(bridgeExit.body), 1, "Bridge exit must emit exactly one [DONE]");
  console.log("[test] Bridge exit is an explicit error exactly once");

  const malformedTerminal = await observeProxyScenario("malformed-terminal");
  assert(malformedTerminal.body.includes("[Error:"), "Malformed terminal frame must be surfaced as an error");
  assertEqual(doneCount(malformedTerminal.body), 1, "Malformed terminal frame must emit exactly one [DONE]");
  console.log("[test] Malformed terminal frame is an explicit error exactly once");

  const malformedMessage = await observeProxyScenario("malformed-server-message");
  assert(malformedMessage.body.includes("Failed to process Cursor server message"), "Malformed protobuf payloads must reach the terminal error owner");
  assertEqual(doneCount(malformedMessage.body), 1, "Malformed protobuf payloads must emit exactly one [DONE]");
  console.log("[test] Malformed protobuf payloads terminate explicitly exactly once");

  const abruptClose = await observeProxyScenario("abrupt-session-close");
  assert(abruptClose.body.includes("[Error:"), "Abrupt HTTP/2 closure must be surfaced as an error");
  assertEqual(doneCount(abruptClose.body), 1, "Abrupt HTTP/2 closure must emit exactly one [DONE]");
  console.log("[test] Abrupt HTTP/2 closure is an explicit error exactly once");

  const frameError = await observeProxyScenario("frame-error");
  assert(frameError.body.includes("[Error:"), "HTTP/2 frame errors must be surfaced as an error");
  assertEqual(doneCount(frameError.body), 1, "HTTP/2 frame errors must emit exactly one [DONE]");
  console.log("[test] HTTP/2 frame errors are explicit exactly once");

  const goaway = await observeProxyScenario("goaway");
  assert(goaway.body.includes("[Error:"), "HTTP/2 GOAWAY must be surfaced as an error");
  assertEqual(doneCount(goaway.body), 1, "HTTP/2 GOAWAY must emit exactly one [DONE]");
  console.log("[test] HTTP/2 GOAWAY is explicit exactly once");

  const aborted = await observeProxyScenario("stream-aborted");
  assert(aborted.body.includes("[Error:"), "Aborted HTTP/2 streams must be surfaced as an error");
  assertEqual(doneCount(aborted.body), 1, "Aborted HTTP/2 streams must emit exactly one [DONE]");
  console.log("[test] Aborted HTTP/2 streams are explicit exactly once");

  const sessionTimeout = await observeProxyScenario("silent-transport", 250, {
    CURSOR_BRIDGE_SESSION_TIMEOUT_MS: "25",
    CURSOR_BRIDGE_PING_INTERVAL_MS: "1000",
  });
  assert(sessionTimeout.body.includes("[Error:"), "HTTP/2 session timeout must be surfaced as an error");
  assertEqual(doneCount(sessionTimeout.body), 1, "HTTP/2 session timeout must emit exactly one [DONE]");
  console.log("[test] HTTP/2 session timeout is explicit exactly once");

  const heartbeatTrickle = await observeProxyScenario("heartbeat-trickle-kept-open");
  assert(heartbeatTrickle.body.includes("[Error:"), "Heartbeat-only traffic must reach an explicit error terminal after transport closure");
  assertEqual(doneCount(heartbeatTrickle.body), 1, "Heartbeat-only transport closure must emit exactly one [DONE]");
  console.log("[test] Heartbeat-only transport closure is an explicit error exactly once");

  const turnEnded = await observeProxyScenario("turn-ended-kept-open");
  assert(turnEnded.body.includes("[Error:"), "turnEnded transport closure must not become a clean success");
  assertEqual(doneCount(turnEnded.body), 1, "turnEnded transport closure must emit exactly one [DONE]");
  console.log("[test] turnEnded transport closure is an explicit error exactly once");

  const slowProgress = await observeProxyScenario("slow-semantic-progress", 500);
  assert(!slowProgress.timedOut, "Slow semantic progress exceeded its bounded completion window");
  assert(!slowProgress.body.includes("[Error:"), "Slow semantic progress must not emit an error");
  for (const part of ["part-1", "part-2", "part-3"]) {
    assert(slowProgress.body.includes(part), `Slow semantic progress lost ${part}`);
  }
  assert(slowProgress.body.includes("data: [DONE]"), "Slow semantic progress must finish normally");
  console.log("[test] Slow semantic progress survives bounded streaming completion");
}

async function testServerMessageClassification(modules: TestModules) {
  console.log("[test] Testing server-message progress and unsupported-query classification...");
  const state = {
    toolCallIndex: 0,
    pendingExecs: [],
    outputTokens: 0,
    totalTokens: 0,
    semanticProgressCount: 0,
    lastSemanticProgressAt: 0,
  };
  const dispatch = (
    message: Parameters<typeof create>[1],
    onProtocolError?: (error: Error) => void,
    sendFrame: (data: Uint8Array) => void = () => {},
  ) =>
    modules.processServerMessage(
      create(AgentServerMessageSchema, message as never),
      new Map(), [], undefined, sendFrame, state, () => {}, () => {}, undefined, onProtocolError,
    );

  dispatch({ message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, {
    message: { case: "heartbeat", value: create(HeartbeatUpdateSchema, {}) },
  }) } });
  dispatch({ message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, {
    message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
  }) } });
  dispatch({ message: { case: "conversationCheckpointUpdate", value: create(ConversationStateStructureSchema, {}) } });
  assertEqual(state.semanticProgressCount, 0, "Heartbeat, turnEnded, and checkpoints must not count as semantic progress");

  dispatch({ message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, {
    message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "progress" }) },
  }) } });
  assertEqual(state.semanticProgressCount, 1, "Text output must count as semantic progress");

  let unsupportedError: Error | undefined;
  dispatch({ message: { case: "interactionQuery", value: create(InteractionQuerySchema, {
    id: 1,
    query: { case: "webSearchRequestQuery", value: {} },
  }) } }, (error) => { unsupportedError = error; });
  assert(unsupportedError?.message.includes("Unsupported Cursor interaction query"), "Unsupported blocking queries must trigger an explicit terminal error");
  unsupportedError = undefined;
  dispatch({ message: { case: "execServerControlMessage", value: create(ExecServerControlMessageSchema, {
    message: { case: "abort", value: { id: 1 } },
  }) } }, (error) => { unsupportedError = error; });
  assert(unsupportedError?.message.includes("Unsupported Cursor exec control message"), "Unsupported control messages must trigger an explicit terminal error");

  let writeFailure: Error | undefined;
  try {
    dispatch({ message: { case: "kvServerMessage", value: create(KvServerMessageSchema, {
      id: 1,
      message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId: new Uint8Array([1]) }) },
    }) } }, undefined, () => { throw new Error("bridge write rejected"); });
  } catch (error) {
    writeFailure = error instanceof Error ? error : new Error(String(error));
  }
  assertEqual(writeFailure?.message, "bridge write rejected", "Bridge write failures must propagate to the terminal owner");
  const { sendNativeExecResult } = await import("../src/native-tools");
  let nativeWriteFailure: Error | undefined;
  try {
    sendNativeExecResult(
      { execId: "dead-bridge", execMsgId: 1 },
      { resultType: "readResult", args: { path: "/tmp/never-written" } },
      "unreachable",
      () => false,
    );
  } catch (error) {
    nativeWriteFailure = error instanceof Error ? error : new Error(String(error));
  }
  assertEqual(
    nativeWriteFailure?.message,
    "Failed to write native tool result to Cursor bridge",
    "A dead bridge must explicitly reject native tool-result writes",
  );
  console.log("[test] Liveness traffic is non-progress and unsupported queries terminate explicitly");
}

async function runScenarioSubprocess(
  apiUrl: string,
  script: string,
): Promise<Record<string, unknown>> {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", script],
    cwd: process.cwd(),
    env: { ...process.env, CURSOR_API_URL: apiUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assertEqual(exitCode, 0, `Scenario subprocess failed: ${stderr}`);
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

async function observeToolResume(
  apiUrl: string,
  scenario: "tool-pause-resume" | "tool-pause-transport-death",
  collision = false,
): Promise<Record<string, unknown>> {
  return runScenarioSubprocess(apiUrl, `
    import { startProxy, stopProxy } from "./src/proxy.ts";
    const port = await startProxy(async () => "test-token");
    const base = "http://localhost:" + port + "/v1/chat/completions";
    const opening = "resume fixture collision-safe opening";
    const request = (messages) => fetch(base, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test", stream: true, messages, tools: [{ type: "function", function: { name: "fixture-tool", parameters: { type: "object" } } }] }),
    });
    const boundedText = async (response, deadlineMs = 150) => {
      const reader = response.body.getReader(); let text = "";
      const drain = (async () => { while (true) { const { done, value } = await reader.read(); if (done) return { text, timedOut: false }; text += new TextDecoder().decode(value, { stream: true }); } })();
      const result = await Promise.race([drain, new Promise(resolve => setTimeout(() => resolve({ text, timedOut: true }), deadlineMs))]);
      void reader.cancel().catch(() => {}); return result;
    };
    const first = await boundedText(await request([{ role: "user", content: opening }]));
    const firstCall = JSON.parse(first.text.match(/data: (.+)\\n\\n/)?.[1] ?? "{}").choices?.[0]?.delta?.tool_calls?.[0]?.id;
    if ("${scenario}" === "tool-pause-transport-death") await Bun.sleep(30);
    let second; let secondCall;
    if (${collision}) {
      second = await boundedText(await request([{ role: "user", content: opening }]));
      secondCall = JSON.parse(second.text.match(/data: (.+)\\n\\n/)?.[1] ?? "{}").choices?.[0]?.delta?.tool_calls?.[0]?.id;
    }
    const resumed = await boundedText(await request([
      { role: "user", content: opening },
      { role: "assistant", content: null, tool_calls: [{ id: firstCall, type: "function", function: { name: "fixture-tool", arguments: "{}" } }] },
      { role: "tool", tool_call_id: firstCall, content: "result-for-" + firstCall },
    ]));
    stopProxy();
    console.log(JSON.stringify({ first, firstCall, second, secondCall, resumed }));
    process.exit(0);
  `);
}

async function observeStalledRefresh(): Promise<Record<string, unknown>> {
  return runScenarioSubprocess("http://127.0.0.1:1", `
    import http from "node:http";
    const server = http.createServer((_, res) => { void res; });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    process.env.CURSOR_REFRESH_URL = "http://127.0.0.1:" + port + "/auth/exchange_user_api_key";
    process.env.CURSOR_REFRESH_TIMEOUT_MS = "25";
    const { refreshCursorToken } = await import("./src/auth.ts");
    const { startProxy, stopProxy } = await import("./src/proxy.ts");
    const proxyPort = await startProxy(async () => (await refreshCursorToken("stalled-refresh")).access);
    const pending = fetch("http://localhost:" + proxyPort + "/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "test", stream: true, messages: [{ role: "user", content: "refresh stall" }] }) });
    const result = await Promise.race([pending.then(async response => ({ headersReturned: true, status: response.status, body: await response.json() })), new Promise(resolve => setTimeout(() => resolve({ headersReturned: false }), 125))]);
    stopProxy(); server.close(); console.log(JSON.stringify(result)); process.exit(0);
  `);
}

async function observeSuccessfulRefresh(): Promise<Record<string, unknown>> {
  return runScenarioSubprocess("http://127.0.0.1:1", `
    import http from "node:http";
    const server = http.createServer((req, res) => {
      if (req.headers.authorization !== "Bearer valid-refresh") throw new Error("unexpected refresh authorization");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accessToken: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDAwMDAwMDB9.fakesig", refreshToken: "rotated-refresh" }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    process.env.CURSOR_REFRESH_URL = "http://127.0.0.1:" + server.address().port + "/auth/exchange_user_api_key";
    process.env.CURSOR_REFRESH_TIMEOUT_MS = "25";
    const { refreshCursorToken } = await import("./src/auth.ts");
    const refreshed = await refreshCursorToken("valid-refresh");
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    console.log(JSON.stringify({
      accessMatches: refreshed.access === "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDAwMDAwMDB9.fakesig",
      refreshMatches: refreshed.refresh === "rotated-refresh",
    }));
  `);
}

async function observeNonStreamingStall(apiUrl: string): Promise<Record<string, unknown>> {
  return runScenarioSubprocess(apiUrl, `
    import { startProxy, stopProxy } from "./src/proxy.ts";
    const port = await startProxy(async () => "test-token");
    const pending = fetch("http://localhost:" + port + "/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "test", stream: false, messages: [{ role: "user", content: "non-streaming stall" }] }) });
    const result = await Promise.race([pending.then(() => ({ headersReturned: true })), new Promise(resolve => setTimeout(() => resolve({ headersReturned: false }), 125))]);
    stopProxy(); console.log(JSON.stringify(result)); process.exit(0);
  `);
}

async function testResumeRefreshAndNonStreamingKnownFailures(modules: TestModules) {
  console.log("[test] Reproducing quarantined resume, refresh, and collection failures...");
  const fixture = await createFakeCursorServer({ deadlineMs: 1_000 });
  try {
    fixture.setScenario("tool-pause-resume");
    const liveResume = await observeToolResume(fixture.apiUrl, "tool-pause-resume");
    assert(
      String((liveResume.resumed as { text?: string }).text ?? "").includes("resumed-correctly"),
      "Healthy tool resume must preserve the matching tool result",
    );
    console.log("[test] Healthy tool resume preserves the paused bridge and result");

    fixture.setScenario("tool-pause-transport-death");
    const deadResume = await observeToolResume(fixture.apiUrl, "tool-pause-transport-death");
    assert(
      String((deadResume.resumed as { text?: string }).text ?? "").includes('"finish_reason":"tool_calls"'),
      "A dead bridge must fall back to a new request instead of resuming the old stream",
    );
    console.log("[test] Transport death exits the child; resume follows the fresh-request fallback");

    fixture.setScenario("tool-pause-resume");
    const collision = await observeToolResume(fixture.apiUrl, "tool-pause-resume", true);
    assert(
      collision.secondCall !== undefined && collision.secondCall !== collision.firstCall,
      "Identical-opening conversations must receive distinct paused tool-call identities",
    );
    assert(
      String((collision.resumed as { text?: string }).text ?? "").includes("resumed-correctly"),
      "An identical-opening conversation must resume its own paused bridge",
    );
    assert(
      !String((collision.resumed as { text?: string }).text ?? "").includes("resumed-with-wrong-result"),
      "A tool result must never resume a different identical-opening conversation",
    );
    console.log("[test] Identical-opening conversations retain isolated paused bridges");

    fixture.setScenario("tool-pause-transport-death");
    const droppedWrite = await observeToolResume(fixture.apiUrl, "tool-pause-transport-death");
    assert(
      String((droppedWrite.resumed as { text?: string }).text ?? "").includes('"finish_reason":"tool_calls"'),
      "A closed transport must not accept a dropped resume write as a live bridge",
    );
    assert(
      !String((droppedWrite.resumed as { text?: string }).text ?? "").includes("resumed-correctly"),
      "A dead bridge must reject its pending result rather than accepting a stale write",
    );
    console.log("[test] Closed-stream bridge rejects stale writes and resumes through a fresh request");

    fixture.setScenario("tool-pause-clean-exit");
    const port = await modules.startProxy(async () => "test-token");
    const paused = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test", stream: true,
        messages: [{ role: "user", content: "paused bridge cleanup" }],
        tools: [{ type: "function", function: { name: "fixture-tool", parameters: { type: "object" } } }],
      }),
    });
    await paused.text();
    await Bun.sleep(40);
    assertEqual(modules.getActiveBridgeCount(), 0, "A clean terminal path must remove its paused bridge entry");
    modules.stopProxy();
    console.log("[test] Clean paused-bridge exit removes its active bridge entry");
  } finally {
    await fixture.close();
  }

  const refresh = await observeStalledRefresh();
  assert(refresh.headersReturned === true, "Refresh stall must not leave the request pre-header");
  assertEqual(refresh.status, 504, "Refresh timeout must return Gateway Timeout");
  const refreshError = refresh.body as { error?: { message?: string; type?: string; code?: string } };
  assertEqual(refreshError.error?.type, "gateway_timeout", "Refresh timeout must be a structured timeout error");
  assertEqual(refreshError.error?.code, "token_refresh_timeout", "Refresh timeout must identify the refresh boundary");
  assert(!JSON.stringify(refreshError).includes("stalled-refresh"), "Refresh timeout errors must not expose refresh credentials");
  console.log("[test] Stalled token refresh returns a bounded, redacted structured error");

  const successfulRefresh = await observeSuccessfulRefresh();
  assertEqual(successfulRefresh.accessMatches, true, "Successful refresh must preserve the access token");
  assertEqual(successfulRefresh.refreshMatches, true, "Successful refresh must preserve a rotated refresh token");
  console.log("[test] Successful token refresh completes within the configured bound");

  const collectionFixture = await createFakeCursorServer({ deadlineMs: 1_000 });
  try {
    collectionFixture.setScenario("heartbeat-trickle-kept-open");
    const nonStreaming = await observeNonStreamingStall(collectionFixture.apiUrl);
    await expectKnownFailure(
      "non-streaming collection reaches a bounded terminal response",
      async () => assert(nonStreaming.headersReturned === true, "Non-streaming collection must not wait forever for bridge close"),
      () => `observed headersReturned=${String(nonStreaming.headersReturned)}`,
    );
  } finally {
    await collectionFixture.close();
  }
}

async function testLifecycleDiagnostics(modules: TestModules) {
  console.log("[test] Testing redacted lifecycle diagnostics...");
  const originalSetting = process.env.CURSOR_PROXY_DIAGNOSTICS;
  const fakeToken = "fake-access-token-DO-NOT-LOG";
  const secretPrompt = "prompt-content-DO-NOT-LOG";
  const secretToolPayload = "tool-payload-DO-NOT-LOG";
  const request = {
    model: "test",
    stream: true,
    messages: [{ role: "user", content: secretPrompt }],
    tools: [{
      type: "function",
      function: { name: "example", parameters: { type: "object", example: secretToolPayload } },
    }],
  };
  const runRequest = async () => {
    const port = await modules.startProxy(async () => fakeToken);
    const response = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${fakeToken}` },
      body: JSON.stringify(request),
    });
    await response.text();
    await Bun.sleep(150);
    modules.stopProxy();
  };

  try {
    delete process.env.CURSOR_PROXY_DIAGNOSTICS;
    const disabled = await captureDiagnosticOutput(runRequest);
    assertEqual(disabled.lines.length, 0, "Diagnostics must be silent when disabled");

    process.env.CURSOR_PROXY_DIAGNOSTICS = "1";
    const enabled = await captureDiagnosticOutput(runRequest);
    const events = enabled.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const stages = new Set(events.map((event) => event.stage));
    for (const stage of [
      "proxy_entry", "auth_access_start", "auth_access_complete", "bridge_spawn",
      "bridge_start", "h2_connect", "connect_stream", "bridge_data", "connect_frame",
      "message_dispatch", "sse_emission", "terminal",
    ]) {
      assert(stages.has(stage), `Missing diagnostic lifecycle stage: ${stage}`);
    }
    const requestIds = new Set(events.map((event) => event.requestId));
    assertEqual(requestIds.size, 1, "Expected one shared diagnostic correlation ID");
    assert(events.every((event) => typeof event.elapsedMs === "number"), "Expected monotonic diagnostic timing");
    const output = enabled.lines.join("\n");
    for (const secret of [fakeToken, secretPrompt, secretToolPayload]) {
      assert(!output.includes(secret), `Diagnostic output leaked secret: ${secret}`);
    }
  } finally {
    if (originalSetting === undefined) delete process.env.CURSOR_PROXY_DIAGNOSTICS;
    else process.env.CURSOR_PROXY_DIAGNOSTICS = originalSetting;
    modules.stopProxy();
  }
  console.log("[test] Redacted lifecycle diagnostics OK");
}

async function testExpiredTokenRefreshBeforeDiscovery(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing refresh-before-discovery...");
  modules.clearModelCache();
  backend.resetObservations();
  backend.setDiscoveryMode("success");
  backend.setDiscoveredModels([
    { id: "fresh-model", name: "Fresh Model", reasoning: true },
  ]);

  let authState = {
    type: "oauth" as const,
    access: "expired-access",
    refresh: "valid-refresh",
    expires: Date.now() - 10_000,
  };
  const writes: Array<{ access: string; refresh: string; expires: number }> = [];
  const hooks = await modules.CursorAuthPlugin({
    client: {
      auth: {
        set: async ({ body }: any) => {
          writes.push(body);
          authState = body;
        },
      },
    },
  } as any);
  const provider = { models: {} as Record<string, unknown> } as any;

  await hooks.auth!.loader(async () => authState, provider);

  assertEqual(writes.length, 1, "Expected refreshed auth to be persisted once");
  assert(
    writes[0]?.access && writes[0].access !== "expired-access",
    "Expected refreshed access token to replace the expired token",
  );
  assertArrayEqual(
    backend.getRefreshAuthHeaders(),
    ["Bearer valid-refresh"],
    "Expected refresh endpoint to be called with the stored refresh token",
  );
  assert(
    backend.getDiscoveryAuthHeaders().every((header) => header === `Bearer ${writes[0]?.access}`),
    `Expected discovery to use the refreshed token, got ${JSON.stringify(backend.getDiscoveryAuthHeaders())}`,
  );
  assertArrayEqual(
    Object.keys(provider.models),
    ["auto", "fresh-model"],
    "Expected provider models to come from successful discovery",
  );

  modules.stopProxy();
  console.log("[test] Refresh-before-discovery OK");
}

async function testDiscoveryFallbackAndSuccess(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing discovery fallback and success...");

  const authState = {
    type: "oauth" as const,
    access: makeJwt(Math.floor(Date.now() / 1000) + 3600),
    refresh: "valid-refresh",
    expires: Date.now() + 3_600_000,
  };
  const hooks = await modules.CursorAuthPlugin({
    client: {
      auth: {
        set: async () => {},
      },
    },
  } as any);
  const provider = { models: { stale: { id: "stale" } } } as any;

  // Failed discovery should fall back to hardcoded models
  modules.clearModelCache();
  backend.setDiscoveryMode("empty");
  const degradedConfig = await hooks.auth!.loader(async () => authState, provider);
  assert(
    Object.keys(provider.models).length > 0,
    "Expected fallback models to be registered when discovery fails",
  );
  assert(
    !("stale" in provider.models),
    "Expected stale models to be replaced",
  );
  const degradedModelsRes = await fetch(`${degradedConfig.baseURL}/models`);
  assertEqual(degradedModelsRes.status, 200, "Expected degraded /v1/models to succeed");
  const degradedModelsBody = await degradedModelsRes.json();
  assert(
    degradedModelsBody.data.length > 0,
    "Expected proxy /v1/models to expose fallback models",
  );

  // Successful discovery should replace with real models
  modules.clearModelCache();
  backend.setDiscoveryMode("success");
  backend.setDiscoveredModels([
    { id: "real-model-a", name: "Real Model A" },
    { id: "real-model-b", name: "Real Model B", reasoning: true },
  ]);
  const discoveredConfig = await hooks.auth!.loader(async () => authState, provider);
  assertArrayEqual(
    Object.keys(provider.models).sort(),
    ["auto", "real-model-a", "real-model-b"],
    "Expected successful discovery to replace fallback models",
  );
  const discoveredModelsRes = await fetch(`${discoveredConfig.baseURL}/models`);
  assertEqual(discoveredModelsRes.status, 200, "Expected discovered /v1/models to succeed");
  const discoveredModelsBody = await discoveredModelsRes.json();
  assertArrayEqual(
    discoveredModelsBody.data.map((model: { id: string }) => model.id).sort(),
    ["auto", "real-model-a", "real-model-b"],
    "Expected proxy /v1/models to expose discovered models",
  );

  modules.stopProxy();
  console.log("[test] Discovery fallback and success OK");
}

async function main() {
  const backend = await createTestCursorBackend();
  process.env.CURSOR_API_URL = backend.apiUrl;
  process.env.CURSOR_REFRESH_URL = backend.refreshUrl;

  const modules = await loadModules();

  let unhandledRejection: unknown;
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejection = reason;
  };
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    await testProxyStartStop(modules);
    await testAuthParams(modules);
    await testTokenExpiry(modules);
    await testPluginShape(modules);
    await testArrayContentParsing(modules);
    await testNonStreamingProtocolErrorsAreStructured();
    await testFakeCursorScenarioHarness();
    await testStreamingTerminationKnownFailures();
    await testServerMessageClassification(modules);
    await testResumeRefreshAndNonStreamingKnownFailures(modules);
    await testLifecycleDiagnostics(modules);
    await testExpiredTokenRefreshBeforeDiscovery(modules, backend);
    await testDiscoveryFallbackAndSuccess(modules, backend);
    await Bun.sleep(0);
    assert(!unhandledRejection, `Unhandled rejection escaped the smoke harness: ${String(unhandledRejection)}`);
    console.log("\n✓ All smoke tests passed");
    process.exitCode = 0;
  } catch (err) {
    console.error("\n✗ Smoke test failed:", err);
    process.exitCode = 1;
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    modules.stopProxy();
    await backend.close();
  }
}

main();
