/**
 * Right-side artifacts panel: list of the thread's artifacts, a version
 * stepper, sandboxed iframe preview for HTML/SVG, and a code view with copy
 * and Blob-download for everything else.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import type { ClientArtifact } from "@/lib/data/entities";
import { artifactExtension, artifactSrcDoc } from "./helpers";

export function ArtifactsPanel({ artifacts }: { artifacts: ClientArtifact[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected =
    artifacts.find((a) => a.identifier === selectedId) ??
    artifacts[artifacts.length - 1] ??
    null;

  if (collapsed) {
    return (
      <div className="chat-artifacts chat-artifacts-collapsed">
        <button
          type="button"
          className="chat-toolbar-btn"
          aria-label="Show artifacts"
          title="Show artifacts"
          onClick={() => setCollapsed(false)}
        >
          <PanelRightOpen size={16} aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <aside className="chat-artifacts" aria-label="Artifacts">
      <div className="chat-artifacts-header">
        <span className="chat-artifacts-title">Artifacts</span>
        <button
          type="button"
          className="chat-toolbar-btn"
          aria-label="Hide artifacts"
          title="Hide artifacts"
          onClick={() => setCollapsed(true)}
        >
          <PanelRightClose size={16} aria-hidden />
        </button>
      </div>

      {artifacts.length > 1 ? (
        <div className="chat-artifacts-list" role="listbox" aria-label="Artifact list">
          {artifacts.map((artifact) => (
            <button
              key={artifact.identifier}
              type="button"
              role="option"
              aria-selected={artifact.identifier === selected?.identifier}
              className="chat-artifact-row"
              data-selected={artifact.identifier === selected?.identifier || undefined}
              onClick={() => setSelectedId(artifact.identifier)}
            >
              <span className="chat-artifact-row-title">{artifact.title || artifact.identifier}</span>
              <span className="chat-artifact-row-type">{artifact.type.toLowerCase()}</span>
            </button>
          ))}
        </div>
      ) : null}

      {selected ? <ArtifactViewer key={selected.identifier} artifact={selected} /> : null}
    </aside>
  );
}

function ArtifactViewer({ artifact }: { artifact: ClientArtifact }) {
  const versions = artifact.versions;
  const pages = Math.max(1, versions.length);
  const [index, setIndex] = useState(pages - 1);
  const [copied, setCopied] = useState(false);

  // Streaming merges replace the artifact wholesale — follow the newest version.
  useEffect(() => {
    setIndex(Math.max(1, artifact.versions.length) - 1);
  }, [artifact.currentVersion, artifact.versions.length, artifact.content]);

  const content =
    versions.length > 0 ? (versions[index]?.content ?? artifact.content) : artifact.content;
  const srcDoc = useMemo(
    () => artifactSrcDoc(artifact.type, content),
    [artifact.type, content],
  );

  const copy = () => {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const download = () => {
    const extension = artifactExtension(artifact.type, artifact.language);
    const safeTitle =
      (artifact.title || artifact.identifier).replace(/[^a-zA-Z0-9._ -]/g, "").trim() ||
      "artifact";
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeTitle}.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="chat-artifact-viewer">
      <div className="chat-artifact-meta">
        <div className="chat-artifact-heading">
          <span className="chat-artifact-name" title={artifact.title}>
            {artifact.title || artifact.identifier}
          </span>
          <span className="chat-artifact-type">
            {artifact.language ? artifact.language : artifact.type.toLowerCase()}
          </span>
        </div>
        <div className="chat-artifact-actions">
          {versions.length > 1 ? (
            <div className="chat-version-pager" role="group" aria-label="Artifact versions">
              <button
                type="button"
                className="chat-toolbar-btn"
                aria-label="Previous artifact version"
                disabled={index === 0}
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
              >
                <ChevronLeft size={13} aria-hidden />
              </button>
              <span className="chat-version-count">
                v{versions[index]?.version ?? index + 1}/{versions.length}
              </span>
              <button
                type="button"
                className="chat-toolbar-btn"
                aria-label="Next artifact version"
                disabled={index === versions.length - 1}
                onClick={() => setIndex((i) => Math.min(versions.length - 1, i + 1))}
              >
                <ChevronRight size={13} aria-hidden />
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="chat-toolbar-btn"
            aria-label={copied ? "Copied" : "Copy artifact"}
            title={copied ? "Copied" : "Copy"}
            onClick={copy}
          >
            {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          </button>
          <button
            type="button"
            className="chat-toolbar-btn"
            aria-label="Download artifact"
            title="Download"
            onClick={download}
          >
            <Download size={14} aria-hidden />
          </button>
        </div>
      </div>

      {srcDoc ? (
        <iframe
          className="chat-artifact-frame"
          title={artifact.title || "Artifact preview"}
          sandbox="allow-scripts"
          srcDoc={srcDoc}
        />
      ) : (
        <pre className="chat-artifact-code selectable">
          <code>{content}</code>
        </pre>
      )}
    </div>
  );
}
