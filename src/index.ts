/**
 * OpenCode Cursor Auth Plugin
 *
 * Enables using Cursor models (Claude, GPT, etc.) inside OpenCode via:
 * 1. Browser-based OAuth login to Cursor
 * 2. Local proxy translating OpenAI format → Cursor gRPC protocol
 * 3. A `provider` hook that publishes discovered models into opencode's
 *    v2 provider catalog (so they appear in the model picker), using the
 *    stored OAuth token to call Cursor's GetUsableModels RPC.
 *
 * Catalog registration uses the `Hooks.provider` hook introduced in
 * @opencode-ai/plugin 1.2.27. Earlier versions of this plugin mutated
 * `provider.models` inside the `auth.loader`, which worked on older
 * opencode builds but is a no-op on opencode 1.18.x — the loader receives a
 * public copy of the provider, not the live catalog entry. The `provider`
 * hook is the supported way to populate models.
 */
import type { Hooks, Plugin, PluginInput, ProviderHook } from "@opencode-ai/plugin";
import type { Auth as AuthV2, Model as ModelV2 } from "@opencode-ai/sdk/v2";
import {
  generateCursorAuthParams,
  getTokenExpiry,
  pollCursorAuth,
  refreshCursorToken,
} from "./auth";
import { getCursorModels, type CursorModel } from "./models";
import { startProxy, getProxyPort } from "./proxy";

const CURSOR_PROVIDER_ID = "cursor";

/**
 * OpenCode plugin that provides Cursor authentication and model access.
 * Register in opencode.json: { "plugin": ["opencode-cursor-oauth"] }
 */
export const CursorAuthPlugin: Plugin = async (
  input: PluginInput,
): Promise<Hooks> => {
  /**
   * Resolve a valid Cursor access token from the stored auth, refreshing it
   * if missing or expired. Persists the refreshed credential back via the
   * SDK client so subsequent calls (and the proxy's token provider) see it.
   * Returns the access token, or undefined if no OAuth auth is stored.
   *
   * Shared between the `provider.models` hook (catalog build) and the
   * `auth.loader` hook (inference routing) so the proxy is started exactly
   * once and both hooks see the same token.
   */
  async function ensureAccessToken(
    getAuth: () => Promise<AuthV2 | undefined>,
  ): Promise<string | undefined> {
    const auth = await getAuth();
    if (!auth || auth.type !== "oauth") return undefined;

    if (auth.access && auth.expires > Date.now()) {
      return auth.access;
    }

    if (!auth.refresh) return undefined;

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
    return refreshed.access;
  }

  /**
   * Ensure the local proxy is running and return its port. Idempotent:
   * startProxy short-circuits when already bound. The token provider closure
   * re-reads auth on each inference request so it picks up refreshed tokens.
   */
  async function ensureProxy(
    getAuth: () => Promise<AuthV2 | undefined>,
    models: CursorModel[],
  ): Promise<number> {
    const port = getProxyPort();
    if (port) return port;
    return startProxy(async () => {
      const currentAuth = await getAuth();
      if (!currentAuth || currentAuth.type !== "oauth") {
        throw new Error("Cursor auth not configured");
      }
      if (currentAuth.access && currentAuth.expires > Date.now()) {
        return currentAuth.access;
      }
      const token = await ensureAccessToken(getAuth);
      if (!token) throw new Error("Cursor auth not configured");
      return token;
    }, models);
  }

  const providerHook: ProviderHook = {
    id: CURSOR_PROVIDER_ID,
    async models(_provider, ctx) {
      // No stored auth yet → user hasn't run `opencode auth login --provider
      // cursor`. Returning an empty map keeps the provider registered but
      // model-less, so the picker omits cursor until auth completes. The
      // daemon rebuilds the catalog (and re-runs this hook) after auth.set.
      if (!ctx.auth || ctx.auth.type !== "oauth") return {};

      const getAuth = async () => ctx.auth as AuthV2 | undefined;
      const accessToken = await ensureAccessToken(getAuth);
      if (!accessToken) return {};

      let models: CursorModel[];
      try {
        models = await getCursorModels(accessToken);
      } catch {
        return {};
      }

      const port = await ensureProxy(getAuth, models);
      return buildCursorProviderModels(models, port);
    },
  };

  return {
    provider: providerHook,

    auth: {
      provider: CURSOR_PROVIDER_ID,

      async loader(getAuth, _provider) {
        const auth = await getAuth();
        if (!auth || auth.type !== "oauth") return {};

        const accessToken = await ensureAccessToken(getAuth);
        if (!accessToken) return {};

        let models: CursorModel[];
        try {
          models = await getCursorModels(accessToken);
        } catch {
          models = await getCursorModels(accessToken);
        }

        const port = await ensureProxy(getAuth, models);

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
): Record<string, ModelV2> {
  return Object.fromEntries(
    models.map((model) => {
      const modelV2: ModelV2 = {
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
        status: "active",
        options: {},
        headers: {},
        release_date: "",
        variants: {},
      };
      return [model.id, modelV2];
    }),
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
