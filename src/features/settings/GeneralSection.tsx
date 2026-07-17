/** General: theme, accent, response language, UI language display. */
import { useDataStore } from "@/state/dataStore";
import { useUiStore, type AccentName, type ThemePreference } from "@/state/uiStore";
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
    </section>
  );
}
