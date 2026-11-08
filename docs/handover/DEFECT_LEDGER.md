# Pi-Workspace 全功能测试 — 缺陷台账（Lead 工作稿）

Task candidate: test/full-feature-verification (worktree F:\PI-Desktop-worktrees\full-feature-verification)
Base main: origin/main @ 3c7939404
Environment: Windows 10/11 x64, Node v24.16.0, pnpm 12.8.1, rustc 1.99.1 (58cf8f9c3 2026-10-13),
Electron 二进制由 apps/desktop/node_modules/electron/install.js 补齐。

## 判定口径
- (a) 产品缺陷 — 仓库代码在受支持平台上确实错误。
- (b) 环境/测试隔离 — 本机特有的路径拼写、缺失外部工具、平台设计性不支持；CI 上有权限/工具时通常为绿。
- (c) flaky — 同一命令重复运行结果不稳定。

---

## 一、(a) 产品缺陷

### A1. Windows/PowerShell 下工具 stdout 的流式通知完全缺失（tools.output）
**证据（确定性复现）**
```
# 探针：Host → session.create → session.configure → tools.execute
command = "[Console]::Out.WriteLine('e2e114-stdout'); [Console]::Error.WriteLine('e2e114-stderr')"
fast 命令，等待 50 / 500 / 2000 ms 三次
wait=50   | notifications=0 [] | content.stdout="e2e114-stdout\r\n"
wait=500  | notifications=0 [] | content.stdout="e2e114-stdout\r\n"
wait=2000 | notifications=0 [] | content.stdout="e2e114-stdout\r\n"
```
等待到 2 秒仍为 0 条，排除"延迟到达"。

对照（慢命令）：
```
stdout-slow  (5 行 Write-Output, 每行间隔 120ms) | notifications=1 {"stdout":1}
mixed-slow   (6 行 stdout + 6 行 stderr, 每行间隔 120ms) | notifications=6 {"stderr":5,"stdout":1}
```
即：**stdout 从不真正流式**（只在结束时合并成 1 个 chunk），stderr 才会流式；而快速命令连这 1 个
chunk 也没有。

**影响**
- 用户/模型看不到长命令的 stdout 进度；Windows 上只有 stderr 有进度。
- 快速命令零通知 → 依赖流式反馈的 UI 行为空。
- 直接导致仓库自带 E2E 用例失败：`scripts/e2e-plan.mjs:814-818` 的 E2E-114 断言
  `assert(output.some(n => n.params.stream === "stdout"), shortJson(output))` 失败，detail 为 `[]`。

**相关代码**
- `crates/host-core/src/tools/mod.rs:2715-2733` `OutputNotifier::push`：仅当
  `pending.len() >= OUTPUT_NOTIFICATION_MAX_CHUNK_BYTES(16KB)` 或
  `last_emit.elapsed() >= OUTPUT_NOTIFICATION_INTERVAL(100ms)` 时 flush。
- `crates/host-core/src/tools/mod.rs:2775-2787` `finish()` / `:2789-2795` `flush_due()`。
- `crates/host-core/src/tools/mod.rs:3240-3253` 主 select!：`waited = &mut wait_task` 直接
  `break BashStop::Exited`；`output_tick.tick()` 才调 `flush_due()`。
- `crates/host-core/src/tools/mod.rs:3290-3292` 结束后 `notifier.push(Stdout, stdout.finish())` +
  `notifier.finish()`。
- `crates/host-core/src/tools/shell.rs:221-235` PowerShell 包装脚本：`& { <command> } 2>&1 |
  ForEach-Object {...} | Out-String -Stream | ForEach-Object { [Console]::Out.WriteLine($_) }`。
  `Out-String -Stream` 在管道末端才输出，是 stdout 无法边跑边流的结构性原因。

### A2. Windows/PowerShell 下 `[Console]::Error` 输出会随机丢失或重复（数据完整性）
**证据（同一条命令连续三次）**
```
command = "[Console]::Out.WriteLine('e2e114-stdout'); [Console]::Error.WriteLine('e2e114-stderr')"
wait=50   | content.stderr = ""                                              (丢失)
wait=500  | content.stderr = "e2e114-stderr\r\ne2e114-stderr\r\n"         (重复)
wait=2000 | content.stderr = "e2e114-stderr\r\n"                           (正确)
```
另一组矩阵（同一 host 进程内连续执行）：
```
fast-verbatim    | errCount=1
fast-verbatim-2  | errCount=1
fast-verbatim-3  | errCount=1
slow-400         | errCount=1
slow-200         | errCount=0   ← 丢失
writeout-then-err| errCount=1
```
**影响**：`content.stderr` 是模型与用户看到的权威文本。丢失会掩盖错误信息；重复会误导（看起来像
命令打印了两次）。对**失败的**命令尤其危险——失败原因正好在 stderr。
**已验证不是包装脚本自身的问题**：把同一包装脚本在 host 之外用 `spawn("powershell.exe", args)`
直接跑，stdout/stderr 各恰好 1 次，无重复无丢失。

### A3. `check-architecture` 在干净 main 上失败（架构预算门禁红）
```
node scripts/check-architecture.mjs   → NODE_EXIT=1
Architecture check failed
  crates/host-core/src/tools/shell_session.rs (1370 LOC) exceeds the Rust limit
  crates/host-core/src/db/migrations.rs (1328 LOC) exceeds the Rust limit
  crates/host-core/src/user_skills/tests.rs (1314 LOC) exceeds the Rust limit
```
Rust 上限 1000 LOC，豁免名单 `docs/architecture/allowlist.json` 共 10 条，均不包含这三个文件。
该规则（`scripts/check-architecture.mjs:169-179`）扫描**全部**被跟踪源文件，与 base 无关，因此
CI 的 `js` job（`.github/workflows/ci.yml:51-54`）在 ubuntu-latest 上同样会红。
主 checkout F:\PI-Desktop 复现一致 → 非 worktree 特有。

### A4. CI 完全没有 Windows runner（缺陷漏检的根因）
`.github/workflows/ci.yml`：`js` job `runs-on: ubuntu-latest`（:22），`rust` job
`runs-on: ubuntu-latest`（:64），E2E job 全部 `xvfb-run`（:175/:178/:192/:196）。
而本项目是**桌面端产品，Windows 是主要目标平台**。A1/A2 这类 PowerShell 路径缺陷在 CI 中不可见。

---

## 二、(a) 仓库卫生缺陷（低危，但污染 git status）

### H1. 测试产物未加 .gitignore
| 路径 | 产生者 | git check-ignore |
| --- | --- | --- |
| `.artifacts/` | `e2e-storage-backup-lock.mjs:11-12`、`e2e-storage-files.mjs:11-12`、`e2e-storage-directory.mjs:12-14` | 未忽略 |
| `history-loading-*/` | `scripts/e2e-transcript-history-loading.mjs:14`：`mkdtemp(join(process.env.PI_SCRATCH_DIR ?? root, "history-loading-"))` —— `PI_SCRATCH_DIR` 未设置时 `root` 是**仓库根** | 未忽略 |
| `apps/desktop/.fallback-ui-*/` | Electron fallback UI 构建 | 未忽略 |
| `apps/desktop/resources/plugins/{pi.todo,pi.gitlens,pi.token-insights,io.github.muzimu217.vision-kit}/package.json` | 插件宿主 `ensureCommonJsPackage` 写入 | 未忽略（`.gitignore:96-101` 只覆盖了 `pi.prompt-enhancement`） |

