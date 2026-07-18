/**
 * Provider mark used in the model picker (same assets as the website).
 */
import { useSyncExternalStore } from "react";

const KNOWN = new Set([
  "anthropic",
  "openai",
  "google",
  "meta",
  "zhipu",
  "moonshot",
  "deepseek",
  "mistral",
  "xai",
  "seedance",
  "minimax",
  "mimo",
  "qwen",
  "longcat",
]);

function subscribeDark(cb: () => void) {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => obs.disconnect();
}
function isDark() {
  return document.documentElement.classList.contains("dark");
}

export function ProviderLogo({
  providerId,
  className,
  title,
}: {
  providerId: string;
  className?: string;
  title?: string;
}) {
  const dark = useSyncExternalStore(subscribeDark, isDark, () => false);
  const id = KNOWN.has(providerId) ? providerId : "openai";
  const src = `/provider-logos/${dark ? "dark" : "light"}/${id}.png`;

  return (
    <img
      src={src}
      alt={title ?? providerId}
      title={title}
      className={className}
      draggable={false}
    />
  );
}
