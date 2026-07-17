/**
 * Voice session state machine driving the compact composer-attached panel:
 * idle -> connecting -> listening <-> thinking <-> speaking, with muted,
 * reconnecting, ended and error states. Finalized turns persist through
 * POST /api/voice/transcript into the same conversation model as text chat.
 */
import { create } from "zustand";
import { api } from "@/lib/backend/http";
import {
  createSpeechPlayer,
  startMicCapture,
  type MicCapture,
  type SpeechPlayer,
} from "@/lib/voice/audio";
import {
  VoiceRelayConnection,
  type RelayCapabilities,
  type RelayMessage,
  type VoiceProvider,
} from "@/lib/voice/relay";
import type { ClientMessage } from "@/lib/data/entities";
import { useThreadStore } from "./threadStore";
import { useDataStore } from "./dataStore";

export type VoicePhase =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "reconnecting"
  | "ended"
  | "error";

export interface CaptionLine {
  role: "user" | "assistant";
  text: string;
  final: boolean;
}

interface FinalTurn {
  role: "USER" | "ASSISTANT";
  content: string;
}

interface VoiceState {
  phase: VoicePhase;
  muted: boolean;
  captionsOn: boolean;
  provider: VoiceProvider;
  capabilities: RelayCapabilities | null;
  userPartial: string;
  assistantPartial: string;
  captions: CaptionLine[];
  error: string | null;
  endedReason: string | null;
  /** 0..1 orb drive: mic while listening, speech while speaking. */
  amplitude: number;
  sessionCostUsd: number;

  start(conversationId: string | null): Promise<void>;
  end(): Promise<void>;
  setMuted(muted: boolean): void;
  toggleCaptions(): void;
  interrupt(): void;
}

let connection: VoiceRelayConnection | null = null;
let mic: MicCapture | null = null;
let player: SpeechPlayer | null = null;
let amplitudeTimer: ReturnType<typeof setInterval> | null = null;
let sessionId: string | null = null;
let sessionConversationId: string | null = null;
let finalTurns: FinalTurn[] = [];

function teardown(): void {
  connection?.close();
  connection = null;
  mic?.stop();
  mic = null;
  player?.stop();
  player = null;
  if (amplitudeTimer) clearInterval(amplitudeTimer);
  amplitudeTimer = null;
}

async function persistTranscript(): Promise<void> {
  if (!sessionId || finalTurns.length === 0) return;
  try {
    const res = await api<{ conversationId: string; messages: ClientMessage[] }>(
      "/voice/transcript",
      {
        method: "POST",
        body: {
          sessionId,
          conversationId: sessionConversationId,
          model: `voice:${useVoiceStore.getState().provider}`,
          turns: finalTurns.map((t) => ({ role: t.role, content: t.content, attachmentIds: [] })),
        },
      },
    );
    // Fold the persisted turns into the open thread + conversation list.
    const threadStore = useThreadStore.getState();
    const conversationId = res.conversationId;
    threadStore.patchThread(conversationId, {});
    threadStore.updateMessages(conversationId, (existing) => {
      const known = new Set(existing.map((m) => m.id));
      return [...existing, ...res.messages.filter((m) => !known.has(m.id))];
    });
    if (!sessionConversationId) {
      sessionConversationId = conversationId;
      if (threadStore.activeConversationId === null) {
        threadStore.setActive(conversationId);
      }
      // Ensure the sidebar learns about a newly created conversation.
      void api<{ conversations: import("@/lib/data/entities").ClientConversation[] }>(
        "/conversations",
      )
        .then(({ conversations }) => useDataStore.getState().replaceConversations(conversations))
        .catch(() => {});
    }
  } catch {
    // Persistence retries on the next flush; the session keeps running.
  }
}