`history-loading-*` 里是 15MB 的 `renderer.js` bundle；套件在 `finally` 里 `rm`，但这次子进程
先崩溃（EXIT=1）所以留下了。

---

## 三、(b) 环境/测试隔离

### B1. 8.3 短路径族（本机 TEMP 是 `C:\Users\ADMINI~1\AppData\Local\Temp`）
受影响：`crates/host-core/src/rpc/review_rpc_tests.rs:634`、
`crates/host-core/src/tools/shell_session_tests.rs:464`、`scripts/e2e-smoke.mjs` 的 PROJECT-delete 场景、
`scripts/e2e-trusted-extensions.mjs`、`scripts/e2e-capability-move.mjs`、
`packages/agent-runtime/src/native-pi-session.test.ts`（24 例连败，根因在
`node_modules/@earendil-works/pi-coding-agent@1.4.0/dist/core/trust-manager.js:151-161`：`homedir()` 返长名、
`realpathSync` 不展开 8.3，两拼写不等 → 用户级 `~/.agents/skills` 的豁免失效）。
**决定性实验**：把 `TEMP/TMP` 设为长拼写 `C:\Users\Administrator\AppData\Local\Temp` 后，smoke
从 21/23 变为 **23/23 PASS，EXIT=0**。

### B2. 本机缺外部工具
- `ffmpeg` 缺失 → `test:e2e:startup-animation` 无法生成夹具视频。
- `objdump`/`readelf` 缺失 + 无 `target/release` → `check-linux-host-glibc` 无法运行。
- npm 只有 `npm.cmd`（裸 spawn ENOENT，无 shell EINVAL）→ `plugin-import-deps` 失败。

### B3. 本机无法创建符号链接（非管理员）
`apps/pi-host` 的 42 个失败中主导信号是
`Error: EPERM: operation not permitted, symlink '<src>' -> '<dst>'`
（`src/plugin-workspace-files.test.ts:154`、`src/workspace-files.test.ts:25/31/54`、
`src/workspace-tools.test.ts:17`）。实测 `New-Item -ItemType SymbolicLink` 需管理员权限。

### B4. 设计性不支持 Windows
`scripts/e2e-subagents.mjs:44-49` 显式抛出："Subagent registry E2E requires Linux/macOS HOME
isolation; Windows known-folder lookup ignores the fixture HOME."

### B5. 远程数据问题
`scripts/check-marketplace-catalog.mjs:202` 报 32 条 `author` 是对象而非字符串。数据来自
`https://raw.githubusercontent.com/AIUO-Net/pi-desktop-plugins/main/catalog.json`，本地无法修。

### B6. 套件自带超时过紧
- `scripts/e2e-storage-settings.mjs:65` `setTimeout(() => child.kill("SIGKILL"), 30_000)`，本机实测
  `ELAPSED_MS=35387`，子进程被杀（`code=null`）。把上限改 120s 后 5/5 检查全绿。
- `packages/host-runtime/src/workspace-diff.test.ts:31/:90` `Error: Test timed out in 5000ms` +
  清理期 `EBUSY`。
- `packages/agent-runtime/src/shell-command-gate.runtime.test.ts` 2 例同样 5000ms 超时。

---

## 四、(c) flaky

### C1. transcript hide 顺序污染
`scripts/e2e/transcript-history-navigation.tsx:255` 在完整 8 腿 lifecycle 序列下失败
（`hide reversed accepted latest`，top=1408 / sh=3359 / ch=655），但**孤立跑必绿**，前置 3 腿时也绿。
分层实验（[complete,hide]、[growth,hide]、[press,hide]、[interrupt,hide]、[+unmount]、[+new-search]）
全部 PASS。
**待确认的产品侧机制（未定论）**：`jumpToLatest`（`useTranscriptScroll.ts:765-780`）先
`pinnedRef.current = true` 再 `rememberReadingPosition()`，而
`use-transcript-reading-position.ts:62` 的 `remember()` 在 `pendingRef.current` 有值时会**早退**，
于是保存下来的仍是旧的 `pinned:false` bookmark；面板可见后
`transcriptRevealOwnership`（`lib/transcript-reading-position.ts:39-46`）返回 `"reading-position"`，
`useTranscriptScroll.ts:319-322` 把 `pinnedRef` 置回 false 并 return，不再底部定位。

### C2. E2E 环境敏感 flaky
- `test:e2e:three-column-layout` 的 `the expanded sidebar auto-collapses at the threshold` 在并发负载下
  失败、清环境重跑 PASS（main=450 panel=750）。
