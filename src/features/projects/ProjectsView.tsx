/**
 * Projects grid: every project the account has, newest activity first,
 * with create / rename / delete flowing through the optimistic mutation queue.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderPlus, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/backend/http";
import type { ProjectSummary } from "@/lib/data/entities";
import { enqueueMutation } from "@/lib/data/mutationQueue";
import { useDataStore } from "@/state/dataStore";
import { useUiStore } from "@/state/uiStore";
import { Dialog } from "@/components/Dialog";
import { useContextMenu } from "@/components/ContextMenu";
import { relativeTime } from "./format";
import "./projects.css";

const NAME_MAX = 160;

type LoadPhase = "loading" | "ready" | "error";

export function ProjectsView() {
  const projects = useDataStore((s) => s.projects);
  const setView = useUiStore((s) => s.setView);
  const { open: openMenu } = useContextMenu();
  const gridRef = useRef<HTMLDivElement>(null);

  const list = useMemo(
    () =>
      Object.values(projects).sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    [projects],
  );

  const hasProjects = list.length > 0;
  const [phase, setPhase] = useState<LoadPhase>(hasProjects ? "ready" : "loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const empty = Object.keys(useDataStore.getState().projects).length === 0;
    if (empty) setPhase("loading");
    setLoadError(null);
    try {
      const { projects: fresh } = await api<{ projects: ProjectSummary[] }>("/projects");
      useDataStore.getState().replaceProjects(fresh);
      setPhase("ready");
    } catch (err) {
      // With cached projects on screen, a failed refresh stays quiet.
      if (Object.keys(useDataStore.getState().projects).length === 0) {
        setPhase("error");
        setLoadError(err instanceof Error ? err.message : "Couldn't load projects.");
      } else {
        setPhase("ready");
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ---- Create ----
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newInstructions, setNewInstructions] = useState("");

  const createProject = () => {
    const name = newName.trim().slice(0, NAME_MAX);
    if (!name) return;
    const instructions = newInstructions.trim();
    const id = crypto.randomUUID();
    useDataStore.getState().upsertProject({
      id,
      name,
      instructions,
      updatedAt: new Date().toISOString(),
      conversationCount: 0,
      fileCount: 0,
      coverUrl: null,
    });
    void enqueueMutation({
      type: "project.create",
      clientEntityId: id,
      name,
      ...(instructions ? { instructions } : {}),
    });
    setCreateOpen(false);
    setNewName("");
    setNewInstructions("");
  };

  // ---- Rename ----
  const [renameTarget, setRenameTarget] = useState<ProjectSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const applyRename = () => {
    if (!renameTarget) return;
    const name = renameValue.trim().slice(0, NAME_MAX);
    if (!name || name === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    useDataStore.getState().upsertProject({ ...renameTarget, name });
    void enqueueMutation({ type: "project.update", entityId: renameTarget.id, name });
    setRenameTarget(null);
  };

  // ---- Delete ----
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);

  const applyDelete = () => {
    if (!deleteTarget) return;
    useDataStore.getState().removeProject(deleteTarget.id);
    void enqueueMutation({ type: "project.delete", entityId: deleteTarget.id });
    setDeleteTarget(null);
  };

  const showMenu = (project: ProjectSummary, x: number, y: number) => {
    openMenu(
      [
        {
          id: "rename",
          label: "Rename",
          icon: <Pencil size={16} />,
          onSelect: () => {
            setRenameValue(project.name);
            setRenameTarget(project);
          },
        },
        {
          id: "delete",
          label: "Delete",
          icon: <Trash2 size={16} />,
          destructive: true,
          separatorBefore: true,
          onSelect: () => setDeleteTarget(project),
        },
      ],
      x,
      y,
    );
  };

  // Arrow-key navigation across the card grid (column-aware for up/down).
  const onGridKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    const cards = Array.from(
      gridRef.current?.querySelectorAll<HTMLElement>("[data-projects-card]") ?? [],
    );
    const index = cards.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    e.preventDefault();
    let next = index;
    if (e.key === "ArrowLeft") next = Math.max(0, index - 1);
    else if (e.key === "ArrowRight") next = Math.min(cards.length - 1, index + 1);
    else {
      const left = cards[index]!.offsetLeft;
      if (e.key === "ArrowDown") {
        const found = cards.findIndex((c, i) => i > index && c.offsetLeft === left);
        next = found >= 0 ? found : index;
      } else {
        for (let i = index - 1; i >= 0; i--) {
          if (cards[i]!.offsetLeft === left) {
            next = i;
            break;
          }
        }
      }
    }
    cards[next]?.focus();
  };

  return (
    <div className="projects-page">
      <header className="projects-header">
        <h1 className="projects-title">Projects</h1>
      </header>

      {phase === "loading" ? (
        <div className="projects-grid" aria-hidden>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="projects-card projects-card-skeleton">
              <div className="projects-skeleton projects-skeleton-cover" />
              <div className="projects-skeleton projects-skeleton-line" />
              <div className="projects-skeleton projects-skeleton-line short" />
            </div>
          ))}
        </div>
      ) : phase === "error" ? (
        <div className="projects-state" role="alert">
          <p>{loadError ?? "Couldn't load projects."}</p>
          <button type="button" className="btn btn-secondary" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      ) : !hasProjects ? (
        <div className="projects-state">
          <FolderPlus size={28} aria-hidden className="projects-state-icon" />
          <p>No projects yet — create one to group related chats with shared instructions</p>
          <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
            New project
          </button>
        </div>
      ) : (
        <div className="projects-grid" ref={gridRef} onKeyDown={onGridKeyDown}>
          <button
            type="button"
            data-projects-card
            className="projects-card projects-card-new"
            onClick={() => setCreateOpen(true)}
          >
            <span className="projects-new-icon" aria-hidden>
              <Plus size={20} />
            </span>
            <span className="projects-card-name">New project</span>
          </button>
          {list.map((project) => (
            <div key={project.id} className="projects-card-wrap">
              <button
                type="button"
                data-projects-card
                className="projects-card"
                onClick={() => setView({ kind: "project", id: project.id })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  showMenu(project, e.clientX, e.clientY);
                }}
              >
                {project.coverUrl ? (
                  <img className="projects-card-cover" src={project.coverUrl} alt="" />
                ) : (
                  <span className="projects-card-tile" aria-hidden>
                    {(project.name.trim()[0] ?? "?").toUpperCase()}
                  </span>
                )}
                <span className="projects-card-name" title={project.name}>
                  {project.name}
                </span>
                <span className="projects-card-meta">
                  {project.conversationCount === 1
                    ? "1 chat"
                    : `${project.conversationCount} chats`}
                  {" · "}
                  {project.fileCount === 1 ? "1 file" : `${project.fileCount} files`}
                  {" · "}
                  {relativeTime(project.updatedAt)}
                </span>
              </button>
              <button
                type="button"
                className="projects-card-more"
                aria-label={`Options for ${project.name}`}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  showMenu(project, rect.left, rect.bottom + 4);
                }}
              >
                <MoreHorizontal size={16} aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}

      <Dialog title="New project" open={createOpen} onClose={() => setCreateOpen(false)}>
        <div className="field">
          <label className="field-label" htmlFor="projects-new-name">
            Name
          </label>
          <input
            id="projects-new-name"
            value={newName}
            maxLength={NAME_MAX}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                createProject();
              }
            }}
            placeholder="What is this project about?"
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="projects-new-instructions">
            Instructions (optional)
          </label>
          <textarea
            id="projects-new-instructions"
            rows={4}
            value={newInstructions}
            onChange={(e) => setNewInstructions(e.target.value)}
            placeholder="Shared context every chat in this project will follow"
          />
        </div>
        <div className="dialog-footer">
          <button type="button" className="btn btn-secondary" onClick={() => setCreateOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!newName.trim()}
            onClick={createProject}
          >
            Create
          </button>
        </div>
      </Dialog>

      <Dialog
        title="Rename project"
        open={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
      >
        <div className="field">
          <label className="field-label" htmlFor="projects-rename">
            Name
          </label>
          <input
            id="projects-rename"
            value={renameValue}
            maxLength={NAME_MAX}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyRename();
              }
            }}
          />
        </div>
        <div className="dialog-footer">
          <button type="button" className="btn btn-secondary" onClick={() => setRenameTarget(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!renameValue.trim()}
            onClick={applyRename}
          >
            Rename
          </button>
        </div>
      </Dialog>

      <Dialog
        title="Delete project"
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
      >
        <p>
          Delete “{deleteTarget?.name}”? Conversations in this project are kept and unlinked, but
          its instructions and files are removed. This can't be undone.
        </p>
        <div className="dialog-footer">
          <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>
            Cancel
          </button>
          <button type="button" className="btn btn-destructive" onClick={applyDelete}>
            Delete
          </button>
        </div>
      </Dialog>
    </div>
  );
}
