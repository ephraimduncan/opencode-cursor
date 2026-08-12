import { type ExecServerMessage, type McpToolDefinition } from "./proto/agent_pb.js";
export type NativeResultType = "readResult" | "writeResult" | "fetchResult" | "shellResult" | "shellStreamResult" | "lsResult" | "grepResult";
/** How to answer the paused native exec once the redirected tool result arrives. */
export interface NativeExecBinding {
    resultType: NativeResultType;
    /** Native arg values needed to shape the typed result frame. */
    args: Record<string, string>;
}
export interface NativeRedirect {
    toolCallId: string;
    toolName: string;
    decodedArgs: string;
    binding: NativeExecBinding;
}
/**
 * Map a native exec request onto a client-provided OpenAI tool.
 * Returns null when no equivalent tool is available (caller rejects as before).
 */
export declare function redirectNativeExec(execMsg: ExecServerMessage, mcpTools: McpToolDefinition[]): NativeRedirect | null;
interface PendingNativeExec {
    execId: string;
    execMsgId: number;
}
/**
 * Convert the redirected tool's text result into the typed native result the
 * paused exec expects. Returns false when no faithful conversion exists
 * (caller falls back to an mcpResult).
 * `sendMessage` receives an unframed AgentClientMessage binary.
 */
export declare function sendNativeExecResult(exec: PendingNativeExec, binding: NativeExecBinding, text: string, sendMessage: (bytes: Uint8Array) => void): boolean;
export {};
