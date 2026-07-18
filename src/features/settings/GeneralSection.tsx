/** General: theme, accent, response language, UI language, and updates. */
import { useDataStore } from "@/state/dataStore";
import { useUiStore, type AccentName, type ThemePreference } from "@/state/uiStore";
import { useUpdateStore } from "@/lib/updater";
import { hostInfo, type HostInfo } from "@/lib/host";
import { useEffect, useState } from "react";
import {
  DebouncedTextSetting,
  patchAccountSettings,
  SavedTick,
  SectionTitle,
  SettingRow,
  ToggleSetting,
  useSavedTick,
} from "./controls";

const THEMES: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const ACCENTS: AccentName[] = ["coral", "teal", "violet", "amber", "sage"];

export function GeneralSection() {
  const settings = useDataStore((s) => s.settings);
  const theme = useUiStore((s) => s.theme);
  const accent = useUiStore((s) => s.accent);
  const setTheme = useUiStore((s) => s.setTheme);
  const setAccent = useUiStore((s) => s.setAccent);
  const transparency = useUiStore((s) => s.transparency);
  const setTransparency = useUiStore((s) => s.setTransparency);
  const themeTick = useSavedTick();
  const accentTick = useSavedTick();
  const updatePhase = useUpdateStore((s) => s.phase);
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates);
  const downloadAndInstall = useUpdateStore((s) => s.downloadAndInstall);
  const relaunchToUpdate = useUpdateStore((s) => s.relaunchToUpdate);
  const [host, setHost] = useState<HostInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    hostInfo()
      .then((info) => {
        if (!cancelled) setHost(info);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const chooseTheme = (value: ThemePreference) => {
    if (value === theme) return;
    setTheme(value);
    patchAccountSettings({ theme: value.toUpperCase() });
    themeTick.markSaved();
  };

  const chooseAccent = (value: AccentName) => {
    if (value === accent) return;
    setAccent(value);
    patchAccountSettings({ accent: value });
    accentTick.markSaved();
  };

  const uiLocale = settings?.uiLocale ?? "auto";

  return (
    <section className="settings-section" aria-label="General">
      <SectionTitle>General</SectionTitle>

      <SettingRow label="Theme" hint="How Juno looks on this device and your account.">
        <SavedTick visible={themeTick.saved} />
        <div className="settings-segment" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={theme === t.value}
              className={`settings-segment-item${theme === t.value ? " is-active" : ""}`}
              onClick={() => chooseTheme(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </SettingRow>

      <SettingRow label="Accent color">
        <SavedTick visible={accentTick.saved} />
        <div className="settings-swatches" role="radiogroup" aria-label="Accent color">
          {ACCENTS.map((name) => (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={accent === name}
              aria-label={`${name.charAt(0).toUpperCase()}${name.slice(1)} accent`}
              className={`settings-swatch settings-swatch-${name}${accent === name ? " is-active" : ""}`}
              onClick={() => chooseAccent(name)}
            />
          ))}
        </div>
      </SettingRow>

      <ToggleSetting
        label="Transparency effects"
        hint="Mica and Acrylic materials on the sidebar, titlebar, and menus."
        checked={transparency}
        onChange={setTransparency}
      />

      <DebouncedTextSetting
        label="Response language"
        hint={'A language name like "French", or "auto" to match your message.'}
        value={settings?.responseLanguage ?? "auto"}
        maxLength={40}
        placeholder="auto"
        onCommit={(next) => patchAccountSettings({ responseLanguage: next || "auto" })}
      />

      <SettingRow
        label="Interface language"
        hint="Set from your account on the web."
      >
        <span className="settings-value">{uiLocale === "auto" ? "Auto" : uiLocale}</span>
      </SettingRow>

      <SettingRow
        label="App updates"
        hint={
          updatePhase.kind === "ready"
            ? `Juno ${updatePhase.version} is downloaded — relaunch to install.`
            : updatePhase.kind === "downloading"
              ? `Downloading Juno ${updatePhase.version}…`
              : updatePhase.kind === "available"
                ? `Juno ${updatePhase.version} is available.`
                : updatePhase.kind === "upToDate"
                  ? "You're on the latest version."
                  : updatePhase.kind === "error"
                    ? updatePhase.message
                    : updatePhase.kind === "checking"
                      ? "Checking…"
                      : host
                        ? `Installed ${host.appVersion}`
                        : "Check for a newer build without re-downloading the installer."
        }
      >
        {updatePhase.kind === "ready" ? (
          <button type="button" className="btn btn-primary" onClick={() => void relaunchToUpdate()}>
            Relaunch to update
          </button>
        ) : updatePhase.kind === "available" ? (
          <button type="button" className="btn btn-primary" onClick={() => void downloadAndInstall()}>
            Download update
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={updatePhase.kind === "checking" || updatePhase.kind === "downloading"}
            onClick={() => void checkForUpdates({ quiet: false })}
          >
            {updatePhase.kind === "checking" ? "Checking…" : "Check for updates"}
          </button>
        )}
      </SettingRow>
    </section>
  );
}
