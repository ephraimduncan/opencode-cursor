/**
 * Cursor model discovery via GetUsableModels gRPC endpoint.
 * Uses Node.js http2 module (primary) with curl --http2 as fallback.
 * Falls back to a hardcoded list if neither transport works.
 */
import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { z } from "zod";
import {
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
} from "./proto/agent_pb";

const CURSOR_BASE_URL = "https://api2.cursor.sh";
const CURSOR_CLIENT_VERSION = "cli-2026.02.13-41ac335";
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

const CursorDecodedResponseSchema = z.object({
  models: z.array(z.unknown()).optional().catch([]),
});

type CursorModelDetails = z.infer<typeof CursorModelDetailsSchema>;

export interface CursorModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

const FALLBACK_MODELS: CursorModel[] = [
  { id: "composer-2", name: "Composer 2", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
  { id: "claude-4.6-sonnet-medium", name: "Sonnet 4.6 1M", reasoning: false, contextWindow: 200_000, maxTokens: 64_000 },
  { id: "claude-4.6-sonnet-medium-thinking", name: "Sonnet 4.6 1M Thinking", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
  { id: "claude-4.6-opus-high", name: "Opus 4.6 1M", reasoning: false, contextWindow: 200_000, maxTokens: 64_000 },
  { id: "claude-4.6-opus-high-thinking", name: "Opus 4.6 1M Thinking", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
  { id: "claude-4.5-sonnet", name: "Sonnet 4.5 1M", reasoning: false, contextWindow: 200_000, maxTokens: 64_000 },
  { id: "claude-4.5-sonnet-thinking", name: "Sonnet 4.5 1M Thinking", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
  { id: "claude-4-sonnet", name: "Sonnet 4", reasoning: false, contextWindow: 200_000, maxTokens: 64_000 },
  { id: "claude-4-sonnet-thinking", name: "Sonnet 4 Thinking", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
  { id: "gpt-5.4-medium", name: "GPT-5.4 1M", reasoning: false, contextWindow: 200_000, maxTokens: 64_000 },
  { id: "gpt-5.2", name: "GPT-5.2", reasoning: false, contextWindow: 128_000, maxTokens: 64_000 },
  { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536 },
  { id: "gemini-3-pro", name: "Gemini 3 Pro", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536 },
  { id: "grok-4-20", name: "Grok 4.20", reasoning: false, contextWindow: 200_000, maxTokens: 64_000 },
  { id: "grok-4-20-thinking", name: "Grok 4.20 Thinking", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
];

export interface CursorModelDiscoveryOptions {
  apiKey: string;
  baseUrl?: string;
  clientVersion?: string;
  timeoutMs?: number;
}

/**
 * Fetch models from Cursor's GetUsableModels gRPC endpoint.
 * Returns null on failure (caller should use fallback list).
 */
export async function fetchCursorUsableModels(
  options: CursorModelDiscoveryOptions,
): Promise<CursorModel[] | null> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  try {
    const requestPayload = create(GetUsableModelsRequestSchema, {});
    const body = toBinary(GetUsableModelsRequestSchema, requestPayload);
    const baseUrl = (options.baseUrl ?? CURSOR_BASE_URL).replace(/\/+$/, "");

    const responseBuffer = await fetchViaHttp2(baseUrl, body, options, timeoutMs);
    if (!responseBuffer) return null;

    const decoded = decodeGetUsableModelsResponse(responseBuffer);
    const parsedDecoded = CursorDecodedResponseSchema.safeParse(decoded);
    if (!parsedDecoded.success) return null;

    return normalizeCursorModels(parsedDecoded.data.models);
  } catch {
    return null;
  }
}

export async function getCursorModels(
  apiKey: string,
): Promise<CursorModel[]> {
  const discovered = await fetchCursorUsableModels({ apiKey });
  return discovered && discovered.length > 0 ? discovered : FALLBACK_MODELS;
}

function buildRequestHeaders(
  options: CursorModelDiscoveryOptions,
): Record<string, string> {
  return {
    "content-type": "application/proto",
    te: "trailers",
    authorization: `Bearer ${options.apiKey}`,
    "x-ghost-mode": "true",
    "x-cursor-client-version":
      options.clientVersion ?? CURSOR_CLIENT_VERSION,
    "x-cursor-client-type": "cli",
  };
}

/**
 * HTTP/2 transport: curl --http2 on macOS/Linux, Node.js subprocess on Windows.
 * Windows curl typically lacks HTTP/2 support, so we skip it entirely there.
 * Bun's node:http2 polyfill is broken, so the Node path spawns a real process.
 */
async function fetchViaHttp2(
  baseUrl: string,
  body: Uint8Array,
  options: CursorModelDiscoveryOptions,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  if (process.platform === "win32") {
    return fetchViaNodeSubprocess(baseUrl, body, options, timeoutMs);
  }
  return fetchViaCurl(baseUrl, body, options, timeoutMs);
}

/**
 * HTTP/2 transport by spawning a Node.js subprocess.
 * Bun's node:http2 is broken, so we use real Node for HTTP/2.
 * Writes a temp .cjs script to avoid shell escaping issues on Windows.
 */
async function fetchViaNodeSubprocess(
  baseUrl: string,
  body: Uint8Array,
  options: CursorModelDiscoveryOptions,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  const headers = buildRequestHeaders(options);
  const ts = Date.now();
  const reqPath = join(tmpdir(), `cursor-req-${ts}.bin`);
  const respPath = join(tmpdir(), `cursor-resp-${ts}.bin`);
  const scriptPath = join(tmpdir(), `cursor-h2-${ts}.cjs`);

  try {
    writeFileSync(reqPath, body);

    // Build a self-contained Node.js CJS script that does the HTTP/2 request.
    // Use forward slashes in paths for cross-platform compatibility.
    const fwdReqPath = reqPath.split("\\").join("/");
    const fwdRespPath = respPath.split("\\").join("/");
    const headerEntries = Object.entries(headers)
      .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
      .join(",");

    const script = `"use strict";
const http2=require("http2"),fs=require("fs");
const body=fs.readFileSync(${JSON.stringify(fwdReqPath)});
const c=http2.connect(${JSON.stringify(baseUrl)});
let timer=setTimeout(()=>{c.close();process.exit(1)},${timeoutMs});
c.on("error",()=>{clearTimeout(timer);process.exit(1)});
const r=c.request({":method":"POST",":path":${JSON.stringify(GET_USABLE_MODELS_PATH)},${headerEntries}});
r.end(body);const ch=[];let st;
r.on("response",(h)=>{st=h[":status"]});
r.on("data",(d)=>ch.push(d));
r.on("end",()=>{clearTimeout(timer);c.close();
const d=Buffer.concat(ch);
if(st>=200&&st<300&&d.length>0){fs.writeFileSync(${JSON.stringify(fwdRespPath)},d);process.exit(0)}
else process.exit(1)});
r.on("error",()=>{clearTimeout(timer);c.close();process.exit(1)});`;

    writeFileSync(scriptPath, script);

    try {
      execSync(`node ${scriptPath}`, {
        timeout: timeoutMs + 3000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      // Check if the response was written despite non-zero exit
    }

    if (!existsSync(respPath)) return null;
    return new Uint8Array(readFileSync(respPath));
  } catch {
    return null;
  } finally {
    try { unlinkSync(reqPath); } catch {}
    try { unlinkSync(respPath); } catch {}
    try { unlinkSync(scriptPath); } catch {}
  }
}

/**
 * HTTP/2 transport via curl (fallback for environments where Node subprocess fails).
 */
async function fetchViaCurl(
  baseUrl: string,
  body: Uint8Array,
  options: CursorModelDiscoveryOptions,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  const reqPath = join(tmpdir(), `cursor-req-${Date.now()}.bin`);
  const respPath = join(tmpdir(), `cursor-resp-${Date.now()}.bin`);
  try {
    writeFileSync(reqPath, body);
    const headers = buildRequestHeaders(options);
    const headerArgs = Object.entries(headers)
      .flatMap(([k, v]) => ["-H", `${k}: ${v}`]);
    const timeoutSecs = Math.ceil(timeoutMs / 1000);
    const url = `${baseUrl}${GET_USABLE_MODELS_PATH}`;
    const args = [
      "curl", "-s", "--http2",
      "--max-time", String(timeoutSecs),
      "-X", "POST",
      ...headerArgs,
      "--data-binary", `@${reqPath}`,
      "-o", respPath,
      "-w", "%{http_code}",
      url,
    ];
    const status = execSync(args.map(a => a.includes(' ') ? `"${a}"` : a).join(' '), {
      timeout: timeoutMs + 2000,
      stdio: ["pipe", "pipe", "pipe"],
    }).toString().trim();
    if (!status.startsWith("2")) return null;
    if (!existsSync(respPath)) return null;
    return new Uint8Array(readFileSync(respPath));
  } catch {
    return null;
  } finally {
    try { unlinkSync(reqPath); } catch {}
    try { unlinkSync(respPath); } catch {}
  }
}

function decodeGetUsableModelsResponse(payload: Uint8Array) {
  if (payload.length === 0) return null;

  // Try Connect framing first (5-byte header)
  const framedBody = decodeConnectUnaryBody(payload);
  if (framedBody) {
    try {
      return fromBinary(GetUsableModelsResponseSchema, framedBody);
    } catch {
      return null;
    }
  }

  // Raw protobuf
  try {
    return fromBinary(GetUsableModelsResponseSchema, payload);
  } catch {
    return null;
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

function normalizeCursorModels(
  models: readonly unknown[] | undefined,
): CursorModel[] {
  if (!models || models.length === 0) return [];

  const byId = new Map<string, CursorModel>();
  for (const model of models) {
    const normalized = normalizeSingleModel(model);
    if (normalized) byId.set(normalized.id, normalized);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
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
