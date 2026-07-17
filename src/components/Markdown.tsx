/**
 * Sanitized markdown for assistant messages. marked -> DOMPurify -> HTML.
 * Code blocks get highlight.js classes; links open in the system browser.
 */
import { memo, useMemo } from "react";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { openUrl } from "@tauri-apps/plugin-opener";
// Syntax token colors live in markdown.css, scoped to the app's light/dark
// theme classes (the stock highlight.js stylesheets are single-theme).
import "./markdown.css";

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const language = lang && hljs.getLanguage(lang) ? lang : undefined;
      const highlighted = language
        ? hljs.highlight(text, { language }).value
        : hljs.highlightAuto(text).value;
      const label = language ?? "";
      return `<pre class="md-code" data-lang="${label}"><button type="button" class="md-copy" aria-label="Copy code"></button><code class="hljs">${highlighted}</code></pre>`;
    },
  },
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("data-external", "true");
    node.removeAttribute("target");
  }
});

function onClickCapture(e: React.MouseEvent) {
  const target = e.target as HTMLElement;
  const copyBtn = target.closest("button.md-copy");
  if (copyBtn) {
    e.preventDefault();
    const code = copyBtn.closest("pre.md-code")?.querySelector("code");
    void navigator.clipboard.writeText(code?.textContent ?? "").then(() => {
      copyBtn.setAttribute("data-copied", "true");
      setTimeout(() => copyBtn.removeAttribute("data-copied"), 1500);
    });
    return;
  }
  const anchor = target.closest("a[data-external]");
  if (anchor) {
    e.preventDefault();
    const href = anchor.getAttribute("href");
    if (href && /^https?:\/\//i.test(href)) void openUrl(href);
  }
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false });
    // Allowlist, not denylist: only the structures markdown can produce.
    return DOMPurify.sanitize(raw, {
      ALLOWED_TAGS: [
        "p", "br", "hr", "blockquote", "pre", "code", "span",
        "em", "strong", "del", "s", "a", "img",
        "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
        "table", "thead", "tbody", "tr", "th", "td",
        "sup", "sub", "input", "button",
      ],
      ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "data-lang", "data-external", "type", "checked", "disabled", "start", "aria-label"],
      ALLOWED_URI_REGEXP: /^(?:https?:|data:image\/(?:png|jpe?g|gif|webp);base64,)/i,
    });
  }, [text]);

  return (
    <div
      className="markdown selectable"
      onClickCapture={onClickCapture}
      // Sanitized above; this is the single designated injection point.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
