import { readSettingsSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  bugTemplate,
  featureTemplate,
  configTemplate,
  apiSource,
  settingsSource,
  settingsSearchSource,
  mainIpcSource,
] = await Promise.all([
  read("../../../.github/ISSUE_TEMPLATE/bug_report.yml"),
  read("../../../.github/ISSUE_TEMPLATE/feature_request.yml"),
  read("../../../.github/ISSUE_TEMPLATE/config.yml"),
  read("../src/lib/api.ts"),
  readSettingsSource(),
  read("../src/lib/settings-search.ts"),
  read("../electron/main/ipc/app-ipc.ts"),
]);

function requiredField(source, id) {
  const start = source.indexOf(`id: ${id}`);
  assert.ok(start >= 0, `missing field ${id}`);
  const next = source.indexOf("\n  - type:", start);
  const block = source.slice(start, next === -1 ? undefined : next);
  assert.match(block, /required:\s*true/, `${id} must be required`);
}

test("blank GitHub issues stay disabled", () => {
  assert.match(configTemplate, /blank_issues_enabled:\s*false/);
});

test("bug report form requires triage fields", () => {
  for (const id of [
    "description",
    "reproduce",
    "expected",
    "actual",
    "app-version",
    "os",
  ]) {
    requiredField(bugTemplate, id);
  }
  assert.match(bugTemplate, /id: environment/);
  assert.match(bugTemplate, /id: logs/);
  assert.match(bugTemplate, /labels:\s*\[["']bug["']\]/);
});

test("feature request form requires a problem and a proposal", () => {
  requiredField(featureTemplate, "problem");
  requiredField(featureTemplate, "proposal");
  assert.match(featureTemplate, /labels:\s*\[["']enhancement["']\]/);
});

test("the Info page points at nothing outside this build", () => {
  // Distribution surface: the panel must not name the build's internals or open
  // an external destination. The report-a-problem row and its Main-owned URL
  // builder are gone; the handbook row survives because it opens a document
  // this build ships, with the viewer the machine already has.
  assert.doesNotMatch(settingsSource, /api\.openFeedback\(\)/);
  assert.doesNotMatch(settingsSource, /settings-about-hero-meta/);
  assert.doesNotMatch(settingsSource, /github\.com/i);
  assert.doesNotMatch(apiSource, /openFeedback:/);
  assert.doesNotMatch(settingsSearchSource, /"settings\.feedback"/);
  // The handbook row is back: it opens a document this build ships, with the
  // viewer the machine already has. Nothing here can reach an external issue
  // form.
  assert.match(settingsSource, /api\.openManual\(\)/);
  assert.doesNotMatch(settingsSource, /shell\.openPath|github\.com/i);
  // The Main-owned URL builder is gone too: nothing in the shipped bundles can
  // assemble an external issue link any more.
  assert.doesNotMatch(mainIpcSource, /appOpenFeedback/);
  assert.doesNotMatch(mainIpcSource, /buildBugReportUrl|assertFeedbackIssueUrl/);
});
