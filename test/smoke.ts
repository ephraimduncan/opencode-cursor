import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  GetUsableModelsResponseSchema,
  ModelDetailsSchema,
} from "../src/proto/agent_pb";

type DiscoveryMode = "success" | "empty" | "auth-error";

interface TestModules {
  startProxy: typeof import("../src/proxy").startProxy;
  stopProxy: typeof import("../src/proxy").stopProxy;
  getProxyPort: typeof import("../src/proxy").getProxyPort;
  generateCursorAuthParams: typeof import("../src/auth").generateCursorAuthParams;
  getTokenExpiry: typeof import("../src/auth").getTokenExpiry;
  CursorAuthPlugin: typeof import("../src/index").CursorAuthPlugin;
  loadCursorModelCatalog: typeof import("../src/models").loadCursorModelCatalog;
  CURSOR_FALLBACK_MODELS: typeof import("../src/models").CURSOR_FALLBACK_MODELS;
}

interface TestCursorBackend {
  apiUrl: string;
  refreshUrl: string;
  setDiscoveryMode: (mode: DiscoveryMode) => void;
  setDiscoveredModels: (models: Array<{ id: string; name: string; reasoning?: boolean }>) => void;
  resetObservations: () => void;
  getDiscoveryAuthHeaders: () => string[];
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

async function createTestCursorBackend(): Promise<TestCursorBackend> {
  let discoveryMode: DiscoveryMode = "success";
  let discoveredModels: Array<{ id: string; name: string; reasoning?: boolean }> = [
    { id: "composer-2", name: "Composer 2", reasoning: true },
  ];
  const discoveryAuthHeaders: string[] = [];
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
      stream.end();
      return;
    }

    const chunks: Buffer[] = [];

    stream.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    stream.on("end", () => {
      if (path === "/agent.v1.AgentService/GetUsableModels") {
        discoveryAuthHeaders.push(authHeader);

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
          ? Buffer.from([0, 0, 0, 0, 0])
          : Buffer.from(
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
      refreshAuthHeaders.length = 0;
    },
    getDiscoveryAuthHeaders() {
      return [...discoveryAuthHeaders];
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
    generateCursorAuthParams: auth.generateCursorAuthParams,
    getTokenExpiry: auth.getTokenExpiry,
    CursorAuthPlugin: index.CursorAuthPlugin,
    loadCursorModelCatalog: models.loadCursorModelCatalog,
    CURSOR_FALLBACK_MODELS: models.CURSOR_FALLBACK_MODELS,
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

  modules.stopProxy();
  console.log("[test] Array content parsing OK");
}

async function testExpiredTokenRefreshBeforeDiscovery(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing refresh-before-discovery...");
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
    ["fresh-model"],
    "Expected provider models to come from successful discovery",
  );

  modules.stopProxy();
  console.log("[test] Refresh-before-discovery OK");
}

async function testDiscoveryDegradedModes(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing degraded discovery modes...");

  backend.setDiscoveryMode("empty");
  const emptyCatalog = await modules.loadCursorModelCatalog({
    apiKey: "fresh-access",
    baseUrl: backend.apiUrl,
    timeoutMs: 500,
  });
  assertEqual(emptyCatalog.source, "fallback", "Expected empty discovery to use fallback catalog");
  assertEqual(emptyCatalog.degraded, true, "Expected empty discovery to be marked degraded");
  assertEqual(emptyCatalog.diagnostics.status, "empty", "Expected empty discovery status");
  assertEqual(
    emptyCatalog.diagnostics.issues[0]?.code,
    "empty_models",
    "Expected empty discovery issue code",
  );

  const transportCatalog = await modules.loadCursorModelCatalog({
    apiKey: "fresh-access",
    baseUrl: "http://127.0.0.1:1",
    timeoutMs: 250,
  });
  assertEqual(transportCatalog.source, "fallback", "Expected transport failure to use fallback catalog");
  assertEqual(transportCatalog.degraded, true, "Expected transport failure to be marked degraded");
  assertEqual(transportCatalog.diagnostics.status, "failed", "Expected transport failure status");
  assertEqual(
    transportCatalog.diagnostics.issues[0]?.code,
    "transport",
    "Expected transport failure issue code",
  );

  console.log("[test] Degraded discovery modes OK");
}

async function testSuccessfulDiscoveryReplacesFallbackState(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing provider model replacement...");

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

  backend.setDiscoveryMode("empty");
  await hooks.auth!.loader(async () => authState, provider);
  assertArrayEqual(
    Object.keys(provider.models).sort(),
    modules.CURSOR_FALLBACK_MODELS.map((model) => model.id).sort(),
    "Expected first degraded load to register the fallback catalog only",
  );

  backend.setDiscoveryMode("success");
  backend.setDiscoveredModels([
    { id: "real-model-a", name: "Real Model A" },
    { id: "real-model-b", name: "Real Model B", reasoning: true },
  ]);
  await hooks.auth!.loader(async () => authState, provider);
  assertArrayEqual(
    Object.keys(provider.models).sort(),
    ["real-model-a", "real-model-b"],
    "Expected successful discovery to replace stale fallback models",
  );

  modules.stopProxy();
  console.log("[test] Provider model replacement OK");
}

async function testFallbackCatalogCurrent(modules: TestModules) {
  console.log("[test] Testing fallback catalog contents...");
  assertArrayEqual(
    modules.CURSOR_FALLBACK_MODELS.map((model) => model.id),
    [
      "composer-2",
      "composer-2-fast",
      "composer-1.5",
      "claude-4.6-sonnet",
      "claude-4.6-opus",
      "gpt-5.4",
      "gpt-5.3-codex",
      "gemini-3.1-pro",
      "gemini-3-flash",
      "grok-4.20",
    ],
    "Unexpected fallback model catalog",
  );
  console.log("[test] Fallback catalog OK");
}

async function main() {
  const backend = await createTestCursorBackend();
  process.env.CURSOR_API_URL = backend.apiUrl;
  process.env.CURSOR_REFRESH_URL = backend.refreshUrl;

  const modules = await loadModules();

  try {
    await testProxyStartStop(modules);
    await testAuthParams(modules);
    await testTokenExpiry(modules);
    await testPluginShape(modules);
    await testArrayContentParsing(modules);
    await testExpiredTokenRefreshBeforeDiscovery(modules, backend);
    await testDiscoveryDegradedModes(modules, backend);
    await testSuccessfulDiscoveryReplacesFallbackState(modules, backend);
    await testFallbackCatalogCurrent(modules);
    console.log("\n✓ All smoke tests passed");
    process.exitCode = 0;
  } catch (err) {
    console.error("\n✗ Smoke test failed:", err);
    process.exitCode = 1;
  } finally {
    modules.stopProxy();
    await backend.close();
  }
}

main();
