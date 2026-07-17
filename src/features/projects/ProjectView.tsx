/**
 * Single-project detail: inline-editable name, shared instructions editor,
 * reference files, and the project's conversations. Reads live from
 * GET /api/projects/{id}; writes flow through the optimistic mutation queue.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  FileText,
  Image as ImageIcon,
  MessageSquare,
  MessageSquarePlus,
  Pin,
  Upload,
} from "lucide-react";
import { api } from "@/lib/backend/http";
import type { ClientAttachment, ProjectDetail } from "@/lib/data/entities";
import { enqueueMutation } from "@/lib/data/mutationQueue";
import { useDataStore } from "@/state/dataStore";
import { useThreadStore } from "@/state/threadStore";
import { useUiStore } from "@/state/uiStore";
import { setPendingProjectId } from "./projectContext";
import { uploadProjectFileByPath } from "./projectUploads";
import { formatSize, relativeTime } from "./format";
import "./projects.css";

const NAME_MAX = 160;
const INSTRUCTIONS_MAX = 50_000;

export function ProjectView({ projectId }: { projectId: string }) {
  const setView = useUiStore((s) => s.setView);
  const summary = useDataStore((s) => s.projects[projectId]);

  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState(summary?.name ?? "");
  const [instructions, setInstructions] = useState("");
  const [files, setFiles] = useState<ClientAttachment[]>([]);
  const savedName = useRef(summary?.name ?? "");
  const savedInstructions = useRef("");

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api<ProjectDetail>(`/projects/${encodeURIComponent(projectId)}`);
      setDetail(data);
      setName(data.project.name);
      savedName.current = data.project.name;
      setInstructions(data.project.instructions);
      savedInstructions.current = data.project.instructions;
      setFiles(data.files.filter((f) => f.fileName !== "__cover__"));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load this project.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveName = () => {
    const next = name.trim().slice(0, NAME_MAX);
    if (!next) {
      setName(savedName.current);
      return;
    }
    if (next === savedName.current) return;
    savedName.current = next;
    setName(next);
    const store = useDataStore.getState();
    const row = store.projects[projectId];
    if (row) store.upsertProject({ ...row, name: next });
    void enqueueMutation({ type: "project.update", entityId: projectId, name: next });
  };

  const saveInstructions = () => {
    if (instructions === savedInstructions.current) return;
    savedInstructions.current = instructions;
    const store = useDataStore.getState();
    const row = store.projects[projectId];
    if (row) store.upsertProject({ ...row, instructions });
    void enqueueMutation({ type: "project.update", entityId: projectId, instructions });
  };

  const startChat = () => {
    setPendingProjectId(projectId);
    useThreadStore.getState().setActive(null);
    setView({ kind: "chat" });
  };

  const openConversation = (id: string) => {
    useThreadStore.getState().setActive(id);
    setView({ kind: "chat" });
  };

  const addFiles = async () => {
    let selection: string | string[] | null = null;
    try {
      selection = await openFileDialog({ multiple: true, title: "Add files to project" });
    } catch {
      return; // picker unavailable/cancelled
    }
    const paths = Array.isArray(selection) ? selection : selection ? [selection] : [];
    if (paths.length === 0) return;
    setUploading(true);
    setUploadError(null);
    let added = 0;
    for (const path of paths) {
      try {
        const attachment = await uploadProjectFileByPath(path, projectId);
        added += 1;
        setFiles((current) => [attachment, ...current]);
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "Couldn't upload that file.");
      }
    }
    if (added > 0) {
      const store = useDataStore.getState();
      const row = store.projects[projectId];
      if (row) store.upsertProject({ ...row, fileCount: row.fileCount + added });
    }
    setUploading(false);
  };

  // Arrow-key navigation over conversation rows.
  const listRef = useRef<HTMLDivElement>(null);
  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-project-row]") ?? [],
    );
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    e.preventDefault();
    const next = e.key === "ArrowDown" ? Math.min(rows.length - 1, index + 1) : Math.max(0, index - 1);
    rows[next]?.focus();
  };

  const conversations = (detail?.conversations ?? [])
    .slice()
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
    });

  const nearLimit = instructions.length > INSTRUCTIONS_MAX * 0.9;

  return (
    <div className="projects-page project-detail">
      <header className="project-header">
        <button
          type="button"
          className="project-back"
          aria-label="Back to projects"
          onClick={() => setView({ kind: "projects" })}
        >
          <ArrowLeft size={16} aria-hidden />
        </button>
        <input
          className="project-name-input"
          value={name}
          maxLength={NAME_MAX}
          aria-label="Project name"
          placeholder="Project name"
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setName(savedName.current);
              e.currentTarget.blur();
            }
          }}
        />
        <button type="button" className="btn btn-primary project-new-chat" onClick={startChat}>
          <MessageSquarePlus size={16} aria-hidden />
          New chat in project
        </button>
      </header>

      {loading ? (
        <div className="project-body" aria-hidden>
          <div className="projects-skeleton projects-skeleton-block" />
          <div className="projects-skeleton projects-skeleton-line" />
          <div className="projects-skeleton projects-skeleton-line short" />
        </div>
      ) : loadError ? (
        <div className="projects-state" role="alert">
          <p>{loadError}</p>
          <button type="button" className="btn btn-secondary" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : (
        <div className="project-body">
          <section className="project-section">
            <h2 className="project-section-title">Instructions</h2>
            <p className="project-section-hint">
              Shared context every chat in this project follows
            </p>
            <textarea
              className="project-instructions"
              rows={6}
              value={instructions}
              maxLength={INSTRUCTIONS_MAX}
              aria-label="Project instructions"
              placeholder="Add instructions, background, or preferences for this project"
              onChange={(e) => setInstructions(e.target.value)}
              onBlur={saveInstructions}
            />
            <span className={`project-char-count${nearLimit ? " warn" : ""}`}>
              {instructions.length.toLocaleString()} / {INSTRUCTIONS_MAX.toLocaleString()}
            </span>
          </section>

          <section className="project-section">
            <div className="project-section-head">
              <h2 className="project-section-title">Files</h2>
              <button
                type="button"
                className="btn btn-secondary project-upload"
                disabled={uploading}
                onClick={() => void addFiles()}
              >
                <Upload size={16} aria-hidden />
                {uploading ? "Uploading…" : "Add files"}
              </button>
            </div>
            {uploadError ? (
              <p className="project-error" role="alert">
                {uploadError}
              </p>
            ) : null}
            {files.length === 0 ? (
              <p className="project-empty">
                No files yet — add reference files to share with every chat in this project
              </p>
            ) : (
              <div className="project-files">
                {files.map((file) => (
                  <div key={file.id} className="project-file">
                    <span className="project-file-icon" aria-hidden>
                      {file.kind === "IMAGE" ? <ImageIcon size={16} /> : <FileText size={16} />}
                    </span>
                    <span className="project-file-name" title={file.fileName}>
                      {file.fileName}
                    </span>
                    <span className="project-file-meta">
                      {formatSize(file.size)}
                      {file.mimeType ? ` · ${file.mimeType}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="project-section">
            <h2 className="project-section-title">Conversations</h2>
            {conversations.length === 0 ? (
              <p className="project-empty">
                No conversations yet — start a new chat in this project
              </p>
            ) : (
              <div className="project-conversations" ref={listRef} onKeyDown={onListKeyDown}>
                {conversations.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    data-project-row
                    className="project-conversation"
                    onClick={() => openConversation(c.id)}
                  >
                    <span className="project-file-icon" aria-hidden>
                      <MessageSquare size={16} />
                    </span>
                    <span className="project-conversation-title" title={c.title}>
                      {c.title}
                    </span>
                    {c.pinned ? (
                      <span className="project-conversation-pin" aria-label="Pinned">
                        <Pin size={13} aria-hidden />
                      </span>
                    ) : null}
                    <span className="project-file-meta">{relativeTime(c.lastMessageAt)}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
