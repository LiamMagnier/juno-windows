/**
 * Account announcements: the newest live undismissed announcement as a quiet
 * banner under the titlebar. Dismissal posts to the server and is also
 * guarded locally (the server dismiss is fire-and-forget on the web too).
 */
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "@/lib/backend/http";
import "./announcement.css";

interface ClientAnnouncement {
  id: string;
  title: string;
  description: string | null;
  newsLabel: string | null;
  newsHref: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
}

const DISMISSED_KEY = "juno.dismissedAnnouncements";

function locallyDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function AnnouncementBar() {
  const [announcement, setAnnouncement] = useState<ClientAnnouncement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api<{ announcement: ClientAnnouncement | null }>("/announcements")
      .then((res) => {
        if (cancelled || !res.announcement) return;
        if (locallyDismissed().has(res.announcement.id)) return;
        setAnnouncement(res.announcement);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!announcement) return null;

  const dismiss = () => {
    const dismissed = locallyDismissed();
    dismissed.add(announcement.id);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed]));
    setAnnouncement(null);
    void api(`/announcements/${encodeURIComponent(announcement.id)}/dismiss`, {
      method: "POST",
    }).catch(() => {});
  };

  const href = announcement.ctaHref ?? announcement.newsHref;
  const label = announcement.ctaLabel ?? announcement.newsLabel;

  return (
    <div className="announcement" role="status">
      <span className="announcement-title">{announcement.title}</span>
      {announcement.description ? (
        <span className="announcement-desc">{announcement.description}</span>
      ) : null}
      {href && label ? (
        <button
          type="button"
          className="announcement-cta"
          onClick={() => void openUrl(href)}
        >
          {label}
        </button>
      ) : null}
      <button type="button" className="announcement-close" aria-label="Dismiss announcement" onClick={dismiss}>
        <X size={13} aria-hidden />
      </button>
    </div>
  );
}
