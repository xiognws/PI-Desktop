/**
 * Autotest — PI-Desktop plugin entry.
 *
 * Owns the platform backend process: the host starts this plugin's resident
 * service (`contributes.services[0]`), which launches the FastAPI backend from
 * the runtime directory and keeps it alive. Agent tools proxy to that backend
 * over loopback; every call is gated by `net.fetch` + `manifest.net.domains`.
 */

const { spawn } = require("node:child_process");
const { existsSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const state = {
  child: null,
  port: 4000,
  platformDir: "",
  pythonPath: "",
  e2eHome: "",
  dataRoot: "",
  lastError: "",
  log: () => {},
};

const HEALTH_TIMEOUT_MS = 25_000;
const HEALTH_POLL_MS = 400;
const STOP_GRACE_MS = 3_000;

/** The plugin directory itself; the platform source ships inside it. */
function pluginDir() {
  return __dirname;
}

function platformDir() {
  return state.platformDir || join(pluginDir(), "platform");
}

/**
 * e2e runtime (Playwright engine) lives in this project, not in another checkout.
 * Order: setting → env → <plugin>/(platform/)runtime/e2e → <worktree>/runtime/e2e.
 * The resolved path is passed to the backend explicitly, because the host does
 * not guarantee that arbitrary env vars survive into the plugin process.
 */
function resolveE2eHome() {
  const win = process.platform === "win32";
  const candidates = [
    state.e2eHome,
    process.env.AUTOTEST_E2E_HOME,
    join(pluginDir(), "platform", "runtime", "e2e"),
    join(pluginDir(), "runtime", "e2e"),
    win ? join(pluginDir(), "..", "..", "runtime", "e2e") : join(pluginDir(), "..", "..", "runtime", "e2e"),
  ].filter((value) => typeof value === "string" && value.trim());
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "node_modules", "e2e"))) {
      state.log(`[autotest] e2e runtime: ${candidate}`);
      return candidate;
    }
  }
  state.log("[autotest] e2e runtime not found (UI cases will report 'not provisioned')");
  return "";
}

function pythonExe() {
  const platform = platformDir();
  const win = process.platform === "win32";
  const candidates = [
    state.pythonPath,
    // 开发/演示：宿主进程的环境变量（正式分发靠设置项 pythonPath）
    process.env.AUTOTEST_PYTHON,
    // 插件内约定：<plugin>/platform/.venv（随插件分发的 venv）
    win ? join(platform, ".venv", "Scripts", "python.exe") : join(platform, ".venv", "bin", "python"),
    // 开发期：仓库根 .venv（<plugin>/../../.venv），依赖全部留在本项目内
    win ? join(pluginDir(), "..", "..", ".venv", "Scripts", "python.exe") : join(pluginDir(), "..", "..", ".venv", "bin", "python"),
    // 同目录放置的配置文件（开发期不想每次填设置时用）
    readPythonFromConfig(),
  ].filter((value) => typeof value === "string" && value.trim());
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      state.log(`[autotest] python: ${candidate}`);
      return candidate;
    }
  }
  // 都没命中时给出"期望路径"，启动会失败但在日志里说得清
  const expected = candidates[0] || (win ? join(platform, ".venv", "Scripts", "python.exe") : join(platform, ".venv", "bin", "python"));
  state.log(`[autotest] python runtime not found: ${expected}`);
  return expected;
}

