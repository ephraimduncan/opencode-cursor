/**
 * OpenCode Cursor Auth Plugin
 *
 * Enables using Cursor models (Claude, GPT, etc.) inside OpenCode via:
 * 1. Browser-based OAuth login to Cursor
 * 2. Local proxy translating OpenAI format → Cursor gRPC protocol
 */
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import {
  generateCursorAuthParams,
  getTokenExpiry,
  pollCursorAuth,
  refreshCursorToken,
} from "./auth";
import { getCursorModels, type CursorModel } from "./models";
import { startProxy } from "./proxy";

const CURSOR_PROVIDER_ID = "cursor";

/**
 * OpenCode plugin that provides Cursor authentication and model access.
 * Register in opencode.json: { "plugin": ["opencode-cursor-oauth"] }
 */
export const CursorAuthPlugin: Plugin = async (
  input: PluginInput,
): Promise<Hooks> => {
  return {
    auth: {
      provider: CURSOR_PROVIDER_ID,

      async loader(getAuth, provider) {
        try {
          const auth = await getAuth();
          if (!auth || auth.type !== "oauth") return {};

          // Ensure we have a valid access token, refreshing if expired
          let accessToken = auth.access;
          if (!accessToken || auth.expires < Date.now()) {
            if (!auth.refresh) {
              console.error("[cursor-oauth] No refresh token available — re-authenticate with: opencode auth login --provider cursor");
              return {};
            }
            try {
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
            } catch (refreshErr) {
              console.error(`[cursor-oauth] Token refresh failed: ${refreshErr instanceof Error ? refreshErr.message : refreshErr}`);
              console.error("[cursor-oauth] Re-authenticate with: opencode auth login --provider cursor");
              return {};
            }
          }

          let models: CursorModel[];
          try {
            models = await getCursorModels(accessToken);
          } catch (modelErr) {
            console.error(`[cursor-oauth] Model discovery failed, using fallback models: ${modelErr instanceof Error ? modelErr.message : modelErr}`);
            models = await getCursorModels(accessToken); // getCursorModels already has internal fallback
          }

          let port: number;
          try {
            port = await startProxy(async () => {
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
          } catch (proxyErr) {
            console.error(`[cursor-oauth] Proxy failed to start: ${proxyErr instanceof Error ? proxyErr.message : proxyErr}`);
            return {};
          }

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
        } catch (err) {
          // Catch-all: never let loader errors propagate and kill other plugins
          console.error(`[cursor-oauth] Loader failed: ${err instanceof Error ? err.message : err}`);
          return {};
        }
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
): Record<string, any> {
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
        cost: {
          input: 0,
          output: 0,
          cache: { read: 0, write: 0 },
        },
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

export default CursorAuthPlugin;