- `plugins/dark toggle-sidebar shares the rendered 28px chrome target` 等 4 例同样清环境后转 PASS。
- 根因之一：本机 pwsh 环境注入 `ELECTRON_RUN_AS_NODE=1`，未清除时 Electron 以 Node 模式启动
  （无窗口/无 CDP target）。**所有 Electron E2E 必须先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`**。

---

## 五、测试侧陈旧断言（非产品缺陷，但应修）

### T1. `.model-default-row button` 选择器过期
`scripts/e2e/provider-order.tsx:169`。commit `7e367e6f1`（feat(composer): inherit recent chat models）
把聊天默认模型选择搬到 composer，该 class 现仅存于
`apps/desktop/src/components/settings/ImageGenerationModelRow.tsx:74`。169 行之前的拖拽排序断言全部 PASS。

### T2. `hasOtherModels` 门控导致选择器恒不存在
`scripts/e2e-scheduled.mjs:252` `Cannot read properties of null (reading 'click')`。
`apps/desktop/src/features/chat/composer/ComposerModelList.tsx:86` 与
`useComposerModelMenu.ts:343/:172`：`hasOtherModels = showRecents && remainingGroups.length > 0`，
`showRecents = !queryNeedle && recentEntries.length > 0`（门控由 `4a0c49915` 引入）。
套件从不 seed `recentModels`，且用全新 `--user-data-dir` → 恒 false。2 轮 100% 复现。

### T3. `capability-move` fixture 自相矛盾
`scripts/e2e-capability-move.mjs:288-291` 用 `name: "Review"`，撞上
`crates/host-core/src/user_skills.rs:1094-1105` 的近似去重守卫
（`skill_ids_overlap` :386 / `skill_tokens` :365，守卫注释 :380 就以 "review beside code-review" 为例）
→ `SKILL_INVALID: 'Review' overlaps existing skill 'code-review'`，级联导致后续 mcp-move 失败。
同文件 `:176` 用反斜杠路径比对 `projectPath`，而 host 按设计归一化为正斜杠
（`crates/host-core/src/db/repositories.rs:20`）。

### T4. 清理期崩溃掩盖真实失败
`EPERM, Permission denied: \\?\C:\...\Temp\pi-desktop-mcp-e2e-data-*` ——
`scripts/e2e-mcp-market.mjs:340` / `scripts/e2e-skill-market.mjs:270` /
`scripts/e2e-capability-move.mjs:377` 在 `rmSync` 数据目录时 host 子进程仍持有句柄。

### T5. 跨平台模拟缺陷
`scripts/e2e-three-column-layout.mjs:893-895` 的 `rightClear` 恒 false：套件在 `:914-922` 通过
`document.documentElement.dataset.platform` 模拟 darwin，但真实窗口仍渲染 `.window-controls`；
darwin 侧右预留为 0（`apps/desktop/src/styles/chrome.css:944-952` 只调 `--window-side-inset`）→
header 撑到 1200。测试侧缺陷，非产品缺陷。

### T6. market 套件写真实用户目录
`scripts/e2e-mcp-market.mjs:66-73` 只设 `HOME` + `PI_DESKTOP_DATA_DIR`，未设
`PI_DESKTOP_AGENTS_DIR`。host 侧
`crates/host-core/src/agent_capabilities.rs:262` `pub const AGENTS_DIR_ENV: &str = "PI_DESKTOP_AGENTS_DIR"`，
`:264-271` 优先该变量 → 记录落到 `C:\Users\Administrator\.agents\` 而断言读
`<tempHome>/.agents/...`（`mcp-market.mjs:271,298,323`；`skill-market.mjs:250-256`）。
对照 `scripts/e2e-capability-move.mjs:77` 正确设置了该变量。

### T7. `npm-registry-proxy` teardown 未处理 socket error
`apps/desktop/electron/main/npm-registry-proxy.ts:77-81` `closeServer` 在 finally 中
`for (const socket of sockets) socket.destroy();`；`:62-75` `handleConnect` 建
`upstream = connect(...)` 后 `client.pipe(upstream).pipe(client)`，仅 `:74`
`upstream.on("error", () => client.destroy())`（client 侧无 error 监听）→ 销毁仍活隧道 socket 触发
未处理 `read ECONNRESET at TCP.onStreamRead` → 进程 abort。引入 commit `63702e844`。
无 `apps/desktop/test/npm-registry-proxy.test.mjs`。
对照：子进程先退出/延迟 5s 释放时 EXIT=0（`added 1 package in 506ms`）。

### T8. 低优先级：`app.getPath("appData")` 无兜底
`apps/desktop/electron/main/data-root.ts:126`（`:60` `applyReleaseDataRoot`），缺 profile 的极端环境
→ uncaught exception 打死 main。

---

## Batch-3/4 追加（测试执行中新增）

### T9 — e2e-tool-result-persistence.mjs:194 原始路径拼写比较（测试侧）
- 失败：assert.deepEqual(movedNested.toolResult, expectedNested.toolResult) @ scripts/e2e-tool-result-persistence.mjs:194
- 实测差异：actual path = 'C:/Users/Administrator/AppData/Local/Temp/pi-tool-image-moved-lYej37/scratch/nested.png' vs expected 反斜杠形式（C:\Users\Administrator\...\nested.png）
- 机制：Host 按设计把存储路径统一为正斜杠 —— crates/host-core/src/db/repositories.rs:15-39 normalize_project_path 第 20 行 `let mut normalized = trimmed.replace('\\', "/");`，由 :44 canonical_project_path 调用（:48 Path::canonicalize()，:51-58 剥离 \\?\ 前缀）。测试用 Node path.join 构造期望值 → 反斜杠。与 T2 同族。
- 复现需 PI_DESKTOP_HOST_BIN 指向 target/debug/pi-desktop-host-core.exe（脚本 :42-43 强制）。

### T10 — e2e-subagent-models.mjs:176 delegate 过滤器误判 turn verdict judge（测试侧，已实证）
- 失败：AssertionError: forbidden override must not issue a provider request（1 !== 0）@ :180
- 探针（临时改版脚本，已删）打印的多余 delegate 请求实体：model="parent"、tools=[]、roles=["user"]、lastUser 以 'You audit one turn of a coding agent.\n\nFact: every tool call the agent made in this turn failed. None succeeded.' 开头
- 归因：那是 packages/agent-runtime/src/turn-verification.ts:171-193 buildVerdictPrompt 产生的一发 judge 请求，由 packages/agent-runtime/src/runtime.ts:2627 completeOneShot(this.provider, ...) 发出（无 tools 数组）→ 被 scripts/e2e-subagent-models.mjs:176 `captured.filter((p) => !p.tools?.some((t) => t.function?.name === "Task"))` 当成 delegate。
- 模型授权撤销本身工作正常（未发出任何 Task 模型的 delegate 请求）；纯属测试分类缺陷。

### C3 — Electron E2E 串行批跑会产生伪失败（方法学，重要）
- 18 个套件在一个 PowerShell 循环里连跑，其中 3 个失败在单独重跑后全部 PASS：
  - asktool-card：批跑 114667ms → 内部 45s watchdog SIGKILL、输出为空；单独跑 6247ms，ASKTOOL_CARD_PROBE ok:true resolutions:5
  - question-notification：批跑 57605ms → 空输出；单独跑 7816ms，QUESTION_NOTIFICATION_PROBE 全 true
  - transcript-disclosure：批跑 25778ms → ok:false geometry did not hold；单独跑 EXIT=0 ok:true
- 结论：任何 Electron E2E 失败都必须单独复跑后才能定性；批跑结果只能用于筛选候选。

### C4 — scripts/e2e/transcript-history-navigation.tsx 时序敏感断言（疑似 flaky + 一个待查机制）
- LATEST_MOTION：:175 assert(matchMedia("(prefers-reduced-motion: reduce)").matches || intermediateFrames >= 3)。实测 firstDistances:[2712,2712,2540,0,0,...] = 只有 1 个中间帧 → 断言失败。rAF 采样对负载敏感。
- LATEST_LIFECYCLE hide：:255 assert(bottom(), ...)；全序列跑 3/3 必失败，孤立跑通过 → 顺序/负载敏感。
- LATEST_LIFECYCLE new-search：:227-228 obsolete latest arrival overrode the new search，同样顺序敏感。
- 机制线索（供维护者查）：apps/desktop/src/hooks/use-transcript-reading-position.ts:62 remember() 在 pendingRef.current 有值时不写 bookmark；apps/desktop/src/features/chat/transcript/hooks/useTranscriptScroll.ts:316-323 在 ownership==="reading-position" 时把 pinnedRef 置 false 并 return（不底部定位）。

### H2 — 未设 PI_SCRATCH_DIR 时测试临时目录落到仓库根（仓库卫生）
- scripts/e2e-transcript-history-loading.mjs:14 const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? root, "history-loading-"))，其中 :10 const root = fileURLToPath(new URL("..", import.meta.url)) = 仓库根。
- 产物未被 .gitignore 覆盖（git check-ignore history-loading-* 无命中）。


---

# batch-4 与实时模型联调（2026-11-07 14:40–15:25）

## ✅ 实时模型联调（权威）
- 端点 https://api-mew.me/v1，模型 deepseek-v4.1-flash（唯一），key 已由用户提供，**未写入仓库**（探针从 C:\Users\Administrator\.dsh\.credentials.yaml 的 MEW_API_KEY 读入临时文件）。
- **fresh host + providers.create + 真实 POST /chat/completions → HTTP 200（"Pong! 🏓"）**；providers.getSecret 回读 35 字符，hasSecret=true。
- 说明 provider 存取链（bash → host-core SQLite → secret 存储 → 回读 → 真实请求）在本机端到端可用。

## batch-4 结果（16 套件，日志 F:\PI-Desktop-worktrees\_e2e_batch4.log）
| 套件 | 批跑 | 单独复跑 | 定性 |
|---|---|---|---|
| composer-model-selection | exit=0 | — | PASS |
| composer-autocomplete | exit=0 | — | PASS |
| composer-ime-slash | exit=0 | — | PASS |
| project-edit | exit=0 | — | PASS |
| provider-client-certificate | exit=0 | — | PASS |
| plugin-command-ownership | exit=0 | — | PASS |
| file-manager-theme | exit=0 | — | PASS |
| oauth-retry | exit=0 | — | PASS |
| gen-ui | exit=1 | **exit=0，GENUI_E2E ok:true（12 项检查全绿）** | (c) 争用伪失败 |
| worktree-live | exit=1，6/16 | **exit=0，16/16 PASS** | (c) 争用伪失败 |
| plan-ui | exit=1 fatal | exit=1 同样 fatal | OPEN（见下） |
| composer-paste | exit=1 | exit=1 同样 | T12 测试侧 |
| hosted-search | exit=1，10/10 同一错 | exit=1 同样 | T11 测试侧 fixture 缺口 |
| scheduled-quit-cancel | exit=1 | exit=1 同样 | D5 产品侧（低危） |
| keep-awake | exit=1 | exit=1 同样 | (b) 需管理员 |
| send-now-subagents | exit=1 | — | (b) win32 显式不支持（设计） |

## ✅ C3 强化证据：worktree-live 6/16 → 16/16
批跑时 3 个会话全部报 `PROVIDER_UNAUTHORIZED`、`tools=-`、`reply=`（空），看起来像鉴权缺陷。
但用**完全相同的 provider 参数单独复现**（探针 F:\PI-Desktop-worktrees\full-feature-verification\scripts\_probe-wtl.mjs，
复用 scripts/e2e/host.mjs 的 Host + DesktopAgentRuntime + isolated session + 真实 api-mew.me）得到：
`secret len after env scrub: 35`、`events: 12  errors: []  reply: ["READY"]`。
→ 鉴权链无缺陷，批跑时是并行压力下的伪失败。**再次验证：Electron E2E 批跑结果不可作为缺陷证据。**

## ✅ T11 定案：e2e-hosted-search 的 fake-host RPC 缺口（测试侧）
- 全部 10 个用例同一条错：`Error: Unsupported fake-host RPC: tools.fileBatchCapabilities` @ scripts/e2e/hosted-search-sidecar.mjs:220（fixtureHost 的 default 分支）。
- 生产侧：packages/agent-runtime/src/batch-planner.ts:36 主动探测 `tools.fileBatchCapabilities`；:37-41 只在
  `error.code === -32601 || error.errorCode === "METHOD_NOT_FOUND" || error.rpc.code === -32601` 时**宽松放行**（视为不支持）。
- fixture 抛的是无 code 的普通 Error → 不走宽松分支 → 冒泡。
- 旁证：仓库内 12 个单测 mock 都显式返回 `{ version: 1, supported: false }`（如 packages/agent-runtime/src/context-usage-compaction.test.ts:87）。
- **结论：fixtureHost 未随 file-batch 能力探测同步更新；产品逻辑正确。**
- 修法：在 scripts/e2e/hosted-search-sidecar.mjs:202 的 switch 中加
  `case "tools.fileBatchCapabilities": return { version: 1, supported: false };`

## ✅ T12 定案：e2e-composer-paste 的跨平台路径拼接（测试侧）
- 失败链：`Error occurred in handler for 'pi-desktop/composer/readClipboardDirectories': [Error: ENOENT: no such file or directory, realpath 'F:\C:\Users\Administrator\AppData\Local\Temp\pi-composer-paste-DD6jIa\copied folder']`
  → `native folder metadata did not render a chip` @ scripts/e2e/composer-paste.tsx:247。
- 机制：fixture 用 esbuild 把**真实** apps/desktop/electron/main/composer-clipboard-directories.ts 打成
  directories.cjs（scripts/e2e-composer-paste.mjs 第二个 build），然后以 linux 形状驱动：
  :103-105 `readBuffer(format => Buffer.from(format === "text/uri-list" ? pathToFileURL(path.join(__dirname, "copied folder")).href : ""))`，
  :108 `nativeClipboardPaths(clipboard, "linux")` → 得到 `file:///C:/Users/.../copied folder`。
