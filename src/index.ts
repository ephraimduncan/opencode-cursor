/**
 * OpenCode Cursor Auth Plugin
 *
 * Enables using Cursor models (Claude, GPT, etc.) inside OpenCode via:
 * 1. Browser-based OAuth login to Cursor
 * 2. Local proxy translating OpenAI format → Cursor gRPC protocol
 */
import type { Config, Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Model as ModelV2 } from "@opencode-ai/sdk/v2";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  generateCursorAuthParams,
  getTokenExpiry,
  pollCursorAuth,
  refreshCursorToken,
} from "./auth";
import { getCursorModels, type CursorModel } from "./models";
import { startProxy } from "./proxy";

const CURSOR_PROVIDER_ID = "cursor";

/** Model map in opencode's config schema (what the `config` hook injects). */
type ConfigProviderModels = NonNullable<
  NonNullable<Config["provider"]>[string]["models"]
>;

/** Model map in opencode's v2 catalog schema (what the `provider` hook returns). */
type CatalogModels = Record<string, ModelV2>;

interface StoredOAuth {
  type: "oauth";
  refresh: string;
  access?: string;
  expires?: number;
}

/** Read the stored cursor OAuth record directly from disk (mirrors core's Auth.all). */
async function readStoredCursorAuth(): Promise<StoredOAuth | undefined> {
  try {
    const dataDir = process.env.XDG_DATA_HOME
      ? join(process.env.XDG_DATA_HOME, "opencode")
      : join(homedir(), ".local", "share", "opencode");
    const content =
      process.env.OPENCODE_AUTH_CONTENT ??
      (await readFile(join(dataDir, "auth.json"), "utf8"));
    const entry = JSON.parse(content)?.[CURSOR_PROVIDER_ID];
    if (entry?.type === "oauth" && typeof entry.refresh === "string") {
      return entry as StoredOAuth;
    }
  } catch {}
  return undefined;
}

/** Persist refreshed credentials via the opencode server so rotated refresh tokens are not lost. */
async function persistCursorAuth(
  input: PluginInput,
  creds: { refresh: string; access: string; expires: number },
): Promise<void> {
  await input.client.auth.set({
    path: { id: CURSOR_PROVIDER_ID },
    body: {
      type: "oauth",
      refresh: creds.refresh,
      access: creds.access,
      expires: creds.expires,
    },
  });
}

/**
 * Get a usable access token from the on-disk auth store, refreshing when
 * expired. Used by hooks that run before opencode exposes auth state
 * (the `config` hook) and by the standalone proxy token provider.
 */
async function resolveDiskAccessToken(
  input: PluginInput,
): Promise<string | undefined> {
  const stored = await readStoredCursorAuth();
  if (!stored) return undefined;
  if (stored.access && (stored.expires ?? 0) > Date.now()) return stored.access;
  try {
    const refreshed = await refreshCursorToken(stored.refresh);
    // Best-effort: rotated refresh tokens must be saved, but a persistence
    // failure should not block model discovery for this run.
    await persistCursorAuth(input, refreshed).catch(() => {});
    return refreshed.access;
  } catch {
    return undefined;
  }
}

/**
 * Model entries in opencode's *config* schema (snake_case cost fields).
 * Injected via the `config` hook so opencode >= 1.18 merges them into its
 * provider catalog; the v2 catalog no longer picks up models mutated inside
 * `auth.loader` (issue #30).
 */
function buildConfigModels(models: CursorModel[]): ConfigProviderModels {
  return Object.fromEntries(
    models.map((model) => {
      const cost = estimateModelCost(model.id);
      return [
        model.id,
        {
          name: model.name,
          temperature: true,
          reasoning: model.reasoning,
          attachment: false,
          tool_call: true,
          limit: { context: model.contextWindow, output: model.maxTokens },
          cost: {
            input: cost.input,
            output: cost.output,
            cache_read: cost.cache.read,
            cache_write: cost.cache.write,
          },
        },
      ];
    }),
  );
}

/**
 * OpenCode plugin that provides Cursor authentication and model access.
 * Register in opencode.json: { "plugin": ["opencode-cursor-oauth"] }
 */
