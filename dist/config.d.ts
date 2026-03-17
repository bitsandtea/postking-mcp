export declare const config: {
    readonly apiUrl: string;
    readonly pollIntervalMs: 3000;
    readonly pollTimeoutMs: 120000;
};
export declare function getToken(): string | null;
export declare function requireToken(): string;
