import { describe, expect, it } from "vitest";
import {
  MAX_EXTRACTION_CANDIDATES,
  MAX_EXTRACTION_TRANSCRIPT_CHARS,
  buildExtractionTranscript,
  parseExtractionCandidates,
} from "./memory-extraction.js";

describe("memory extraction parsing", () => {
  it("reads a plain array of candidates", () => {
    const parsed = parseExtractionCandidates(
      JSON.stringify([
        {
          kind: "fact",
          title: "Release builds need --locked",
          body: "The workspace refuses to build without a locked dependency graph.",
          tags: ["build"],
        },
      ]),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ kind: "fact", tags: ["build"] });
  });

  it("unwraps a fenced block with prose around it", () => {
    const parsed = parseExtractionCandidates(
      'Here is what I found:\n```json\n[{"kind":"pitfall","title":"Port 5173 stays bound","body":"A killed dev server leaves the port held for a minute."}]\n```\nDone.',
    );
    expect(parsed.map((entry) => entry.title)).toEqual(["Port 5173 stays bound"]);
  });

  it("accepts an object that carries the array in one field", () => {
    const parsed = parseExtractionCandidates(
      JSON.stringify({
        memories: [
          { kind: "preference", title: "Tabs over spaces", body: "The user prefers tabs in Rust files." },
        ],
      }),
    );
    expect(parsed).toHaveLength(1);
  });

  it("drops unknown kinds, blank fields, and summaries dressed as memories", () => {
    const parsed = parseExtractionCandidates(
      JSON.stringify([
        { kind: "opinion", title: "Made up kind", body: "should be dropped" },
        { kind: "fact", title: "", body: "no title" },
        { kind: "fact", title: "No body", body: "" },
        { kind: "fact", title: "Too long", body: "x".repeat(2_000) },
        { kind: "decision", title: "Locked graph wins", body: "Chose the lockfile over a fresh resolve." },
      ]),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe("Locked graph wins");
  });

  it("keeps the first copy of a repeated candidate and never exceeds the cap", () => {
    const items = Array.from({ length: 9 }, (_, index) => ({
      kind: "fact",
      title: index < 2 ? "Repeated fact" : `Fact ${index}`,
      body: index < 2 ? "Same text" : `Body ${index}`,
    }));
    const parsed = parseExtractionCandidates(JSON.stringify(items));
    expect(parsed).toHaveLength(MAX_EXTRACTION_CANDIDATES);
    expect(parsed.filter((entry) => entry.title === "Repeated fact")).toHaveLength(1);
  });

  it("answers nothing for prose, an empty answer, or broken JSON", () => {
    expect(parseExtractionCandidates("I could not find anything.")).toEqual([]);
    expect(parseExtractionCandidates("")).toEqual([]);
    expect(parseExtractionCandidates("[{oops")).toEqual([]);
    expect(parseExtractionCandidates("[1, 2, 3]")).toEqual([]);
  });
});

describe("extraction transcript", () => {
  it("labels roles and keeps the tail when the turn is long", () => {
    const short = buildExtractionTranscript([
      { role: "user", content: "why does the build fail" },
      { role: "assistant", content: "because the graph is unlocked" },
    ]);
    expect(short).toContain("### User");
    expect(short).toContain("### Assistant");

    const long = buildExtractionTranscript([
      { role: "user", content: "a".repeat(10_000) },
      { role: "assistant", content: "the conclusion" },
    ]);
    expect(long.length).toBeLessThanOrEqual(MAX_EXTRACTION_TRANSCRIPT_CHARS);
    expect(long.endsWith("the conclusion")).toBe(true);
  });

  it("skips blank turns", () => {
    expect(buildExtractionTranscript([{ role: "user", content: "   " }])).toBe("");
  });
});
