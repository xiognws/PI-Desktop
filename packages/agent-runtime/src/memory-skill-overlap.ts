/**
 * Keeping one lesson in one place, mechanically.
 *
 * Measured: the rule "a procedure belongs in the skill and nowhere else" was in
 * the prompt, and the same four-step procedure still ended up as a skill *and* as
 * two memory entries — the main turn wrote memory, the review fork created the
 * skill, and neither knew about the other. A prompt rule cannot see what the
 * other writer just did; a check at write time can.
 *
 * The check is deliberately narrow. It only refuses a memory entry that looks
 * like a procedure (steps, not a sentence) *and* whose vocabulary already belongs
 * to a skill. A fact that happens to share a word with a skill — "this machine
 * blocks TCP 22" next to a "publish a branch" skill — is exactly what memory is
 * for, and stays accepted.
 */

/** A skill the library already holds, as the catalogue knows it. */
export type SkillSummary = {
  id: string;
  name?: string;
  description?: string;
  /**
   * The document itself, when the caller could read it.
   *
   * Measured, this is what makes the check work: catalogues describe skills in one
   * line of English ("Use when adding a new frontend IPC channel…") while the
   * procedure a person dictates is Chinese and full of paths. Comparing an entry
   * against that one line shared exactly one token (`ipc`) and let a real
   * duplicate through; the same entry against the body — which names
   * `protocol.ts`, `electron/main/ipc`, `api.ts` and the test step — shares most
   * of its vocabulary.
   */
  body?: string;
};

/** Latin words of three letters+, plus CJK 2/3-grams: the same shape the map uses. */
export function topicTokens(text: string): string[] {
  const tokens = new Set<string>();
  const lower = (text ?? "").toLowerCase();
  for (const match of lower.matchAll(/[a-z][a-z0-9_-]{2,}/g)) tokens.add(match[0]);
  for (const match of lower.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = match[0];
    for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2));
  }
  return [...tokens];
}

function overlap(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  let shared = 0;
  for (const token of new Set(left)) if (rightSet.has(token)) shared += 1;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : shared / union;
}

/**
 * Whether an entry reads like a procedure rather than a fact.
 *
 * Signals, any two of which are enough: numbered/enumerated steps, three or more
 * arrow/step separators, or an explicit ordering word next to a verb. One
 * signal alone is too easy to hit ("first, the disk was full").
 */
export function looksLikeProcedure(text: string): boolean {
  const value = text ?? "";
  // A numbered/enumerated pair. `` does not work next to CJK, so the boundary
  // is "not a digit", which is what actually distinguishes a step marker from a
  // version number or a timestamp.
  const numbered =
    /[^\d]1[.)、]/.test(value) && /[^\d]2[.)、]/.test(value);
  // Two arrows are a flow, not a sentence about one.
  const arrows = (value.match(/→|->|=>/g) ?? []).length >= 2;
  // An explicit ordering pair: 先…再/然后, or two English sequence words.
  const orderedCn = /(先|首先)[^。；]{2,60}(再|然后|接着)/.test(value);
  const orderedEn =
    (value.match(/(first|then|next|finally)/gi) ?? []).length >= 2;
  return numbered || arrows || orderedCn || orderedEn;
}

export type CoverageHit = { skillId: string; score: number };

/**
 * The skill that already covers this entry, if one plainly does.
 *
 * Used for the *message*, not for the gate: the gate is the type of the sentence
 * (see `duplicateOfSkill`). Naming the likely skill turns a refusal into one
 * action ("patch that skill"); when nothing matches lexically the refusal still
 * stands and points at `skill_manage create`.
 */
export function coveredBySkill(
  text: string,
  skills: readonly SkillSummary[],
  minScore = 0.12,
): CoverageHit | undefined {
  const tokens = topicTokens(text);
  let best: CoverageHit | undefined;
  for (const skill of skills) {
    const skillTokens = topicTokens(
      `${skill.name ?? ""} ${skill.description ?? ""} ${skill.id} ${skill.body ?? ""}`,
    );
    const shared = [...new Set(tokens)].filter((token) => skillTokens.includes(token)).length;
    // A hint only: two shared technical terms ("package", "scripts") are enough to
    // name the likely skill, because the refusal already stands on its own.
    if (shared < 2) continue;
    const score = shared / Math.max(tokens.length, 1);
    if (score >= minScore && (!best || score > best.score)) {
      best = { skillId: skill.id, score: Number(score.toFixed(3)) };
    }
  }
  return best;
}

/**
 * The first added entry that is a procedure rather than a fact.
 *
 * **The gate is the shape of the sentence, not a similarity score.** Two live
 * attempts at a similarity gate failed for the same reason: the library describes
 * a skill in one line of English while the procedure a person dictates is Chinese
 * and full of paths, so a real duplicate shared two or three tokens with the
 * document — and a threshold low enough to catch it also let through entries that
 * merely mentioned the same subsystem. The policy does not need the comparison
 * anyway: a procedure belongs in a skill *whether or not* one exists yet, and
 * `skill_manage create` is the action that follows. So the check asks the one
 * question the text can answer by itself — is this steps or a fact — and the
 * similarity is only used to name the skill to patch.
 *
 * `existingEntries` is still honoured: an entry stored before this rule existed
 * is never re-judged, so a session can always free space by rewriting it.
 */
export function procedureNeedingASkill(
  addedEntries: readonly string[],
  existingEntries: readonly string[],
  skills: readonly SkillSummary[] = [],
): { entry: string; skillId?: string } | undefined {
  const existing = new Set(existingEntries.map((entry) => entry.trim()));
  for (const entry of addedEntries) {
    if (existing.has(entry.trim())) continue;
    if (!looksLikeProcedure(entry)) continue;
    return { entry, skillId: coveredBySkill(entry, skills)?.skillId };
  }
  return undefined;
}

/** Kept for callers that want the similarity verdict on its own. */
export function duplicateOfSkill(
  addedEntries: readonly string[],
  existingEntries: readonly string[],
  skills: readonly SkillSummary[],
  minScore = 0.12,
): { entry: string; skillId: string } | undefined {
  const existing = new Set(existingEntries.map((entry) => entry.trim()));
  for (const entry of addedEntries) {
    if (existing.has(entry.trim())) continue;
    const hit = coveredBySkill(entry, skills, minScore);
    if (hit) return { entry, skillId: hit.skillId };
  }
  return undefined;
}
