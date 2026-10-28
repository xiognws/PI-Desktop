/**
 * Pipeline state machine.
 *
 * Division of labour:
 *   model work   → `complete()`, injected by the plugin (`pi.agent.complete`,
 *                  i.e. the Desktop model the user already has)
 *   rules/audit  → the Python backend (stage order, schema checks, checkpoint
 *                  policy, agent_calls ledger); this file never lets a stage
 *                  advance on its own judgement
 *
 * Every model answer is validated twice: locally (cheap, lets us re-ask within
 * the stage) and by the backend (authoritative). A stage that cannot produce a
 * valid answer ends the run as `failed` — it never falls through to a fake pass.
 */
import { MAX_REPAIR_ROUNDS, RULES, buildPrompt, parseModelJson } from "./config.mjs";

const MAX_STEPS = 40;

export function createEngine({ api, complete, log = () => {} }) {
  async function fetchRequirement(projectId, state) {
    const filename = state.pipeline.requirement_filename;
    if (!filename) return "";
    const answer = await api.requirementText(projectId, filename);
    return String(answer.text ?? "");
  }

  function stageOutput(state, stage) {
    const rows = state.stages.filter((row) => row.stage === stage && row.status === "done");
    return rows.length ? rows[rows.length - 1].output_json || {} : {};
  }

  async function buildContext(projectId, state, stage) {
    const pipeline = state.pipeline;
    if (stage === "analyze") {
      return {
        requirementFilename: pipeline.requirement_filename,
        requirementText: await fetchRequirement(projectId, state),
      };
    }
    if (stage === "design") {
      return { functionPoints: stageOutput(state, "analyze").function_points || [] };
    }
    if (stage === "repair") {
      const judge = stageOutput(state, "judge");
      const failing = (judge.results || []).filter((item) => item.verdict !== "pass");
      const scripts = await scriptsOfThisRun(projectId, state);
      const failures = [];
      for (const item of failing) {
        const script = scripts.find((row) => row.id === item.scriptId);
        if (!script) continue;
        const content = await api.scriptContent(projectId, script.id);
        failures.push({
          scriptId: script.id,
          scriptName: script.name,
          caseTitle: item.caseTitle,
          verdict: item.verdict,
          failure: item.reason || "（没有失败输出）",
          content: String(content.content || ""),
        });
      }
      return { targetUrl: pipeline.target_url || "", failures, round: resolvedRound(state) + 1 };
    }
    if (stage === "author") {
      const cases = (await api.listCases(projectId)).cases || [];
      const designed = stageOutput(state, "design").cases || [];
      const titles = new Set(designed.map((item) => item.title));
      return {
        targetUrl: pipeline.target_url || "",
        cases: cases
          .filter((item) => titles.size === 0 || titles.has(item.title || item.name))
          .map((item) => ({
            title: item.title || item.name,
            steps: item.steps,
            expected: item.expected,
            priority: item.priority,
          })),
      };
    }
    return {};
  }

  async function applyDesign(projectId, stageRow) {
    const wanted = (stageRow.output_json?.cases || []).slice();
    const existing = (await api.listCases(projectId)).cases || [];
    const known = new Set(existing.map((item) => item.title || item.name));
    const created = [];
    for (const item of wanted) {
      if (known.has(item.title)) continue;
      const saved = await api.createCase(projectId, {
        name: item.title,
        type: item.case_type || "功能",
        module: item.function_point || "",
        steps: item.steps,
        expected: item.expected,
        priority: item.priority || "中",
        status: "未执行",
      });
      known.add(item.title);
      created.push(saved.id);
      log(`用例已创建：${item.title} → ${saved.id}`);
    }
    return { created };
  }

  /**
   * 已知且确定的 import 错误不必让整轮执行报废：
   * `@e2e-dev/web` 只导出 test，expect 必须来自 "e2e"。模型经常写错，
   * 这里做一次**确定性改写**（不是猜），并把改写记录到日志，gate 仍然兜底。
   */
  function normalizeE2eImports(content) {
    if (!content.includes("@e2e-dev/web")) return { content, changed: false };
    const lines = content.split("\n");
    let changed = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!/from\s+["']@e2e-dev\/web["']/.test(line)) continue;
      const named = /import\s*\{([^}]*)\}\s*from/.exec(line);
      if (!named) continue;
      const names = named[1].split(",").map((item) => item.trim()).filter(Boolean);
      if (!names.some((item) => item === "expect")) continue;
      const kept = names.filter((item) => item !== "expect");
      lines[i] = kept.length
        ? line.replace(named[0], `import { ${kept.join(", ")} } from`)
        : `// removed empty import from @e2e-dev/web`;
      if (!lines.some((row) => /import\s*\{[^}]*expect[^}]*\}\s*from\s+["']e2e["']/.test(row))) {
        lines.splice(i + 1, 0, 'import { expect } from "e2e";');
      }
      changed = true;
    }
    return { content: lines.join("\n"), changed };
  }

  async function applyAuthor(projectId, state, stageRow) {
    const scripts = stageRow.output_json?.scripts || [];
    const cases = (await api.listCases(projectId)).cases || [];
    const caseIdByTitle = new Map(cases.map((item) => [item.title || item.name, item.id]));
    const existing = (await api.listScripts(projectId)).scripts || [];
    const known = new Set(existing.map((item) => item.name));
    const created = [];
    for (const script of scripts) {
      if (known.has(script.name)) continue;
      if (script.language === "e2e") {
        const fixed = normalizeE2eImports(script.content);
        if (fixed.changed) {
          script.content = fixed.content;
          log(`已修正 ${script.name} 的 import：expect 移到 "e2e"`);
        }
      }
      const saved = await api.createScript(projectId, {
        name: script.name,
        language: script.language,
        content: script.content,
        case_id: caseIdByTitle.get(script.case_title) || "",
      });
      known.add(script.name);
      created.push(saved.id);
      log(`脚本已创建：${script.name} → ${saved.id}`);
    }
    return { created };
  }

  async function applyGate(projectId, state) {
    const authored = new Set(
      (stageOutput(state, "author").scripts || []).map((item) => item.name),
    );
    const all = (await api.listScripts(projectId)).scripts || [];
    // 只检查这条流水线产出的脚本；项目里历史遗留的坏脚本不该拖垮本次运行
    const scoped = authored.size ? all.filter((item) => authored.has(item.name)) : all;
    const failures = [];
    let checked = 0;
    for (const script of scoped) {
      const result = await api.checkScript(projectId, script.id);
      checked += 1;
      for (const failure of result.failures || []) failures.push(`${script.name}：${failure}`);
    }
    return { ok: failures.length === 0, failures, checked };
  }

  const VERDICT_BY_STATUS = {
    已完成: "pass",
    失败: "fail",
    异常: "error",
    已取消: "cancelled",
  };

  function authoredNames(state) {
    return new Set((stageOutput(state, "author").scripts || []).map((item) => item.name));
  }

  async function scriptsOfThisRun(projectId, state) {
    const names = authoredNames(state);
    const all = (await api.listScripts(projectId)).scripts || [];
    return all.filter((item) => names.has(item.name));
  }

  function durationOf(detail, row) {
    const events = detail?.events || [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.type === "run.end" && event.durationMs !== undefined) return Number(event.durationMs);
      if (event.type === "case.end" && event.durationMs !== undefined) return Number(event.durationMs);
    }
    return Number(row?.duration_ms || 0);
  }

  function artifactsOf(detail) {
    return (detail?.events || [])
      .filter((event) => event.type === "artifact")
      .map((event) => ({ kind: String(event.kind || "log"), path: String(event.path || "") }))
      .filter((item) => item.path);
  }

  function failureOf(detail) {
    const events = detail?.events || [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].type === "case.end" && events[index].failure) return String(events[index].failure);
    }
    return "";
  }

  async function waitExecution(projectId, scriptName, afterId) {
    const rule = RULES.execute;
    for (let attempt = 0; attempt < rule.pollLimit; attempt += 1) {
      const rows = (await api.listExecutions(projectId)).executions || [];
      const match = rows
        .filter((row) => row.name === scriptName && row.id > afterId && row.status !== "执行中")
        .sort((a, b) => b.id - a.id)[0];
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, rule.pollMs));
    }
    throw new Error(`执行超时：${scriptName} 在 ${(rule.pollLimit * rule.pollMs) / 1000}s 内没有结束`);
  }

  async function runExecute(projectId, state) {
    const scripts = await scriptsOfThisRun(projectId, state);
    if (!scripts.length) throw new Error("没有可执行的脚本（author 阶段没有产出）");
    const executions = [];
    for (const script of scripts) {
      const before = (await api.listExecutions(projectId)).executions || [];
      const maxId = before.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0);
      log(`执行 ${script.name}…`);
      await api.runScript(projectId, script.id);
      const row = await waitExecution(projectId, script.name, maxId);
      const detail = await api.getExecution(projectId, row.id);
      const verdict = VERDICT_BY_STATUS[row.status] || "error";
      executions.push({
        scriptId: script.id,
        scriptName: script.name,
        caseId: script.case_id || "",
        executionId: row.id,
        status: verdict,
        durationMs: durationOf(detail, row),
        failure: verdict === "pass" ? "" : failureOf(detail),
        artifacts: artifactsOf(detail),
        counts: {
          pass: Number(row.passed || 0),
          fail: Number(row.failed || 0),
          skip: 0,
        },
      });
      log(`  ${script.name} → ${verdict} (execution ${row.id})`);
    }
    return { executions };
  }

  async function runJudge(projectId, state) {
    const runs = stageOutput(state, "execute").executions || [];
    if (!runs.length) throw new Error("judge 没有可判定的执行记录");
    const cases = (await api.listCases(projectId)).cases || [];
    const titleById = new Map(cases.map((item) => [item.id, item.title || item.name]));
    const results = runs.map((run) => ({
      scriptId: run.scriptId,
      scriptName: run.scriptName,
      caseId: run.caseId,
      caseTitle: titleById.get(run.caseId) || run.scriptName,
      verdict: run.status,
      reason: run.failure || "",
      durationMs: run.durationMs,
    }));
    const counts = { pass: 0, fail: 0, error: 0, cancelled: 0 };
    for (const item of results) counts[item.verdict] += 1;
    // 用例状态回写（执行结束时后端已写一次，这里是幂等兜底）
    for (const item of results) {
      if (!item.caseId) continue;
      const text = { pass: "通过", fail: "失败", error: "异常", cancelled: "已取消" }[item.verdict];
      try {
        await api.setCaseStatus(projectId, item.caseId, text);
      } catch (error) {
        log(`用例状态回写失败 ${item.caseId}: ${error.message || error}`);
      }
    }
    return { results, counts };
  }

  async function applyRepair(projectId, state, stageRow, round) {
    const patched = stageRow.output_json?.patched || [];
    if (!patched.length) throw new Error("repair 没有返回任何补丁");
    const saved = [];
    for (const item of patched) {
      const content = String(item.content || "");
      if (!content.trim()) throw new Error(`补丁缺少 content：${item.scriptName || item.scriptId}`);
      await api.saveScript(projectId, item.scriptId, content);
      saved.push({ scriptId: item.scriptId, scriptName: item.scriptName, note: item.note || "" });
      log(`已修复 ${item.scriptName || item.scriptId}（第 ${round} 轮）：${item.note || ""}`);
    }
    return { patched: saved, round };
  }

  function resolvedRound(state) {
    return state.stages.filter((row) => row.stage === "repair" && row.status === "done").length;
  }

  async function buildReport(projectId, pipelineId, state) {
    const points = stageOutput(state, "analyze").function_points || [];
    const cases = stageOutput(state, "design").cases || [];
    const judge = stageOutput(state, "judge");
    const runs = stageOutput(state, "execute").executions || [];
    const repairs = state.stages.filter((row) => row.stage === "repair" && row.status === "done");
    const rounds = repairs.length;
    const counts = judge.counts || { pass: 0, fail: 0, error: 0, cancelled: 0 };

    for (const item of judge.results || []) {
      if (item.verdict === "pass") {
        const evidence = runs.find((run) => run.scriptId === item.scriptId);
        if (!evidence || !evidence.executionId) {
          throw new Error(`用例 ${item.caseTitle} 判为通过但没有执行证据，拒绝生成报告`);
        }
      }
    }

    // 证据要跨轮：修复前的失败截图是这轮修复的依据，不能因为最后一轮通过就消失
    const roundsOfRuns = state.stages
      .filter((row) => row.stage === "execute" && row.status === "done")
      .sort((a, b) => a.attempt - b.attempt)
      .map((row) => ({ attempt: row.attempt, executions: row.output_json?.executions || [] }));

    const artifactLines = [];
    const seenArtifacts = new Set();
    for (const round of roundsOfRuns) {
      for (const run of round.executions) {
        for (const artifact of run.artifacts || []) {
          const normalized = String(artifact.path).replace(/\\/g, "/");
          const key = normalized.split("/").slice(-3).join("/");
          if (seenArtifacts.has(key)) continue;
          seenArtifacts.add(key);
          artifactLines.push(
            `- 第 ${round.attempt} 轮 \`${run.scriptName}\` ${artifact.kind}：${artifact.path}`,
          );
        }
      }
    }

    const rows = (judge.results || []).map((item) => {
      const run = runs.find((entry) => entry.scriptId === item.scriptId) || {};
      const verdict = { pass: "通过", fail: "失败", error: "异常", cancelled: "已取消" }[item.verdict];
      const reason = (item.reason || "").replace(/\|/g, "\\|").slice(0, 160);
      return `| ${item.caseTitle} | ${item.scriptName} | ${verdict} | ${Math.round(item.durationMs || 0)}ms | #${run.executionId ?? "-"} | ${reason || "-"} |`;
    });

    const coverage = points
      .map((point) => {
        const owned = cases.filter((item) => (item.function_point || "") === point.name);
        return `- ${point.name}${point.module ? `（${point.module}）` : ""}：${owned.length} 条用例`;
      })
      .join("\n");

    const failedList = (judge.results || []).filter((item) => item.verdict !== "pass");
    const verdictLine = failedList.length
      ? `**未通过**：通过 ${counts.pass}，失败 ${counts.fail}，异常 ${counts.error}，取消 ${counts.cancelled}`
      : `**全部通过**：通过 ${counts.pass} 条`;

    const markdown = [
      `# 测试报告 · ${state.pipeline.requirement_filename || "未命名需求"}`,
      "",
      `- 流水线：${pipelineId}`,
      `- 模型：${state.pipeline.model_key || "会话模型"}`,
      `- 被测地址：${state.pipeline.target_url || "未指定"}`,
      `- 修复轮次：${rounds} / ${MAX_REPAIR_ROUNDS}`,
      "",
      "## 结论",
      "",
      verdictLine,
      "",
      "## 用例结果",
      "",
      "| 用例 | 脚本 | 结论 | 耗时 | 执行 | 失败原因 |",
      "| --- | --- | --- | --- | --- | --- |",
      ...(rows.length ? rows : ["| （无用例） | - | - | - | - | - |"]),
      "",
      "## 需求覆盖",
      "",
      coverage || "- 需求分析没有产出功能点",
      "",
      "## 证据",
      "",
      ...(roundsOfRuns.length
        ? roundsOfRuns.flatMap((round) =>
            round.executions.map(
              (run) =>
                `- 第 ${round.attempt} 轮 \`${run.scriptName}\` → execution #${run.executionId}（${run.status}，${Math.round(run.durationMs || 0)}ms）${run.failure ? `：${run.failure.slice(0, 120)}` : ""}`,
            ),
          )
        : ["- 没有执行记录"]),
      ...(artifactLines.length ? ["", "## 产物", "", ...artifactLines] : []),
      ...(rounds
        ? [
            "",
            "## 修复记录",
            "",
            ...repairs.map((row, index) => {
              const patched = (row.output_json?.patched || [])
                .map((item) => `${item.scriptName || item.scriptId}（${item.note || "未说明"}）`)
                .join("、");
              return `- 第 ${index + 1} 轮：${patched || "无"}`;
            }),
          ]
        : []),
      "",
    ].join("\n");

    return { name: `${state.pipeline.requirement_filename || "测试"} 测试报告`, markdown, counts };
  }

  async function runStage(projectId, pipelineId, state) {
    const stage = state.pipeline.current_stage;
    const rule = RULES[stage];
    if (!rule) throw new Error(`unknown stage: ${stage}`);

    // Deterministic stages: no model involved (rules and processes only).
    if (stage === "gate") {
      const output = await applyGate(projectId, state);
      await api.reportStage(projectId, pipelineId, stage, { status: "done", output });
      return api.getPipeline(projectId, pipelineId);
    }
    if (stage === "execute") {
      const output = await runExecute(projectId, state);
      await api.reportStage(projectId, pipelineId, stage, { status: "done", output });
      return api.getPipeline(projectId, pipelineId);
    }
    if (stage === "judge") {
      const output = await runJudge(projectId, state);
      await api.reportStage(projectId, pipelineId, stage, { status: "done", output });
      return api.getPipeline(projectId, pipelineId);
    }
    if (stage === "report") {
      const output = await buildReport(projectId, pipelineId, state);
      await api.reportStage(projectId, pipelineId, stage, { status: "done", output });
      return api.getPipeline(projectId, pipelineId);
    }

    const context = await buildContext(projectId, state, stage);
    if (stage === "analyze" && !context.requirementText.trim()) {
      await api.reportStage(projectId, pipelineId, stage, {
        status: "failed",
        error: "需求文档为空，无法分析",
      });
      return api.getPipeline(projectId, pipelineId);
    }

    let lastError = "";
    for (let attempt = 1; attempt <= rule.maxAttempts; attempt += 1) {
      const { system, prompt } = buildPrompt(stage, context);
      const promptWithHint = lastError
        ? `${prompt}\n\n上一次的回答被规则拒绝：${lastError}\n请修正并重新输出完整 JSON。`
        : prompt;
      log(`${rule.label} 第 ${attempt}/${rule.maxAttempts} 次调用模型…`);
      const answer = await complete({ stage, system, prompt: promptWithHint });
      const parsed = parseModelJson(answer.text);
      if (!parsed) {
        lastError = "回答不是合法 JSON";
        await api.recordCall(projectId, pipelineId, {
          stage,
          modelKey: answer.modelKey || "",
          prompt: promptWithHint,
          output: answer.text || "",
          tokensIn: answer.usage?.inputTokens ?? 0,
          tokensOut: answer.usage?.outputTokens ?? 0,
          accepted: false,
          reason: lastError,
        });
        continue;
      }
      let reported;
      try {
        reported = await api.reportStage(projectId, pipelineId, stage, {
          status: "done",
          output: parsed,
          tokensIn: answer.usage?.inputTokens ?? 0,
          tokensOut: answer.usage?.outputTokens ?? 0,
        });
      } catch (error) {
        lastError = String(error.message || error);
        await api.recordCall(projectId, pipelineId, {
          stage,
          modelKey: answer.modelKey || "",
          prompt: promptWithHint,
          output: answer.text || "",
          tokensIn: answer.usage?.inputTokens ?? 0,
          tokensOut: answer.usage?.outputTokens ?? 0,
          accepted: false,
          reason: lastError,
        });
        continue;
      }
      await api.recordCall(projectId, pipelineId, {
        stage,
        modelKey: answer.modelKey || "",
        prompt: promptWithHint,
        output: answer.text || "",
        tokensIn: answer.usage?.inputTokens ?? 0,
        tokensOut: answer.usage?.outputTokens ?? 0,
        accepted: true,
        reason: "",
      });

      const doneRow = (reported.stages || [])
        .filter((row) => row.stage === stage && row.status === "done")
        .pop();
      if (stage === "design" && doneRow) await applyDesign(projectId, doneRow);
      if (stage === "author" && doneRow) await applyAuthor(projectId, reported, doneRow);
      if (stage === "repair" && doneRow) {
        await applyRepair(projectId, reported, doneRow, resolvedRound(reported));
      }
      return reported;
    }

    await api.reportStage(projectId, pipelineId, stage, {
      status: "failed",
      error: lastError || "模型未在重试上限内给出合规输出",
    });
    return api.getPipeline(projectId, pipelineId);
  }

  /** Run until the pipeline pauses for approval, finishes or fails. */
  async function run(projectId, pipelineId, { maxSteps = MAX_STEPS } = {}) {
    let state = await api.getPipeline(projectId, pipelineId);
    for (let index = 0; index < maxSteps; index += 1) {
      const status = state.pipeline.status;
      if (status !== "running") return state;
      state = await runStage(projectId, pipelineId, state);
    }
    return state;
  }

  return { run, runStage };
}
