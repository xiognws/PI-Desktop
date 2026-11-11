/**
 * Autotest 服务的生命周期（Electron main 侧）。
 *
 * 只做四件事：选目录/解释器 → 起 uvicorn → 探活 → 原子写 `runtime.json`。
 * Agent 扩展（sidecar 内）读到 `runtime.json` 后直连 loopback，不经 main 转发。
 *
 * 失败一律 fail-soft：服务起不来时应用照常使用，只是 autotest 工具会报连接失败。
 *
 * 目录约定（`<dataDir>` 是 Desktop 的数据目录，main 已导出为
 * `PI_DESKTOP_DATA_DIR`，sidecar 继承得到）:
 *
 *   <dataDir>/autotest/runtime.json    { port, pid, workspace, startedAt }
 *   <dataDir>/autotest/workspace/      项目数据（AUTOTEST_WORKSPACE）
 *   <dataDir>/autotest/platform.db     平台库（AUTOTEST_PLATFORM_DB）
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 本模块所在目录，用于在源码仓库里定位 `services/autotest`（测试可覆盖）。 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export type AutotestServiceStatus = "stopped" | "starting" | "ready" | "failed";

export type AutotestRuntime = {
  port: number;
  pid: number;
  workspace: string;
  startedAt: string;
};

export type AutotestServiceOptions = {
  /** Desktop 数据目录（`<userData>` 或 `PI_DESKTOP_DATA_DIR`）。 */
  dataDir: string;
  /** 打包后是 `process.resourcesPath`；开发期可为空。 */
  resourcesPath?: string;
  /** 当前模块目录（`.../electron/autotest`），默认按本模块位置推导；测试可覆盖。 */
  moduleDir?: string;
  /** 日志出口，默认静默。 */
  log?: (message: string) => void;
};

const HEALTH_TIMEOUT_MS = 25_000;
const HEALTH_POLL_MS = 400;
const STOP_GRACE_MS = 3_000;

function defaultLog(): void {
  // 静默：没有注入 logger 时不要把启动日志写进控制台。
}

/** Windows 上是 python.exe；其它平台是 bin/python3。 */
function interpreterIn(runtimeDir: string): string {
  return process.platform === "win32" ? join(runtimeDir, "python.exe") : join(runtimeDir, "bin", "python3");
}

/** 服务源码目录：打包内 `<resources>/autotest`，开发期是仓库的 `services/autotest`。 */
export function resolveServiceDir(options: AutotestServiceOptions): string | null {
  const moduleDir = options.moduleDir ?? MODULE_DIR;
  const candidates = [
    process.env.PI_AUTOTEST_SERVICE_DIR ?? "",
    options.resourcesPath ? join(options.resourcesPath, "autotest") : "",
    // 模块目录是 `<repo>/apps/desktop/electron/autotest`，源码在 `<repo>/services/autotest`。
    join(moduleDir, "..", "..", "..", "..", "services", "autotest"),
  ].filter((value) => value.trim().length > 0);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "src", "autotest", "api", "server.py"))) return candidate;
  }
  return null;
}

export type PythonRuntime = { exe: string; home: string; sitePackages: string };

/** 解释器：先用 Pi 自带的那份（3.12 + office 栈），再退到显式配置/系统 python。 */
export function resolvePythonRuntime(options: AutotestServiceOptions): PythonRuntime | null {
  const moduleDir = options.moduleDir ?? MODULE_DIR;
  const bundled = [
    options.resourcesPath ? join(options.resourcesPath, "python") : "",
    join(moduleDir, "..", "..", "..", "..", "apps", "desktop", "resources", "python"),
  ].filter((value) => value.trim().length > 0);
  for (const root of bundled) {
    const exe = interpreterIn(join(root, "runtime"));
    if (existsSync(exe)) {
      return { exe, home: join(root, "runtime"), sitePackages: join(root, "site-packages") };
    }
  }
  const explicit = (process.env.PI_DESKTOP_PYTHON ?? process.env.PI_AUTOTEST_PYTHON ?? "").trim();
  if (explicit && existsSync(explicit)) {
    // 显式给的解释器可能来自另一份自带运行时（例如开发期复用的主 checkout），
    // 若它是 `<pythonRoot>/runtime/python.exe` 形态，旁边的 site-packages 一并挂上。
    const home = dirname(explicit);
    const root = dirname(home);
    const sitePackages = join(root, "site-packages");
    return { exe: explicit, home, sitePackages: existsSync(sitePackages) ? sitePackages : "" };
  }
  return null;
}

