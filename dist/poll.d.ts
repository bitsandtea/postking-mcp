interface WithOperationStatus {
    operationStatus?: string | Record<string, unknown> | null;
}
/**
 * Poll a URL until operationStatus.state is "completed" or "failed".
 * Returns the final response body.
 */
export declare function pollUntilDone<T extends WithOperationStatus>(pollUrl: string): Promise<T>;
export {};