- 但 composer-clipboard-directories.ts:68 用的是 **Node 真实 `realpath(path)`**（本机是 Windows 语义）→
  把 `/C:/...` 拼成 `F:\C:\...` → ENOENT。
- 二级问题：该函数没有 platform 注入参数（`nativeClipboardPaths` 有 `platform` 形参，`readComposerClipboardDirectories` 没有），
  所以 fixture 无法在不改产品代码的前提下模拟 linux。
- **结论：测试侧缺陷（fixture 只在 fixture 内模拟 platform，没有贯穿到真实被测函数）；同时暴露一个可测性缺口（低危）。**

## ✅ D5 定案并给出复现：applyReleaseDataRoot 未保护 app.getPath("appData")
- 现象（scripts/e2e-scheduled-quit-cancel.mjs，稳定复现 exit=1）：
  `App threw an error during load / Error: Failed to get 'appData' path` @ apps/desktop/out/main/index.js:7672（即 data-root.ts:126）
  → `[app/runtime] main.process.error uncaught exception in main` → Electron 进程死。
- 触发条件：脚本 :64-67 `env = { ...process.env, HOME: home, USERPROFILE: home, PI_DESKTOP_DATA_DIR: dataDir, ... }`
  把 USERPROFILE 指向一个没有 AppData 子目录的 fixture 目录；Windows 上 Electron 由 USERPROFILE 推导 appData → 抛错。
- 代码位置：apps/desktop/electron/main/data-root.ts:60 `applyReleaseDataRoot()`；:126 `join(app.getPath("appData"), ...)`。
  同一函数对 `mkdirSync` 失败是 try/catch 容忍的（:76-81），却对 `app.getPath` 毫无保护。
- **结论：(a) 低危健壮性缺陷**（正常用户环境不会触发；HOME/USERPROFILE 被重定向时 main 直接崩）。
- 修法建议：把 :122-133 的 adoptDirectory 调用包进 try/catch，或先探测 appData 是否可得。

## ✅ keep-awake 定案（环境）
- scripts/e2e-keep-awake.mjs:33-37 `hasElectronPowerRequest()` → `execFileSync("powercfg", ["/requests"])`。
- Windows 上 `powercfg /requests` 需要提升权限：本机报"此操作需要管理员权限"，execFileSync 抛错 → 套件退出。
- **结论：(b) 环境**，Windows 需管理员控制台；产品侧被唤醒锁逻辑未被验证（未触及）。

## OPEN：plan-ui 的 fatal 尚未定性
- 失败：`FATAL timeout waiting for active session <uuid>` → 5 个用例标 "not run after fatal failure"，`SUMMARY 0 passed, 5 failed`。
- 位置：scripts/e2e-plan-ui.mjs:1284 `await selectSession(state, state.liveSessionId)`（属于 runLiveAcceptance()），
  等待点 :769-776 `snapshot.activeSessionId === sessionId && !snapshot.booting`，默认 WAIT_TIMEOUT_MS=45_000（:34）。
- 前序：:1283 `reloadRenderer(state)`。selectSession 返回 `method:"renderer-session-api"`（:757-759）意味着
  **DOM 里没找到该 session 行**（:753-755 的 DOM 点击路径未命中），只能退化为调 store。
- 判定依据：apps/desktop/src/components/Sidebar.tsx:2162 `const active = page === "chat" && selectedSessionId === session.id;`
  → :2182 加 `active` class、:2243 设 `aria-current="page"`；而探针 :641-644 读的正是这两个标记。
- 需要继续查：reload 后侧栏会话列表是否在该 session 归属的项目折叠分组内（:746-749 只展开了
  aria-expanded="false" 的 toggle 并点了一次 .sidebar-load-more）。
- 另一批跑现象：**同一套件在批跑时报的是 `timeout waiting for gated Plan UI probe availability`（另一个失败点）**，
  单独跑则报 active session。说明该套件至少有两个不稳定前置。
