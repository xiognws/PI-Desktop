// Renderer entry for pi.autotest.
// No panel, no window: every surface is a slot in the conversation, which is
// where the review gate belongs.
import { bindBridge, pluginId } from './bridge.mjs';
import { AUTOTEST_CSS } from './styles.mjs';
import { StageStrip } from './strip.mjs';
import { ReportBlock } from './blocks.mjs';
import {
  RequirementCard,
  CasesCard,
  ScriptsCard,
  RunCard,
  DiagnoseCard,
  ReportCard,
  StatusCard,
} from './cards.mjs';

const TOOL_CARDS = [
  ['autotest_requirement', RequirementCard],
  ['autotest_cases', CasesCard],
  ['autotest_author', ScriptsCard],
  ['autotest_run', RunCard],
  ['autotest_diagnose', DiagnoseCard],
  ['autotest_report', ReportCard],
  ['autotest_status', StatusCard],
  ['autotest_select', CasesCard],
];

export function onLoad(pi) {
  bindBridge(pi);
  pi.ui.injectStyle(AUTOTEST_CSS);
  const id = pluginId();

  // `toolName` must be the BARE agent tool name: slotRegistrationRefusal
  // (plugin-sdk renderer.ts:449-460) rejects anything that is not one of
  // contributes.agentTools, so the qualified spelling cannot be registered
  // here. The host derives the lookup key itself with pluginToolName()
  // (registry.ts:86-100), which is why both sides agree without this file
  // knowing about the prefix.
  TOOL_CARDS.forEach(function (pair) {
    pi.slots.register({ slot: 'toolCard', toolName: pair[0], component: pair[1] });
  });

  // The always-visible surface: the rail plus, when the plan still needs a
  // decision, the review gate itself, because tool cards sit inside a folded
  // activity group.
  pi.slots.register({ slot: 'entryExtra', component: StageStrip });
  pi.slots.register({ slot: 'blockRenderer', language: id + ':report', component: ReportBlock });
}
