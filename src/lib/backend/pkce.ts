/**
 * PKCE + handshake secrets for the native device-auth flow.
 * Mirrors the backend's validation in juno/src/lib/native-auth-core.ts:
 * base64url strings of 43..256 chars, S256 challenge only.
 */

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** 32 random bytes -> 43-char base64url string (matches server regex). */
export function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export interface AuthHandshake {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
}

export async function createHandshake(): Promise<AuthHandshake> {
  const codeVerifier = randomSecret();
  return {
    state: randomSecret(),
    nonce: randomSecret(),
    codeVerifier,
    codeChallenge: await s256Challenge(codeVerifier),
  };
}
