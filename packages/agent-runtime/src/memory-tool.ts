import { Type } from "@earendil-works/pi-ai";

/**
 * `Remember` tool (ADR 0371). The description is the whole extraction policy in
 * stage 2a: storage is deterministic, so the decision of *what* deserves to
 * survive a session lives in this prompt and nowhere else.
 */
export const rememberDescription =
  "Save one durable memory for future sessions. Use it only for knowledge that stays useful after this conversation ends: a preference the user stated, a decision together with its reason, a pitfall hit while working, a stable fact about this project, or a procedure that worked. Never use it for temporary task progress, file contents you can re-read, secrets, or anything the user asked to forget. Say what was learned, not what you did. Default scope is this project; pass scope=session for a note that only matters in this conversation, or scope=global for a preference that applies to every project.";

export const rememberParameters = {
  title: Type.String({
    minLength: 1,
    maxLength: 200,
    description: "Short label for the memory, for example 'deploy target' or 'no drive-by refactors'.",
  }),
  body: Type.String({
    minLength: 1,
    maxLength: 8000,
    description:
      "The fact itself, stated declaratively and self-contained: a future session sees this without today's conversation.",
  }),
  kind: Type.Optional(
    Type.Union(
      [
        Type.Literal("fact"),
        Type.Literal("preference"),
        Type.Literal("decision"),
        Type.Literal("pitfall"),
        Type.Literal("procedure"),
      ],
      { description: "What sort of knowledge this is. Defaults to fact." },
    ),
  ),
  scope: Type.Optional(
    Type.Union(
      [
        Type.Literal("project"),
        Type.Literal("session"),
        Type.Literal("global"),
      ],
      {
        description:
          "How far the memory travels: project (default), this session only, or every project.",
      },
    ),
  ),
  tags: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 40 }), {
      maxItems: 6,
      description: "Optional keywords for later filtering.",
    }),
  ),
};