/** `<plugin>/autotest.config.json` → { "pythonPath": "…" }（开发便利，可选） */
function readPythonFromConfig() {
  try {
    const raw = require("node:fs").readFileSync(join(pluginDir(), "autotest.config.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.pythonPath === "string" ? parsed.pythonPath : "";
  } catch {
    return "";
  }
}

function backendUrl(path) {
  return `http://127.0.0.1:${state.port}${path}`;
}

async function api(path, options) {
  const method = options?.method ?? "GET";
  const response = await pi.net.fetch({
    url: backendUrl(path),
    method,
    // 没有 content-type 时 FastAPI 把 JSON 文本当裸 body，带 dict 参数的路由
    // 会直接 422 "Input should be a valid dictionary"。所有写请求都必须带上。
    ...(options?.body === undefined ? {} : { headers: { "content-type": "application/json" } }),
    body: options?.body,
    timeoutMs: 30_000,
  });
  if (response.status >= 400) {
    throw new Error(`backend ${response.status}: ${response.bodyText.slice(0, 300)}`);
  }
  try {
    return JSON.parse(response.bodyText);
  } catch {
    return { raw: response.bodyText };
  }
}

async function healthy() {
  try {
    const body = await api("/api/health");
    return body?.status === "ok" ? body : null;
  } catch {
    return null;
  }
}

/**
 * 后端代码指纹：只哈希"改了就要求重启后端"的那几个文件。
 * 端口上跑的是旧代码时，接手它等于改了提示词却在跑老逻辑。
 */
function codeStamp() {
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const hash = crypto.createHash("sha1");
  const files = [
    join(platformDir(), "src/autotest/api/server.py"),
    join(platformDir(), "src/autotest/pipelines/service.py"),
    join(platformDir(), "src/autotest/pipelines/schedules.py"),
    join(platformDir(), "src/autotest/runtime/watchdog.py"),
  ];
  for (const file of files) {
    try {
      const st = fs.statSync(file);
      hash.update(`${file}:${st.size}:${st.mtimeMs}`);
    } catch {
      hash.update(`${file}:missing`);
    }
  }
  hash.update(join(pluginDir(), "pipeline", "config.mjs"));
  return hash.digest("hex").slice(0, 12);
}

/** 结束占用端口的进程（只在确认它是本插件自己的旧后端之后调用）。 */
async function killPortOwner(port) {
  const { execFileSync } = require("node:child_process");
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell",
        ["-NoProfile", "-Command", `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`],
        { encoding: "utf8" },
      ).trim();
      const pid = Number(out.split(/\s+/).find((part) => /^\d+$/.test(part)));
      if (pid > 0) process.kill(pid);
    } else {
      const out = execFileSync("sh", ["-c", `lsof -ti tcp:${port} -sTCP:LISTEN`], { encoding: "utf8" }).trim();
      for (const line of out.split(/\s+/)) {
        const pid = Number(line);
        if (pid > 0) process.kill(pid);
      }
    }
  } catch (error) {
    state.log(`[autotest] could not free port ${port}: ${error?.message ?? error}`);
  }
}

async function waitHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthy()) return true;
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  return false;
}

async function loadConfig() {
  const settings = (await pi.plugin.getSettings()) || {};
  const port = Number(settings.backendPort);
  state.port = Number.isFinite(port) && port > 0 ? port : 4000;
  state.pythonPath = String(settings.pythonPath ?? "").trim();
  state.e2eHome = String(settings.e2eHome ?? "").trim();
  state.platformDir = join(pluginDir(), "platform");

  const explicitData = String(settings.dataRoot ?? "").trim();
  if (explicitData) {
    state.dataRoot = explicitData;
  } else {
    const dataPath = await pi.plugin.getDataPath();
    state.dataRoot = join(dataPath, "workspace");
  }
  mkdirSync(state.dataRoot, { recursive: true });
  return { autoStart: settings.autoStart !== false };
}

