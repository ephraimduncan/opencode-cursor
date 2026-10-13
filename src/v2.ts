import { Credential, Integration, Model, Plugin, PluginOptions } from "@opencode-ai/plugin";
import {
  generateCursorAuthParams,
  getTokenExpiry,
  pollCursorAuth,
  refreshCursorToken,
} from "./auth";
import {
  clearModelCache,
  getCursorModels,
  type CursorModel,
} from "./models";
import { startProxy, stopProxy } from "./proxy";

const CURSOR_ID = "cursor";
const CURSOR_INTEGRATION_ID = Integration.ID.make(CURSOR_ID);
const CURSOR_METHOD_ID = Integration.MethodID.make("cursor-oauth");
const OPENAI_COMPATIBLE_PACKAGE =
  "@opencode-ai/ai/providers/openai-compatible";
const CURSOR_DISABLE_HTTP2 = process.env.CURSOR_DISABLE_HTTP2 === "1";

interface CatalogState {
  readonly models: CursorModel[];
  readonly port: number;
}

interface CursorPluginOptions extends PluginOptions {
  disableHttp2?: boolean;
}

const CursorV2Plugin = Plugin.define({
  id: "opencode.cursor-oauth",
  setup: async (ctx, options?: CursorPluginOptions) => {
    await ctx.integration.transform((draft) => {
      draft.update(CURSOR_ID, (integration) => {
        integration.name = "Cursor";
      });
      draft.method.update({
        integrationID: CURSOR_INTEGRATION_ID,
        method: {
          id: CURSOR_METHOD_ID,
          type: "oauth",
          label: "Login with Cursor",
        },
        async authorize() {
          const { verifier, uuid, loginUrl } = await generateCursorAuthParams();
          return {
            mode: "auto",
            url: loginUrl,
            instructions:
              "Complete login in your browser. This window will close automatically.",
            callback: pollCursorAuth(uuid, verifier).then(
              ({ accessToken, refreshToken }) =>
                Credential.OAuth.make({
                  type: "oauth",
                  methodID: CURSOR_METHOD_ID,
                  refresh: refreshToken,
                  access: accessToken,
                  expires: getTokenExpiry(accessToken),
                }),
            ),
          };
        },
        async refresh(credential) {
          const refreshed = await refreshCursorToken(credential.refresh);
          return Credential.OAuth.make({
            ...credential,
            methodID: CURSOR_METHOD_ID,
            refresh: refreshed.refresh,
            access: refreshed.access,
            expires: refreshed.expires,
          });
        },
      });
    });
    // Setup batches transforms, so apply OAuth refresh before loading the catalog.
    await ctx.integration.reload();

    let catalog = await loadCatalog(ctx, options?.disableHttp2 ?? CURSOR_DISABLE_HTTP2);
    await ctx.catalog.transform((draft) => {
      const current = catalog;
      if (!current) return;

      draft.provider.update(CURSOR_ID, (provider) => {
        provider.integrationID = CURSOR_INTEGRATION_ID;
        provider.name = "Cursor";
        provider.activation = "auto";
        provider.package = OPENAI_COMPATIBLE_PACKAGE;
        provider.settings = {
          ...provider.settings,
          baseURL: `http://localhost:${current.port}/v1`,
        };
      });

      for (const cursorModel of current.models) {
        draft.model.update(CURSOR_ID, cursorModel.id, (model) => {
          model.modelID = Model.ID.make(cursorModel.id);
          model.name = cursorModel.name;
          model.capabilities = {
            tools: true,
            input: ["text"],
            output: ["text"],
          };
          model.limit = {
            context: cursorModel.contextWindow,
            output: cursorModel.maxTokens,
          };
          model.status = "active";
          model.enabled = true;
        });
      }
    });

    const stopWatching = watchConnections(ctx, async () => {
      clearModelCache();
      catalog = await loadCatalog(ctx, options?.disableHttp2 ?? CURSOR_DISABLE_HTTP2);
      if (!catalog) stopProxy();
      await ctx.catalog.reload();
    });

    return async () => {
      try {
        await stopWatching();
      } finally {
        stopProxy();
      }
    };
  },
});

export default CursorV2Plugin;

async function loadCatalog(
  ctx: Plugin.Context,
  disableHttp2: boolean,
): Promise<CatalogState | undefined> {
  try {
    const accessToken = await getAccessToken(ctx);
    const models = await getCursorModels(accessToken, disableHttp2);
    const port = await startProxy(() => getAccessToken(ctx), models, disableHttp2);
    return { models, port };
  } catch {
    return undefined;
  }
}

async function getAccessToken(ctx: Plugin.Context): Promise<string> {
  const connection = await ctx.integration.connection.active(CURSOR_ID);
  if (!connection) throw new Error("Cursor auth not configured");

  const credential = await ctx.integration.connection.resolve(connection);
  if (!credential || credential.type !== "oauth") {
    throw new Error("Cursor auth not configured");
  }
  return credential.access;
}

function watchConnections(
  ctx: Plugin.Context,
  refresh: () => Promise<void>,
): () => Promise<void> {
  const events = ctx.event.subscribe()[Symbol.asyncIterator]();
  const watcher = (async () => {
    try {
      while (true) {
        const next = await events.next();
        if (next.done) return;
        const event = next.value;
        if (
          event.type === "integration.connection.updated" &&
          event.data.integrationID === CURSOR_ID
        ) {
          await refresh().catch(() => {});
        }
      }
    } catch {}
  })();

  return async () => {
    await events.return?.();
    await watcher;
  };
}
