/** Contracts of the Juno backend's native v1 surface (contracts/openapi/juno-native-v1.yaml). */

export interface DeviceSession {
  id: string;
  name: string;
  platform?: string;
  appVersion?: string;
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string | null;
  current?: boolean;
}

export interface RefreshResponse {
  tokenType: "Bearer";
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

export interface TokenResponse extends RefreshResponse {
  deviceSession: DeviceSession;
}

export interface Profile {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
}

export interface SessionResponse {
  profile: Profile;
  deviceSession: DeviceSession;
  accessTokenExpiresAt: string;
  contractVersion: string;
  minimumSupportedAppVersion: string;
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
    retryable: boolean;
    retryAfterMs?: number | null;
  };
}

/** Error surfaced by the API client for any non-2xx response. */
export class BackendError extends Error {
  /** Structured extras from v1 envelopes, e.g. { currentRevision, deleted }. */
  public details: Record<string, unknown> | undefined;

  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "BackendError";
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }

  get isQuotaError(): boolean {
    return this.status === 402 || this.code === "QUOTA_EXCEEDED";
  }
}
