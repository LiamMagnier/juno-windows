import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RotateCcw } from "lucide-react";
import {
  getQuickSettings,
  updateQuickSettings,
  type QuickSettings,
  type QuickSettingsPatch,
} from "@/lib/quick/native";
import { shortcutFromKeyboardEvent } from "@/lib/quick/shortcut";
import { SectionTitle, SettingRow, ToggleSetting } from "./controls";

export function QuickSection() {
  const [settings, setSettings] = useState<QuickSettings | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getQuickSettings()
      .then(setSettings)
      .catch(() => setError("Juno Quick settings are unavailable."));
  }, []);

  const update = async (patch: QuickSettingsPatch) => {
    if (!settings || busy) return;
    setBusy(true);
    setError(null);
    try {
      setSettings(await updateQuickSettings(patch));
    } catch (cause) {
      const command = cause as { message?: string };
      setError(command.message ?? "That Quick setting could not be changed.");
      setSettings(await getQuickSettings().catch(() => settings));
    } finally {
      setBusy(false);
    }
  };

  if (!settings) {
    return (
      <section className="settings-section" aria-label="Juno Quick">
        <SectionTitle>Juno Quick</SectionTitle>
        <p className={error ? "settings-error" : "settings-muted"} role="status">{error ?? "Loading…"}</p>
      </section>
    );
  }

  const registered = settings.shortcutStatus === "registered";

  return (
    <section className="settings-section" aria-label="Juno Quick">
      <SectionTitle
        trailing={
          <span className={`quick-settings-status ${registered ? "is-ok" : "is-warning"}`}>
            {registered ? <CheckCircle2 size={13} aria-hidden /> : <AlertTriangle size={13} aria-hidden />}
            {registered ? "Shortcut active" : settings.shortcutStatus}
          </span>
        }
      >
        Juno Quick
      </SectionTitle>

      <ToggleSetting
        label="Enable Juno Quick"
        hint="Keep Juno available from the global shortcut and notification area. Closing the main window keeps it in the background."
        checked={settings.enabled}
        onChange={(enabled) => void update({ enabled })}
      />

      <SettingRow
        label="Global shortcut"
        hint="One active shortcut at a time. If another app owns the new chord, Juno keeps the previous one."
      >
        <div className="quick-shortcut-setting">
          <button
            type="button"
            className={`quick-shortcut-recorder${recording ? " is-recording" : ""}`}
            disabled={!settings.enabled || busy}
            aria-label={recording ? "Press a new shortcut" : `Global shortcut ${settings.shortcut}`}
            onClick={() => {
              setRecording(true);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (!recording) return;
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Escape") {
                setRecording(false);
                return;
              }
              const shortcut = shortcutFromKeyboardEvent(event.nativeEvent);
              if (!shortcut) {
                setError("Use at least one modifier: Ctrl, Shift, Alt, or Windows key.");
                return;
              }
              setRecording(false);
              void update({ shortcut });
            }}
          >
            {recording ? "Press shortcut…" : settings.shortcut.replaceAll("+", " + ")}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            aria-label="Reset Quick shortcut"
            disabled={busy || settings.shortcut === "Ctrl+Space"}
            onClick={() => void update({ shortcut: "Ctrl+Space" })}
          >
            <RotateCcw size={14} aria-hidden />
          </button>
        </div>
      </SettingRow>

      <ToggleSetting
        label="Launch at login"
        hint="Start quietly in the notification area so the shortcut works before opening Juno."
        checked={settings.launchAtLogin}
        onChange={(launchAtLogin) => void update({ launchAtLogin })}
      />

      <ToggleSetting
        label="Dismiss when focus moves away"
        hint="Hide Quick when you click another app. Active responses keep running and are available from the shortcut."
        checked={settings.dismissOnBlur}
        onChange={(dismissOnBlur) => void update({ dismissOnBlur })}
      />

      {settings.shortcutError || error ? (
        <p className="settings-error" role="alert">{error ?? settings.shortcutError}</p>
      ) : null}
      <p className="settings-muted">
        Quit Juno explicitly from its notification-area menu. Draft text is account-scoped in Windows Credential Manager and cleared on sign-out.
      </p>
    </section>
  );
}

