import {
  Credential,
  Integration,
  Model,
  Plugin,
  Provider,
} from "@opencode/plugin";
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
const CURSOR_METHOD_ID = "cursor-oauth" as Integration.MethodID;
const OPENAI_COMPATIBLE_PACKAGE =
  "@opencode/ai/providers/openai-compatible";

interface CatalogState {
  readonly models: CursorModel[];
  readonly port: number;
}

/** Provider.Info is a frozen-by-default schema struct; these drafts are built fresh. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const CursorV2Plugin = Plugin.define({
  id: "opencode.cursor-oauth",
  setup: async (ctx) => {
    await ctx.integration.transform((draft) => {
      draft.update(CURSOR_ID, (integration) => {
        integration.name = "Cursor";
      });
      draft.method.update({
        integrationID: CURSOR_ID,
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

    let catalog = await loadCatalog(ctx);
    await ctx.provider.transform((draft) => {
      const current = catalog;
      if (!current) return;

      const info = Provider.Info.empty(CURSOR_ID as Provider.ID) as Mutable<Provider.Info>;
      info.integrationID = CURSOR_ID as Integration.ID;
      info.name = "Cursor";
      info.activation = "auto";
      info.package = OPENAI_COMPATIBLE_PACKAGE;
      info.settings = {
        baseURL: `http://localhost:${current.port}/v1`,
      };

      const models = current.models.map((cursorModel) => {
        const model = Model.Info.default(
          CURSOR_ID as Provider.ID,
          cursorModel.id as Model.ID,
        ) as Mutable<Model.Info>;
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
        return model;
      });

      draft.add({ info, models });
    });
    // Ensure the freshly registered provider transform is applied immediately.
    await ctx.provider.reload();

    const stopWatching = watchConnections(ctx, async () => {
      clearModelCache();
      catalog = await loadCatalog(ctx);
      if (!catalog) stopProxy();
      await ctx.provider.reload();
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

async function loadCatalog(ctx: Plugin.Context): Promise<CatalogState | undefined> {
  try {
    const accessToken = await getAccessToken(ctx);
    const models = await getCursorModels(accessToken);
    const port = await startProxy(() => getAccessToken(ctx), models);
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
          event.type === "credential.updated" ||
          (event.type === "credential.switched" &&
            event.data?.integrationID === CURSOR_ID)
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
