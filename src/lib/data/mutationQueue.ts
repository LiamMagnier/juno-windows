/**
 * Offline-safe write path: POST /api/v1/mutations with idempotency and
 * optimistic-concurrency, queued in IndexedDB and flushed serially.
 *
 * Rules from the server contract (juno/src/app/api/v1/mutations/route.ts):
 * - retries of the SAME logical mutation must resend the byte-identical body
 *   (requestHash covers the whole JSON) -> we store the serialized string;
 * - 500 server_unavailable is retryable with the same clientMutationId;
 * - 409 revision_conflict -> refetch entity, rebase baseRevision, retry with
 *   a NEW clientMutationId;
 * - create ops carry clientEntityId (a local UUID); the result's
 *   entityMappings adopts the server cuid.
 */
import { apiUrl } from "../backend/config";
import { getAccessToken, parseErrorEnvelope } from "../backend/tokens";
import { BackendError } from "../backend/types";
import { dbDelete, dbGetAllEntries, dbPut } from "./db";
import { revisionOf, useDataStore } from "@/state/dataStore";

export type MutationOperation =
  | { type: "conversation.create"; clientEntityId?: string; title?: string }
  | { type: "conversation.rename"; entityId: string; title: string }
  | {
      type: "conversation.update";
      entityId: string;
      patch: {
        title?: string;
        pinned?: boolean;
        projectId?: string | null;
        folderId?: string | null;
      };
    }
  | { type: "conversation.delete"; entityId: string }
  | { type: "project.create"; clientEntityId?: string; name: string; instructions?: string }
  | { type: "project.update"; entityId: string; name?: string; instructions?: string }
  | { type: "project.delete"; entityId: string }
  | { type: "memory.create"; clientEntityId?: string; content: string }
  | { type: "memory.update"; entityId: string; content: string }
  | { type: "memory.delete"; entityId: string }
  | { type: "settings.update"; patch: Record<string, unknown> };

interface QueuedMutation {
  id: string; // clientMutationId
  /** Exact serialized request body — replays must be byte-identical. */
  body: string;
  entityType: string;
  entityId: string | null;
  enqueuedAt: number;
  attempts: number;
}

export interface MutationOutcome {
  entityMappings?: Record<string, string>;
  entity?: { id: string; revision: number; deleted?: boolean };
}

const MAX_ATTEMPTS = 8;

let queue: QueuedMutation[] = [];
let flushing = false;
let loaded = false;
const listeners = new Set<() => void>();

function entityTypeOf(op: MutationOperation): string {
  const prefix = op.type.split(".")[0];
  return prefix ?? op.type;
}

function entityIdOf(op: MutationOperation): string | null {
  if ("entityId" in op) return op.entityId;
  if ("clientEntityId" in op && op.clientEntityId) return op.clientEntityId;
  return null;
}

async function loadQueue(): Promise<void> {
  if (loaded) return;
  const entries = await dbGetAllEntries<QueuedMutation>("pendingMutations");
  queue = entries.map(([, v]) => v).sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  loaded = true;
}

export function pendingMutationCount(): number {
  return queue.length;
}

export function onQueueDrained(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Enqueue a mutation. The caller applies the optimistic change to the store
 * BEFORE calling this; the queue guarantees eventual delivery + id adoption.
 */
export async function enqueueMutation(
  operation: MutationOperation,
  baseRevision?: number,
): Promise<void> {
  await loadQueue();
  const entityType = entityTypeOf(operation);
  const entityId = entityIdOf(operation);
  const revision =
    baseRevision ??
    (operation.type.endsWith(".create")
      ? 0
      : entityId
        ? revisionOf(entityType, entityId)
        : 0);
  const record: QueuedMutation = {
    id: crypto.randomUUID(),
    body: JSON.stringify({
      clientMutationId: "", // placeholder replaced below to keep field order stable
      baseRevision: revision,
      operation,
    }),
    entityType,
    entityId,
    enqueuedAt: Date.now(),
    attempts: 0,
  };
  // Re-serialize once with the real id so replays are byte-identical.
  record.body = JSON.stringify({
    clientMutationId: record.id,
    baseRevision: revision,
    operation,
  });
  queue.push(record);
  await dbPut("pendingMutations", record.id, record);
  void flushQueue();
}

async function postMutation(body: string): Promise<MutationOutcome> {
  const token = await getAccessToken();
  let res = await fetch(apiUrl("/v1/mutations"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
  });
  if (res.status === 401) {
    const fresh = await getAccessToken({ forceRefresh: true });
    res = await fetch(apiUrl("/v1/mutations"), {
      method: "POST",
      headers: { authorization: `Bearer ${fresh}`, "content-type": "application/json" },
      body,
    });
  }
  if (!res.ok) throw await parseErrorEnvelope(res);
  return (await res.json()) as MutationOutcome;
}

function applyOutcome(record: QueuedMutation, outcome: MutationOutcome): void {
  const store = useDataStore.getState();
  if (outcome.entityMappings) {
    for (const [localId, serverId] of Object.entries(outcome.entityMappings)) {
      store.adoptEntityId(record.entityType, localId, serverId);
    }
  }
  if (outcome.entity) {
    store.setRevision(record.entityType, outcome.entity.id, outcome.entity.revision);
  }
}

async function rebaseAndRetry(record: QueuedMutation, currentRevision: number): Promise<void> {
  // Last-writer-wins rebase: keep the user's intent, adopt the server revision.
  const parsed = JSON.parse(record.body) as {
    clientMutationId: string;
    baseRevision: number;
    operation: MutationOperation;
  };
  if (parsed.operation.type.endsWith(".create")) return; // creates never rebase
  const rebased: QueuedMutation = {
    ...record,
    id: crypto.randomUUID(),
    attempts: 0,
    body: JSON.stringify({
      clientMutationId: "",
      baseRevision: currentRevision,
      operation: parsed.operation,
    }),
  };
  rebased.body = JSON.stringify({
    clientMutationId: rebased.id,
    baseRevision: currentRevision,
    operation: parsed.operation,
  });
  queue.push(rebased);
  await dbPut("pendingMutations", rebased.id, rebased);
}

export async function flushQueue(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    await loadQueue();
    while (queue.length > 0) {
      const record = queue[0]!;
      try {
        const outcome = await postMutation(record.body);
        applyOutcome(record, outcome);
        queue.shift();
        await dbDelete("pendingMutations", record.id);
      } catch (err) {
        if (err instanceof BackendError) {
          if (err.status === 409 && err.code === "revision_conflict") {
            // Conflict: drop this attempt, rebase onto the server revision.
            queue.shift();
            await dbDelete("pendingMutations", record.id);
            const current = err.details?.currentRevision;
            const deleted = err.details?.deleted === true;
            if (!deleted && typeof current === "number") {
              await rebaseAndRetry(record, current);
            }
            // Deleted or unknown revision: the next sync pull restores truth.
            continue;
          }
          if (err.status === 400 || err.status === 404 || err.status === 409) {
            // Permanent rejection — drop it; sync restores server truth.
            queue.shift();
            await dbDelete("pendingMutations", record.id);
            continue;
          }
          if (err.isAuthError) break; // signed out; queue survives for next session
        }
        // Transient (network / 500 retryable): back off and stop this flush.
        record.attempts += 1;
        await dbPut("pendingMutations", record.id, record);
        if (record.attempts >= MAX_ATTEMPTS) {
          queue.shift();
          await dbDelete("pendingMutations", record.id);
          continue;
        }
        break;
      }
    }
  } finally {
    flushing = false;
    if (queue.length === 0) for (const l of listeners) l();
  }
}
