/**
 * Smart mode crosses four layers, and each one can be dropped without a type
 * error: a launch that never plans the tier, a prompt adapter that stops
 * forwarding the two new parameters, a kernel that ignores the delegation
 * default, or a picker that cannot leave the mode. These contracts pin the
 * wiring at each boundary, because the behavior itself is covered by
 * `packages/shared` (routing) and `crates/agent-core` (delegation default).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [launch, prompt, ipc, router, picker, list, hook, composer] = await Promise.all([
  read("../electron/main/runtime/session-launch.ts"),
  read("../electron/main/kernel/kernel-prompt.ts"),
  read("../electron/main/ipc/agent-ipc.ts"),
  read("../electron/main/runtime/smart-routing.ts"),
  read("../src/features/chat/composer/ComposerModelPicker.tsx"),
  read("../src/features/chat/composer/ComposerModelList.tsx"),
  read("../src/features/chat/composer/hooks/useComposerModelMenu.ts"),
  read("../src/components/Composer.tsx"),
]);

test("a turn's tier is decided before the launch resolves its binding", () => {
  assert.match(launch, /smartRouting\.planTurn\(/);
  // The routed binding replaces the overrides; the resolver below then runs the
  // one provider path it already had, rather than a second cheaper copy.
  assert.match(launch, /smartPlan\.tier === "sub"[\s\S]{0,200}providerId: smartPlan\.binding\.providerId/);
  assert.match(launch, /delegationDefaultModel/);
  assert.match(launch, /smartTurn: \{ tier: smartPlan\.tier, reason: smartPlan\.reason \}/);
});

test("the cheap half is authorized without a second opt-in", () => {
  assert.match(launch, /const smartHalf =/);
  assert.match(launch, /if \(!binding\.availableForSubagents && !smartHalf\) continue;/);
  assert.match(launch, /const authorizeForDelegation = binding\.availableForSubagents \|\| smartHalf\?\.delegation === true;/);
});

test("the prompt adapter forwards both new parameters", () => {
  assert.match(prompt, /"delegationDefaultModel",/);
  assert.match(prompt, /"smartTurn",/);
});

test("the router reads turn events instead of stored state", () => {
  assert.match(router, /observeEvent/);
  assert.match(router, /case "turn_end":/);
  // A delegate's events belong to the delegate, not to the session's turn.
  assert.match(router, /envelope\.parentToolCallId/);
  assert.match(router, /downgraded/);
});

test("a stuck cheap turn has a strong half to continue on", () => {
  // Both halves resolve through the one catalog loop; only the cheap one becomes
  // a delegation key, because the orchestrator is not a delegate.
  assert.match(launch, /const smartHalves:/);
  assert.match(launch, /delegation: false,/);
  assert.match(launch, /const smartEscalationKey =/);
  assert.match(launch, /escalation: \{\s*provider: subagentBindings\.providers\[smartEscalationKey\]/);
  assert.match(prompt, /"escalation",/);
});

test("the composer can enter the mode and leave it", () => {
  // The row heads the recent group in the list; the picker only forwards the pair.
  assert.match(list, /chat\.smartModeEntry/);
  assert.match(list, /recentEntries\.length > 0 \|\| smartMode/);
  assert.match(picker, /smartMode=\{smartMode\}/);
  assert.match(composer, /snapshotFromTemplate\(smartTemplate\)/);
  // Picking one model is picking one model: the mode must clear.
  assert.match(hook, /smartMode: null/);
});

test("the chip names the mode rather than one of its models", () => {
  assert.match(composer, /const smartPairActive = /);
  assert.match(composer, /const modelLabel = smartPairActive[\s\S]{0,120}chat\.smartModeEntry/);
  // A pair may cross providers, so the row carries both labels.
  assert.match(composer, /mainProvider: providerLabelOf\(smartTemplate\.main\.providerId\)/);
  assert.match(composer, /subProvider: providerLabelOf\(smartTemplate\.sub\.providerId\)/);
});
