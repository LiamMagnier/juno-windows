import { useUiStore, type AppMode } from "@/state/uiStore";
import { ChatView } from "@/features/chat/ChatView";
import { ProjectsView } from "@/features/projects/ProjectsView";
import { ProjectView } from "@/features/projects/ProjectView";
import { MemoryPanel } from "@/features/memory/MemoryPanel";
import { ConnectorsPanel } from "@/features/connectors/ConnectorsPanel";
import { TasksPanel } from "@/features/tasks/TasksPanel";
import { CodeView } from "@/features/code/CodeView";

/** Routes the main pane by uiStore.view. */
export function MainPane({ mode }: { mode: AppMode }) {
  const view = useUiStore((s) => s.view);

  if (mode === "code") return <CodeView />;

  switch (view.kind) {
    case "chat":
      return <ChatView />;
    case "projects":
      return <ProjectsView />;
    case "project":
      return <ProjectView projectId={view.id} />;
    case "memory":
      return <MemoryPanel />;
    case "connectors":
      return <ConnectorsPanel />;
    case "tasks":
      return <TasksPanel />;
    case "code":
      return <CodeView />;
  }
}
