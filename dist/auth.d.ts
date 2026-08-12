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
export declare function generateCursorAuthParams(): Promise<CursorAuthParams>;
export declare function pollCursorAuth(uuid: string, verifier: string): Promise<{
    accessToken: string;
    refreshToken: string;
}>;
export declare function refreshCursorToken(refreshToken: string): Promise<CursorCredentials>;
/**
 * Extract JWT expiry with 5-minute safety margin.
 * Falls back to 1 hour from now if token can't be parsed.
 */
export declare function getTokenExpiry(token: string): number;
