/** Modal dialog with focus trap, Escape dismiss, and acrylic scrim. */
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { registerOverlay } from "./overlayStack";
import "./dialog.css";

export function Dialog({
  title,
  open,
  onClose,
  children,
  footer,
  width = 440,
}: {
  title: string;
  open: boolean;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  // Keep onClose in a ref so the focus-trap effect depends on [open] only —
  // inline onClose props would otherwise re-run it on every parent re-render,
  // yanking focus back to the first control and corrupting focus restoration.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const overlay = registerOverlay();
    previousFocus.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("input, textarea, button, select")?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!overlay.isTop()) return;
        e.stopImmediatePropagation();
        onCloseRef.current();
      } else if (e.key === "Tab" && panel) {
        const focusables = Array.from(
          panel.querySelectorAll<HTMLElement>(
            "button, [href], input, textarea, select, [tabindex]:not([tabindex='-1'])",
          ),
        ).filter((el) => !el.hasAttribute("disabled"));
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      overlay.unregister();
      window.removeEventListener("keydown", onKeyDown, true);
      previousFocus.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="dialog-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width }}
      >
        <h2 className="dialog-title">{title}</h2>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
