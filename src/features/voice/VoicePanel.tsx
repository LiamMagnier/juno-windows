/**
 * Inline voice panel: a compact card docked directly above the chat composer
 * while a voice session is running. Shows the amplitude-driven orb, live
 * captions (or a one-line state label), and the session controls
 * (mute / interrupt / captions / end), plus ended and error layouts.
 */
import { useRef, type KeyboardEvent } from "react";
import { Captions, CircleStop, Mic, MicOff, PhoneOff, X } from "lucide-react";
import { useThreadStore } from "@/state/threadStore";
import { useVoiceStore, type VoicePhase } from "@/state/voiceStore";
import { VoiceOrb, type OrbStatus } from "@/components/signature/VoiceOrb";
import "./voice.css";

/** Voice phase → the website's VoiceOrb status. */
function orbStatusFor(phase: VoicePhase, muted: boolean): OrbStatus {
  switch (phase) {
    case "connecting":
    case "reconnecting":
    case "thinking":
      return "thinking";
    case "speaking":
      return "speaking";
    case "error":
      return "error";
    case "ended":
      return "idle";
    default:
      return muted ? "idle" : "listening";
  }
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
  // The orb reads amplitude every frame off this ref (no extra re-renders).
  const levelRef = useRef(0);
  levelRef.current = amplitude;

  if (phase === "idle") return null;

  const live = phase !== "ended" && phase !== "error";

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
        <VoiceOrb status={orbStatusFor(phase, muted)} levelRef={levelRef} className="voice-orb-mark" />
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
