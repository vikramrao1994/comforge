export declare function withGrantFile<T>(envelope: unknown, run: (grantFile: string | undefined) => Promise<T>): Promise<T>;
