import { generatePKCE } from "./pkce";
import { AsyncLocalStorage } from "node:async_hooks";

const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const CURSOR_REFRESH_URL =
  process.env.CURSOR_REFRESH_URL ??
  "https://api2.cursor.sh/auth/exchange_user_api_key";

const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY = 1000;
const POLL_MAX_DELAY = 10_000;
const POLL_BACKOFF_MULTIPLIER = 1.2;
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;
const MAX_REFRESH_TIMEOUT_MS = 60_000;

export class CursorTokenRefreshTimeoutError extends Error {
  constructor() {
    super("Cursor token refresh timed out; retry the request or sign in again");
    this.name = "CursorTokenRefreshTimeoutError";
  }
}

function getRefreshTimeoutMs(): number {
  const configured = Number(process.env.CURSOR_REFRESH_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_REFRESH_TIMEOUT_MS;
  return Math.min(Math.floor(configured), MAX_REFRESH_TIMEOUT_MS);
}

const lifecycleDiagnosticContext = new AsyncLocalStorage<{
  requestId: string;
  startedAt: number;
  emittedStages: Set<LifecycleDiagnosticStage>;
}>();

export type LifecycleDiagnosticStage =
  | "auth_access_start" | "auth_access_complete"
  | "auth_refresh_start" | "auth_refresh_complete" | "auth_refresh_failed"
  | "proxy_entry" | "bridge_spawn" | "connect_frame" | "end_stream"
  | "message_dispatch"
  | "tool_pause" | "tool_resume" | "sse_emission" | "terminal";

type LifecycleDiagnosticDetails = Readonly<{
  byteLength?: number; messageCase?: string; interactionCase?: string;
  toolCount?: number; exitCode?: number; errorName?: string; status?: string;
}>;

/** Diagnostics are opt-in because even safe metadata is operational noise. */
export function lifecycleDiagnosticsEnabled(): boolean {
  return process.env.CURSOR_PROXY_DIAGNOSTICS === "1";
}

/** Keep one correlation ID across asynchronous proxy and auth work. */
export function withLifecycleDiagnosticContext<T>(requestId: string, operation: () => T): T {
  return lifecycleDiagnosticContext.run({ requestId, startedAt: performance.now(), emittedStages: new Set() }, operation);
}

export function lifecycleDiagnosticContextInfo(): { requestId: string; elapsedMs: number } | undefined {
  const context = lifecycleDiagnosticContext.getStore();
  return context && { requestId: context.requestId, elapsedMs: Math.round(performance.now() - context.startedAt) };
}

/** Emits only explicitly allowlisted metadata. Do not add payload-bearing fields here. */
export function emitLifecycleDiagnostic(
  source: "auth" | "proxy", stage: LifecycleDiagnosticStage,
  details: LifecycleDiagnosticDetails = {},
): void {
  if (!lifecycleDiagnosticsEnabled()) return;
  const context = lifecycleDiagnosticContextInfo();
  if (!context) return;
  const store = lifecycleDiagnosticContext.getStore();
  if (!store || store.emittedStages.has(stage)) return;
  store.emittedStages.add(stage);
  const event: Record<string, string | number> = { source, stage, requestId: context.requestId, elapsedMs: context.elapsedMs };
  if (typeof details.byteLength === "number") event.byteLength = details.byteLength;
  if (typeof details.messageCase === "string") event.messageCase = details.messageCase;
  if (typeof details.interactionCase === "string") event.interactionCase = details.interactionCase;
  if (typeof details.toolCount === "number") event.toolCount = details.toolCount;
  if (typeof details.exitCode === "number") event.exitCode = details.exitCode;
  if (typeof details.errorName === "string") event.errorName = details.errorName;
  if (typeof details.status === "string") event.status = details.status;
  console.error(JSON.stringify(event));
}

export interface CursorAuthParams {
  verifier: string;
  challenge: string;
  uuid: string;
  loginUrl: string;
}

export interface CursorCredentials {
  access: string;
  refresh: string;
  expires: number;
}


export async function generateCursorAuthParams(): Promise<CursorAuthParams> {
  const { verifier, challenge } = await generatePKCE();
  const uuid = crypto.randomUUID();

  const params = new URLSearchParams({
    challenge,
    uuid,
    mode: "login",
    redirectTarget: "cli",
  });

  const loginUrl = `${CURSOR_LOGIN_URL}?${params.toString()}`;
  return { verifier, challenge, uuid, loginUrl };
}

export async function pollCursorAuth(
  uuid: string,
  verifier: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  let delay = POLL_BASE_DELAY;
  let consecutiveErrors = 0;

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await Bun.sleep(delay);

    try {
      const response = await fetch(
        `${CURSOR_POLL_URL}?uuid=${uuid}&verifier=${verifier}`,
      );

      if (response.status === 404) {
        consecutiveErrors = 0;
        delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY);
        continue;
      }

      if (response.ok) {
        const data = (await response.json()) as {
          accessToken: string;
          refreshToken: string;
        };
        return {
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
        };
      }

      throw new Error(`Poll failed: ${response.status}`);
    } catch {
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        throw new Error(
          "Too many consecutive errors during Cursor auth polling",
        );
      }
    }
  }

  throw new Error("Cursor authentication polling timeout");
}

export async function refreshCursorToken(
  refreshToken: string,
): Promise<CursorCredentials> {
  emitLifecycleDiagnostic("auth", "auth_refresh_start");
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, getRefreshTimeoutMs());
  let response: Response;
  try {
    response = await fetch(CURSOR_REFRESH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${refreshToken}`, "Content-Type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
  } catch (error) {
    const refreshError = timedOut
      ? new CursorTokenRefreshTimeoutError()
      : new Error("Cursor token refresh request failed");
    emitLifecycleDiagnostic("auth", "auth_refresh_failed", { errorName: refreshError.name });
    throw refreshError;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    emitLifecycleDiagnostic("auth", "auth_refresh_failed", { exitCode: response.status });
    throw new Error(`Cursor token refresh failed with HTTP status ${response.status}`);
  }

  const data = (await response.json()) as {
    accessToken: string;
    refreshToken: string;
  };

  const credentials = {
    access: data.accessToken,
    refresh: data.refreshToken || refreshToken,
    expires: getTokenExpiry(data.accessToken),
  };
  emitLifecycleDiagnostic("auth", "auth_refresh_complete");
  return credentials;
}


/**
 * Extract JWT expiry with 5-minute safety margin.
 * Falls back to 1 hour from now if token can't be parsed.
 */
export function getTokenExpiry(token: string): number {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) {
      return Date.now() + 3600 * 1000;
    }
    const decoded = JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    if (
      decoded &&
      typeof decoded === "object" &&
      typeof decoded.exp === "number"
    ) {
      return decoded.exp * 1000 - 5 * 60 * 1000;
    }
  } catch {
  }
  return Date.now() + 3600 * 1000;
}