/** 服务子进程的环境：只有一个解释器，依赖放 `.deps`，自带 site-packages 一并挂上。 */
export function buildServiceEnv(
  python: PythonRuntime,
  serviceDir: string,
  workspace: string,
  platformDb: string,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const pythonPath = [
    join(serviceDir, "src"),
    join(serviceDir, ".deps"),
    python.sitePackages,
    parent.PYTHONPATH ?? "",
  ]
    .filter((value) => value.length > 0)
    .join(process.platform === "win32" ? ";" : ":");
  return {
    ...parent,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    PYTHONHOME: python.home,
    PYTHONPATH: pythonPath,
    AUTOTEST_WORKSPACE: workspace,
    // 平台库固定落在数据目录：服务以 `<resources>/autotest` 为 cwd 启动，
    // 不给这个变量就会写进安装目录。
    AUTOTEST_PLATFORM_DB: platformDb,
    AUTOTEST_PARENT_PID: String(process.pid),
  };
}

/** 取一个本机空闲端口；服务固定 loopback，不对外暴露。 */
export async function pickFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error("could not allocate a loopback port"));
      });
    });
  });
}

/** 先写临时文件再 rename：读的一方要么看到旧文件，要么看到完整的新文件。 */
export function writeRuntimeFile(path: string, runtime: AutotestRuntime): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(runtime, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

export function removeRuntimeFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // 退出路径上删不掉不算错误：下次启动会覆盖。
  }
}

async function probeHealth(port: number, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(Math.min(timeoutMs, 2_000)),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export class AutotestService {
  // 显式字段赋值：node --test 的类型剥离不支持参数属性语法。
  private readonly options: AutotestServiceOptions;
  private child: ChildProcess | null = null;
  private status: AutotestServiceStatus = "stopped";
  private port = 0;
  private error = "";

  constructor(options: AutotestServiceOptions) {
    this.options = options;
  }

  get runtimePath(): string {
    return join(this.options.dataDir, "autotest", "runtime.json");
  }

  private get workspace(): string {
    return join(this.options.dataDir, "autotest", "workspace");
  }

  private get platformDbPath(): string {
    return join(this.options.dataDir, "autotest", "platform.db");
  }

  state(): { status: AutotestServiceStatus; port: number; error: string } {
    return { status: this.status, port: this.port, error: this.error };
  }

  async start(): Promise<void> {
    if (this.child || this.status === "ready") return;
    const log = this.options.log ?? defaultLog;
    this.status = "starting";

    const serviceDir = resolveServiceDir(this.options);
    if (!serviceDir) {
      this.fail(log, "autotest service sources not found (services/autotest or <resources>/autotest)");
      return;
    }
    const python = resolvePythonRuntime(this.options);
    if (!python) {
      this.fail(log, "python runtime not found (resources/python or PI_DESKTOP_PYTHON)");
      return;
    }

    let port: number;
    try {
      port = await pickFreePort();
    } catch (error) {
      this.fail(log, `could not allocate a port: ${String(error)}`);
      return;
    }
    this.port = port;
    mkdirSync(this.workspace, { recursive: true });

    const child = spawn(
      python.exe,
      ["-m", "uvicorn", "autotest.api.server:app", "--host", "127.0.0.1", "--port", String(port)],
      {
        cwd: serviceDir,
        env: buildServiceEnv(python, serviceDir, this.workspace, this.platformDbPath),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => log(`[autotest] ${String(chunk).trimEnd()}`));
    child.stderr?.on("data", (chunk: Buffer) => log(`[autotest] ${String(chunk).trimEnd()}`));
    child.on("exit", (code, signal) => {
      log(`[autotest] backend exited code=${String(code)} signal=${String(signal)}`);
      if (this.child === child) {
        this.child = null;
        if (this.status === "ready") {
          this.status = "failed";
          this.error = "backend exited";
        }
      }
    });
    child.on("error", (error) => {
      this.fail(log, `spawn failed: ${error.message}`);
    });

    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await probeHealth(port, HEALTH_POLL_MS)) {
        this.status = "ready";
        this.error = "";
        writeRuntimeFile(this.runtimePath, {
          port,
          pid: child.pid ?? 0,
          workspace: this.workspace,
          startedAt: new Date().toISOString(),
        });
        log(`[autotest] backend ready on 127.0.0.1:${port}`);
        return;
      }
      if (!this.child) return;
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
    }
    this.fail(log, "backend did not answer /api/health in time");
  }

  /**
   * 用户从「工作台不可用」提示里点重试时走这里：先收掉可能半启动的子进程，
   * 再完整走一次 start()。`starting` 状态下也允许调用——start() 的探活循环在
   * `this.child` 被清空后自己会退出，不会留下两个后端。
   */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    removeRuntimeFile(this.runtimePath);
    const child = this.child;
    this.child = null;
    this.status = "stopped";
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    const deadline = Date.now() + STOP_GRACE_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    // uvicorn 在 Windows 上不一定响应 SIGTERM；按进程树收掉，避免残留占端口。
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      return;
    }
    child.kill("SIGKILL");
  }

  private fail(log: (message: string) => void, message: string): void {
    this.status = "failed";
    this.error = message;
    removeRuntimeFile(this.runtimePath);
    log(`[autotest] ${message}`);
  }
}
