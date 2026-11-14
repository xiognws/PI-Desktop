/**
 * `electron/autotest/service.ts` 的单元测试。
 *
 * 只测可判定的部分：目录/解释器解析、子进程环境、runtime.json 的原子写与清理、
 * 端口分配。真正的 uvicorn 拉起属于集成路径（需要 sidecar/Electron 环境），
 * 这里不覆盖。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "..", "..", "test", "helpers", "ts-import-hooks.mjs")));

const {
  AutotestService,
  buildServiceEnv,
  pickFreePort,
  removeRuntimeFile,
  resolvePythonRuntime,
  resolveServiceDir,
  writeRuntimeFile,
} = await import("../autotest/service.ts");

/** 造一个最小的仓库布局：源码服务 + 自带 python。 */
async function makeRepo(root) {
  const moduleDir = join(root, "apps", "desktop", "electron", "autotest");
  await mkdir(join(moduleDir), { recursive: true });
  await mkdir(join(root, "services", "autotest", "src", "autotest", "api"), { recursive: true });
  await writeFile(join(root, "services", "autotest", "src", "autotest", "api", "server.py"), "# app\n");
  const pythonRuntime = join(root, "apps", "desktop", "resources", "python", "runtime");
  await mkdir(join(pythonRuntime, "bin"), { recursive: true });
  await mkdir(join(root, "apps", "desktop", "resources", "python", "site-packages"), { recursive: true });
  await writeFile(join(pythonRuntime, "python.exe"), "");
  await writeFile(join(pythonRuntime, "bin", "python3"), "");
  return { moduleDir, pythonRuntime };
}

function clearEnv() {
  delete process.env.PI_AUTOTEST_SERVICE_DIR;
  delete process.env.PI_DESKTOP_PYTHON;
  delete process.env.PI_AUTOTEST_PYTHON;
}

test("resolveServiceDir 按仓库布局定位 services/autotest", async () => {
  clearEnv();
  const root = await mkdtemp(join(tmpdir(), "autotest-svc-"));
  try {
    const { moduleDir } = await makeRepo(root);
    assert.equal(resolveServiceDir({ dataDir: root, moduleDir }), join(root, "services", "autotest"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveServiceDir 在源码不存在时返回 null 而不是猜一个路径", async () => {
  clearEnv();
  const root = await mkdtemp(join(tmpdir(), "autotest-svc-"));
  try {
    assert.equal(resolveServiceDir({ dataDir: root, moduleDir: root }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolvePythonRuntime 选自带 python，并带上 site-packages", async () => {
  clearEnv();
  // 没有这条，测试就会随机器的 PATH 变化：自带运行时只在“不优先用户解释器”时胜出。
  process.env.PI_PYTHON_STRATEGY = "bundled";
  const root = await mkdtemp(join(tmpdir(), "autotest-svc-"));
  try {
    const { moduleDir } = await makeRepo(root);
    const runtime = resolvePythonRuntime({ dataDir: root, moduleDir });
    assert.ok(runtime);
    assert.ok(runtime.exe.includes(join("runtime", process.platform === "win32" ? "python.exe" : "bin")));
    assert.ok(runtime.sitePackages.endsWith(join("python", "site-packages")));
    assert.ok(runtime.home.endsWith("runtime"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolvePythonRuntime 没有自带环境也没有显式配置时返回 null", async () => {
  clearEnv();
  // 显式要求系统解释器：没有自带树可退，结果与机器上装了什么无关。
  process.env.PI_PYTHON_STRATEGY = "system";
  process.env.PATH = "";
  const root = await mkdtemp(join(tmpdir(), "autotest-svc-"));
  try {
    assert.equal(resolvePythonRuntime({ dataDir: root, moduleDir: root }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildServiceEnv 把 src、.deps、自带 site-packages 依次挂到 PYTHONPATH", () => {
  const env = buildServiceEnv(
    { exe: "/py/python.exe", home: "/py/runtime", sitePackages: "/py/site-packages" },
    "/svc",
    "/ws",
    "/db/platform.db",
    { PYTHONPATH: "/extra", PATH: "/bin" },
  );
  const sep = process.platform === "win32" ? ";" : ":";
  assert.deepEqual(env.PYTHONPATH.split(sep), [
    join("/svc", "src"),
    join("/svc", ".deps"),
    "/py/site-packages",
    "/extra",
  ]);
  assert.equal(env.PYTHONHOME, "/py/runtime");
  assert.equal(env.AUTOTEST_WORKSPACE, "/ws");
  assert.equal(env.AUTOTEST_PLATFORM_DB, "/db/platform.db");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.PYTHONUTF8, "1");
});

test("writeRuntimeFile 原子写入，读取方看到完整 JSON，且不留临时文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "autotest-rt-"));
  try {
    const path = join(root, "autotest", "runtime.json");
    writeRuntimeFile(path, { port: 4012, pid: 42, workspace: join(root, "ws"), startedAt: "T" });
    const parsed = JSON.parse(await readFile(path, "utf8"));
    assert.equal(parsed.port, 4012);
    assert.equal(parsed.pid, 42);
    // 退出码不是证据，rename 也不是：Windows 上杀软/索引器可能让临时名在
    // rename 之后极短时间内仍然可见，所以给一个有界重试窗口，而不是断言
    // "此刻目录一定干净"。
    let leftovers = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      leftovers = (await readdir(join(root, "autotest"))).filter((name) => name.endsWith(".tmp"));
      if (leftovers.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(leftovers, []);
    removeRuntimeFile(path);
    assert.deepEqual(await readdir(join(root, "autotest")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pickFreePort 分配一个 loopback 端口", async () => {
  const port = await pickFreePort();
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
});

test("AutotestService 初始状态是 stopped，runtimePath 指向数据目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "autotest-svc-"));
  try {
    const service = new AutotestService({ dataDir: root });
    assert.deepEqual(service.state(), { status: "stopped", port: 0, error: "" });
    assert.equal(service.runtimePath, join(root, "autotest", "runtime.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart 重新尝试启动，失败原因不会被吞掉", async () => {
  clearEnv();
  const root = await mkdtemp(join(tmpdir(), "autotest-svc-"));
  try {
    const service = new AutotestService({ dataDir: root, moduleDir: root });
    await service.start();
    assert.equal(service.state().status, "failed");
    assert.match(service.state().error, /not found/);

    // 用户点「重试启动」：状态先回 stopped 再走一次 start()，仍旧失败但错误可读。
    await service.restart();
    assert.equal(service.state().status, "failed");
    assert.match(service.state().error, /not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
