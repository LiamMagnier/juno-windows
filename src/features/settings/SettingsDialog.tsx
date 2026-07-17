/**
 * Settings — a two-column dialog (nav rail + scrollable pane) covering
 * general appearance, personalization, plan & usage, devices, data &
 * account, and the developer backend switch.
 */
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Gauge,
  MonitorSmartphone,
  SlidersHorizontal,
  Sparkles,
  Zap,
  UserRound,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { useUiStore } from "@/state/uiStore";
import { AccountSection } from "./AccountSection";
import { BackendSection } from "./BackendSection";
import { DevicesSection } from "./DevicesSection";
import { GeneralSection } from "./GeneralSection";
import { PersonalizationSection } from "./PersonalizationSection";
import { PlanSection } from "./PlanSection";
import { QuickSection } from "./QuickSection";
import "./settings.css";

type SectionId = "general" | "quick" | "personalization" | "plan" | "devices" | "data" | "backend";

const SECTIONS: Array<{ id: SectionId; label: string; icon: LucideIcon }> = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "quick", label: "Juno Quick", icon: Zap },
  { id: "personalization", label: "Personalization", icon: Sparkles },
  { id: "plan", label: "Plan & usage", icon: Gauge },
  { id: "devices", label: "Devices", icon: MonitorSmartphone },
  { id: "data", label: "Data & account", icon: UserRound },
  { id: "backend", label: "Backend (dev)", icon: Wrench },
];

export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen);
  const openSettings = useUiStore((s) => s.openSettings);
  const [section, setSection] = useState<SectionId>("general");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void listen<string>("juno://open-settings", (event) => {
      if (event.payload === "quick") setSection("quick");
    }).then((off) => {
      cleanup = off;
    });
    return () => cleanup?.();
  }, []);

  if (!open) return null;

  const activeIndex = SECTIONS.findIndex((s) => s.id === section);

  const onRailKeyDown = (e: React.KeyboardEvent) => {
    let next = -1;
    if (e.key === "ArrowDown") next = (activeIndex + 1) % SECTIONS.length;
    else if (e.key === "ArrowUp") next = (activeIndex + SECTIONS.length - 1) % SECTIONS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = SECTIONS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setSection(SECTIONS[next]!.id);
    tabRefs.current[next]?.focus();
  };

  return (
    <Dialog title="Settings" open onClose={() => openSettings(false)} width={720}>
      <div className="settings-layout">
        <nav
          className="settings-rail"
          role="tablist"
          aria-label="Settings sections"
          aria-orientation="vertical"
          onKeyDown={onRailKeyDown}
        >
          {SECTIONS.map((s, i) => {
            const Icon = s.icon;
            const active = s.id === section;
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                id={`settings-tab-${s.id}`}
                aria-selected={active}
                aria-controls="settings-pane"
                tabIndex={active ? 0 : -1}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                className={`settings-rail-item${active ? " is-active" : ""}`}
                onClick={() => setSection(s.id)}
              >
                <Icon size={16} aria-hidden />
                {s.label}
              </button>
            );
          })}
        </nav>
        <div
          id="settings-pane"
          className="settings-pane"
          role="tabpanel"
          aria-labelledby={`settings-tab-${section}`}
        >
          {section === "general" ? <GeneralSection /> : null}
          {section === "quick" ? <QuickSection /> : null}
          {section === "personalization" ? <PersonalizationSection /> : null}
          {section === "plan" ? <PlanSection /> : null}
          {section === "devices" ? <DevicesSection /> : null}
          {section === "data" ? <AccountSection /> : null}
          {section === "backend" ? <BackendSection /> : null}
        </div>
      </div>
    </Dialog>
  );
}
