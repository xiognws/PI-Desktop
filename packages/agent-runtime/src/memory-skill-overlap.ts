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
export type SkillSummary = { id: string; name?: string; description?: string };

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
 * Threshold 0.25 on Jaccard over the skill's `name + description`: a procedure
 * copied into memory repeats the nouns of the skill it came from, while an
 * unrelated fact shares almost none of them.
 */
export function coveredBySkill(
  text: string,
  skills: readonly SkillSummary[],
  minScore = 0.25,
): CoverageHit | undefined {
  if (!looksLikeProcedure(text)) return undefined;
  const tokens = topicTokens(text);
  let best: CoverageHit | undefined;
  for (const skill of skills) {
    const skillTokens = topicTokens(`${skill.name ?? ""} ${skill.description ?? ""} ${skill.id}`);
    const shared = [...new Set(tokens)].filter((token) => skillTokens.includes(token)).length;
    // Coverage, not Jaccard: a skill description is short and a procedure is
    // long, so the question is "does the skill cover these words", not "are the
    // two texts the same size". Three shared terms is the floor — one shared noun
    // ("ipc", "test") is a coincidence, not a match.
    if (shared < 3) continue;
    const score = shared / Math.max(Math.min(tokens.length, skillTokens.length), 1);
    if (score >= minScore && (!best || score > best.score)) {
      best = { skillId: skill.id, score: Number(score.toFixed(3)) };
    }
  }
  return best;
}

/**
 * Which of `entries` the library already covers.
 *
 * Only the entries being *added* are checked: an entry that was already stored
 * before the skill existed must not make the whole batch refuse, or a session
 * could never free space.
 */
export function duplicateOfSkill(
  addedEntries: readonly string[],
  existingEntries: readonly string[],
  skills: readonly SkillSummary[],
  minScore = 0.25,
): { entry: string; skillId: string } | undefined {
  const existing = new Set(existingEntries.map((entry) => entry.trim()));
  for (const entry of addedEntries) {
    if (existing.has(entry.trim())) continue;
    const hit = coveredBySkill(entry, skills, minScore);
    if (hit) return { entry, skillId: hit.skillId };
  }
  return undefined;
}
