/**
 * Shared settings plumbing: optimistic account-settings patches through the
 * mutation queue, a transient "Saved" tick, and debounced text fields.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check } from "lucide-react";
import type { AccountSettings } from "@/lib/data/entities";
import { enqueueMutation } from "@/lib/data/mutationQueue";
import { useDataStore } from "@/state/dataStore";

/** Apply the patch to the store optimistically, then enqueue settings.update. */
export function patchAccountSettings(patch: Record<string, unknown>): void {
  const store = useDataStore.getState();
  const current = store.settings;
  if (current) {
    store.setSettings({ ...current, ...(patch as Partial<AccountSettings>) });
  }
  void enqueueMutation({ type: "settings.update", patch });
}

/** Transient "Saved" indicator state for one field group. */
export function useSavedTick(): { saved: boolean; markSaved: () => void } {
  const [saved, setSaved] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const markSaved = useCallback(() => {
    setSaved(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setSaved(false), 1600);
  }, []);
  return { saved, markSaved };
}

export function SavedTick({ visible }: { visible: boolean }) {
  return (
    <span
      className={`settings-saved${visible ? " is-visible" : ""}`}
      aria-hidden={!visible}
      role="status"
    >
      <Check size={12} aria-hidden />
      Saved
    </span>
  );
}

/** Section heading with an optional trailing element. */
export function SectionTitle({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="settings-section-title">
      <h3>{children}</h3>
      {trailing}
    </div>
  );
}

export function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-row-label">{label}</span>
        {hint ? <span className="settings-row-hint">{hint}</span> : null}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

const DEBOUNCE_MS = 600;

/**
 * Text input or textarea that commits its value 600ms after the last
 * keystroke (and on blur), showing a "Saved" tick per commit.
 */
export function DebouncedTextSetting({
  label,
  hint,
  value,
  placeholder,
  maxLength,
  multiline = false,
  showCount = false,
  onCommit,
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  /** Omit for no character cap (model context is the real limit). */
  maxLength?: number;
  multiline?: boolean;
  showCount?: boolean;
  onCommit(next: string): void;
}) {
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);
  const timer = useRef<number | null>(null);
  const { saved, markSaved } = useSavedTick();

  // Adopt external value changes (sync from another device) while clean.
  useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);

  const commit = useCallback(
    (next: string) => {
      dirty.current = false;
      const clamped = maxLength != null ? next.slice(0, maxLength) : next;
      if (clamped === value) return;
      onCommit(clamped);
      markSaved();
    },
    [maxLength, onCommit, value, markSaved],
  );

  const schedule = (next: string) => {
    setDraft(next);
    dirty.current = true;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => commit(next), DEBOUNCE_MS);
  };

  const flush = () => {
    if (!dirty.current) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    commit(draft);
  };

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const field = multiline ? (
    <textarea
      className="settings-textarea"
      value={draft}
      {...(maxLength != null ? { maxLength } : {})}
      {...(placeholder !== undefined ? { placeholder } : {})}
      onChange={(e) => schedule(e.target.value)}
      onBlur={flush}
      aria-label={label}
    />
  ) : (
    <input
      type="text"
      value={draft}
      {...(maxLength != null ? { maxLength } : {})}
      {...(placeholder !== undefined ? { placeholder } : {})}
      onChange={(e) => schedule(e.target.value)}
      onBlur={flush}
      aria-label={label}
    />
  );

  return (
    <div className="field settings-field">
      <div className="settings-field-head">
        <span className="field-label">{label}</span>
        <SavedTick visible={saved} />
      </div>
      {field}
      <div className="settings-field-foot">
        {hint ? <span className="settings-row-hint">{hint}</span> : <span />}
        {showCount ? (
          <span
            className={`settings-count${maxLength != null && draft.length > maxLength * 0.9 ? " is-warning" : ""}`}
          >
            {maxLength != null
              ? `${draft.length}/${maxLength}`
              : `${draft.length.toLocaleString()} chars`}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function ToggleSetting({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange(next: boolean): void;
}) {
  const { saved, markSaved } = useSavedTick();
  return (
    <SettingRow label={label} hint={hint}>
      <SavedTick visible={saved} />
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`settings-switch${checked ? " is-on" : ""}`}
        onClick={() => {
          onChange(!checked);
          markSaved();
        }}
      >
        <span className="settings-switch-thumb" aria-hidden />
      </button>
    </SettingRow>
  );
}
