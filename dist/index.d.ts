/**
 * OpenCode Cursor Auth Plugin
 *
 * Enables using Cursor models (Claude, GPT, etc.) inside OpenCode via:
 * 1. Browser-based OAuth login to Cursor
 * 2. Local proxy translating OpenAI format → Cursor gRPC protocol
 */
import type { Plugin } from "@opencode-ai/plugin";
/**
 * OpenCode plugin that provides Cursor authentication and model access.
 * Register in opencode.json: { "plugin": ["opencode-cursor-oauth"] }
 */
export declare const CursorAuthPlugin: Plugin;
/**
 * Modern plugin module format: `{ id, server }`. Newer opencode loaders
 * (including the Desktop app's sidecar) require this shape; the bare
 * function default export was silently ignored there.
 */
export declare const CursorAuthPluginModule: {
    id: string;
    server: Plugin;
};
export default CursorAuthPluginModule;
