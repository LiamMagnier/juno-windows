/**
 * Inline voice panel: a compact card docked directly above the chat composer
 * while a voice session is running. Shows the amplitude-driven orb, live
 * captions (or a one-line state label), and the session controls
 * (mute / interrupt / captions / end), plus ended and error layouts.
 */
import { useEffect, useState, type CSSProperties, type KeyboardEvent } from "react";
import {
  Captions,
  CircleStop,
  Mic,
  MicOff,
  PhoneOff,
  Sparkles,
  TriangleAlert,
  Volume2,
  X,
} from "lucide-react";
import { useThreadStore } from "@/state/threadStore";
import { useVoiceStore, type VoicePhase } from "@/state/voiceStore";
import "./voice.css";

type OrbState =
  | "listening"
  | "muted"
  | "thinking"
  | "speaking"
  | "connecting"
  | "error"
  | "ended";

function orbState(phase: VoicePhase, muted: boolean): OrbState {
  switch (phase) {
    case "connecting":
    case "reconnecting":
      return "connecting";
    case "speaking":
      return "speaking";
    case "thinking":
      return "thinking";
    case "error":
      return "error";
    case "ended":
      return "ended";
    default:
      return muted ? "muted" : "listening";
  }
}

const ORB_ICONS: Record<OrbState, typeof Mic> = {
  listening: Mic,
  muted: MicOff,
  thinking: Sparkles,
  speaking: Volume2,
  connecting: Mic,
  error: TriangleAlert,
  ended: PhoneOff,
};

/** Live prefers-reduced-motion flag (reacts to OS setting changes). */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function stateLabel(phase: VoicePhase, muted: boolean): string {
  switch (phase) {
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "thinking":
      return "Thinking…";
    case "speaking":
      return "Speaking…";
    default:
      return muted ? "Muted" : "Listening…";
  }
}

export function VoicePanel() {
  const phase = useVoiceStore((s) => s.phase);
  const muted = useVoiceStore((s) => s.muted);
  const captionsOn = useVoiceStore((s) => s.captionsOn);
  const userPartial = useVoiceStore((s) => s.userPartial);
  const assistantPartial = useVoiceStore((s) => s.assistantPartial);
  const captions = useVoiceStore((s) => s.captions);
  const error = useVoiceStore((s) => s.error);
  const endedReason = useVoiceStore((s) => s.endedReason);
  const amplitude = useVoiceStore((s) => s.amplitude);
  const sessionCostUsd = useVoiceStore((s) => s.sessionCostUsd);
  const start = useVoiceStore((s) => s.start);
  const end = useVoiceStore((s) => s.end);
  const setMuted = useVoiceStore((s) => s.setMuted);
  const toggleCaptions = useVoiceStore((s) => s.toggleCaptions);
  const interrupt = useVoiceStore((s) => s.interrupt);
  const activeConversationId = useThreadStore((s) => s.activeConversationId);
  const reducedMotion = useReducedMotion();

  if (phase === "idle") return null;

  const state = orbState(phase, muted);
  const OrbIcon = ORB_ICONS[state];
  const live = phase !== "ended" && phase !== "error";
  // The amplitude-driven pulse is JS-set inline style, so the global CSS
  // reduced-motion collapse can't stop it — gate it here (state is still
  // conveyed by icon + text label).
  const animated = !reducedMotion && (state === "listening" || state === "speaking");
  const scale = animated ? 1 + amplitude * 0.35 : 1;
  const orbStyle: CSSProperties | undefined = reducedMotion
    ? undefined
    : ({
        transform: `scale(${scale.toFixed(3)})`,
        "--orb-glow": (0.25 + amplitude * 0.5).toFixed(3),
      } as CSSProperties);

  const lastAssistantFinal = [...captions]
    .reverse()
    .find((line) => line.role === "assistant" && line.final)?.text;
  const assistantLine = assistantPartial || lastAssistantFinal || "";

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      void end();
    }
  };

  return (
    <section
      role="region"
      aria-label="Voice conversation"
      className="voice-panel"
      data-phase={phase}
      onKeyDown={onKeyDown}
    >
      <div className="voice-orb-wrap" aria-hidden>
        <div className="voice-orb" data-state={state} style={orbStyle}>
          <OrbIcon size={16} aria-hidden />
        </div>
      </div>

      {phase === "ended" ? (
        <>
          <div className="voice-center">
            <p className="voice-note">{endedReason ?? "Voice session ended"}</p>
          </div>
          <div className="voice-controls">
            <button
              type="button"
              className="btn btn-secondary voice-restart-btn"
              onClick={() => void start(activeConversationId)}
            >
              Start again
            </button>
            <button
              type="button"
              className="voice-icon-btn"
              aria-label="Close voice panel"
              title="Close"
              onClick={() => void end()}
            >
              <X size={16} aria-hidden />
            </button>
          </div>
        </>
      ) : phase === "error" ? (
        <>
          <div className="voice-center">
            <p className="voice-note voice-error-text">
              {error ?? "Something went wrong with voice."}
            </p>
          </div>
          <div className="voice-controls">
            <button
              type="button"
              className="btn btn-secondary voice-restart-btn"
              onClick={() => void start(activeConversationId)}
            >
              Retry
            </button>
            <button
              type="button"
              className="voice-icon-btn"
              aria-label="Close voice panel"
              title="Close"
              onClick={() => void end()}
            >
              <X size={16} aria-hidden />
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="voice-center" aria-live="polite">
            {captionsOn ? (
              <>
                {assistantLine ? (
                  <p
                    className="voice-caption-assistant"
                    data-partial={assistantPartial.length > 0 || undefined}
                  >
                    {assistantLine}
                  </p>
                ) : (
                  <p className="voice-state-label">{stateLabel(phase, muted)}</p>
                )}
                {userPartial ? (
                  <p className="voice-caption-user" data-partial>
                    You: {userPartial}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="voice-state-label">{stateLabel(phase, muted)}</p>
            )}
          </div>
          <div className="voice-controls">
            {sessionCostUsd > 0 ? (
              <span className="voice-cost" title="Estimated session cost">
                ~${sessionCostUsd.toFixed(4)}
              </span>
            ) : null}
            <button
              type="button"
              className="voice-icon-btn"
              aria-label={muted ? "Unmute microphone" : "Mute microphone"}
              title={muted ? "Unmute microphone" : "Mute microphone"}
              aria-pressed={muted}
              data-active={muted || undefined}
              disabled={!live}
              onClick={() => setMuted(!muted)}
            >
              {muted ? <MicOff size={16} aria-hidden /> : <Mic size={16} aria-hidden />}
            </button>
            {phase === "speaking" ? (
              <button
                type="button"
                className="voice-icon-btn"
                aria-label="Interrupt"
                title="Interrupt"
                onClick={interrupt}
              >
                <CircleStop size={16} aria-hidden />
              </button>
            ) : null}
            <button
              type="button"
              className="voice-icon-btn"
              aria-label="Captions"
              title="Captions"
              aria-pressed={captionsOn}
              data-active={captionsOn || undefined}
              onClick={toggleCaptions}
            >
              <Captions size={16} aria-hidden />
            </button>
            <button
              type="button"
              className="voice-icon-btn voice-end-btn"
              aria-label="End voice conversation"
              title="End voice conversation"
              onClick={() => void end()}
            >
              <PhoneOff size={16} aria-hidden />
            </button>
          </div>
        </>
      )}
    </section>
  );
}