export const CursorAuthPlugin: Plugin = async (
  input: PluginInput,
): Promise<Hooks> => {
  return {
    /**
     * opencode >= 1.18 builds its provider catalog from config + models.dev
     * before auth loaders run, and `auth.loader` only receives a deep copy of
     * the provider. Injecting the provider stub and discovered models into the
     * config here is the only path that reaches the v2 catalog (issue #30).
     */
    async config(cfg) {
      try {
        const providers = (cfg.provider ??= {});
        const cursor = (providers[CURSOR_PROVIDER_ID] ??= {});
        cursor.name ??= "Cursor";

        const accessToken = await resolveDiskAccessToken(input);
        if (!accessToken) return;

        const models = await getCursorModels(accessToken);
        const configModels = (cursor.models ??= {});
        for (const [id, model] of Object.entries(buildConfigModels(models))) {
          // User-defined model entries win over discovered ones.
          configModels[id] ??= model;
        }
      } catch {
        // Never block opencode startup on discovery problems; the auth
        // loader still provides baseURL/fetch for any configured models.
      }
    },

    /**
     * v2 catalog hook (opencode >= 1.18). Only invoked when the `cursor`
     * provider already exists in opencode's catalog; returns the full
     * discovered model set backed by the local proxy.
     */
    provider: {
      id: CURSOR_PROVIDER_ID,
      async models(_provider, ctx) {
        const auth = ctx.auth;
        if (!auth || auth.type !== "oauth") return {};

        let accessToken = auth.access;
        if (!accessToken || auth.expires < Date.now()) {
          const refreshed = await refreshCursorToken(auth.refresh);
          await persistCursorAuth(input, refreshed).catch(() => {});
          accessToken = refreshed.access;
        }

        const models = await getCursorModels(accessToken);
        const port = await startProxy(async () => {
          const token = await resolveDiskAccessToken(input);
          if (!token) throw new Error("Cursor auth not configured");
          return token;
        }, models);
        return buildCursorProviderModels(models, port);
      },
    },

    auth: {
      provider: CURSOR_PROVIDER_ID,

      async loader(getAuth, provider) {
        const auth = await getAuth();
        if (!auth || auth.type !== "oauth") return {};

        // Ensure we have a valid access token, refreshing if expired
        let accessToken = auth.access;
        if (!accessToken || auth.expires < Date.now()) {
          const refreshed = await refreshCursorToken(auth.refresh);
          await input.client.auth.set({
            path: { id: CURSOR_PROVIDER_ID },
            body: {
              type: "oauth",
              refresh: refreshed.refresh,
              access: refreshed.access,
              expires: refreshed.expires,
            },
          });
          accessToken = refreshed.access;
        }

        const models = await getCursorModels(accessToken);

        const port = await startProxy(async () => {
          const currentAuth = await getAuth();
          if (currentAuth.type !== "oauth") {
            throw new Error("Cursor auth not configured");
          }

          if (!currentAuth.access || currentAuth.expires < Date.now()) {
            const refreshed = await refreshCursorToken(currentAuth.refresh);
            await input.client.auth.set({
              path: { id: CURSOR_PROVIDER_ID },
              body: {
                type: "oauth",
                refresh: refreshed.refresh,
                access: refreshed.access,
                expires: refreshed.expires,
              },
            });
            return refreshed.access;
          }

          return currentAuth.access;
        }, models);

        if (provider) {
          (provider as any).models = buildCursorProviderModels(models, port);
        }

        return {
          baseURL: `http://localhost:${port}/v1`,
          apiKey: "cursor-proxy",
          async fetch(
            requestInput: RequestInfo | URL,
            init?: RequestInit,
          ) {
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization");
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(
                  ([key]) => key.toLowerCase() !== "authorization",
                );
              } else {
                delete (init.headers as Record<string, string>)[
                  "authorization"
                ];
                delete (init.headers as Record<string, string>)[
                  "Authorization"
                ];
              }
            }

            return fetch(requestInput, init);
          },
        };
      },

      methods: [
        {
          type: "oauth",
          label: "Login with Cursor",
          async authorize() {
            const { verifier, uuid, loginUrl } =
              await generateCursorAuthParams();

            return {
              url: loginUrl,
              instructions:
                "Complete login in your browser. This window will close automatically.",
              method: "auto" as const,
              async callback() {
                const { accessToken, refreshToken } = await pollCursorAuth(
                  uuid,
                  verifier,
                );

                return {
                  type: "success" as const,
                  refresh: refreshToken,
                  access: accessToken,
                  expires: getTokenExpiry(accessToken),
                };
              },
            };
          },
        },
      ],
    },
  };
};

