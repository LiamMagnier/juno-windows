/**
 * Tiny module-level stack for layered overlays (dialogs, popovers, context
 * menus, palettes). Each overlay registers on mount and asks `isTop()` before
 * handling Escape, so a single keypress dismisses only the top-most layer
 * instead of whichever listener happened to run first.
 */

const stack: symbol[] = [];

export interface OverlayRegistration {
  /** True while this overlay is the top-most registered layer. */
  isTop(): boolean;
  /** Remove this overlay from the stack (call on unmount/close). */
  unregister(): void;
}

/** True while any overlay is registered (gates global shortcuts like F6). */
export function hasOpenOverlay(): boolean {
  return stack.length > 0;
}

export function registerOverlay(): OverlayRegistration {
  const token = Symbol("overlay");
  stack.push(token);
  return {
    isTop: () => stack[stack.length - 1] === token,
    unregister: () => {
      const index = stack.indexOf(token);
      if (index !== -1) stack.splice(index, 1);
    },
  };
}
