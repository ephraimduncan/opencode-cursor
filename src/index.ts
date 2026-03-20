/**
 * OpenCode Cursor Auth Plugin
 *
 * Enables using Cursor models (Claude, GPT, etc.) inside OpenCode via:
 * 1. Browser-based OAuth login to Cursor
 * 2. Local proxy translating OpenAI format → Cursor gRPC protocol
 */
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import {
  ensureCursorAccessToken,
  generateCursorAuthParams,
  getTokenExpiry,
  pollCursorAuth,
} from "./auth";
import {
  loadCursorModelCatalog,
  type CursorModel,
  type CursorModelCatalog,
} from "./models";
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
        const auth = await getAuth();
        if (!auth || auth.type !== "oauth") return {};

        const getValidAccessToken = () =>
          ensureCursorAccessToken({
            getAuth: async () => {
              const currentAuth = await getAuth();
              return currentAuth && currentAuth.type === "oauth"
                ? currentAuth
                : null;
            },
            persistAuth: async (credentials) => {
              await input.client.auth.set({
                path: { id: CURSOR_PROVIDER_ID },
                body: {
                  type: "oauth",
                  refresh: credentials.refresh,
                  access: credentials.access,
                  expires: credentials.expires,
                },
              });
            },
          });

        const accessToken = await getValidAccessToken();
        const modelCatalog = await loadCursorModelCatalog({ apiKey: accessToken });
        const port = await startProxy(getValidAccessToken, modelCatalog.models);

        reportModelDiscovery(modelCatalog);

        if (provider) {
          (provider as any).models = buildCursorProviderModels(modelCatalog.models, port);
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

function reportModelDiscovery(catalog: CursorModelCatalog): void {
  if (catalog.diagnostics.issues.length === 0) return;

  const summary = catalog.diagnostics.issues
    .map((issue) => `${issue.code}: ${issue.message}`)
    .join("; ");

  if (catalog.degraded) {
    console.warn(
      `[cursor] Model discovery degraded; using fallback catalog (${summary})`,
    );
    return;
  }

  console.warn(`[cursor] Model discovery incomplete; using parsed subset (${summary})`);
}

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