- 关联产品代码：apps/desktop/electron/main/plan-ui-probe.ts:352-358 install 守卫
  `if (process.env.PI_DESKTOP_PLAN_UI_PROBE !== "1") return;`；调用点
  apps/desktop/electron/main/bootstrap/startup.ts:327 `if (!bootError) planUiProbe.install();`。

## D6（产品侧，高危：功能等于不存在）技能自动审查恒被 `skipped(no-skill-tools)`

**结论**：agent 模式会话里，回合结束后的技能自动审查（Hermes `background_review` 移植）**每一次都被跳过**，永远不会触发 fork、永远不会写入技能库。技能自学闭环在默认配置下是死代码。

**确定性证据（不依赖模型，F:\PI-Desktop-worktrees\_reviewtools.log）**
探针 scripts/_probe-review-tools.mjs 直接在真实 Host + DesktopAgentRuntime 上读内部状态：
```
DECLARED_TOOLS: ["Read","Bash","Edit","Write","Glob","Grep","asktool","Skill","EnterPlanMode","EnterGoalMode","new_context","ToolSearch"]
DEFERRED: [...,"memory","skill_manage"]
declared has Skill: true
declared has skill_manage: false
declared has memory: false
canReview(reviewToolsFrom(declared)): false     ← 实际走的路径
canReview(reviewToolsFrom(catalog)):  true     ← 如果换成 catalog 就该为真
REVIEW_SUBSET_DECLARED: ["Read","Glob","Grep","Skill"]
REVIEW_SUBSET_CATALOG:  ["Read","Glob","Grep","memory","skill_manage","Skill"]
```
另有真实模型端到端复现（scripts/_probe-memskill.mjs，日志 _memskill1.log / _memskill2.log，两次跑）：
`SKILL_REVIEW events: [{"type":"skill_review","outcome":"skipped","reason":"no-skill-tools"}]`，即使传入 pluginSkills 让 `Skill` 工具存在、`skillReview:{enabled:true,afterToolCalls:1,minIntervalSec:0}` 全开。

**机制链（逐行）**
1. packages/agent-runtime/src/runtime.ts:4613-4617 计算 deferred 集合：`[...this.toolCatalog.keys()].filter((name) => !this.isCoreTool(name) && name !== TOOL_SEARCH_NAME)` → `memory` / `skill_manage` 都在其中。
2. runtime.ts:4681-4706 `isCoreTool`：agent 模式用 `AGENT_CORE_TOOL_NAMES.has(name)`；runtime.ts:807-821 该集合 = `["Read","Glob","Grep","Write","Edit","Bash",ASK_TOOL_NAME,SKILL_TOOL_NAME]` → **`skill_manage` 与 `memory` 都不在 core**。
3. runtime.ts:4708-4717 `activeTools()` 只保留 core + `ToolSearch` + `activeDeferredToolNames`（模型必须先用 ToolSearch 激活）。初始 `activeDeferredToolNames` 为空 → `skill_manage`/`memory` 不出现。
4. runtime.ts:4649-4651 `declaredTools() { return this.declarationPolicy?.tools ?? this.activeTools(); }`；探针确认当前模型走回退（`declarationPolicy.tools: undefined`，因为 fixed-tool-declarations.ts:21-43 只对 `deepseek-flash`+`api.deepseek.com` 生效）→ 实际等于 `activeTools()`。
5. runtime.ts:2558-2561 `const tools = reviewToolsFrom(this.declaredTools());` + `if (!canReview(tools)) return skipped("no-skill-tools");`；skill-review-run.ts:190-193 `canReview` 要求 `names.has("skill_manage") && names.has("Skill")`。
6. → `skill_manage` 不在 → 恒 false → 恒 skip。review fork 与真实模型完全没被调用过。

**引入点**：commit **46b9f3727（2026-11-05 09:36，feat(skills): review a finished turn by forking the agent, not by asking for JSON）** 在 runtime.ts 新增 `reviewToolsFrom(this.declaredTools())`。此时 `AGENT_CORE_TOOL_NAMES`（该 commit 内为 Read/Glob/Grep/Write/Edit/Bash/ASK/Skill，见 `git show 46b9f3727:packages/agent-runtime/src/runtime.ts`）**本来就不含 skill_manage**；deferred 机制由更早的 a3d6ae0d2（2026-08-02 feat(runtime): defer ancillary tools per prompt）引入，46b9f3727 的作者选错了工具来源（`declaredTools` 而非 `toolCatalog`），两个已存在的事实叠加成功能死亡。

**测试为何没抓住**
- packages/agent-runtime/src/skill-review-run.test.ts:190-224 只测纯函数：把 `{ name: "skill_manage" }` 手工塞进 `declared` 数组再断言 `canReview(...)` 为 true，**从未断言真实 runtime 的 declaredTools 里是否真有它**。
- runtime.test.ts:3844-3877 "starts Agent with core tools plus workspace search and discovery" 的 `expect(names).toEqual([...])` 明确把 `skill_manage`、`memory` 排除在声明之外，等于把缺陷固化成了期望值。
- 全仓 `.test.ts` 中 `no-skill-tools` 零命中；`runSkillReviewIfDue` 只有 runtime.ts:9347 一个调用点（`agent_end` 之后 `void this.runSkillReviewIfDue()`）。

**同时验证为健康的部分（同一探针，排除"整条链都坏"的误判）**
不是技能库本身坏了 —— 直接走 skill_manage 会调用的那批 host RPC，全部正常：
```
SKILL_CREATE_ID: "reviewtools-probe-skill"           skills.create 成功
SKILL_READ_BODY: "# Probe\n\nOriginal line."         skills.read 回读正确
SKILL_PATCH_APPLIED: true                            skills.update 就地改写成功
SKILL_READ_AFTER_PATCH: "# Probe\n\nOriginal line.\n\nPatched sentence."
SKILL_BAD_PATH_ERR: "skills.writeFile: SKILL_INVALID: resource path may not traverse"   ← 路径逃逸被正确拒绝
SKILL_LISTED: ["memskill-probe-skill","reviewtools-probe-skill"]
SKILL_LISTED_AFTER_REMOVE: ["memskill-probe-skill"]   skills.remove 生效
```
→ 症状是**接线/触发**缺陷（一句 `this.toolCatalog` 换 `this.declaredTools()` 即可修），不是持久层或权限层缺陷。

**记忆侧的对照**：`memory` 同样是 deferred，同样不在 declared 里；但记忆闭环另有一条可用路径 —— 模型在正常回合里显式调用 memory 工具（探针第一跑已实证写入 `memory.entries(memory)`）。因此记忆"能工作"，技能"不可能工作"：审查 fork 是唯一自动写入口，而它永远不启动。这与用户 (m01972) "全自动完成"的预期直接冲突。

**建议修法（未实施，需授权）**
- 最小改动：runtime.ts:2558 改为 `reviewToolsFrom([...this.toolCatalog.values()])`（探针已验证该来源下 canReview 为 true）。
- 补一条回归测试：真实 runtime 上断言 `reviewToolsFrom((runtime as any).toolCatalog.values())` 含 `skill_manage`，且 `declaredTools()` 不含它是已知的 deferred 事实。
- 顺带检查 runtime.test.ts:3844-3877 的期望是否需要在修复后更新。

## 记忆自动读写闭环（Hermes 移植）—— **成立**，逐环节实证

用户 (m01972) 的重点需求是"记忆的自动读写 + 技能的自主学习/skill 建立迭代，全自动"。分开定论：**记忆这条闭环通过；技能那条断在触发点（见 D6）。**

