/**
 * Hand-off between the projects feature and the chat composer: when the user
 * starts a new chat from inside a project, the project id is stashed here and
 * consumed by the chat feature on its next send, so the conversation is
 * created already linked to the project (never eagerly).
 */
let pendingProjectId: string | null = null;

/** Stash the project a soon-to-be-created chat should belong to. */
export function setPendingProjectId(projectId: string | null): void {
  pendingProjectId = projectId;
}

/** Read and clear the stashed project id (one-shot). */
export function consumePendingProjectId(): string | null {
  const id = pendingProjectId;
  pendingProjectId = null;
  return id;
}

/** Read the stashed project id without clearing it (for composer chips). */
export function peekPendingProjectId(): string | null {
  return pendingProjectId;
}
