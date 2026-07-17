import { describe, expect, it } from "vitest";
import { dateGroupLabel, groupByDate } from "./dateGroups";
import type { ClientConversation } from "@/lib/data/entities";

const now = new Date(2026, 6, 17, 12, 0, 0); // 2026-07-17 local noon

function iso(daysAgo: number): string {
  return new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
}

function convo(id: string, lastMessageAt: string): ClientConversation {
  return {
    id,
    title: id,
    titleSource: "default",
    model: null,
    kind: "chat",
    codeWorkspaceName: null,
    codeWorkspacePath: null,
    pinned: false,
    folderId: null,
    projectId: null,
    activeConnectors: [],
    archivedAt: null,
    lastMessageAt,
    createdAt: lastMessageAt,
  };
}

describe("dateGroupLabel", () => {
  it("labels today and future timestamps as Today", () => {
    expect(dateGroupLabel(iso(0), now)).toBe("Today");
    expect(dateGroupLabel(iso(-1), now)).toBe("Today");
  });

  it("labels exactly one calendar day back as Yesterday", () => {
    expect(dateGroupLabel(iso(1), now)).toBe("Yesterday");
  });

  it("uses the 7 and 30 day windows inclusively", () => {
    expect(dateGroupLabel(iso(2), now)).toBe("Previous 7 days");
    expect(dateGroupLabel(iso(7), now)).toBe("Previous 7 days");
    expect(dateGroupLabel(iso(8), now)).toBe("Previous 30 days");
    expect(dateGroupLabel(iso(30), now)).toBe("Previous 30 days");
  });

  it("falls back to month + year beyond 30 days", () => {
    const label = dateGroupLabel(iso(60), now);
    expect(label).toMatch(/2026/);
    expect(label).not.toBe("Previous 30 days");
  });

  it("handles invalid dates without throwing", () => {
    expect(dateGroupLabel("not-a-date", now)).toBe("Earlier");
  });
});

describe("groupByDate", () => {
  it("groups consecutive conversations under one label preserving order", () => {
    const list = [convo("a", iso(0)), convo("b", iso(0)), convo("c", iso(1)), convo("d", iso(40))];
    const groups = groupByDate(list, now);
    expect(groups.map((g) => g.label).slice(0, 2)).toEqual(["Today", "Yesterday"]);
    expect(groups[0]?.items.map((c) => c.id)).toEqual(["a", "b"]);
    expect(groups[2]?.items.map((c) => c.id)).toEqual(["d"]);
  });

  it("returns an empty array for no conversations", () => {
    expect(groupByDate([], now)).toEqual([]);
  });
});