async function startBackend() {
  if (state.child) return;
  await loadConfig();

  const exe = pythonExe();
  if (!existsSync(exe)) {
    state.lastError = `python runtime not found: ${exe}`;
    state.log(`[autotest] ${state.lastError}`);
    return;
  }

  state.stopping = false;
  const stamp = codeStamp();
  const already = await healthy();
  if (already && already.codeStamp === stamp) {
    state.log(`[autotest] reusing the backend already listening on ${state.port} (code ${stamp})`);
    return;
  }
  if (already) {
    // 旧代码的孤儿后端：先收掉，否则新提示词/新规则根本不会生效
    state.log(
      `[autotest] replacing stale backend on ${state.port} ` +
        `(code ${already.codeStamp || "unknown"} -> ${stamp})`,
    );
    await killPortOwner(state.port);
    for (let i = 0; i < 20; i += 1) {
      if (!(await healthy())) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  state.log(`[autotest] starting backend: ${exe} (port ${state.port}, platform ${platformDir()})`);
  const e2eHome = resolveE2eHome();
  const child = spawn(
    exe,
    ["-m", "uvicorn", "autotest.api.server:app", "--host", "127.0.0.1", "--port", String(state.port)],
    {
      cwd: platformDir(),
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        // src-layout: an editable install makes this redundant, a bare copy needs it.
        PYTHONPATH: [join(platformDir(), "src"), process.env.PYTHONPATH].filter(Boolean).join(";"),
        // keep project data outside the plugin package
        AUTOTEST_WORKSPACE: state.dataRoot,
        // 宿主退出时后端要跟着退，否则残留进程占住端口
        AUTOTEST_PARENT_PID: String(process.pid),
        AUTOTEST_CODE_STAMP: stamp,
        // the host may sanitise env, so resolve the e2e runtime here and hand it over
        ...(e2eHome ? { AUTOTEST_E2E_HOME: e2eHome } : {}),
        ...(existsSync(join(pluginDir(), "runner", "run.mjs"))
          ? { AUTOTEST_E2E_RUNNER: join(pluginDir(), "runner", "run.mjs") }
          : {}),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  state.child = child;

  const relay = (chunk) => {
    const text = String(chunk).trimEnd();
    if (text) state.log(`[backend] ${text}`);
  };
  child.stdout?.on("data", relay);
  child.stderr?.on("data", relay);
  child.on("exit", (code, signal) => {
    state.log(`[backend] exited code=${code} signal=${signal}`);
    if (state.child === child) state.child = null;
    // 后端崩了没人接手，面板就会一直"离线"直到用户重开插件：自己重起，带退避。
    if (state.stopping || state.restartTimer) return;
    state.restartAttempts = (state.restartAttempts ?? 0) + 1;
    const delay = Math.min(30000, 1500 * 2 ** Math.min(4, state.restartAttempts - 1));
    state.log(`[autotest] backend exited; restarting in ${delay}ms (attempt ${state.restartAttempts})`);
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      void startBackend().catch((error) => state.log(`[autotest] restart failed: ${error}`));
    }, delay);
  });
  child.on("error", (error) => {
    state.lastError = String(error?.message ?? error);
    state.log(`[backend] spawn failed: ${state.lastError}`);
  });

  const ready = await waitHealthy(HEALTH_TIMEOUT_MS);
  if (ready) state.restartAttempts = 0;
  state.lastError = ready ? "" : "backend did not answer /api/health in time";
  state.log(ready ? `[autotest] backend ready on ${state.port}` : `[autotest] ${state.lastError}`);
}

async function stopBackend() {
  state.stopping = true;
  if (state.restartTimer) {
    clearTimeout(state.restartTimer);
    state.restartTimer = null;
  }
  const child = state.child;
  if (!child) return;
  state.child = null;
  child.kill("SIGTERM");
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.killed) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  child.kill("SIGKILL");
}

function requireProjectId(args) {
  const projectId = String(args?.projectId ?? "").trim();
  if (!projectId) throw new Error("projectId is required");
  return projectId;
}

// ---- pipeline supervisor ---------------------------------------------------
// The panel only writes rows into the backend; this loop is what actually
// advances them, because only the plugin can call the Desktop model
// (`pi.agent.complete`). One pipeline at a time, so model calls never race.

const pipelineState = { timer: null, busy: new Set() };

async function resolveModel() {
  try {
    const context = await pi.session.getLlmContext();
    if (context?.modelKey) {
      return { modelKey: context.modelKey, thinkingLevel: context.thinkingLevel };
    }
  } catch {
    // no active session — fall back to the default ready model
  }
  try {
    const models = await pi.models.list();
    const pick = models.find((model) => model.isDefault) || models[0];
    if (pick) return { modelKey: pick.key };
  } catch {
    // fall through to the explicit error below
  }
  return null;
}

function pipelineClient() {
  return {
    async createPipeline(projectId, body) {
      return api(`/api/projects/${projectId}/pipelines`, { method: "POST", body: JSON.stringify(body) });
    },
    async getPipeline(projectId, pipelineId) {
      return api(`/api/projects/${projectId}/pipelines/${pipelineId}`);
    },
    async listPipelines(projectId) {
      return api(`/api/projects/${projectId}/pipelines`);
    },
    async reportStage(projectId, pipelineId, stage, body) {
      return api(`/api/projects/${projectId}/pipelines/${pipelineId}/stages/${stage}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    async recordCall(projectId, pipelineId, body) {
      return api(`/api/projects/${projectId}/pipelines/${pipelineId}/agent-calls`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    async resume(projectId, pipelineId, action) {
      return api(`/api/projects/${projectId}/pipelines/${pipelineId}/${action}`, { method: "POST" });
    },
    async requirementText(projectId, filename) {
      return api(`/api/projects/${projectId}/requirements/${encodeURIComponent(filename)}/content`);
    },
    async listCases(projectId) {
      return api(`/api/projects/${projectId}/cases`);
    },
    async createCase(projectId, body) {
      return api(`/api/projects/${projectId}/cases`, { method: "POST", body: JSON.stringify(body) });
    },
    async listScripts(projectId) {
      return api(`/api/projects/${projectId}/scripts`);
    },
    async createScript(projectId, body) {
      return api(`/api/projects/${projectId}/scripts`, { method: "POST", body: JSON.stringify(body) });
    },
    async checkScript(projectId, scriptId) {
      return api(`/api/projects/${projectId}/scripts/${scriptId}/gate`, { method: "POST" });
    },
    async scriptContent(projectId, scriptId) {
      return api(`/api/projects/${projectId}/scripts/${scriptId}/content`);
    },
    async saveScript(projectId, scriptId, content) {
      return api(`/api/projects/${projectId}/scripts/${scriptId}/content`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      });
    },
    async runScript(projectId, scriptId) {
      return api(`/api/projects/${projectId}/scripts/${scriptId}/run?background=true`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    },
    async listExecutions(projectId) {
      return api(`/api/projects/${projectId}/executions`);
    },
    async getExecution(projectId, executionId) {
      return api(`/api/projects/${projectId}/executions/${executionId}`);
    },
    async setCaseStatus(projectId, caseId, status) {
      return api(`/api/projects/${projectId}/cases/${caseId}/status`, {
        method: "POST",
        body: JSON.stringify({ status }),
      });
    },
    async readReport(projectId, pipelineId) {
      return api(`/api/projects/${projectId}/pipelines/${pipelineId}/report`);
    },
  };
}

async function advancePipeline(projectId, pipelineId) {
  const model = await resolveModel();
  if (!model) throw new Error("no model available: pick a session model or configure a provider first");
  const { createEngine } = await import("./pipeline/engine.mjs");
  const engine = createEngine({
    api: pipelineClient(),
    log: (message) => state.log(`[pipeline ${pipelineId}] ${message}`),
    complete: async ({ system, prompt }) =>
      pi.agent.complete({ modelKey: model.modelKey, thinkingLevel: model.thinkingLevel, system, messages: [{ role: "user", content: prompt }] }),
  });
  return engine.run(projectId, pipelineId);
}

async function failPipeline(projectId, pipelineId, error) {
  try {
    const stateNow = await api(`/api/projects/${projectId}/pipelines/${pipelineId}`);
    const stage = stateNow?.pipeline?.current_stage;
    if (stage && stateNow?.pipeline?.status === "running") {
      await api(`/api/projects/${projectId}/pipelines/${pipelineId}/stages/${stage}`, {
        method: "POST",
        body: JSON.stringify({ status: "failed", error: String(error?.message ?? error) }),
      });
    }
  } catch (inner) {
    state.log(`[pipeline] could not record failure: ${inner?.message ?? inner}`);
  }
}

async function pumpPipelines() {
  let rows;
  try {
    rows = (await api("/api/pipelines?status=running")).pipelines ?? [];
  } catch {
    return; // backend not up yet
  }
  for (const row of rows) {
    const key = `${row.project_id}:${row.id}`;
    if (pipelineState.busy.has(key)) continue;
    pipelineState.busy.add(key);
    try {
      const result = await advancePipeline(row.project_id, row.id);
      const status = result?.pipeline?.status;
      state.log(`[pipeline ${row.id}] ${status} @ ${result?.pipeline?.current_stage}`);
      if (status === "waiting") {
        await pi.ui.showToast(`Autotest 流水线待确认：${result.pipeline.current_stage}`, "info");
      }
      if (["done", "failed", "cancelled"].includes(status)) {
        await notifyPipelineFinished(row.project_id, row.id, result);
      }
    } catch (error) {
      state.log(`[pipeline ${row.id}] failed: ${error?.message ?? error}`);
      await failPipeline(row.project_id, row.id, error);
    } finally {
      pipelineState.busy.delete(key);
    }
  }
}

// ---- scheduled runs -------------------------------------------------------
// Schedules live in the backend; this loop only asks "what is due" and fires it.
// Firing is a backend call so "create pipeline + advance next_run" stays one
// transaction even if the host dies mid-loop.

const schedulerState = { timer: null, busy: false };
const notified = new Set();

async function pumpSchedules() {
  if (schedulerState.busy) return;
  schedulerState.busy = true;
  try {
    const due = (await api("/api/pipelines/due")).due ?? [];
    for (const row of due) {
      try {
        const fired = await api(`/api/projects/${row.project_id}/schedules/${row.id}/fire`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        state.log(`[schedule ${row.id}] fired → ${fired?.pipeline?.id}`);
        await pi.ui.showToast(`Autotest 计划「${row.name}」已启动`, "info");
      } catch (error) {
        state.log(`[schedule ${row.id}] fire failed: ${error?.message ?? error}`);
      }
    }
  } finally {
    schedulerState.busy = false;
  }
}

function startScheduler() {
  if (schedulerState.timer) return;
  schedulerState.timer = setInterval(() => {
    pumpSchedules().catch((error) => state.log(`[schedule] pump error: ${error?.message ?? error}`));
  }, 30_000);
  pumpSchedules().catch(() => {});
}

function stopScheduler() {
  if (schedulerState.timer) clearInterval(schedulerState.timer);
  schedulerState.timer = null;
}

/** 流水线结束时的汇报：先机械摘要，能拿到模型就再压成两句话。 */
async function notifyPipelineFinished(projectId, pipelineId, result) {
  const pipeline = result?.pipeline;
  if (!pipeline) return;
  const key = `${pipelineId}:${pipeline.status}`;
  if (notified.has(key)) return;
  notified.add(key);

  const judge = [...(result.stages || [])].reverse().find((row) => row.stage === "judge");
  const counts = judge?.output_json?.counts || {};
  const rounds = (result.stages || []).filter((row) => row.stage === "repair").length;
  const headline =
    pipeline.status === "done"
      ? `通过 ${counts.pass ?? 0} / 失败 ${counts.fail ?? 0} / 异常 ${counts.error ?? 0}（修复 ${rounds} 轮）`
      : `结束于 ${pipeline.current_stage}：${(result.stages || []).filter((row) => row.error).map((row) => row.error).join("；") || pipeline.status}`;

  let summary = headline;
  try {
    const report = await api(`/api/projects/${projectId}/pipelines/${pipelineId}/report`);
    const markdown = String(report?.markdown || "");
    if (markdown) {
      const model = await resolveModel();
      if (model) {
        const answer = await pi.agent.complete({
          modelKey: model.modelKey,
          thinkingLevel: model.thinkingLevel,
          system: "你是测试负责人。用中文两句话汇报这次自动化测试结果：结论 + 最需要注意的一条。不要罗列步骤。",
          messages: [{ role: "user", content: markdown.slice(0, 6000) }],
        });
        if (answer?.text?.trim()) summary = answer.text.trim();
      }
    }
  } catch (error) {
    state.log(`[pipeline ${pipelineId}] summary skipped: ${error?.message ?? error}`);
  }

  const title = `Autotest ${pipeline.status === "done" ? "已完成" : "需要关注"}`;
  try {
    await pi.ui.notify({ title, body: summary });
  } catch {
    // notifications may be denied; the toast below still shows it
  }
  await pi.ui.showToast(`${title}：${summary}`, pipeline.status === "done" ? "info" : "warn");
}

function startPipelineSupervisor() {
  if (pipelineState.timer) return;
  pipelineState.timer = setInterval(() => {
    pumpPipelines().catch((error) => state.log(`[pipeline] pump error: ${error?.message ?? error}`));
  }, 2500);
  startScheduler();
}

function stopPipelineSupervisor() {
  if (pipelineState.timer) clearInterval(pipelineState.timer);
  pipelineState.timer = null;
  pipelineState.busy.clear();
  stopScheduler();
}

const TOOLS = [
  {
    name: "platform_status",
    run: async () => ({
      ok: Boolean(await healthy()),
      port: state.port,
      platformDir: platformDir(),
      dataRoot: state.dataRoot,
      pythonPath: pythonExe(),
      pythonFound: state.pythonPath ? existsSync(state.pythonPath) : existsSync(pythonExe()),
      lastError: state.lastError,
    }),
  },
  {
    name: "list_projects",
    run: async (args) => {
      const limit = Number(args?.limit);
      const query = Number.isFinite(limit) ? `?limit=${Math.trunc(limit)}` : "";
      return api(`/api/projects${query}`);
    },
  },
  {
    name: "list_cases",
    run: async (args) => api(`/api/projects/${encodeURIComponent(requireProjectId(args))}/cases`),
  },
  {
    name: "list_executions",
    run: async (args) =>
      api(`/api/projects/${encodeURIComponent(requireProjectId(args))}/executions`),
  },
  {
    name: "list_scripts",
    run: async (args) => api(`/api/projects/${encodeURIComponent(requireProjectId(args))}/scripts`),
  },
  {
    name: "create_script",
    run: async (args) => {
      const projectId = requireProjectId(args);
      const name = String(args?.name ?? "").trim();
      const content = String(args?.content ?? "");
      if (!name) throw new Error("name is required");
      const language = String(args?.language ?? "python");
      return api(`/api/projects/${encodeURIComponent(projectId)}/scripts`, {
        method: "POST",
        body: JSON.stringify({ name, language, content }),
      });
    },
  },
  {
    name: "run_case",
    run: async (args) => {
      const projectId = requireProjectId(args);
      const scriptId = String(args?.scriptId ?? "").trim();
      if (!scriptId) throw new Error("scriptId is required");
      return api(
        `/api/projects/${encodeURIComponent(projectId)}/scripts/${encodeURIComponent(scriptId)}/run?background=true`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
  },
  {
    name: "get_execution",
    run: async (args) => {
      const projectId = requireProjectId(args);
      const executionId = Number(args?.executionId);
      if (!Number.isFinite(executionId)) throw new Error("executionId is required");
      return api(`/api/projects/${encodeURIComponent(projectId)}/executions/${executionId}`);
    },
  },
  {
    name: "cancel_run",
    run: async (args) => {
      const projectId = requireProjectId(args);
      const executionId = Number(args?.executionId);
      if (!Number.isFinite(executionId)) throw new Error("executionId is required");
      return api(`/api/projects/${projectId}/executions/${executionId}/cancel`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    },
  },
  {
    name: "run_pipeline",
    run: async (args) => {
      const projectId = requireProjectId(args);
      const body = {
        requirementFilename: String(args?.requirementFilename ?? "").trim(),
        checkpointPolicy: String(args?.checkpointPolicy ?? "analyze").trim(),
        targetUrl: String(args?.targetUrl ?? "").trim(),
      };
      const created = await api(`/api/projects/${projectId}/pipelines`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return {
        started: true,
        pipelineId: created.pipeline?.id,
        status: created.pipeline?.status,
        checkpointPolicy: created.pipeline?.checkpoint_policy,
        hint: "the plugin supervisor advances it; poll pipeline_status until status is not running",
      };
    },
  },
  {
    name: "pipeline_status",
    run: async (args) => {
      const projectId = requireProjectId(args);
      const pipelineId = String(args?.pipelineId ?? "").trim();
      if (pipelineId) return api(`/api/projects/${projectId}/pipelines/${pipelineId}`);
      return api(`/api/projects/${projectId}/pipelines`);
    },
  },
  {
    name: "pipeline_report",
    run: async (args) => {
      const projectId = requireProjectId(args);
      const pipelineId = String(args?.pipelineId ?? "").trim();
      if (!pipelineId) throw new Error("pipelineId is required");
      return api(`/api/projects/${projectId}/pipelines/${pipelineId}/report`);
    },
  },
  {
    name: "list_schedules",
    run: async (args) =>
      api(`/api/projects/${requireProjectId(args)}/schedules`),
  },
  {
    name: "fire_schedule",
    run: async (args) => {
      const projectId = requireProjectId(args);
      const scheduleId = String(args?.scheduleId ?? "").trim();
      if (!scheduleId) throw new Error("scheduleId is required");
      return api(`/api/projects/${projectId}/schedules/${scheduleId}/fire`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    },
  },
  {
    name: "pipeline_action",
    run: async (args) => {
      const projectId = requireProjectId(args);
      const pipelineId = String(args?.pipelineId ?? "").trim();
      const action = String(args?.action ?? "").trim();
      if (!pipelineId) throw new Error("pipelineId is required");
      if (!["approve", "retry", "cancel"].includes(action)) {
        throw new Error("action must be approve, retry or cancel");
      }
      return api(`/api/projects/${projectId}/pipelines/${pipelineId}/${action}`, {
        method: "POST",
        body: action === "cancel" ? undefined : JSON.stringify({}),
      });
    },
  },
];

async function registerTools() {
  const manifest = pi.plugin.getManifest();
  const declared = manifest?.contributes?.agentTools ?? [];
  for (const entry of declared) {
    const implementation = TOOLS.find((tool) => tool.name === entry.name);
    if (!implementation) continue;
    await pi.agent.registerTool({
      name: entry.name,
      description: entry.description,
      risk: entry.risk ?? "low",
      schema: entry.schema ?? { type: "object", properties: {} },
      execute: async (args) => {
        try {
          return await implementation.run(args);
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) };
        }
      },
    });
  }
}

async function registerCommands() {
  await pi.commands.register({
    id: "autotest.open",
    title: "Autotest: Open Platform",
    keywords: ["autotest", "test", "platform"],
    run: async () => {
      await pi.ui.openPanel({ title: "Autotest" });
    },
  });

  await pi.commands.register({
    id: "autotest.restart-backend",
    title: "Autotest: Restart Backend",
    keywords: ["autotest", "backend", "restart"],
    run: async () => {
      await stopBackend();
      await startBackend();
      await pi.ui.showToast(`Autotest backend: ${state.lastError ? state.lastError : "ready"}`);
    },
  });
}

async function onLoad(ctx) {
  if (typeof ctx?.log === "function") state.log = ctx.log;
  await loadConfig();
  await registerCommands();
  await registerTools();
  await pi.services.register({
    id: "backend",
    start: async (serviceContext) => {
      if (typeof serviceContext?.log === "function") state.log = serviceContext.log;
      await startBackend();
    },
    stop: stopBackend,
  });
  startPipelineSupervisor();
  // 宿主的服务管理器不一定替我们把 backend 起起来（权限待审、服务状态 stopped 时它
  // 只登记不执行）。后端是面板的全部依赖，所以这里自己拉起一次；startBackend 自身
  // 幂等（同 codeStamp 已在跑就复用）。
  void startBackend().catch((error) => state.log(`[autotest] backend start failed: ${error}`));
}

async function onUnload() {
  stopPipelineSupervisor();
  for (const tool of TOOLS) {
    try {
      await pi.agent.unregisterTool(tool.name);
    } catch {
      // tool may not have been registered
    }
  }
  for (const id of ["autotest.open", "autotest.restart-backend"]) {
    try {
      await pi.commands.unregister(id);
    } catch {
      // command may not have been registered
    }
  }
  await stopBackend();
}

module.exports = { onLoad, onUnload };
