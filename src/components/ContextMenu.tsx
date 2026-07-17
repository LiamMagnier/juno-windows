/**
 * Windows-style context menu: right-click anchored, keyboard navigable,
 * Escape/Tab/blur dismiss, true roving focus on menu items, destructive tint.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { registerOverlay } from "./overlayStack";
import "./contextmenu.css";

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  onSelect(): void;
}

interface MenuState {
  items: MenuItem[];
  x: number;
  y: number;
}

const MenuContext = createContext<{
  open(items: MenuItem[], x: number, y: number): void;
} | null>(null);

export function useContextMenu() {
  const ctx = useContext(MenuContext);
  if (!ctx) throw new Error("useContextMenu requires <ContextMenuProvider>");
  return ctx;
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const open = useCallback((items: MenuItem[], x: number, y: number) => {
    setMenu({ items, x, y });
  }, []);

  return (
    <MenuContext.Provider value={{ open }}>
      {children}
      {menu ? <MenuPopup menu={menu} onClose={() => setMenu(null)} /> : null}
    </MenuContext.Provider>
  );
}

function MenuPopup({ menu, onClose }: { menu: MenuState; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [position, setPosition] = useState({ x: menu.x, y: menu.y });
  const [focusIndex, setFocusIndex] = useState(0);
  const enabled = menu.items.filter((i) => !i.disabled);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPosition({
      x: Math.min(menu.x, window.innerWidth - rect.width - 8),
      y: Math.min(menu.y, window.innerHeight - rect.height - 8),
    });
    setFocusIndex(0);
  }, [menu]);

  // Escape layering + focus restoration: register on the overlay stack and
  // hand focus back to whatever had it before the menu opened.
  useEffect(() => {
    const overlay = registerOverlay();
    const previousFocus = document.activeElement as HTMLElement | null;
    return () => {
      overlay.unregister();
      previousFocus?.focus();
    };
  }, []);

  // True roving focus: DOM focus follows the highlighted menu item so screen
  // readers announce each item as arrows (or hover) move the highlight.
  useEffect(() => {
    const item = itemRefs.current[focusIndex];
    if (item) item.focus();
    else ref.current?.focus();
  }, [focusIndex, menu]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab") {
      // Per the WAI-ARIA menu pattern, Tab dismisses the menu.
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusIndex((i) => (i + 1) % enabled.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIndex((i) => (i - 1 + enabled.length) % enabled.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setFocusIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setFocusIndex(Math.max(0, enabled.length - 1));
    }
  };

  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: position.x, top: position.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item, itemIndex) => {
        const enabledIndex = enabled.indexOf(item);
        return (
          <div key={item.id}>
            {item.separatorBefore ? <div className="context-menu-separator" role="separator" /> : null}
            <button
              ref={(el) => {
                if (enabledIndex >= 0) itemRefs.current[enabledIndex] = el;
              }}
              type="button"
              id={`context-menu-item-${itemIndex}`}
              role="menuitem"
              className="context-menu-item"
              tabIndex={-1}
              data-destructive={item.destructive || undefined}
              data-focused={enabledIndex === focusIndex || undefined}
              disabled={item.disabled}
              onPointerEnter={() => enabledIndex >= 0 && setFocusIndex(enabledIndex)}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
            >
              {item.icon ? <span className="context-menu-icon">{item.icon}</span> : null}
              {item.label}
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