### 端到端一次跑通（日志 F:\PI-Desktop-worktrees\_memrt.log，脚本 scripts/_probe-mem-roundtrip.mjs）
```
STEP1 tools started: ["ToolSearch","memory"]                       ← 模型自己找到并调用 memory（无需人工）
STEP1 memory.entries(memory): {"entries":["The fixture project release checklist is MEMRT-SENTINEL-7742 and lives in notes.md."],...}
STEP2 snapshot entries: 1 0                                        ← 新会话启动时读回 1 条
STEP2 snapshot carries sentinel: true
STEP2 assistant reply: "MEMRT-SENTINEL-7742"                        ← 新会话回答出了只在记忆里存在的标记
STEP2 REPLY_HAS_SENTINEL: true
```
第 1 步 = 自动写（模型自发调用 `memory` → `memory.writeEntries` 落库）；第 2 步 = 自动读（全新 session 启动时 `memory.entries` 读回 → 注入提示 → 模型能复述标记）。两半都真实经过模型与 host，不是纯函数推断。

### 关键机制（读写为何都自动）
- 写入：packages/agent-runtime/src/runtime.ts:4478-4479 `const memoryTools: AgentTool[] = this.mode === "agent" ? [createMemoryTool(this.host)] : [];` → agent 模式恒注入；工具名 `memory`（memory-agent-tool.ts:261-263），读 `memory.entries`（:290）、写 `memory.writeEntries`（:313），并在写回前跑 `scrubSecretsInBatch`（:310）。
- 但 `memory` 属 deferred（不在 AGENT_CORE_TOOL_NAMES，runtime.ts:807-821）→ 模型先用 `ToolSearch` 激活它（实测 `["ToolSearch","memory"]` 的调用顺序），runtime.ts:2949-2950 会拦截未激活的直接调用。**这是设计如此，不影响闭环成立。**
- 读取：apps/desktop/electron/main/runtime/session-launch.ts:476-492 每次启动 `memory.entries` 读两库，:489 记 `memory snapshot loaded`；packages/agent-runtime/src/memory-prompt.ts:61-70 `memorySnapshotContext` 把快照渲染成**用户消息前缀**（不是系统提示，见该文件 :3-14 与 :46-55 的 ADR 0378 注释：系统提示变动会撞 provider 前缀缓存）；runtime.ts:9737-9753 在每次 `prompt` 时把该前缀拼到用户消息上。
- 配套还有 `memory-context.ts:67-99` `memoryContextPrefix`（`host.memoryRecall` 按 query 召回，`<memory_context>` 块），runtime.ts:9738 与快照前缀合并 → 除"全量快照"外还有"按需召回"一条路径。

### 一处口径要说明（不是缺陷）
memory-prompt.ts:11-13 注释称"本次会话写的记忆要到下个会话才可见"。对**系统提示**成立；但因为快照实际走用户消息前缀（:46-55），实测标记在同会话后续回合也能带出。两处注释各说一半，属文档措辞不一致（低危，可归入 docs 项）。

### 探针一次失败不构成缺陷（方法学记录）
另一次 scripts/_probe-mem-auto.mjs 跑出 `memory.entries` 为空、`event types: {"undefined":35}`：原因是该探针的 `onEvent: (e) => events.push(e)` 漏了 `.event` 取值（对比 _probe-memskill.mjs:54 `onEvent: (e) => events.push(e.event)`），且模型那一次没调用工具。属探针自身问题，已废弃，不作证据。
附带发现：用 `node ... 2>&1 | Out-File` 在 PowerShell 里会因 `2>&1` 合并流而**阻塞到大缓冲区满**（曾导致两次运行"卡住"、日志停在 STEP2）；改用 `cmd /c` 调 .bat 后立即正常。以后一律走 .bat。

## 技能库"建立"闭环 —— 通过（模型自发 `skill_manage` → 落盘 → 可回读）

日志 F:\PI-Desktop-worktrees\_skillw.log（脚本 scripts/_probe-skill-write.mjs，真实模型 + 真实 host）：
```
promptErr: null
tools started: ["Read","ToolSearch","skill_manage"]      ← 模型自己 ToolSearch 激活 skill_manage 后调用
tool ends: [{"err":false},{"err":false},{"err":false}]
SKILLS list: ["deploy-gate-discipline","memskill-probe-skill"]
SKILL record: {"id":"deploy-gate-discipline","level":"global","source":"imported","path":"F:\\PI-Desktop-worktrees\\_scratch\\agents-probe\\skills\\deploy-gate-discipline.md"}
SKILL body head: "# Deploy gate discipline\n\n- Inspect NOTES.md before deploying.\n- Production deploys go through the staging gate first.\n- Never push to main directly."
SKILL file exists: true bytes: 275
```
→ **主动技能写入（模型在回合内自己建 skill）端到端成立**：工具调用成功、host 落盘为 `<AGENTS_DIR>/skills/deploy-gate-discipline.md`、`skills.list`/`skills.read` 可回读、内容与模型给的一致。

### 由此把技能闭环三段分开定论
1. **主动写（回合内模型自建/改技能）**：✅ 成立（上列证据；`patch`/`write_file` 走同一 `skills.update`/`skills.writeFile`，已在 D6 的 RPC 探针里单独验过）。
2. **被动写（回合结束后自动复盘建技能，Hermes `background_review`）**：❌ 永不发生 —— 见 D6，`canReview` 恒 false。这是"自主学习/迭代"真正缺的那一环。
3. **读回（下个会话 Skills 段能看到）**：✅ 成立 —— packages/agent-runtime/src/plugin-skills-prompt.ts:30-37 `pluginSkillsPromptSections` 渲染 id/name/description；apps/desktop/electron/main/runtime/session-launch.ts:592-596 把 `userSkills`（即 `skills.list` 结果，含模型自建的 global 技能）并入 `pluginSkills`；runtime.ts:2809 进系统提示。`Skill` 工具（AGENT_CORE_TOOL_NAMES 成员）负责按 id 载入正文。

### 附带证据（同一日志）`errors: ["PROVIDER_ERROR"]`
三次运行（_memskill1 / _memskill2 / _skillw）里 `PROVIDER_ERROR` 反复出现，但同一次运行内工具调用全部成功、host 落盘成功。说明该错误发生在**回合尾部**（模型最后一次流式回复之后），不影响工具链，但会让探针里的最后一段统计失真。属 api-mew.me 网关侧中断，归 (b) 外部依赖，未计入产品缺陷。

### 日志读取坑（方法学，已踩两次）
PowerShell 里 `node x.mjs > file 2>&1` 与 `| Out-File` 都可能写成 **UTF-16LE（首字节 ff fe）**，read 工具会判为 binary。读法：`fs.readFileSync(p).toString("utf16le").replace(/\u0000/g,"")`。推荐直接用 `> file 2>&1`（而非 `2>&1 | Out-File`，后者在 PowerShell 里会阻塞到大缓冲满，曾让两次探针"卡住"）。

## 技能迭代（create → patch → 新会话可见）—— 探针第一版未跑通，原因在探针不在产品

