/**
 * Windows-style context menu: right-click anchored, keyboard navigable,
 * Escape/blur dismiss, roving focus, destructive tint.
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
    el.focus();
  }, [menu]);

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
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusIndex((i) => (i + 1) % enabled.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIndex((i) => (i - 1 + enabled.length) % enabled.length);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const item = enabled[focusIndex];
      if (item) {
        onClose();
        item.onSelect();
      }
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
      {menu.items.map((item) => {
        const enabledIndex = enabled.indexOf(item);
        return (
          <div key={item.id}>
            {item.separatorBefore ? <div className="context-menu-separator" role="separator" /> : null}
            <button
              type="button"
              role="menuitem"
              className="context-menu-item"
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
