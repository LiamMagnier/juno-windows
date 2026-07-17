/**
 * Realtime voice relay client. The WebSocket lives in Rust (no browser
 * Origin header — the relay rejects foreign Origins); this wraps the
 * juno voice protocol (juno/relay/src/protocol.ts, mirrored in
 * juno-app/docs/BACKEND_API.md §11).
 */
import { invoke, Channel } from "@tauri-apps/api/core";
import { api } from "../backend/http";

export type VoiceProvider = "openai" | "gemini" | "qwen" | "minimax";

export interface RelayCapabilities {
  videoInput: boolean;
  trueS2S: boolean;
  needsClientTranscript: boolean;
  maxSessionSec: number;
}

export type RelayMessage =
  | { type: "session.ready"; provider: VoiceProvider; capabilities: RelayCapabilities }
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
  | { type: "turn"; speaker: "assistant"; phase: "start" | "end" }
  | { type: "interrupted" }
  | {
      type: "usage";
      provider: VoiceProvider;
      audioInSec: number;
      audioOutSec: number;
      estCostUsd: number;
    }
  | { type: "session.closed"; reason: "session-limit" | "provider" | "client" | "error" }
  | { type: "error"; message: string }
  | { type: "pong" };

type RustVoiceEvent =
  | { event: "open" }
  | { event: "text"; data: string }
  | { event: "audio"; base64: string }
  | { event: "closed"; reason: string }
  | { event: "error"; message: string };

export interface RelayHandlers {
  onMessage(message: RelayMessage): void;
  /** Model speech: PCM16 little-endian mono 24 kHz. */
  onAudio(samples: Int16Array): void;
  onClosed(reason: string): void;
  onError(message: string): void;
}

export interface RelayTokenResponse {
  token: string;
  url?: string;
  providers?: Record<string, boolean>;
}

const DEFAULT_LOCAL_RELAY = "ws://localhost:8787";

export async function fetchRelayToken(): Promise<RelayTokenResponse> {
  return api<RelayTokenResponse>("/voice/relay-token");
}

function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
}

function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export class VoiceRelayConnection {
  private connId: number | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  private constructor(private handlers: RelayHandlers) {}

  static async connect(handlers: RelayHandlers): Promise<VoiceRelayConnection> {
    const tokenRes = await fetchRelayToken();
    const relayUrl = tokenRes.url ?? DEFAULT_LOCAL_RELAY;
    const url = `${relayUrl}${relayUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(tokenRes.token)}`;

    const conn = new VoiceRelayConnection(handlers);
    const channel = new Channel<RustVoiceEvent>();
    channel.onmessage = (event) => conn.handleEvent(event);
    conn.connId = await invoke<number>("voice_connect", { url, onEvent: channel });
    // Keepalive every ~20s per protocol.
    conn.pingTimer = setInterval(() => conn.sendJson({ type: "ping" }), 20_000);
    return conn;
  }

  private handleEvent(event: RustVoiceEvent): void {
    switch (event.event) {
      case "open":
        break;
      case "text": {
        try {
          const message = JSON.parse(event.data) as RelayMessage;
          // Unknown types are ignored for forward compatibility.
          if (message && typeof message.type === "string") this.handlers.onMessage(message);
        } catch {
          // ignore malformed frames
        }
        break;
      }
      case "audio":
        this.handlers.onAudio(base64ToInt16(event.base64));
        break;
      case "closed":
        if (!this.closed) {
          this.closed = true;
          this.stopPing();
          this.handlers.onClosed(event.reason);
        }
        break;
      case "error":
        this.handlers.onError(event.message);
        break;
    }
  }

  sendJson(message: Record<string, unknown>): void {
    if (this.connId === null || this.closed) return;
    void invoke("voice_send_text", { connId: this.connId, data: JSON.stringify(message) }).catch(
      () => {},
    );
  }

  startSession(provider: VoiceProvider): void {
    this.sendJson({ type: "session.start", provider });
  }

  switchProvider(provider: VoiceProvider): void {
    this.sendJson({ type: "session.switch", provider });
  }

  sendClientTranscript(text: string): void {
    this.sendJson({ type: "input.text", text });
  }

  interrupt(): void {
    this.sendJson({ type: "control.interrupt" });
  }

  /** Microphone audio: PCM16 little-endian mono 16 kHz. */
  sendAudio(samples: Int16Array): void {
    if (this.connId === null || this.closed) return;
    void invoke("voice_send_audio", {
      connId: this.connId,
      base64Data: int16ToBase64(samples),
    }).catch(() => {});
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopPing();
    if (this.connId !== null) {
      void invoke("voice_close", { connId: this.connId }).catch(() => {});
    }
  }
}
