/**
 * Cursor model discovery via GetUsableModels.
 * Dynamic discovery is the source of truth. A small fallback catalog is used
 * only when discovery is degraded.
 */
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { z } from "zod";
import { callCursorUnaryRpc } from "./proxy";
import {
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
} from "./proto/agent_pb";

const GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

const CursorModelDetailsSchema = z.object({
  modelId: z.string(),
  displayName: z.string().optional().catch(undefined),
  displayNameShort: z.string().optional().catch(undefined),
  displayModelId: z.string().optional().catch(undefined),
  aliases: z
    .array(z.unknown())
    .optional()
    .catch([])
    .transform((aliases) =>
      (aliases ?? []).filter(
        (alias: unknown): alias is string => typeof alias === "string",
      ),
    ),
  thinkingDetails: z.unknown().optional(),
});

type CursorModelDetails = z.infer<typeof CursorModelDetailsSchema>;

export interface CursorModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

/**
 * Verified from current Cursor docs. Keep this intentionally small: it is a
 * degraded-mode escape hatch, not a synthetic account inventory.
 */
export const CURSOR_FALLBACK_MODELS: CursorModel[] = [
  {
    id: "composer-2",
    name: "Composer 2",
    reasoning: true,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "composer-2-fast",
    name: "Composer 2 Fast",
    reasoning: true,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "composer-1.5",
    name: "Composer 1.5",
    reasoning: true,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "claude-4.6-sonnet",
    name: "Claude 4.6 Sonnet",
    reasoning: true,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "claude-4.6-opus",
    name: "Claude 4.6 Opus",
    reasoning: true,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    reasoning: true,
    contextWindow: 272_000,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    reasoning: true,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    reasoning: false,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    reasoning: true,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "grok-4.20",
    name: "Grok 4.20",
    reasoning: true,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
];

export type CursorModelDiscoveryIssueCode =
  | "auth"
  | "transport"
  | "decode"
  | "empty_response"
  | "empty_models"
  | "parse_drop";

export interface CursorModelDiscoveryIssue {
  code: CursorModelDiscoveryIssueCode;
  message: string;
}

export type CursorModelDiscoveryStatus =
  | "success"
  | "partial"
  | "empty"
  | "failed";

export interface CursorModelDiscoveryDiagnostics {
  status: CursorModelDiscoveryStatus;
  issues: CursorModelDiscoveryIssue[];
  responseModelCount: number;
  parsedModelCount: number;
}

export interface CursorModelCatalog {
  models: CursorModel[];
  source: "discovered" | "fallback";
  degraded: boolean;
  diagnostics: CursorModelDiscoveryDiagnostics;
}

export interface CursorModelDiscoveryOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

interface CursorModelDiscoveryResult extends CursorModelDiscoveryDiagnostics {
  models: CursorModel[];
}

export async function loadCursorModelCatalog(
  options: CursorModelDiscoveryOptions,
): Promise<CursorModelCatalog> {
  const discovery = await discoverCursorModels(options);
  if (discovery.status === "success" || discovery.status === "partial") {
    return {
      models: discovery.models,
      source: "discovered",
      degraded: false,
      diagnostics: discovery,
    };
  }

  return {
    models: [...CURSOR_FALLBACK_MODELS],
    source: "fallback",
    degraded: true,
    diagnostics: discovery,
  };
}

async function discoverCursorModels(
  options: CursorModelDiscoveryOptions,
): Promise<CursorModelDiscoveryResult> {
  const requestPayload = create(GetUsableModelsRequestSchema, {});
  const requestBody = toBinary(GetUsableModelsRequestSchema, requestPayload);
  let response: Awaited<ReturnType<typeof callCursorUnaryRpc>>;
  try {
    response = await callCursorUnaryRpc({
      accessToken: options.apiKey,
      rpcPath: GET_USABLE_MODELS_PATH,
      requestBody,
      url: options.baseUrl,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    return failedDiscovery({
      code: "transport",
      message: `Cursor GetUsableModels bridge failed to start: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const errorIssue = classifyDiscoveryFailure(response);
  if (errorIssue) {
    return failedDiscovery(errorIssue);
  }

  const decoded = decodeGetUsableModelsResponse(response.body);
  if (!decoded) {
    return failedDiscovery({
      code: "decode",
      message: "Cursor GetUsableModels response could not be decoded",
    });
  }

  const normalized = normalizeCursorModels(decoded.models);
  const issues: CursorModelDiscoveryIssue[] = [];

  if (normalized.totalCount === 0) {
    issues.push({
      code: "empty_models",
      message: "Cursor GetUsableModels succeeded but returned no models",
    });
    return {
      status: "empty",
      issues,
      responseModelCount: 0,
      parsedModelCount: 0,
      models: [],
    };
  }

  if (normalized.droppedCount > 0) {
    issues.push({
      code: "parse_drop",
      message: `Dropped ${normalized.droppedCount} unusable model entries from Cursor discovery`,
    });
  }

  if (normalized.models.length === 0) {
    return {
      status: "failed",
      issues,
      responseModelCount: normalized.totalCount,
      parsedModelCount: 0,
      models: [],
    };
  }

  return {
    status: issues.length > 0 ? "partial" : "success",
    issues,
    responseModelCount: normalized.totalCount,
    parsedModelCount: normalized.models.length,
    models: normalized.models,
  };
}

function failedDiscovery(
  issue: CursorModelDiscoveryIssue,
): CursorModelDiscoveryResult {
  return {
    status: "failed",
    issues: [issue],
    responseModelCount: 0,
    parsedModelCount: 0,
    models: [],
  };
}

function classifyDiscoveryFailure(
  response: Awaited<ReturnType<typeof callCursorUnaryRpc>>,
): CursorModelDiscoveryIssue | null {
  if (response.timedOut) {
    return {
      code: "transport",
      message: "Cursor GetUsableModels request timed out",
    };
  }

  const structuredError = decodeStructuredError(response.body);
  if (structuredError) {
    return {
      code: inferIssueCodeFromError(structuredError),
      message: structuredError.message,
    };
  }

  if (response.exitCode !== 0) {
    return {
      code: "transport",
      message: `Cursor GetUsableModels bridge exited with code ${response.exitCode}`,
    };
  }

  if (response.body.length === 0) {
    return {
      code: "empty_response",
      message: "Cursor GetUsableModels returned an empty response body",
    };
  }

  return null;
}

function decodeStructuredError(payload: Uint8Array): {
  code?: string;
  message: string;
} | null {
  if (payload.length === 0) return null;

  try {
    const text = new TextDecoder().decode(payload).trim();
    if (!text.startsWith("{")) return null;
    const parsed = JSON.parse(text) as Record<string, unknown>;

    if (parsed.error && typeof parsed.error === "object") {
      const error = parsed.error as Record<string, unknown>;
      const message = typeof error.message === "string" ? error.message : null;
      if (!message) return null;
      return {
        code: typeof error.code === "string" ? error.code : undefined,
        message,
      };
    }

    const message = typeof parsed.message === "string" ? parsed.message : null;
    if (!message) return null;
    return {
      code: typeof parsed.code === "string" ? parsed.code : undefined,
      message,
    };
  } catch {
    return null;
  }
}

function inferIssueCodeFromError(error: {
  code?: string;
  message: string;
}): CursorModelDiscoveryIssueCode {
  const haystack = `${error.code ?? ""} ${error.message}`.toLowerCase();
  if (
    haystack.includes("unauth") ||
    haystack.includes("forbidden") ||
    haystack.includes("token") ||
    haystack.includes("auth") ||
    haystack.includes("permission")
  ) {
    return "auth";
  }
  return "transport";
}

function decodeGetUsableModelsResponse(payload: Uint8Array): {
  models: readonly unknown[];
} | null {
  try {
    return fromBinary(GetUsableModelsResponseSchema, payload);
  } catch {
    const framedBody = decodeConnectUnaryBody(payload);
    if (!framedBody) return null;
    try {
      return fromBinary(GetUsableModelsResponseSchema, framedBody);
    } catch {
      return null;
    }
  }
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
  if (payload.length < 5) return null;

  let offset = 0;
  while (offset + 5 <= payload.length) {
    const flags = payload[offset]!;
    const view = new DataView(
      payload.buffer,
      payload.byteOffset + offset,
      payload.byteLength - offset,
    );
    const messageLength = view.getUint32(1, false);
    const frameEnd = offset + 5 + messageLength;
    if (frameEnd > payload.length) return null;

    // Compression flag
    if ((flags & 0b0000_0001) !== 0) return null;

    // End-of-stream flag — skip trailer frames
    if ((flags & 0b0000_0010) === 0) {
      return payload.subarray(offset + 5, frameEnd);
    }

    offset = frameEnd;
  }

  return null;
}

function normalizeCursorModels(models: readonly unknown[]): {
  models: CursorModel[];
  totalCount: number;
  droppedCount: number;
} {
  if (models.length === 0) {
    return { models: [], totalCount: 0, droppedCount: 0 };
  }

  const byId = new Map<string, CursorModel>();
  let droppedCount = 0;

  for (const model of models) {
    const normalized = normalizeSingleModel(model);
    if (!normalized) {
      droppedCount++;
      continue;
    }
    byId.set(normalized.id, normalized);
  }

  return {
    models: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    totalCount: models.length,
    droppedCount,
  };
}

function normalizeSingleModel(model: unknown): CursorModel | null {
  const parsed = CursorModelDetailsSchema.safeParse(model);
  if (!parsed.success) return null;

  const details = parsed.data;
  const id = details.modelId.trim();
  if (!id) return null;

  return {
    id,
    name: pickDisplayName(details, id),
    reasoning: Boolean(details.thinkingDetails),
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

function pickDisplayName(model: CursorModelDetails, fallbackId: string): string {
  const candidates = [
    model.displayName,
    model.displayNameShort,
    model.displayModelId,
    ...model.aliases,
    fallbackId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return fallbackId;
}
