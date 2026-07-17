/**
 * Code usage accounting against the account plan — port of
 * juno-app/core/src/usage.ts. Reserve once per user turn; record real
 * tokens at turn end; refund unproductive turns. Only a real 402 blocks;
 * every other failure fails OPEN.
 */
import { api } from "../backend/http";
import { BackendError } from "../backend/types";
import type { Usage } from "./types";

export interface UsageReservation {
  allowed: boolean;
  message?: string;
}

export async function reserveTurn(): Promise<UsageReservation> {
  try {
    await api("/agent/usage", { method: "POST", body: { phase: "start" } });
    return { allowed: true };
  } catch (err) {
    if (err instanceof BackendError && err.status === 402) {
      return { allowed: false, message: err.message };
    }
    // Transient failure: never tell the user they're out of quota because
    // the accounting endpoint blipped.
    return { allowed: true };
  }
}

export async function recordTurn(model: string, usage: Usage): Promise<void> {
  await api("/agent/usage", {
    method: "POST",
    body: {
      phase: "record",
      model,
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
    },
  }).catch(() => {});
}

export async function refundTurn(): Promise<void> {
  await api("/agent/usage", { method: "POST", body: { phase: "refund" } }).catch(() => {});
}
