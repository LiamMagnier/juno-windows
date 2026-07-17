/**
 * Sidebar date grouping — mirrors the Mac app's SidebarView DateGroup
 * thresholds exactly: <=0 Today, ==1 Yesterday, <=7 Previous 7 days,
 * <=30 Previous 30 days, else "<Month> <Year>".
 */
import type { ClientConversation } from "@/lib/data/entities";

const DAY_MS = 86_400_000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function dateGroupLabel(lastMessageAt: string, now: Date = new Date()): string {
  const date = new Date(lastMessageAt);
  if (Number.isNaN(date.getTime())) return "Earlier";
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (dayDiff <= 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff <= 7) return "Previous 7 days";
  if (dayDiff <= 30) return "Previous 30 days";
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export interface ConversationGroup {
  label: string;
  items: ClientConversation[];
}

/** Groups conversations (already sorted lastMessageAt desc) preserving order. */
export function groupByDate(
  conversations: ClientConversation[],
  now: Date = new Date(),
): ConversationGroup[] {
  const groups: ConversationGroup[] = [];
  let current: ConversationGroup | null = null;
  for (const conversation of conversations) {
    const label = dateGroupLabel(conversation.lastMessageAt, now);
    if (!current || current.label !== label) {
      current = { label, items: [] };
      groups.push(current);
    }
    current.items.push(conversation);
  }
  return groups;
}

/** Sort comparator: newest activity first. */
export function byLastMessageDesc(a: ClientConversation, b: ClientConversation): number {
  return b.lastMessageAt < a.lastMessageAt ? -1 : b.lastMessageAt > a.lastMessageAt ? 1 : 0;
}
