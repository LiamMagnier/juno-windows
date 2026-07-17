/** Personalization: personality, custom instructions, default model, memory. */
import { useDataStore } from "@/state/dataStore";
import {
  DebouncedTextSetting,
  patchAccountSettings,
  SavedTick,
  SectionTitle,
  SettingRow,
  ToggleSetting,
  useSavedTick,
} from "./controls";

/** Server-validated personality ids (juno PATCH /api/settings contract). */
const PERSONALITIES: Array<{ value: string; label: string }> = [
  { value: "default", label: "Default" },
  { value: "concise", label: "Concise" },
  { value: "encouraging", label: "Encouraging" },
  { value: "socratic", label: "Socratic" },
  { value: "formal", label: "Formal" },
  { value: "nerdy", label: "Nerdy" },
];

export function PersonalizationSection() {
  const settings = useDataStore((s) => s.settings);
  const manifest = useDataStore((s) => s.manifest);
  const personalityTick = useSavedTick();
  const modelTick = useSavedTick();

  const personality = settings?.personality ?? "default";
  const defaultModel = settings?.defaultModel ?? "";

  const models = (manifest?.models ?? []).filter(
    (m) => m.availability === "available" && m.lifecycle !== "deprecated",
  );
  const knownModel = models.some((m) => m.id === defaultModel);

  return (
    <section className="settings-section" aria-label="Personalization">
      <SectionTitle>Personalization</SectionTitle>

      <SettingRow label="Personality" hint="Sets the tone of Juno's replies.">
        <SavedTick visible={personalityTick.saved} />
        <select
          className="settings-select"
          value={personality}
          aria-label="Personality"
          onChange={(e) => {
            patchAccountSettings({ personality: e.target.value });
            personalityTick.markSaved();
          }}
        >
          {PERSONALITIES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </SettingRow>

      <DebouncedTextSetting
        label="Custom instructions"
        hint="Preferences and context Juno should keep in mind in every chat."
        value={settings?.customInstructions ?? ""}
        maxLength={4000}
        multiline
        showCount
        placeholder="Anything Juno should know about you or how to respond"
        onCommit={(next) => patchAccountSettings({ customInstructions: next })}
      />

      <SettingRow label="Default model" hint="Used for new conversations.">
        <SavedTick visible={modelTick.saved} />
        <select
          className="settings-select"
          value={knownModel ? defaultModel : ""}
          aria-label="Default model"
          disabled={models.length === 0}
          onChange={(e) => {
            if (!e.target.value) return;
            patchAccountSettings({ defaultModel: e.target.value });
            modelTick.markSaved();
          }}
        >
          {models.length === 0 ? (
            <option value="">Models unavailable</option>
          ) : (
            <>
              {!knownModel ? (
                <option value="" disabled>
                  {defaultModel || "Choose a model"}
                </option>
              ) : null}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName} · {m.provider.displayName}
                </option>
              ))}
            </>
          )}
        </select>
      </SettingRow>

      <ToggleSetting
        label="Memory"
        hint="Let Juno remember useful details from your chats."
        checked={settings?.memoryEnabled ?? true}
        onChange={(next) => patchAccountSettings({ memoryEnabled: next })}
      />
    </section>
  );
}
