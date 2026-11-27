import { type Principal } from "./contracts.ts";
import type { HostServices, IsolationProvider, RemoteHost, RemoteRepositoryBinding, RepositoryBinding } from "./host.ts";
export interface HttpLimits {
    maxBodyBytes: number;
    maxSessions: number;
    sessionIdleMs: number;
    requestsPerMinute: number;
    maxConcurrentPerPrincipal: number;
}
export declare const DEFAULT_HTTP_LIMITS: HttpLimits;
export interface HttpOptions {
    repositories: readonly RepositoryBinding[];
    host: HostServices;
    /**
     * Checkout-free repositories (see ComforgeMcpOptions.remoteRepositories): GitHub evidence reads
     * only, whatever the isolation. Requires `remote`; `repositories` may then be empty.
     */
    remoteRepositories?: readonly RemoteRepositoryBinding[];
    /** The host's trusted-configuration source and credentials for `remoteRepositories`. */
    remote?: RemoteHost;
    /** The host's authentication: a principal for this request, or null for 401. */
    authenticate(request: Request): Promise<Principal | null> | Principal | null;
    /** Exact `Host` header values served; required, never empty. */
    allowedHosts: readonly string[];
    /** Exact `Origin` values accepted when a request carries one (browsers do). */
    allowedOrigins: readonly string[];
    /** `WWW-Authenticate` value for 401 answers (e.g. a Bearer challenge with resource metadata). */
    challenge?: string;
    isolation?: IsolationProvider;
    /** See ComforgeMcpOptions.compactDiscovery. */
    compactDiscovery?: boolean;
    /** See ComforgeMcpOptions.textContent. */
    textContent?: "full" | "summary";
    limits?: Partial<HttpLimits>;
    now?: () => number;
}
export declare const fingerprintOf: (p: Principal) => string;
export interface HttpHandler {
    handle(request: Request): Promise<Response>;
    /** Live sessions (for tests and health reporting). */
    sessions(): number;
    close(): Promise<void>;
}
export declare function createHttpHandler(options: HttpOptions): HttpHandler;