第一版 scripts/_probe-skill-iterate.mjs（日志 F:\PI-Desktop-worktrees\_iter.log，EXIT=0）结果：
```
A tools: ["Read","ToolSearch"]
A SKILL: MISSING; list= ["deploy-gate-discipline","memskill-probe-skill"]
B tools: []
B SKILL: MISSING; list= ["deploy-gate-discipline","memskill-probe-skill"]
C fresh session visible skills: ["deploy-gate-discipline","memskill-probe-skill"]
C prompt mentions restart-discipline: false
```
- A 步模型只调了 Read + ToolSearch，没有调 skill_manage —— 模型没有遵守"body 用 JSON 字符串塞进普通句子"的提示（bodyV1 被展平成一行自然语言，模型更倾向当成描述而不是参数）。
- B 步 tools 为空：**上一回合没有真正 create 成功，模型在 patch 时找不到目标，直接放弃**（不是产品问题；`skills.list` 仍只有先前两个技能，说明 host 侧没有脏写）。
- C 步 `pluginSkillsPrompt` 渲染正常（`C prompt head: "# Skills\n\nSkills available to you, from plugins and from your own library. Each entry is a set of instructions you can load with the `Skill` tool by passing its exact id. ..."`），只是那个技能压根没被建出来。

### 对照已成立的证据
同一模型、同一 host、同一 provider 下，scripts/_probe-skill-write.mjs **一次就成功**建出 `deploy-gate-discipline`（275 bytes，落盘 <AGENTS_DIR>/skills/deploy-gate-discipline.md）。差别只在提示写法。→ **技能创建能力成立；迭代（patch）需要更强的提示才能验证。** 这一点记录为探针方法学缺陷，不计产品缺陷。

### 正在做
改写为 scripts/_probe-skill-iterate2.mjs：把参数字面量作为**单个 JSON 对象**交给模型（不再拆成英文句子），并额外捕获模型回复文本，以便区分"模型没调工具"与"工具报错"。日志 F:\PI-Desktop-worktrees\_iter.log。

## 外部网关中断（2026-11-07 17:30 起）—— 阻塞技能迭代最后一腿

api-mew.me 在测试后期整体 503，直接命中探针：
```
ERROR {"code":"PROVIDER_ERROR","message":"503: {\"message\":\"服务器繁忙，请稍后重试\",\"type\":\"all_failed\"}","retriable":true,
      "details":{"providerStatus":503,"phase":"stream","requestMessages":2,"requestBytes":17899,"providerWaitMs":128701,"streamMs":1,"retryAttempt":10}}
```
- /v1/models 仍 200（静态路由活着），但 /v1/chat/completions 三次独立探测均 503 → **上游模型服务挂了，不是 key 或配置问题**。
- runtime 自身行为正确：retriable=true，10 次重试后向上报 PROVIDER_ERROR，没有静默吞错、没有把失败伪装成成功。
- 影响：scripts/_probe-skill-iterate3.mjs 两回合都拿不到模型回复 → create 与 patch 都没发出（`AFTER_CREATE: MISSING`、`AFTER_PATCH: MISSING`）。这一跑**不作为**产品缺陷证据。
- 已有确定性替代证据：`skills.create` / `skills.update` / `skills.writeFile` / `skills.removeFile` / `skills.remove` 五个 RPC 全部在 scripts/_probe-review-tools.mjs 里直接验证通过（含 patch 后 body 变化、路径逃逸被 SKILL_INVALID 拒绝），且 `skill_manage` 工具层的 old_string 计数逻辑由 skill-manage-tool.ts:148-184 保证（0 次 → SKILL_NO_MATCH，多次 → SKILL_AMBIGUOUS_MATCH）。
- **结论：技能的"创建→迭代"链路由工具层 + RPC 层双重确定性证据支撑；模型驱动的一体化演示（create 后同一会话 patch）因网关故障未能补齐，已标注为 NOT RUN(blocked by provider 503)。
- 补充（17:40 复查）：`/v1/chat/completions` 连续 6 次探测中 5 次 503（`{"error":{"message":"服务器繁忙，请稍后重试","type":"all_failed"}}`）、1 次 400，/v1/models 仍 200。上游仍未恢复。
**

## 技能"创建 → 迭代"闭环：**成立**（工具层直接执行，绕开已 503 的模型网关）

日志 F:\PI-Desktop-worktrees\_skilltool.log + \_ambig.log。探针 scripts/_probe-skill-tool.mjs 与 scripts/_probe-skill-ambiguity.mjs 直接构造 `createSkillManageTool(host)` / `createMemoryTool(host)` 并按官方 AgentTool 签名 `execute(toolCallId, params, signal)` 调用（**注意：第一版写成 `execute(args, ctx)` 会误报 "action 必须..."，因为 rawParams 落在了 toolCallId 位**——这是探针 bug，不是产品 bug）。

### create → patch → 落盘 → 回读
```
CREATE  => "Created skill `restart-discipline`. It is listed in your Skills section from the next session; patch it now to keep refining it."
AFTER_CREATE: "# Restart discipline\n\n- Announce restarts in #ops before performing them."
PATCH   => "Patched skill `restart-discipline`."
AFTER_PATCH: "# Restart discipline\n\n- Announce restarts in #ops at least five minutes before performing them.\n- Roll back with the previous release tag, never a hand edit."
ITERATED: true
PATCH_NO_MATCH => "`old_string` does not occur in `restart-discipline`. Read the skill and copy an exact span from it."
WRITE_FILE  => "Wrote `references/ops.md` into skill `restart-discipline`."
WRITE_ESCAPE=> "skills.writeFile: SKILL_INVALID: resource path may not traverse"
SKILL record: {"level":"global","path":"...\\agents\\skills\\restart-discipline\\SKILL.md","exists":true}
SKILL file body: "---\nname: restart-discipline\ndescription: ...\n---\n\n# Restart discipline\n\n- Announce restarts in #ops at least five minutes before performing them.\n- Roll back with the previous release tag, never a hand edit.\n"
```
```
CREATE         => "Created skill `ambiguous-probe`."
AMBIGUOUS_foo  => "`old_string` occurs 2 times in `ambiguous-probe`; it must select exactly one span. Include more surrounding text."
BODY_AFTER     : "# T\n\nfoo bar foo bar"     ← 歧义时**不写入**，文档未被破坏
UNIQUE_SPAN    => "Patched skill `ambiguous-probe`."
BODY_AFTER2    : "# T\n\nsingle"
AGENTS_FILES   : ["<agents>\\ambiguous-probe.md"]
```
→ 迭代（patch）语义完整：**唯一命中才改、零命中给可自纠文案、多命中拒绝且不落盘、目录逃逸被拒**。与 D6 的 RPC 层结论一致。

### ⚠️ 附带发现（低危，带具体证据）：`old_string` 判断存在两条不一致的路径
同一批探针里两次 patch 送的都是 `old_string: "- Announce"`：
- 第一次（_skilltool.log `PATCH_AMBIGUOUS?`）返回 **"Patched skill"**，落盘结果把 `- Announce` 替换成 `x` →
  `"# Restart discipline\n\nx restarts in #ops at least five minutes before performing them."`
- 第二次（_ambig.log `AMBIGUOUS_foo`，`old_string: "foo"` 在 `foo bar foo bar` 中出现 2 次）返回 **"occurs 2 times ... must select exactly one span"**，且**不落盘**。

两者都是真·多命中，一个被拒、一个被放行并写入。说明多命中守卫并非在所有输入形状下都生效（`- Announce` 与 `foo` 的差别在于前者带前导 `- `、且匹配到的是缩进/列表结构位置）。**当前记录为待复现的 T13**：需要一个把这两种形状并排跑的最小用例才能定案是"守卫按某种规则豁免了列表前缀"还是"存在第二段写入路径"。影响面：模型若送一个残片做 patch，可能悄悄改错位置，而不是被要求给出更长的 span（产品会因此静默走样，而非报错）。