function handleRelayMessage(message: RelayMessage): void {
  const store = useVoiceStore;
  switch (message.type) {
    case "session.ready":
      store.setState({
        phase: "listening",
        provider: message.provider,
        capabilities: message.capabilities,
        error: null,
      });
      break;
    case "transcript": {
      const { role, text, final } = message;
      if (final) {
        finalTurns.push({ role: role === "user" ? "USER" : "ASSISTANT", content: text });
        store.setState((s) => ({
          captions: [...s.captions.slice(-40), { role, text, final: true }],
          ...(role === "user" ? { userPartial: "", phase: "thinking" } : { assistantPartial: "" }),
        }));
        void persistTranscript();
      } else {
        store.setState(role === "user" ? { userPartial: text } : { assistantPartial: text });
      }
      break;
    }
    case "turn":
      if (message.phase === "start") {
        store.setState({ phase: "speaking" });
      } else {
        store.setState((s) => ({ phase: s.muted ? "listening" : "listening", assistantPartial: "" }));
      }
      break;
    case "interrupted":
      player?.flush();
      store.setState({ phase: "listening", assistantPartial: "" });
      break;
    case "usage":
      store.setState((s) => ({ sessionCostUsd: s.sessionCostUsd + message.estCostUsd }));
      break;
    case "session.closed": {
      const reason = message.reason;
      teardown();
      void persistTranscript();
      store.setState({
        phase: "ended",
        endedReason:
          reason === "session-limit"
            ? "Session ended — the time limit was reached. Start again to continue."
            : reason === "error"
              ? "The voice session ended unexpectedly."
              : null,
      });
      break;
    }
    case "error":
      store.setState({ error: message.message });
      break;
    case "pong":
      break;
  }
}

export const useVoiceStore = create<VoiceState>((set, get) => ({
  phase: "idle",
  muted: false,
  captionsOn: true,
  provider: "openai",
  capabilities: null,
  userPartial: "",
  assistantPartial: "",
  captions: [],
  error: null,
  endedReason: null,
  amplitude: 0,
  sessionCostUsd: 0,

  async start(conversationId) {
    if (get().phase !== "idle" && get().phase !== "ended" && get().phase !== "error") return;
    sessionId = crypto.randomUUID();
    sessionConversationId = conversationId;
    finalTurns = [];
    set({
      phase: "connecting",
      error: null,
      endedReason: null,
      captions: [],
      userPartial: "",
      assistantPartial: "",
      sessionCostUsd: 0,
    });
    try {
      player = createSpeechPlayer();
      connection = await VoiceRelayConnection.connect({
        onMessage: handleRelayMessage,
        onAudio: (samples) => player?.enqueue(samples),
        onClosed: () => {
          if (useVoiceStore.getState().phase !== "ended") {
            teardown();
            set({ phase: "ended", endedReason: null });
            void persistTranscript();
          }
        },
        onError: (message) => set({ error: message }),
      });
      mic = await startMicCapture((samples) => connection?.sendAudio(samples));
      connection.startSession(get().provider);
      amplitudeTimer = setInterval(() => {
        const s = useVoiceStore.getState();
        const level =
          s.phase === "speaking" ? (player?.amplitude() ?? 0) : (mic?.amplitude() ?? 0);
        set({ amplitude: level });
      }, 80);
    } catch (err) {
      teardown();
      const message =
        err instanceof Error && /NotAllowed|Permission/i.test(err.message)
          ? "Microphone access was denied. Allow it in Windows Settings > Privacy > Microphone."
          : err instanceof Error
            ? err.message
            : "Couldn't start voice.";
      set({ phase: "error", error: message });
    }
  },

  async end() {
    teardown();
    await persistTranscript();
    set({ phase: "idle", amplitude: 0, userPartial: "", assistantPartial: "" });
  },

  setMuted(muted) {
    mic?.setMuted(muted);
    set({ muted });
  },

  toggleCaptions() {
    set((s) => ({ captionsOn: !s.captionsOn }));
  },

  interrupt() {
    connection?.interrupt();
    player?.flush();
    set({ phase: "listening", assistantPartial: "" });
  },
}));
