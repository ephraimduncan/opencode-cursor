interface CursorUnaryRpcOptions {
    accessToken: string;
    rpcPath: string;
    requestBody: Uint8Array;
    url?: string;
    timeoutMs?: number;
}
export declare function callCursorUnaryRpc(options: CursorUnaryRpcOptions): Promise<{
    body: Uint8Array;
    exitCode: number;
    timedOut: boolean;
}>;
export declare function getProxyPort(): number | undefined;
export declare function startProxy(getAccessToken: () => Promise<string>, models?: ReadonlyArray<{
    id: string;
    name: string;
}>): Promise<number>;
export declare function stopProxy(): void;
export {};