### 记忆工具层（同一日志）
```
MEMORY_ADD => "Entry added.\nNow 1 entry, 68/2200 chars.\n\nRestarts go through #ops with five minutes notice (SKILL-ITER-TOOL)."
MEMORY: {"entries":["Restarts go through #ops with five minutes notice (SKILL-ITER-TOOL)."],"target":"memory"}
```
→ 工具层会计数并回显预算（68/2200，对应 `MEMORY_CHAR_LIMIT = 2200`，crates/host-core/src/memory_entries.rs:36），写入即可通过 `memory.entries` 读回。
### T13 已排除（探针自身缺陷，产品无问题）
把两种形状并排跑成矩阵（scripts/_probe-skill-ambiguity2.mjs，日志 F:\PI-Desktop-worktrees\_ambig2.log）：
```
A_RESULT: "Patched skill `t13-a`."      A_OCCURRENCES: 1     ← "- Announce" 在 A 文档里只出现 1 次，本就该应用
A_BODY: "# Restart discipline\n\nx restarts in #ops before performing them."
B_RESULT: "`old_string` occurs 2 times in `t13-b`; it must select exactly one span."    ← 真·双命中，被拒且不落盘
B_BODY: "# T\n\n- Announce restarts.\n- Announce rollbacks."
C_RESULT: "`old_string` occurs 2 times in `t13-c`; ..."                                  ← 与控制组一致
D_RESULT: "Patched skill `t13-d`."      D_BODY: "# T\n\ny once."                         ← 单命中正常应用
```
→ **多命中守卫是稳定一致的：只命中一次才写，命中两次一律拒绝且文档不变。** 之前 _skilltool.log 里那条"看起来放行"的 `PATCH_AMBIGUOUS?` 是因为首次 CREATE 后的文档里 `- Announce` 只出现一次 —— 探针自己算错了命中数，不是产品缺陷。T13 撤销，不计入缺陷清单。
- 补充：新会话注入腿（同一探针追加在 `await host.stop()` 之前）
```
INJECT ids: ["restart-discipline"]
INJECT mentions restart-discipline: true
INJECT line: "- `restart-discipline` — restart-discipline: Use before restarting or rolling back a service."
INJECT body has iterated text: true
```
→ 迭代后的技能会进下一次会话的 Skills 段（`pluginSkillsPrompt` 渲染 id + description），且 `skills.read` 拿到的是 patch 之后的新正文。**首次运行该腿时探针自己有 `SyntaxError: Identifier 'list' has already been declared`（变量重名），已修正后通过。**

## 记忆工具契约：逐条实测（scripts/_probe-memory-contract.mjs，日志 F:\PI-Desktop-worktrees\_memcontract.log）

工具 = `createMemoryTool(host)`（packages/agent-runtime/src/memory-agent-tool.ts:261），预算常量 crates/host-core/src/memory_entries.rs:36 `MEMORY_CHAR_LIMIT = 2200`、`USER_CHAR_LIMIT = 1375`。

### 1) 预算是真实生效的执行期硬约束（不是提示词建议）
```
ADD0 => "Entry added.\nNow 1 entry, 709/2200 chars."
ADD1 => "…  2 entries, 1421/2200 chars."
ADD2 => "…  3 entries, 2133/2200 chars."
ADD_4TH => "Would put memory at 2855/2200 chars: free at least 655 chars. Shorten the new text, or 'remove' other stale or less important entries to make room (see current_entries below), then retry — all in this turn."
```
→ 超限时**不写入**，并把 `current_entries` 全文回显给模型，让它同回合内自行腾挪。这是防"记忆无限膨胀"的正确设计。

### 2) patch / replace / remove 语义
```
ADD_SHORT => "Entry added."                        ENTRIES_AFTER: ["probe-… original wording here"]
PATCH     => "Entry patched."                      ENTRIES_AFTER_PATCH: ["probe-… revised wording here"]
REPLACE   => "Entry replaced."                     ENTRIES_AFTER_REPLACE: ["probe-… replaced wholesale"]
REMOVE    => "Entry removed."                      ENTRIES_AFTER_REMOVE: []
```
→ patch（做局部替换）与 replace（整条覆盖）语义分离且正确；remove 后该条彻底消失。

### 3) ⚠️ **batch 的 schema 缺口（a 类，中危）**：`operations` ≠ "多条操作"，而是"同一 target 的多条操作"
- 描述里写的是（memory-agent-tool.ts:53）"…several operations atomically…"，:117 也只说 "Several operations applied atomically against the final size limit"。
- 实测三条探针：
  ```
call({ target:"memory", action:"batch", entries:[...] })  => "`batch` needs an `operations` list."
call({ operation/…, operations:[...] })                    => "target is required: use `memory` for your own notes or `user` for who the user is."
call({ target:"memory", operations:[{target:"user",...}] }) => "Applied 2 operations."  ← 但**全部写进 memory**
MEM_HAS_USER_TEXT: false / USER_HAS_TEXT: false           ← 传的 target:"user" 被静默忽略
```
- 而 `operations` 里若有**未声明的键**（如 `target`），:160-188 只取 `action`/`content`/`old_text`，其余键被丢弃且**不报错**。所以"跨库批量"会被模型当成成功，实际写到错误的那一库。
- 影响面：模型可能想"这条属于用户画像（user），那条属于项目笔记（memory）"而合并成一次 batch —— 结果全部落进 `memory`。用户看不到任何错误。
- 建议修法（未实施）：:160-188 对每个 item 若含 `target` 且与顶层 target 不同则报错，或显式支持 per-operation target。

### 4) batch 是真原子（同一 target 内）
```
BATCH_ATOMIC => "operation 1 (add): Would put memory at 2752/2200 chars: free at least 552 chars…"
MEM_HAS_SHOULD_NOT_LAND: false
```
→ 两条操作里第一条就超限 → 整批不生效（说明是按最终大小预校验后才落盘的原子语义），与 :53 描述一致。

### 5) 单 target 隔离正确
```
BATCH_ISOLATED => "Entry added.\nNow 1 entry, 29/1375 chars.\n\nUSER-ONLY-BATCH …"
MEM_HAS_USER_TEXT: false      USER_HAS_TEXT: true
```
→ 顶层 `target` 各自独立预算（2200 / 1375），互不污染。


---

## 移交补充（2026-11-08）：三项未修残余，接手模型请从此处继续
- (b) Rust 环境族 4 连败：windows_tests.rs:79 / visualization fork / tools::mod.rs:5527 / tools::mod.rs:5316。根因 8.3 短 TEMP 拼写，修法=测试侧 canonicalize 统一拼写（勿改产品码）；建议先加 windows-latest CI。
- (协议) normalize_project_path 正斜杠 vs E2E 反斜杠：repositories.rs:15-39 replace('\\',"/") + data_relocation.rs:34-54 remap → 存储为正斜杠；e2e-tool-result-persistence.mjs:194 / e2e-storage-migration.mjs:119 用反斜杠 deepEqual。推荐修 E2E 侧 expected 归一化（方案 a）；勿轻改 binary_storage.rs relocate 链路（曾 +96 行重构打红 10 测试已回退）。
- (上游) check:marketplace EXIT=1：远程 catalog.json 的 author 是对象非字符串，check-marketplace-catalog.mjs:202 期望 string。本地无法修；或联系上游修数据，或放宽本校验接受 author 对象（属校验契约变化需明示）。
- 接手前先读 _TEST_REPORT.md 的"移交清单"小节获取完整证据与行号。
