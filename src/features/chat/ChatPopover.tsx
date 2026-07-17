/**
 * Anchored popover for composer controls: opens above its anchor, closes on
 * Escape / outside pointer-down / window blur, restores focus to the anchor.
 */
import { useEffect, useRef, type ReactNode } from "react";

export function ChatPopover({
  open,
  onClose,
  label,
  width,
  align = "start",
  children,
}: {
  open: boolean;
  onClose(): void;
  label: string;
  width?: number;
  align?: "start" | "end";
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const wrap = ref.current?.parentElement;
    const onPointerDown = (e: PointerEvent) => {
      if (wrap && !wrap.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        wrap?.querySelector<HTMLElement>("button")?.focus();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onClose);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className="chat-popover"
      role="dialog"
      aria-label={label}
      data-align={align}
      style={width !== undefined ? { width } : undefined}
    >
      {children}
    </div>
  );
}
