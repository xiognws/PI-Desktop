import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyHomeLinks, dropDanglingHomeLinks, HOME_LINK_DIRS, planHomeLinks } from "../electron/main/data-root-home.ts";

const quiet = { log: () => {}, warn: () => {} };
const sandboxes = [];

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "pi-data-root-home-"));
  sandboxes.push(base);
  const home = join(base, "home");
  const root = join(base, "D/PI-Desktop");
  const dataDir = join(root, "data");
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  return { base, home, root, dataDir, links: planHomeLinks({ home, root, dataDir }) };
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function linkTo(target, path) {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

test.after(() => {
  for (const base of sandboxes) rmSync(base, { recursive: true, force: true });
});

test("every installation redirects skills, agent state and the legacy data directory", () => {
  const { home, root, dataDir, links } = sandbox();
  assert.deepEqual(
    links.map((link) => [link.home, link.target]),
    [
      [join(home, HOME_LINK_DIRS.agents), join(root, "agents")],
      [join(home, HOME_LINK_DIRS.pi), join(root, "pi")],
      [join(home, HOME_LINK_DIRS.legacyData), dataDir],
    ],
  );
});

test("existing content moves to the data root and the home path keeps working through the link", () => {
  const { home, root, dataDir, links } = sandbox();
  write(join(home, ".agents/skills/learned/SKILL.md"), "# learned\n");
  write(join(home, ".pi/agent/user-profile/profile.json"), '{"name":"u"}\n');
  write(join(home, ".pi-desktop/plugins/data/io.example/data.json"), '{"kept":true}\n');

  const results = applyHomeLinks(links, quiet);
  assert.deepEqual(results.map((result) => result.state), ["linked", "linked", "linked"]);
  assert.deepEqual(results.map((result) => result.merged), [true, true, true]);

  // Physically on the data drive ...
  assert.equal(readFileSync(join(root, "agents/skills/learned/SKILL.md"), "utf8"), "# learned\n");
  assert.equal(readFileSync(join(root, "pi/agent/user-profile/profile.json"), "utf8"), '{"name":"u"}\n');
  assert.equal(readFileSync(join(dataDir, "plugins/data/io.example/data.json"), "utf8"), '{"kept":true}\n');
  // ... and the home path is a link, not a second copy.
  for (const name of [".agents", ".pi", ".pi-desktop"]) {
    assert.equal(lstatSync(join(home, name)).isSymbolicLink(), true, `${name} must be a link`);
  }

  // A write through the old path lands in the data root — this is what a plugin
  // calling os.homedir() does after the host moved its own files.
  write(join(home, ".agents/skills/fresh/SKILL.md"), "# fresh\n");
  assert.equal(readFileSync(join(root, "agents/skills/fresh/SKILL.md"), "utf8"), "# fresh\n");
});

test("a second launch is a no-op and leaves an existing link untouched", () => {
  const { home, links } = sandbox();
  write(join(home, ".agents/skills/learned/SKILL.md"), "# learned\n");
  applyHomeLinks(links, quiet);
  const file = join(home, ".agents/skills/learned/SKILL.md");
  const before = statSync(file).mtimeMs;

  const second = applyHomeLinks(links, quiet);
  assert.deepEqual(second.map((result) => result.state), ["kept", "kept", "kept"]);
  assert.equal(lstatSync(join(home, ".agents")).isSymbolicLink(), true);
  assert.equal(statSync(file).mtimeMs, before);
});

test("the data root wins over a stale file left behind on the system drive", () => {
  const { home, root, links } = sandbox();
  write(join(root, "agents/skills/learned/SKILL.md"), "# live\n");
  write(join(home, ".agents/skills/learned/SKILL.md"), "# stale\n");
  write(join(home, ".agents/skills/other/SKILL.md"), "# only-on-the-system-drive\n");

  const [agents] = applyHomeLinks(links, quiet);
  assert.equal(agents.state, "linked");
  // The live copy is not overwritten, and a file the root never had is carried over.
  assert.equal(readFileSync(join(root, "agents/skills/learned/SKILL.md"), "utf8"), "# live\n");
  assert.equal(readFileSync(join(root, "agents/skills/other/SKILL.md"), "utf8"), "# only-on-the-system-drive\n");
  assert.equal(readFileSync(join(home, ".agents/skills/learned/SKILL.md"), "utf8"), "# live\n");
});

test("a home directory the user already linked elsewhere is left alone", () => {
  const { base, home, links } = sandbox();
  const userTarget = join(base, "user-chosen/agents");
  write(join(userTarget, "skills/mine/SKILL.md"), "# mine\n");
  linkTo(userTarget, join(home, ".agents"));

  const [agents] = applyHomeLinks(links, quiet);
  assert.equal(agents.state, "kept");
  assert.equal(agents.merged, false);
  assert.equal(readFileSync(join(home, ".agents/skills/mine/SKILL.md"), "utf8"), "# mine\n");
});

test("a plain file where the link belongs is reported instead of destroyed", () => {
  const { home, links } = sandbox();
  write(join(home, ".pi"), "not a directory\n");

  const [, piLink] = applyHomeLinks(links, quiet);
  assert.equal(piLink.state, "skipped");
  assert.match(String(piLink.error), /not a directory/);
  assert.equal(readFileSync(join(home, ".pi"), "utf8"), "not a directory\n");
});

test("a failed copy keeps the original directory, so nothing is lost", () => {
  const { base, home } = sandbox();
  write(join(home, ".agents/skills/learned/SKILL.md"), "# learned\n");
  // A file where the installation root should be makes every mkdir below it fail.
  const blockedRoot = join(base, "blocked-root");
  writeFileSync(blockedRoot, "x", "utf8");

  const [agents] = applyHomeLinks(planHomeLinks({ home, root: blockedRoot, dataDir: join(base, "d") }), quiet);
  assert.equal(agents.state, "skipped");
  assert.ok(agents.error);
  assert.equal(readFileSync(join(home, ".agents/skills/learned/SKILL.md"), "utf8"), "# learned\n");
  assert.equal(lstatSync(join(home, ".agents")).isSymbolicLink(), false);
  assert.equal(existsSync(join(home, ".agents/skills/learned/SKILL.md")), true);
});

test("a link whose data drive is gone is dropped so the home layout takes over", () => {
  const { home, root, links } = sandbox();
  applyHomeLinks(links, quiet);
  // The drive is not mounted this launch: the targets are gone, the links stay.
  rmSync(root, { recursive: true, force: true });
  assert.equal(existsSync(join(home, ".agents")), false);

  const dropped = dropDanglingHomeLinks(home, quiet);
  assert.equal(dropped.length, 3);
  for (const name of Object.values(HOME_LINK_DIRS)) {
    assert.equal(existsSync(join(home, name)), false, `${name} is dropped and recreated by its next writer`);
  }
});

test("a link that points at a different root is kept, and the mismatch is reported", () => {
  const { base, home, root, dataDir } = sandbox();
  const otherRoot = join(base, "other/PI-Desktop");
  write(join(otherRoot, "agents/skills/kept/SKILL.md"), "# kept\n");
  linkTo(join(otherRoot, "agents"), join(home, ".agents"));

  const warnings = [];
  const results = applyHomeLinks(planHomeLinks({ home, root, dataDir }), {
    log: () => {},
    warn: (message) => warnings.push(String(message)),
  });

  assert.equal(results[0].state, "kept");
  assert.equal(readFileSync(join(home, ".agents/skills/kept/SKILL.md"), "utf8"), "# kept\n");
  assert.ok(warnings.some((message) => message.includes("kept") && message.includes("would use")));
});
