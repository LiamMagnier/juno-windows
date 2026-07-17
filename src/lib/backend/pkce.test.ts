import { describe, expect, it } from "vitest";
import { createHandshake, randomSecret, s256Challenge } from "./pkce";

// Server-side validation regex from juno/src/lib/native-auth-core.ts
const BASE64URL_256 = /^[A-Za-z0-9_-]{43,256}$/;

describe("pkce", () => {
  it("generates secrets matching the backend's validation regex", () => {
    for (let i = 0; i < 32; i++) {
      expect(randomSecret()).toMatch(BASE64URL_256);
    }
  });

  it("generates unique secrets", () => {
    const seen = new Set(Array.from({ length: 64 }, () => randomSecret()));
    expect(seen.size).toBe(64);
  });

  it("computes the RFC 7636 S256 challenge", async () => {
    // Appendix B of RFC 7636
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await s256Challenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("creates a full handshake whose challenge matches its verifier", async () => {
    const handshake = await createHandshake();
    expect(handshake.state).toMatch(BASE64URL_256);
    expect(handshake.nonce).toMatch(BASE64URL_256);
    expect(handshake.codeVerifier).toMatch(BASE64URL_256);
    expect(handshake.codeChallenge).toBe(await s256Challenge(handshake.codeVerifier));
    expect(handshake.state).not.toBe(handshake.nonce);
  });
});