function buildCursorProviderModels(
  models: CursorModel[],
  port: number,
): CatalogModels {
  return Object.fromEntries(
    models.map((model) => [
      model.id,
      {
        id: model.id,
        providerID: CURSOR_PROVIDER_ID,
        api: {
          id: model.id,
          url: `http://localhost:${port}/v1`,
          npm: "@ai-sdk/openai-compatible",
        },
        name: model.name,
        capabilities: {
          temperature: true,
          reasoning: model.reasoning,
          attachment: false,
          toolcall: true,
          input: {
            text: true,
            audio: false,
            image: false,
            video: false,
            pdf: false,
          },
          output: {
            text: true,
            audio: false,
            image: false,
            video: false,
            pdf: false,
          },
          interleaved: false,
        },
        cost: estimateModelCost(model.id),
        limit: {
          context: model.contextWindow,
          output: model.maxTokens,
        },
        status: "active" as const,
        options: {},
        headers: {},
        release_date: "",
        variants: {},
      },
    ]),
  );
}

interface ModelCost {
  input: number;
  output: number;
  cache: { read: number; write: number };
}

// $/M token rates from cursor.com/docs/models-and-pricing
const MODEL_COST_TABLE: Record<string, ModelCost> = {
  // Anthropic
  "claude-4-sonnet":         { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
  "claude-4-sonnet-1m":      { input: 6, output: 22.5, cache: { read: 0.6, write: 7.5 } },
  "claude-4.5-haiku":        { input: 1, output: 5, cache: { read: 0.1, write: 1.25 } },
  "claude-4.5-opus":         { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
  "claude-4.5-sonnet":       { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
  "claude-4.6-opus":         { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
  "claude-4.6-opus-fast":    { input: 30, output: 150, cache: { read: 3, write: 37.5 } },
  "claude-4.6-sonnet":       { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },

  // Cursor
  "composer-1":              { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "composer-1.5":            { input: 3.5, output: 17.5, cache: { read: 0.35, write: 0 } },
  "composer-2":              { input: 0.5, output: 2.5, cache: { read: 0.2, write: 0 } },
  "composer-2-fast":         { input: 1.5, output: 7.5, cache: { read: 0.2, write: 0 } },

  // Google
  "gemini-2.5-flash":        { input: 0.3, output: 2.5, cache: { read: 0.03, write: 0 } },
  "gemini-3-flash":          { input: 0.5, output: 3, cache: { read: 0.05, write: 0 } },
  "gemini-3-pro":            { input: 2, output: 12, cache: { read: 0.2, write: 0 } },
  "gemini-3-pro-image":      { input: 2, output: 12, cache: { read: 0.2, write: 0 } },
  "gemini-3.1-pro":          { input: 2, output: 12, cache: { read: 0.2, write: 0 } },

  // OpenAI
  "gpt-5":                   { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "gpt-5-fast":              { input: 2.5, output: 20, cache: { read: 0.25, write: 0 } },
  "gpt-5-mini":              { input: 0.25, output: 2, cache: { read: 0.025, write: 0 } },
  "gpt-5-codex":             { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "gpt-5.1-codex":           { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "gpt-5.1-codex-max":       { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "gpt-5.1-codex-mini":      { input: 0.25, output: 2, cache: { read: 0.025, write: 0 } },
  "gpt-5.2":                 { input: 1.75, output: 14, cache: { read: 0.175, write: 0 } },
  "gpt-5.2-codex":           { input: 1.75, output: 14, cache: { read: 0.175, write: 0 } },
  "gpt-5.3-codex":           { input: 1.75, output: 14, cache: { read: 0.175, write: 0 } },
  "gpt-5.4":                 { input: 2.5, output: 15, cache: { read: 0.25, write: 0 } },
  "gpt-5.4-mini":            { input: 0.75, output: 4.5, cache: { read: 0.075, write: 0 } },
  "gpt-5.4-nano":            { input: 0.2, output: 1.25, cache: { read: 0.02, write: 0 } },

  // xAI
  "grok-4.20":               { input: 2, output: 6, cache: { read: 0.2, write: 0 } },

  // Moonshot
  "kimi-k2.5":               { input: 0.6, output: 3, cache: { read: 0.1, write: 0 } },
};

// Most-specific first
const MODEL_COST_PATTERNS: Array<{ match: (id: string) => boolean; cost: ModelCost }> = [
  { match: (id) => /claude.*opus.*fast/i.test(id),   cost: MODEL_COST_TABLE["claude-4.6-opus-fast"]! },
  { match: (id) => /claude.*opus/i.test(id),         cost: MODEL_COST_TABLE["claude-4.6-opus"]! },
  { match: (id) => /claude.*haiku/i.test(id),        cost: MODEL_COST_TABLE["claude-4.5-haiku"]! },
  { match: (id) => /claude.*sonnet/i.test(id),       cost: MODEL_COST_TABLE["claude-4.6-sonnet"]! },
  { match: (id) => /claude/i.test(id),               cost: MODEL_COST_TABLE["claude-4.6-sonnet"]! },
  { match: (id) => /composer-?2/i.test(id),          cost: MODEL_COST_TABLE["composer-2"]! },
  { match: (id) => /composer-?1\.5/i.test(id),      cost: MODEL_COST_TABLE["composer-1.5"]! },
  { match: (id) => /composer/i.test(id),             cost: MODEL_COST_TABLE["composer-1"]! },
  { match: (id) => /gpt-5\.4.*nano/i.test(id),      cost: MODEL_COST_TABLE["gpt-5.4-nano"]! },
  { match: (id) => /gpt-5\.4.*mini/i.test(id),      cost: MODEL_COST_TABLE["gpt-5.4-mini"]! },
  { match: (id) => /gpt-5\.4/i.test(id),            cost: MODEL_COST_TABLE["gpt-5.4"]! },
  { match: (id) => /gpt-5\.3/i.test(id),            cost: MODEL_COST_TABLE["gpt-5.3-codex"]! },
  { match: (id) => /gpt-5\.2/i.test(id),            cost: MODEL_COST_TABLE["gpt-5.2"]! },
  { match: (id) => /gpt-5\.1.*mini/i.test(id),      cost: MODEL_COST_TABLE["gpt-5.1-codex-mini"]! },
  { match: (id) => /gpt-5\.1/i.test(id),            cost: MODEL_COST_TABLE["gpt-5.1-codex"]! },
  { match: (id) => /gpt-5.*mini/i.test(id),          cost: MODEL_COST_TABLE["gpt-5-mini"]! },
  { match: (id) => /gpt-5.*fast/i.test(id),          cost: MODEL_COST_TABLE["gpt-5-fast"]! },
  { match: (id) => /gpt-5/i.test(id),                cost: MODEL_COST_TABLE["gpt-5"]! },
  { match: (id) => /gemini.*3\.1/i.test(id),        cost: MODEL_COST_TABLE["gemini-3.1-pro"]! },
  { match: (id) => /gemini.*3.*flash/i.test(id),     cost: MODEL_COST_TABLE["gemini-3-flash"]! },
  { match: (id) => /gemini.*3/i.test(id),            cost: MODEL_COST_TABLE["gemini-3-pro"]! },
  { match: (id) => /gemini.*flash/i.test(id),        cost: MODEL_COST_TABLE["gemini-2.5-flash"]! },
  { match: (id) => /gemini/i.test(id),               cost: MODEL_COST_TABLE["gemini-3.1-pro"]! },
  { match: (id) => /grok/i.test(id),                 cost: MODEL_COST_TABLE["grok-4.20"]! },
  { match: (id) => /kimi/i.test(id),                 cost: MODEL_COST_TABLE["kimi-k2.5"]! },
];

const DEFAULT_COST: ModelCost = { input: 3, output: 15, cache: { read: 0.3, write: 0 } };

function estimateModelCost(modelId: string): ModelCost {
  const normalized = modelId.toLowerCase();
  const exact = MODEL_COST_TABLE[normalized];
  if (exact) return exact;

  const stripped = normalized.replace(/-(high|medium|low|preview|thinking|spark-preview)$/g, "");
  const strippedMatch = MODEL_COST_TABLE[stripped];
  if (strippedMatch) return strippedMatch;

  return MODEL_COST_PATTERNS.find((p) => p.match(normalized))?.cost ?? DEFAULT_COST;
}

export default CursorAuthPlugin;
