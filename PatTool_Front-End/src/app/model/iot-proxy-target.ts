export interface IotProxyTarget {
    id?: string;
    publicSlug?: string;
    description?: string;
    owner?: string;
    creationDate?: string | Date;
    updateDate?: string | Date;
    upstreamBaseUrl?: string;
    upstreamUsername?: string;
    /** Write-only on create/update; never returned on read. */
    upstreamPassword?: string;
    hasUpstreamPassword?: boolean;
}

export interface BrowserOpenUrlResponse {
    relativeUrlWithQuery: string;
    expiresInSeconds: number;
}

/** Effective server limits for LAN IoT proxy UI (from {@code GET …/server-settings}). */
export interface IotProxyServerSettings {
    openTokenValiditySeconds: number;
    openTokenExplicitSecretConfigured: boolean;
    maxResponseBytes: number;
    maxRequestBodyBytes: number;
    maxRewriteBodyBytes: number;
    redirectMaxHops: number;
    maxUpstreamUrlCharacters: number;
    connectTimeoutMillis: number;
    readTimeoutMillis: number;
}
