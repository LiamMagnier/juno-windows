/**
 * Library picker — browse files previously attached to any chat and re-attach
 * them to the current message. `/api/library` lists them; `/api/library/attach`
 * returns fresh conversation-bound copies.
 */
import { useEffect, useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { api } from "@/lib/backend/http";
import type { ClientAttachment } from "@/lib/data/entities";
import { fileUrl } from "./fileUrl";
import { formatBytes } from "./helpers";

interface LibraryItem extends ClientAttachment {
  createdAt: string;
}

export function LibraryPicker({
  open,
  onClose,
  onAttach,
  remaining,
}: {
  open: boolean;
  onClose: () => void;
  onAttach: (attachments: ClientAttachment[]) => void;
  remaining: number;
}) {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [attaching, setAttaching] = useState(false);

  useEffect(() => {
    if (!open) {
      setSelected(new Set());
      setError(null);
      return;
    }
    let cancelled = false;
    setItems(null);
    api<{ items: LibraryItem[] }>("/library")
      .then((res) => {
        if (!cancelled) setItems(res.items);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load your library.");
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < remaining) next.add(id);
      return next;
    });
  };

  const attach = async () => {
    if (selected.size === 0) return;
    setAttaching(true);
    try {
      const res = await api<{ attachments: ClientAttachment[] }>("/library/attach", {
        method: "POST",
        body: { attachmentIds: [...selected] },
      });
      onAttach(res.attachments);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't attach those files.");
    } finally {
      setAttaching(false);
    }
  };

  return (
    <Dialog title="Add from your library" open={open} onClose={onClose}>
      <div className="library-picker">
        {items === null && !error ? (
          <div className="library-picker-state">
            <Loader2 size={18} className="chat-spin" aria-hidden /> Loading…
          </div>
        ) : error ? (
          <div className="library-picker-state" role="alert">
            {error}
          </div>
        ) : items && items.length === 0 ? (
          <div className="library-picker-state">
            Nothing here yet. Files you attach to chats show up in your library.
          </div>
        ) : (
          <div className="library-grid" role="group" aria-label="Library files">
            {items?.map((item) => {
              const isSelected = selected.has(item.id);
              const atCap = !isSelected && selected.size >= remaining;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={isSelected}
                  className="library-tile"
                  data-selected={isSelected || undefined}
                  disabled={atCap}
                  onClick={() => toggle(item.id)}
                >
                  {item.kind === "IMAGE" ? (
                    <img className="library-thumb" src={fileUrl(item.url)} alt="" />
                  ) : (
                    <span className="library-thumb library-thumb-file">
                      <FileText size={22} aria-hidden />
                    </span>
                  )}
                  <span className="library-tile-name" title={item.fileName}>
                    {item.fileName}
                  </span>
                  <span className="library-tile-size">{formatBytes(item.size)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={selected.size === 0 || attaching}
          onClick={() => void attach()}
        >
          {attaching ? "Adding…" : selected.size > 0 ? `Add ${selected.size}` : "Add"}
        </button>
      </div>
    </Dialog>
  );
}
