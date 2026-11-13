/**
 * 发布包契约：autotest 服务必须进 `extraResources`。
 *
 * 旧插件（`plugins/autotest` + 随包副本）删掉之后，发布版的 autotest 后端
 * 只剩 `services/autotest` 这一条路径。打包漏掉它时应用照常启动，只是所有
 * autotest 工具都报"连接失败"——这种失败在开发机上永远看不到，只能靠这条
 * 断言把它挡在打包前。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, "..", "..");
const REPO = join(DESKTOP, "..", "..");
const SERVICE = join(REPO, "services", "autotest");

function extraResources() {
  const manifest = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8"));
  return manifest.build.extraResources;
}

test("extraResources 把服务源码、托管页、e2e runner 与依赖打进 autotest/", () => {
  const entries = extraResources();
  const byTo = new Map(entries.map((entry) => [entry.to, entry.from]));

  assert.equal(byTo.get("autotest/src"), "../../services/autotest/src");
  // 固定提示词是运行时读的文件（`prompts/` 在 `src/` 之外），漏打包会让装出来的
  // 版本直接退化成"没有规则"的生成 —— 开发机上永远看不到。目录存在性一起断言。
  assert.equal(byTo.get("autotest/prompts"), "../../services/autotest/prompts");
  assert.ok(existsSync(join(SERVICE, "prompts", "case-design.md")));
  assert.equal(byTo.get("autotest/ui-shell"), "../../services/autotest/ui-shell");
  assert.equal(byTo.get("autotest/runner"), "../../services/autotest/runner");
  // `.deps` 是本机 `pip install --target` 的产物，不进 git；这里只要求配置存在，
  // 存在性检查留给打包机（缺了它会直接 fail，不会静默产出坏包）。
  assert.equal(byTo.get("autotest/.deps"), "../../services/autotest/.deps");
});

test("Vue 工作台产物随包发布，且打包链先构建它", () => {
  const manifest = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8"));
  const byTo = new Map(manifest.build.extraResources.map((entry) => [entry.to, entry.from]));

  // 后端只托管磁盘上真实存在的目录：不把 ui/dist 打进包，
  // 安装版就一直停在零构建的 ui-shell，Vue 版在工作台里永远看不到。
  assert.equal(byTo.get("autotest/ui/dist"), "../../services/autotest/ui/dist");
  // dist 是构建产物、不进 git，所以发布链必须自己生成它，否则 extraResources
  // 指向一个不存在的目录会让 electron-builder 直接失败在最后一步。
  const scripts = manifest.scripts;
  assert.ok(scripts["bundle:autotest-ui"], "缺少 bundle:autotest-ui 脚本");
  // 不变量：带自带 Python 的发布链（后端能跑）也必须带上 Vue 产物，
  // 否则装出来的是「服务在、界面退回 ui-shell」的半成品。
  for (const [lane, command] of Object.entries(scripts)) {
    if (!command.includes("bundle:python")) continue;
    assert.match(command, /bundle:autotest-ui/, `${lane} 带了 Python 却没构建 Vue 工作台`);
  }
  assert.ok(existsSync(join(SERVICE, "ui", "package.json")), "services/autotest/ui 不存在");
});

test("被声明的三份源码目录在仓库里真实存在", () => {
  for (const name of ["src", "ui-shell", "runner"]) {
    assert.ok(existsSync(join(SERVICE, name)), `services/autotest/${name} 不存在`);
  }
});
