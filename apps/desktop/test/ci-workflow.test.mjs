import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  ciWorkflowSource,
  desktopPackageSource,
  linuxPackageWorkflowSource,
  mirrorToCnbWorkflowSource,
  agentRuntimePackageSource,
  i18nPackageSource,
  pluginSdkPackageSource,
  sharedPackageSource,
] = await Promise.all([
  read("../../../.github/workflows/ci.yml"),
  read("../package.json"),
  read("../../../.github/workflows/linux-package.yml"),
  read("../../../.github/workflows/mirror-to-cnb.yml"),
  read("../../../packages/agent-runtime/package.json"),
  read("../../../packages/i18n/package.json"),
  read("../../../packages/plugin-sdk/package.json"),
  read("../../../packages/shared/package.json"),
]);

test("CI skips documentation-only pushes and pull requests", () => {
  assert.equal(
    (ciWorkflowSource.match(/- 'docs\/\*\*'/g) ?? []).length,
    2,
    "docs path is ignored by push and pull_request triggers",
  );
  assert.equal(
    (ciWorkflowSource.match(/- '\*\*\/\*\.md'/g) ?? []).length,
    2,
    "Markdown files are ignored by push and pull_request triggers",
  );
  assert.match(ciWorkflowSource, /^  workflow_dispatch:/m);
});

test("CI does not typecheck workspace dependencies twice", () => {
  for (const source of [
    agentRuntimePackageSource,
    i18nPackageSource,
    pluginSdkPackageSource,
    sharedPackageSource,
  ]) {
    assert.match(JSON.parse(source).scripts.build, /^tsc\b/);
  }

  assert.match(
    ciWorkflowSource,
    /run: pnpm --filter @pi-workspace\/desktop typecheck/,
  );
  assert.doesNotMatch(ciWorkflowSource, /run: pnpm typecheck/);
});

test("manual Linux package validation covers the RPM desktop identity", () => {
  assert.match(linuxPackageWorkflowSource, /^on:\s*\n\s+workflow_dispatch:/m);
  assert.match(linuxPackageWorkflowSource, /runs-on: ubuntu-22\.04/);
  assert.match(
    linuxPackageWorkflowSource,
    /run: pnpm --filter @pi-workspace\/desktop run dist:linux -- --x64/,
  );
  assert.match(
    linuxPackageWorkflowSource,
    /name: Install RPM inspection tools[\s\S]*apt-get install[\s\S]*cpio rpm/,
  );
  assert.match(
    linuxPackageWorkflowSource,
    /find apps\/desktop\/release[\s\S]*-name '\*\.rpm'/,
  );
  assert.match(linuxPackageWorkflowSource, /rpm -qpl "\$rpm_package"/);
  assert.match(linuxPackageWorkflowSource, /build-id/);
  assert.match(
    linuxPackageWorkflowSource,
    /usr\/share\/applications\/pi-workspace\.desktop/,
  );
  assert.match(linuxPackageWorkflowSource, /Icon=pi-workspace/);
  assert.match(linuxPackageWorkflowSource, /StartupWMClass=pi-workspace/);
  assert.match(
    linuxPackageWorkflowSource,
    /uses: actions\/upload-artifact@v7[\s\S]*path: apps\/desktop\/release\/\*\.rpm/,
  );
});

test("the Linux package config lets the workflow choose the architecture", () => {
  const build = JSON.parse(desktopPackageSource).build;
  // electron-builder prefers a target's configured arch list over the CLI
  // `--x64`/`--arm64` flag, so pinning both here would make each Linux lane
  // build the other architecture around its own native host-core.
  for (const entry of build.linux.target) {
    assert.equal(
      entry.arch,
      undefined,
      `linux target ${entry.target} must not pin an arch`,
    );
  }
  assert.match(
    build.linux.artifactName,
    /-linux-\$\{arch\}\.\$\{ext\}$/,
    "the AppImage name carries its architecture",
  );
  assert.equal(build.deb.artifactName, "pi-workspace_${version}_${arch}.${ext}");
  assert.equal(build.rpm.artifactName, "pi-workspace-${version}-${arch}.${ext}");
});

test("GitHub releases trigger the CNB mirror pipeline with a JSON payload", () => {
  assert.match(
    mirrorToCnbWorkflowSource,
    /release:\s+types:\s+\[published, edited\]/,
  );
  assert.match(
    mirrorToCnbWorkflowSource,
    /workflow_dispatch:\s+inputs:\s+tag:/,
  );
  assert.match(
    mirrorToCnbWorkflowSource,
    /if: github\.repository == 'xiognws\/PI-Desktop'/,
  );
  assert.match(
    mirrorToCnbWorkflowSource,
    /CNB_MIRROR_TOKEN: \$\{\{\s*secrets\.CNB_MIRROR_TOKEN\s*\}\}/,
  );
  assert.match(
    mirrorToCnbWorkflowSource,
    /Missing repository secret CNB_MIRROR_TOKEN/,
  );
  assert.match(
    mirrorToCnbWorkflowSource,
    /https:\/\/api\.cnb\.cool\/aixk\/Pi-Desktop\/-\/build\/start/,
  );
  assert.match(mirrorToCnbWorkflowSource, /event: "api_trigger_mirror"/);
  assert.match(mirrorToCnbWorkflowSource, /env: \{ MIRROR_TAGS: \$tag \}/);
  assert.match(mirrorToCnbWorkflowSource, /jq -n --arg tag "\$MIRROR_TAG"/);
  assert.match(mirrorToCnbWorkflowSource, /curl --fail-with-body/);
  assert.doesNotMatch(
    mirrorToCnbWorkflowSource,
    /-d ".*github\.event\.release\.tag_name/,
    "JSON payload must not interpolate the release tag through YAML string escaping",
  );
});
