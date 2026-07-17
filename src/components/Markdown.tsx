/**
 * Sanitized markdown for assistant messages. marked -> DOMPurify -> HTML.
 * Code blocks get highlight.js classes; links open in the system browser.
 */
import { memo, useMemo } from "react";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { openUrl } from "@tauri-apps/plugin-opener";
import "highlight.js/styles/github-dark.css";
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
      return `<pre class="md-code" data-lang="${label}"><code class="hljs">${highlighted}</code></pre>`;
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
  const anchor = (e.target as HTMLElement).closest("a[data-external]");
  if (anchor) {
    e.preventDefault();
    const href = anchor.getAttribute("href");
    if (href && /^https?:\/\//i.test(href)) void openUrl(href);
  }
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false });
    return DOMPurify.sanitize(raw, {
      FORBID_TAGS: ["style", "form", "input", "iframe", "object", "embed"],
      FORBID_ATTR: ["onerror", "onclick", "onload"],
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
