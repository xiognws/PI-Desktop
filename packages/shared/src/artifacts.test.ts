import { describe, expect, it } from "vitest";

import {
  artifactDirectory,
  artifactFileName,
  artifactOpKey,
  filterArtifacts,
  groupArtifactsBySession,
  type ArtifactRow,
} from "./artifacts.js";

function row(over: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    sessionId: "s1",
    sessionTitle: "Refactor the picker",
    path: "D:\\Code\\PI-Desktop\\apps\\desktop\\src\\a.tsx",
    op: "write",
    updatedAt: "2026-10-29T01:00:00.000Z",
    ...over,
  };
}

describe("artifact path helpers", () => {
  it("splits a Windows path into name and directory", () => {
    expect(artifactFileName("D:\\Code\\a\\b.tsx")).toBe("b.tsx");
    expect(artifactDirectory("D:\\Code\\a\\b.tsx")).toBe("D:\\Code\\a");
  });

  it("splits a POSIX path the same way", () => {
    expect(artifactFileName("/home/u/proj/b.tsx")).toBe("b.tsx");
    expect(artifactDirectory("/home/u/proj/b.tsx")).toBe("/home/u/proj");
  });

  it("keeps a bare file name whole and yields no directory", () => {
    expect(artifactFileName("b.tsx")).toBe("b.tsx");
    expect(artifactDirectory("b.tsx")).toBe("");
  });

  it("ignores a trailing separator", () => {
    expect(artifactFileName("/a/b/")).toBe("b");
    expect(artifactDirectory("/a/b/")).toBe("/a");
  });
});

describe("artifactOpKey", () => {
  it("maps known ops to their label keys", () => {
    expect(artifactOpKey("write")).toBe("artifacts.op.write");
    expect(artifactOpKey("edit")).toBe("artifacts.op.edit");
  });

  it("falls back for an op the UI has no label for", () => {
    expect(artifactOpKey("delete")).toBe("artifacts.op.other");
  });
});

describe("filterArtifacts", () => {
  const rows = [
    row(),
    row({ path: "/home/u/notes.md", op: "edit", sessionTitle: "Notes", sessionId: "s2" }),
  ];

  it("returns everything for an empty query", () => {
    expect(filterArtifacts(rows, "   ")).toHaveLength(2);
  });

  it("matches the file name, the directory, the op and the session title", () => {
    expect(filterArtifacts(rows, "A.TSX")).toHaveLength(1);
    expect(filterArtifacts(rows, "desktop\\src")).toHaveLength(1);
    expect(filterArtifacts(rows, "edit")).toHaveLength(1);
    expect(filterArtifacts(rows, "notes")).toHaveLength(1);
  });

  it("returns nothing when no field matches", () => {
    expect(filterArtifacts(rows, "zzz")).toHaveLength(0);
  });
});

describe("groupArtifactsBySession", () => {
  it("groups by session, newest session first and newest file first inside", () => {
    const rows = [
      row({ path: "/a/old.ts", updatedAt: "2026-10-01T00:00:00.000Z" }),
      row({ path: "/a/new.ts", updatedAt: "2026-10-05T00:00:00.000Z" }),
      row({ sessionId: "s2", sessionTitle: "Newer", path: "/b/x.ts", updatedAt: "2026-10-09T00:00:00.000Z" }),
    ];

    const groups = groupArtifactsBySession(rows);
    expect(groups.map((g) => g.sessionId)).toEqual(["s2", "s1"]);
    expect(groups[1]?.rows.map((r) => artifactFileName(r.path))).toEqual(["new.ts", "old.ts"]);
  });

  it("keeps artifacts of a deleted session under a null title", () => {
    const groups = groupArtifactsBySession([row({ sessionTitle: null })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.sessionTitle).toBeNull();
  });

  it("tolerates a blank session title", () => {
    const groups = groupArtifactsBySession([row({ sessionTitle: "  " })]);
    expect(groups[0]?.sessionTitle).toBeNull();
  });

  it("does not mutate the input order", () => {
    const rows = [
      row({ path: "/a/old.ts", updatedAt: "2026-10-01T00:00:00.000Z" }),
      row({ path: "/a/new.ts", updatedAt: "2026-10-05T00:00:00.000Z" }),
    ];
    groupArtifactsBySession(rows);
    expect(rows.map((r) => artifactFileName(r.path))).toEqual(["old.ts", "new.ts"]);
  });
});
