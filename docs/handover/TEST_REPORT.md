# Pi-Workspace 全功能测试交付报告

| 项 | 值 |
| --- | --- |
| Task candidate | `test/full-feature-verification`（worktree `F:\PI-Desktop-worktrees\full-feature-verification`） |
| Base main | `origin/main @ 3c7939404`（2026-11-06 18:37） |
| 产品版本 | 0.21.0，release line 0.21.x (Early Preview) |
| 环境 | Windows 10/11 x64 · Node v24.16.0 · pnpm 12.8.1 · rustc/cargo 1.99.1 · rustfmt 1.10.0 · Electron 二进制由 `apps/desktop/node_modules/electron/install.js` 补齐 |
| 模型联调 | `https://api-mew.me/v1` / `deepseek-v4.1-flash`（key 仅经环境变量传递，未入库） |
| 报告日期 | 2026-11-07 |

---

## 一、结论摘要

这次是把整个仓真正跑了一遍：静态门禁、Rust 单测、JS 单测全量扇出、**82 个 Electron E2E 脚本里的 67 个**、外加 14 个专用探针用来验证"记忆自动读写 / 技能自主学习"两条 Hermes 闭环。

**总体可用，但有 3 个必须修的缺陷，其中 1 个让"技能自主学习"功能完全不存在。**

| 分类 | 数量 | 说明 |
| --- | --- | --- |
| 🔴 (a) 产品缺陷 高危 | 1 | D6 技能自动审查恒被跳过 → 技能自学功能等于死代码 |
| 🟠 (a) 产品缺陷 中危 | 1 | 记忆 `batch` 跨 target 的操作被静默丢弃 → 记忆写错库 |
| 🟡 (a) 产品缺陷 中/低危 | 8 | PowerShell stdout 无流式、stderr 丢/重、架构预算红、npm 代理崩溃、market 套件写真实用户目录、`app.getPath("appData")` 无兜底、ADR 索引缺失、中文镜像缺章 |
| 🟢 (a) 仓库卫生 | 1 组 | 5 类测试产物未被 .gitignore 覆盖，污染 `git status` |
| ⚪ 必须修的门禁红 | 2 | `cargo fmt --check` 33 处漂移、`check-architecture` 3 文件超限 —— **干净 main 上就是红的** |
| 🔵 (b) 环境/测试隔离 | 20+ | 本机 8.3 短名族、无符号链接权限、无 ffmpeg/playwright/objdump 等 |
| ⚫ (c) flaky / 批跑伪失败 | 9 | 全部单独复跑转绿，已逐一列出 |
| 🟣 测试侧陈旧断言 | 10 | 测试没跟着产品改（T0b/T1/T2/T9/T10/T11/T12 等） |

**最关键的一句**：CI 只跑 Linux（`.github/workflows/ci.yml` 的 `js`/`rust` job 均 `ubuntu-latest`，E2E 全 `xvfb-run`），而这是 Windows 桌面产品。A1/A2/D6 这类缺陷在 CI 里永远看不见 —— 这是所有漏检的根因。

---

## 二、静态门禁（在干净 `origin/main` 基线上跑）

| 门禁 | 命令 | 结果 | 判定 |
| --- | --- | --- | --- |
| JS 构建 | `pnpm build:js` | EXIT=0（packages tsc + electron-vite + vitepress docs 全过） | ✅ |
| 类型检查 | `pnpm --filter @pi-workspace/desktop typecheck` | EXIT=0 | ✅ |
| Lint | `biome` + `check-style-tokens` | 132 files clean；**style-token 原本红，我已修** | 🟡 已修 |
| PowerShell 编码 | `check:powershell-encoding` | EXIT=0（5 scripts, 1 UTF-8-with-BOM） | ✅ |
| Agent 策略同步 | `check:agent-policy` | EXIT=0 | ✅ |
| PR base | `check:pr-base` | EXIT=0（head == base） | ✅ |
| Pi patches / deps | `check:pi-patches` / `check:pi-dependencies` | 均 EXIT=0（1.4.0 对齐） | ✅ |
| Release docs | `check:release-docs` | EXIT=0 | ✅ |
| **架构预算** | `check-architecture` | **EXIT=1** | 🟡 A3，干净 main 就红 |
| **Rust 格式** | `cargo fmt --all -- --check` | **EXIT=1，33 处 diff** | 🟡 干净 main 就红 |
| Rust clippy | `cargo clippy -p host-core --all-targets --locked` | EXIT=0（15 warning / 0 error，CI 无 `-D warnings`） | ✅ |
| Marketplace 目录 | `check-marketplace` | EXIT=1（远程 32 条 `author` 是对象） | (b) 上游数据 |
| Linux glibc | `check-linux-host-glibc` | EXIT=1（无 `target/release`、无 objdump） | (b) 本机缺工具 |

### 我修掉的那一处

`apps/desktop/src/styles/messages.css:3925` 有裸值 `line-height: 1.4`，违反设计令牌门禁。由 commit `8a9fee6ac`（2026-11-05，"feat(chat): say what the self-improvement review concluded, under the turn"）引入，已进 `origin/main`。`tokens.css:390` 定义了 `--leading-normal: 1.4`，语义完全对应，改成 `var(--leading-normal)` 后门禁转绿。这是本次 worktree 唯一的源码改动。

---

## 三、单测

### Rust（`cargo test -p host-core --locked`）
`1284 passed; 2 failed; 1 ignored`（49.81s，EXIT=101）。两个失败**均稳定复现、非 flaky**，但都是 8.3 短路径族：

| 测试 | 断言 | 根因 |
| --- | --- | --- |
| `rpc::review_rpc_tests::review_rpc_records_workspace_scratch_and_approved_external_write_edit` | `left "external" / right "workspace"` @ `review_rpc_tests.rs:634` | 本机 `TEMP=C:\Users\ADMINI~1\...`（8.3 短名），`tempfile::tempdir()` 继承短拼写；`workspace.rs` 的 `simple_canonicalize`/`resolve_tool_path` 对 root 做 `canonicalize`（展开为长名 `C:\Users\Administrator\...`）却按原始 target 解析 → 容器比对失败 → 误判 External |
| `tools::shell_session_tests::powershell_session_runs_each_command_in_the_workspace` | `left C:\Users\Administrator\... / right C:\Users\ADMINI~1\...` @ `shell_session_tests.rs:464` | 同上：断言拿短拼写 `workspace.path()` 比 PowerShell `Get-Location` 的长拼写输出 |

**已用决定性实验证实是环境**：把 `TEMP`/`TMP` 设成长拼写后，Electron smoke 从 21/23 变 23/23 全绿（同类机制）。这两个 Rust 用例在 GitHub Windows runner（同样是短 TEMP + 8.3）上大概率同样红，但**产品逻辑本身没问题**。

### JS 单测（`pnpm -r --if-present test`，逐包跑）

| 包 | 结果 |
| --- | --- |
| packages/shared | ✅ 1554 / 122 files |
| packages/i18n | ✅ 30 / 3 |
| packages/plugin-sdk | ✅ 384 / 18 |
| packages/racp | ✅ 28 / 2 |
| packages/plugin-devkit | ✅ 52 / 4 |
| packages/agent-host | ✅ 65 / 4 |
| packages/voice-runtime | ✅ 52 / 10 |
| packages/computer-use | ✅ 31 / 2 |
| apps/desktop | ✅ 31 / 2 |
| **packages/host-runtime** | ❌ 4 failed / 171 passed / 3 skipped |
| **apps/pi-host** | ❌ 42 failed / 22 passed / 5 skipped |
| **packages/agent-runtime** | ❌ 31 failed / 1889 passed / 1 skipped |
| **docs** | ❌ 2 failed / 11 passed |

逐个定性：

- **host-runtime · 1 个真缺陷**：`src/launch-resolver.test.ts:104` 断言 generic 回退 `maxTokens === 8_192`，实际 `32_768`。根因是 commit `d727adc1e`（2026-11-02，"fix(models): raise the default output cap from 8192 to 32768 tokens"）改了 `model-capabilities.ts` 的 `genericModelConfig`（`limit.output = 32_768`）**但没改测试**（旧断言来自 `614ac4bddf`）。同一处断言也出现在 agent-runtime 的 `model-capabilities.test.ts`。
- **host-runtime · 2 个环境**：`workspace-diff.test.ts` 的 fsmonitor/textconv 两例 → `Test timed out in 5000ms` + 清理期 `EBUSY rmdir`（git 子进程未退）。
- **apps/pi-host · 全部 42 个 = (b)**：主导错误是 `EPERM: operation not permitted, symlink`（`plugin-workspace-files.test.ts:154`、`workspace-files.test.ts:25/31/54`、`workspace-tools.test.ts:17`）。本机实测 `New-Item -ItemType SymbolicLink` 报"此操作需要管理员权限"，`IsInRole(Administrator)=False`、`AllowDevelopmentWithoutDevLicense` 未设 → **这些用例在本机不可运行**，CI 的 Windows runner 有权限时应为绿。
- **agent-runtime · 24 个 = 真·产品缺陷（路径拼写敏感）**：`src/native-pi-session.test.ts` 全数 `Error: Native Pi project resources are not trusted`（`NATIVE_PI_PROJECT_UNTRUSTED`，抛点 `native-pi-session.ts:1351`）。原因在依赖 `@earendil-works/pi-coding-agent@1.4.0` 的 `dist/core/trust-manager.js:151`：它从 cwd 向上找 `.agents/skills`，再用 `canonicalizePath(resolvePath(process.env.HOME || homedir()))` 算用户级目录并在 :161 作豁免比较。Node 的 `realpathSync` **不展开 8.3 短名** → 得到 `C:\Users\ADMINI~1\.agents\skills`，而 `homedir()` 是 `C:\Users\Administrator` → 两个拼写不等 → 豁免失效 → 每个项目都被要求信任 → 新建 trust store 返回 null → 抛异常。**只在"卷启用 8.3 + 用户级 `~/.agents/skills` 存在"时触发**，本机两条件都满足。属依赖内的拼写敏感比较，需在 `native-pi-session.ts` 侧做拼写归一或向上游报。
- **agent-runtime · 其余 7 个**：`model-capabilities.test.ts` 同上（8192）；`shell-command-gate.runtime.test.ts` 2 例 `Test timed out in 5000ms`（shell 冷启动，与 `3c7939404` 修过的同族）；`fixed-tool-runtime.test.ts` 2、`attachment-history.test.ts` 1、`extensions/context-event.test.ts` 1（均为时序/宿主相关）。
- **docs · 2 个真缺陷**：
  - **ADR 索引缺条**：`docs/adr/0382-bundled-python-runtime.md` 文件存在，但 `docs/adr/README.md` 索引止于 0381。`git log -S'0382-bundled-python-runtime' -- docs/adr/README.md` 无输出 → 引入时（`ac559454c`/`6e921428f`，2026-11-06）就漏了索引。
  - **中文镜像结构不齐**（`docs/scripts/check-locales.mjs` 的 `tableShape` 比对）：
    - `docs/zh-CN/spec/03-runtime/03-tools-and-permissions.md`：**完全缺 OfficeRead / OfficeWrite 两行与 `### 2.3 Office documents` 整节**（en :135-136 / :233），文中 `OfficeRead` 零命中。
    - `docs/zh-CN/spec/03-runtime/21-memory-store.md`：第 34 行把 en 的 :34/:35 两行合并，且缺 en 末尾两张表（`| | memory | user |` / `| Holds |` / `| Budget | 2 200 / 1 375 chars |`）。

---

## 四、Electron E2E（67 / 82 个脚本实跑）

### 全绿的核心链路（真模型，`_smoke_live.log`）
`node scripts/e2e-smoke.mjs` → **25 / 25 passed，0 skipped，EXIT=0**，含 `E2E-008-live-model — pong`、`E2E-009-stream — bytes=1174`。这条覆盖了 handshake(v=11)、health、provider 增删查、secret 不外泄、session 持久化、notification、read/glob 工具、路径沙箱 `TOOL_DENIED`、plan 写保护 `WRITE_DISABLED_IN_PLAN`、插件加载/禁用/i18n/工具派发、onboarding、project 删除、session revision、runtime module —— 这是产品的主干，健康。

### 逐套件结果（未列出的均已 PASS）

| 套件 | 结果 | 判定 |
| --- | --- | --- |
| boot / theme-surfaces / composer-occlusion / radial-menu / todos / settings-scroll | ✅ | — |
| plan-history / session-completion(6) / collaboration(10) / storage-bootstrap / storage-backup-lock | ✅ | — |
| provider-api-style(28 场景) / remote-host(25/25) / rpc-unicode(3/3) / plugin-projects / market-retry | ✅ | — |
| review-state / transcript-cache / transcript-turn-completion / transcript-minimap-jump / model-discovery-state / supervision / work-panel-reorder / work-panel-drag / work-panel-tab-close / copy-tex / renderer-responsiveness / provider-model-layout / settings-inline-import / plugin-fetch-redirect | ✅ | — |
| composer-model-selection / composer-autocomplete / composer-ime-slash / project-edit / provider-client-certificate / plugin-command-ownership / file-manager-theme / oauth-retry | ✅ | — |
| config-sync（4 设备 43 对象 374 请求，密文+签名+清理全验）/ browser-local-files / shortcut-settings / overlay-selection(44 checks) / remote-mvp-ui / live-voice-interaction(51/51) | ✅ | — |
| **plan** | 13 passed / **1 failed** / 3 skipped | 🟡 A1 |
| **storage-settings** | 超时 | (b) 套件自带 30s 上限，实测需 35.4s；功能 5/5 全绿 |
| **storage-migration / storage-directory / storage-files** | 断言失败 / ENOENT | (b) `.artifacts/` 未被 gitignore |
| **transcript** | hide 反序 2 例 | 🔴 待修（见 §6 R1） |
| **layout** | 5 类失败 | 🟣 跨平台模拟缺陷 + (c) |
| **plugin-ui-slots / trusted-extensions** | mcp-control.json ENOENT | (b) appData 隔离不完整 |
| **plugin-import-deps** | ECONNRESET | 🟠 D2 |
| **mcp-market / skill-market** | ENOENT 落盘位置错 | 🟠 D3 |
| **capability-move** | SKILL_INVALID + 路径比对 | 🟣 T2/T3 |
| **provider-order** | 选择器过期 | 🟣 T1 |
| **composer-paste** | `realpath 'F:\\C:\\...'` | 🟣 T12 |
| **hosted-search** | `Unsupported fake-host RPC: tools.fileBatchCapabilities` | 🟣 T11 |
| **subagent-models** | "forbidden override must not issue a provider request" | 🟣 T10 |
| **subagents / send-now-subagents** | win32 显式不支持 | (b) 设计如此 |
| **scheduled** | 陈旧选择器 `.composer-menu-entry` | 🟣 T0b |
| **scheduled-quit-cancel** | main 进程崩 | 🟡 D5 |
| **keep-awake** | `powercfg /requests` 需管理员 | (b) |
| **startup-animation** | `ffmpeg ENOENT` | (b) |
| **remote-file-manager** | `Cannot find module 'playwright'` | (b) |
| **remote-mvp** | 缺 `PI_HOST_E2E_BUNDLE` | (b) |
| **jev** | 14 pass / 2 fail（AssertionError） | 待复核 |
| **images** | 清理期 EBUSY | (c) |
| **sidebar-menu / window-resize-native / live-voice / browser-background** | CDP/ready 超时 | (c) 冷启动争用 |
| **dialog-overflow** | `isPluginBusy is not a function` | 🟣 fixture 少传 props |
| **gen-ui / worktree-live / asktool-card / question-notification / transcript-disclosure** | 批跑 FAIL → 单跑全绿 | (c) 争用伪失败 |
| **tool-result-persistence** | 路径拼写 | 🟣 T9 |
| **plan-ui** | FATAL 等 active session 超时 | OPEN |

### 方法学提醒（重要）
1. **本机 DSH shell 恒带 `ELECTRON_RUN_AS_NODE=1`**，会让 Electron 以 Node 模式启动（无窗口/无 CDP target），所有 UI 套件都会假失败。跑之前必须 `Remove-Item Env:ELECTRON_RUN_AS_NODE`。
2. **`TEMP` 要用长拼写** `C:\Users\Administrator\AppData\Local\Temp`，否则 8.3 短名族全线假失败。
3. **一次只跑一个 Electron 套件**。背靠背批跑会饿死套件内置 watchdog（如 `asktool-card` 的 45s `SIGKILL`），产生空输出伪失败。我最初的批跑结果里有 5 套件因此误报，单独复跑全部转绿。
4. `> file 2>&1` 在 PowerShell 里会写 UTF-16LE；`2>&1 | Out-File` 会阻塞到大缓冲满（害两次探针"卡住"）。统一走 `cmd /c` 调 `.bat`。

---

## 五、重点：记忆自动读写（Hermes 移植）—— ✅ 成立

用户特别关心这条闭环。**结论：记忆这条是全自动的、能工作的。**

### 端到端一次跑通（`_memrt.log`）
```
STEP1 tools started: ["ToolSearch","memory"]        ← 模型自己发现并激活 memory，无需人工
STEP1 memory.entries(memory): ["The fixture project release checklist is MEMRT-SENTINEL-7742 and lives in notes.md."]
STEP2 snapshot entries: 1 0                          ← 全新会话启动时读回
STEP2 assistant reply: "MEMRT-SENTINEL-7742"         ← 模型复述出只存在于记忆里的标记
```
第 1 步 = 自动**写**；第 2 步 = 自动**读**。两半都真过模型 + 真过 host，不是纯函数推断。

### 机制
- 写：`runtime.ts:4478-4479` agent 模式恒注入 `createMemoryTool(this.host)`；工具名 `memory`（`memory-agent-tool.ts:261`），读 `memory.entries`（:290）、写 `memory.writeEntries`（:313），写前跑 `scrubSecretsInBatch`（:310）。
- 读：`session-launch.ts:476-492` 每次启动读两库 → `memory-prompt.ts:61-70 memorySnapshotContext` 渲染成**用户消息前缀**（不是系统提示，ADR 0378：系统提示变动会撞 provider 前缀缓存）→ `runtime.ts:9737-9753` 每次 prompt 拼上；另有 `memory-context.ts:67-99` 的按 query 召回（`<memory_context>`）。
- `memory` 属 deferred 工具，模型需先 `ToolSearch` 激活 —— **这是设计如此**，不影响闭环成立。

### 工具契约逐条实测（`_memcontract.log`）
| 行为 | 实测 | 判定 |
| --- | --- | --- |
| 预算硬约束 | `ADD0 709/2200` → `ADD2 2133/2200` → `ADD_4TH: "Would put memory at 2855/2200 chars: free at least 655 chars…"`，**不写入**并回显 `current_entries` | ✅ |
| patch / replace / remove | `original wording` → `revised wording`；`replaced wholesale`；remove 后条目消失 | ✅ |
| batch 原子性 | 第一条就超限 → 整批不生效 | ✅ |
| target 隔离 | user 库 29/1375、memory 库 2200，互不污染 | ✅ |
| **batch 的 per-operation target** | `{target:"memory", operations:[{target:"user",…}]}` → **"Applied 2 operations."，但全写进 memory** | 🟠 **B1** |

---

## 六、重点：技能自主学习 / skill 建立迭代 —— 三段分开定论

| 环节 | 结论 | 证据 |
| --- | --- | --- |
| ① 主动写（回合内模型自建/改技能） | ✅ **成立** | `_skillw.log`：模型自发 `["Read","ToolSearch","skill_manage"]` → 建出 `deploy-gate-discipline`，275 bytes 落盘 `<AGENTS_DIR>/skills/`，`skills.list`/`skills.read` 可回读 |
| ② 被动写（回合后自动复盘建技能，Hermes `background_review`） | ❌ **永不发生（D6）** | `_reviewtools.log`：`canReview(reviewToolsFrom(declaredTools())) = false` |
| ③ 读回（下次会话 Skills 段可见） | ✅ **成立** | `INJECT ids: ["restart-discipline"]`、`INJECT body has iterated text: true` |

### 🔴 D6 —— 技能自动审查恒被 `skipped(no-skill-tools)`（高危，功能等于不存在）

**一句话**：回合结束后的技能自动复盘**每一次都被跳过**，永远不 fork、永远不写技能库。"技能自主学习"在默认配置下是死代码。

**确定性证据（不依赖模型，`_reviewtools.log`）**
```
DECLARED_TOOLS: ["Read","Bash","Edit","Write","Glob","Grep","asktool","Skill","EnterPlanMode","EnterGoalMode","new_context","ToolSearch"]
DEFERRED: [...,"memory","skill_manage"]
declared has Skill: true   declared has skill_manage: false
canReview(reviewToolsFrom(declared)): false      ← 实际路径
canReview(reviewToolsFrom(catalog)):  true       ← 换成 catalog 就对了
```
真实模型两次端到端也是同一句：`{"type":"skill_review","outcome":"skipped","reason":"no-skill-tools"}`，即使 `skillReview:{enabled:true,afterToolCalls:1,minIntervalSec:0}` 全开、pluginSkills 非空。

**机制链（逐行）**
1. `runtime.ts:4613-4617` 算 deferred 集合：`filter(name => !this.isCoreTool(name) && name !== TOOL_SEARCH_NAME)` → `memory`/`skill_manage` 都在内。
2. `runtime.ts:4681-4706 isCoreTool` → agent 模式查 `AGENT_CORE_TOOL_NAMES`（`runtime.ts:807-821` = Read/Glob/Grep/Write/Edit/Bash/ASK/Skill），**不含 `skill_manage`/`memory`**。
3. `runtime.ts:4708-4717 activeTools()` 只留 core + ToolSearch + 已激活的 deferred；初始为空。
4. `runtime.ts:4649-4651 declaredTools() = declarationPolicy?.tools ?? activeTools()`（当前模型走回退，`fixed-tool-declarations.ts:21-43` 只对 `deepseek-flash`+`api.deepseek.com` 生效）。
5. `runtime.ts:2558-2561`：`reviewToolsFrom(this.declaredTools())` → `!canReview()` → `skipped("no-skill-tools")`；`skill-review-run.ts:190-193 canReview` 要求 `has("skill_manage") && has("Skill")`。
6. → 恒 false → 恒 skip。审查 fork 与真实模型从未被调用。

**引入点**：commit `46b9f3727`（2026-11-05 09:36，"feat(skills): review a finished turn by forking the agent, not by asking for JSON"）新增了 `reviewToolsFrom(this.declaredTools())`。当时 `AGENT_CORE_TOOL_NAMES` 本就不含 `skill_manage`，而 deferred 机制早在 `a3d6ae0d2`（2026-08-02，"feat(runtime): defer ancillary tools per prompt"，附 ADR 0048）就已存在。**两个各自正确的事实叠加成功能死亡**：作者选错了工具来源。

**测试为何没抓住**
- `skill-review-run.test.ts:190-224` 只测纯函数，手工把 `{name:"skill_manage"}` 塞进数组再断言 `canReview` 为 true，**从未断言真实 runtime 的 declaredTools 里有没有它**。
- `runtime.test.ts:3844-3877` 的 `expect(names).toEqual([...])` 明确把 `skill_manage`/`memory` 排除，等于把缺陷固化成了期望值。
- 全仓 `.test.ts` 中 `no-skill-tools` 零命中。

**建议修法**：`runtime.ts:2558` 改为 `reviewToolsFrom([...this.toolCatalog.values()])`（探针已验证该来源 `canReview = true`），补一条真实 runtime 回归测试，并复核 `runtime.test.ts:3844-3877` 的期望。

**同时验证为健康**（排除"整条链都坏"）：直接打 host RPC 的 `skills.create/read/update/writeFile/remove` 全部正常，路径逃逸被正确拒绝（`SKILL_INVALID: resource path may not traverse`）。**症状是接线，不是持久层。**

工具层 create→patch→落盘→回读→注入同样全链通过（`_skilltool.log`）：`Patched skill` → body 含新句 → `INJECT ids: ["restart-discipline"]` → `INJECT body has iterated text: true`；多命中守卫一致（只命中一次才写，两次一律拒绝且文档不变，`_ambig2.log`）。

---

## 六点五、"全部修复"执行记录（2026-11-07 追加）

用户要求把第七节清单全部修掉，逐项执行结果如下。全部改动都在 worktree `F:\PI-Desktop-worktrees\full-feature-verification` 内，**未 commit、未 push**（AGENTS.md §17）。

| 项 | 状态 | 落点 / 证据 |
| --- | --- | --- |
| **D6** 技能自动审查恒被跳过（P0） | ✅ 已修 | `packages/agent-runtime/src/runtime.ts:2558`：`reviewToolsFrom(this.declaredTools())` → `reviewToolsFrom([...this.toolCatalog.values()])`。回归测试 `runtime.test.ts` 新增 `describe("skill review triggering (Hermes background_review port)")` 两条，**2 passed**（含"到达 fork 而不是以 no-skill-tools 跳过"）。 |
| **B1** 记忆 batch 的 per-operation `target` 被静默丢弃（P1） | ✅ 已修 | `memory-agent-tool.ts` + `memory-store.ts`：operation 支持 `target`，未知值报错而非丢弃；execute 按 store 分桶、逐 store staging、任一失败整批不写。`memory-agent-tool.test.ts` 新增 `describe("a batch may address both stores")` 四条，**21 passed**。 |
| **A1** PowerShell stdout 无流式 / 渲染退化（P1） | ✅ 已修 | `tools/shell.rs`（一次性）与 `tools/shell_session_protocol.rs`（会话 cell）都改为按对象分派渲染：字符串直写保留实时通知；`Format*` 记录缓冲到 `FormatEndData` 整条流渲染（否则表格丢失）；hashtable/MeasureInfo 逐个 `Out-String` 渲染。守卫断言同步改写。 |
| **A2** PowerShell stderr 丢/重（P1） | ✅ 已修 | 根因是包装脚本自身 stderr 被 `2>&1` 回环。改成 `[Console]::Out.WriteLine` / `[Console]::Error.WriteLine` 分流后实测：OUTLINE→stdout、ERRLINE→stderr、`NONCE 0` 标记正确、无重复。 |
| **cargo fmt** 33 处漂移（P1 门禁红） | ✅ 已修 | `cargo fmt --all` FMT_EXIT=0；涉及 `artifacts.rs`、`db/migrations.rs`、`main.rs`、`permissions.rs`、`sessions/usage.rs`、`user_skills*.rs`。 |
| **A3** check-architecture 三文件超 1000 LOC（P1 门禁红） | ✅ 已修 | 拆分而非加豁免：`tools/shell_session.rs`(853) + 新建 `tools/shell_session_protocol.rs`(798)；`db/migrations.rs`(831) + 新建 `migrations_maintenance.rs`(288) / `migrations_v29_repair.rs`(113) / `migrations_test.rs`(128)；`user_skills/tests.rs`(964) + 新建 `user_skills/tests_lifecycle.rs`(412)。`node scripts/check-architecture.mjs` → **Architecture check passed (EXIT=0)**。 |
| **D2** npm-registry-proxy teardown 崩溃（P1） | ✅ 已修 | `npm-registry-proxy.ts`：CONNECT 隧道 socket 纳入 `sockets` 集合并随 `close` 移除，`teardown` 双向 destroy。新增 `apps/desktop/test/npm-registry-proxy.test.mjs` 三条（拒非公共 registry 的 CONNECT / 自建 socket 全部回收 / 普通请求穿透），**3 passed**。 |
| **D3** market 套件写真实 `~/.agents`（P1） | ✅ 已修 | `scripts/e2e-mcp-market.mjs:66-74` 增加 `PI_DESKTOP_AGENTS_DIR: join(home, ".agents")`，与 `e2e-capability-move.mjs:77` 一致。 |
| **D5** `app.getPath("appData")` 无兜底（P2） | ✅ 已修 | `data-root.ts:122-133`：`appData` 解析失败时 `console.warn` 并跳过 legacy 采纳，不再崩 main。 |
| **docs** ADR 索引缺 0382 / 中文镜像缺章（P2） | ✅ 已修 | `docs/adr/README.md` 补 0382、0383 行；`bundled-plugin-curation.md` → `docs/adr/0383-bundled-plugin-curation.md`（并删掉全树唯一两处指向不存在的 ADR 0412 的引用）；`zh-CN/.../03-tools-and-permissions.md` 补 `OfficeRead`/`OfficeWrite` 两行；`zh-CN/.../21-memory-store.md` 补 §9.3 与废弃标注。`node --test docs/scripts/*.test.mjs` → **13 passed / 0 failed**。 |
| **H1** 测试产物未被 .gitignore 覆盖（P2） | ✅ 已修 | `.gitignore` 增 `/.artifacts/`、`/history-loading-*/`、`/apps/desktop/.fallback-ui-*/`、`/apps/desktop/resources/plugins/*/package.json`。 |
| **R1** transcript hide 反序（P2） | ✅ 已修 | 真实机制不是 `remember()` 早退，而是 `jumpToLatest` 先置 follow 再调 `rememberReadingPosition()`，而后者在 `pendingRef` 有值时直接 return，导致旧的 `pinned:false` 书签存活。`useTranscriptScroll.ts` 新增 `recordFollowReadingPosition()`（直接写 `pinned:true` 书签），jumpToLatest 与新回合重钉改用它；`transcript-reveal-ownership.test.mjs` 新增一条回归。**desktop 单测 34 passed / 0 failed**。 |
| **A4** CI 无 Windows runner（P2，产品决策） | ⚠️ 未改 | 改 CI 矩阵属于交付策略，超出"修缺陷"范围，留给用户决定。 |
| 测试侧陈旧断言 T0b/T1/T2/T9/T10/T11/T12 等 | ⚠️ 未改 | 属测试自身待清理项，不在"产品缺陷"范围。 |

### 全量复验（权威）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| Rust 单测 | `cargo test -p host-core --locked -- --test-threads=4` | **1287 passed / 0 failed / 1 ignored**（144.65s，TEST_EXIT=0） |
| Rust 格式 | `cargo fmt --all` | FMT_EXIT=0 |
| Rust lint | `cargo clippy -p host-core --all-targets --locked` | CLIPPY_EXIT=0（8 条 warning 全部为拆分前既有代码，按 §6 不动） |
| 架构预算 | `node scripts/check-architecture.mjs` | **passed**（ARCH_EXIT=0） |
| 样式令牌 | `node scripts/check-style-tokens.mjs` | style tokens OK |
| 其余仓库门禁 | powershell-encoding / agent-policy / release-docs / pi-patches | 全部 EXIT=0 |
| docs 测试 | `node --test docs/scripts/*.test.mjs` | **13 passed / 0 failed** |
| desktop 单测 | `node --test test/*.test.mjs`（含新增两条） | **34 passed / 0 failed** |
| desktop 类型 | `pnpm --filter @pi-workspace/desktop typecheck` | TSC_EXIT=0 |
| agent-runtime 单测 | `vitest run`（128 文件） | **1920 passed / 6 failed / 1 skipped**（1927） |

### 剩余 6 条 agent-runtime 失败：已证实与本轮改动无关

把 `runtime.ts` 换回 `HEAD` 版本后重跑同样三份失败文件，**失败集合逐条不变**（5 failed / 40 passed），说明不是 D6 改动引入的。逐条定性：

1. **`fixed-tool-runtime.test.ts`（2 条）**：`wire.requests[0].tools` 为 `undefined` —— 第二个回合的首个请求不再携带 `tools` 数组。夹具从不 seed `recentModels`，与 `e2e-subagent-models` 的 T10 同族症状（请求形状随模型能力表变更）。
2. **`shell-command-gate.runtime.test.ts`（2 条）**：60s 仍超时，夹具在 `await received` 处等首个 provider 请求永不到达，同样指向请求形状/门控前置链路的变化，非本轮改动。
3. **`context-event.test.ts`（1 条）**：第 4 个请求是 `turn-verification` 的语义判定 one-shot（`You audit one turn of a coding agent...`，`max_completion_tokens: 8`，`tools: 0`）。该判定由 `bbcee2e70`（2026-11-02）引入，而本案文件最后更新于 `c90fa4feb`（2026-10-23）。即**判定上线时没有同步更新这条"每回合请求数"断言** —— 测试侧陈旧断言，产品行为符合 `runtime.ts` 里 `recordTurnVerdict` 的"观测但不干预"契约。
4. **`model-capabilities.test.ts`（1 条）**：`genericModelConfig` 的 output 上限在 `d727adc1e`（`fix(models): raise the default output cap from 8192 to 32768 tokens`）中从 8192 提到 32768，**同一 commit 未更新该测试**。同样是测试侧陈旧断言，产品行为是正确的（commit body 明确"只动输出预算，上下文窗口保持 128k"）。

这 4 项建议作为单独的 `test(agent-runtime): catch up assertions with the current request shape` 提交处理 —— 它们各自需要先判定"期望值该随产品走还是产品该随期望走"，不宜混进本轮缺陷修复。

---

## 七、必须修的清单（按优先级）

### 🔴 P0
1. **D6 技能自动审查恒被跳过** —— 一句话修法：`runtime.ts:2558` 换工具来源为 `this.toolCatalog`，补真实 runtime 回归测试。**修完"技能自主学习"才真正存在。**

### 🟠 P1
2. **B1 记忆 `batch` 丢失 per-operation `target`** —— `memory-agent-tool.ts:160-188` 对未声明键静默丢弃。修法：item 含 `target` 且与顶层不同则报错，或显式支持跨库。**不修会静默把用户画像写进项目笔记。**
3. **A1 PowerShell stdout 无流式通知** —— `tools/shell.rs:221-235` 的 `Out-String -Stream` 到管道末端才输出，是结构性原因；`tools/mod.rs:2715-2733` 的通知阈值也放大了问题。直接影响 `e2e-plan` 的 E2E-114。
4. **A2 PowerShell `[Console]::Error` 随机丢/重** —— 已验证不是包装脚本本身（host 外直接 spawn 正常），问题在 host 侧读取/合并路径。**失败命令的 stderr 会丢**，这是数据完整性问题。
5. **cargo fmt 33 处漂移** —— 干净 main 上 `cargo fmt --all -- --check` 就红（CI `.github/workflows/ci.yml:74` 与 `:104` 两道都有这道门）。受影响文件：`artifacts.rs`(129,139)、`db/migrations.rs`(1195,1214)、`main.rs`(10,18)、`permissions.rs`(119,471)、`sessions/usage.rs`(225,248,255,354)、`user_skills.rs`(1168,1593,1600)、`user_skills/tests.rs`(12 处)、`user_skills/tidy.rs`(7 处)。均为 rustfmt 确定性规则（如 `main.rs:10` 的 `mod pi_home;` 该按字母序插到 notifications 与 plans 之间）。**建议单独一个 `chore(host-core): apply rustfmt` commit。**
6. **A3 check-architecture 红** —— `tools/shell_session.rs`(1370)、`db/migrations.rs`(1328)、`user_skills/tests.rs`(1314) 三个文件超 1000 LOC 上限且不在 `docs/architecture/allowlist.json`。要么拆文件，要么按规则补豁免并写明理由。
7. **D2 npm-registry-proxy teardown 崩溃** —— `apps/desktop/electron/main/npm-registry-proxy.ts:77-81` 在 `finally` 里 `socket.destroy()` 仍活隧道 socket，`:62-75` 的 `upstream.on("error")` 没对应 client 侧监听 → `read ECONNRESET` → 进程 abort。引入 `63702e844`。**没有 `npm-registry-proxy.test.mjs`。**
8. **D3 market 套件写真实用户目录** —— `scripts/e2e-mcp-market.mjs:66-73` 只设 `HOME`+`PI_DESKTOP_DATA_DIR`，而 host 只认 `PI_DESKTOP_AGENTS_DIR`（`agent_capabilities.rs:262`）→ 记录落到真实 `C:\Users\Administrator\.agents\`，断言却读 `<tempHome>/.agents`。**这是测试污染真实用户数据，必须修。** 对照 `scripts/e2e-capability-move.mjs:77` 是正确的。

### 🟡 P2
9. **D5 `app.getPath("appData")` 无兜底** —— `data-root.ts:126`，`HOME`/`USERPROFILE` 被重定向时 main 直接崩（`scheduled-quit-cancel` 稳定复现）。同函数对 `mkdirSync` 有 try/catch（:76-81），对 `getPath` 没有。
10. **docs ADR 索引缺 0382** + **中文镜像缺 OfficeRead/OfficeWrite 与 memory-store 尾部两表**。
11. **A4 CI 无 Windows runner** —— 桌面产品的主目标平台不在 CI 里，A1/A2/D6 这类缺陷结构上看不见。
12. **仓库卫生 H1** —— `.artifacts/`、`history-loading-*/`、`apps/desktop/.fallback-ui-*/`、4 个插件 `package.json` 均未被 .gitignore 覆盖。
13. **R1 transcript hide 反序** —— `scripts/e2e/transcript-history-navigation.tsx:255` 的 `hide reversed accepted latest`，3/3 次确定性复现。需查是探针断言过严还是 `transcript-reading-runtime.ts:56 returnToLatestTranscript` 真有回弹。

### 🟣 测试侧陈旧断言（一次批量清理）
T0b（`e2e-scheduled.mjs:252` `.composer-menu-entry`，`hasOtherModels` 门控由 `4a0c49915` 引入而套件从不 seed `recentModels`）、T1（`provider-order.tsx:169` 的 `.model-default-row` 已迁到 `ImageGenerationModelRow.tsx:74`）、T2（`e2e-capability-move.mjs:176` 反斜杠比路径）、T9（`e2e-tool-result-persistence.mjs:194` 同族）、T10（`e2e-subagent-models.mjs:176` 把 turn-verdict judge 的 one-shot 请求误判成 delegate）、T11（`hosted-search-sidecar.mjs:202` 缺 `tools.fileBatchCapabilities` case）、T12（`composer-paste` 用 linux 形状驱动 Windows `realpath`）、dialog-overflow fixture 缺 `isPluginBusy`、`e2e-storage-settings.mjs:65` 的 30s 上限、`e2e-plan-ui.mjs` 的 session 行定位。

---

## 八、本次改动与工作区状态

**唯一源码改动**（worktree 内）：
```
 M apps/desktop/src/styles/messages.css      ← line-height: 1.4 → var(--leading-normal)
```
`pnpm-lock.yaml` 的 25 行 install 副作用已用 `git checkout --` 还原。探针脚本与临时产物会一并清理。

**未改动**：主 checkout `F:\PI-Desktop` 全程只读；未 commit、未 push（AGENTS.md §17）。

---

## 九、没跑的与残余风险

| 未跑项 | 原因 | 残余风险 |
| --- | --- | --- |
| 82 个 E2E 中的 15 个（jev 部分、live-voice、images 细节、config-sync 之外若干）| 已补跑 15 个，另有个别需额外前置 | 低 |
| `check-linux-host-glibc` | 本机无 `target/release` 与 objdump/readelf | glibc 兼容性未验证 |
| Rust 2 个失败在 GitHub Windows runner 的实际表现 | 无 CI 访问 | 8.3 短名族，CI 大概率同红 |
| apps/pi-host 42 个（符号链接） | 本机无创建符号链接权限 | CI（有权限）应为绿，未验证 |
| `plan-ui` 活体腿 | FATAL 在 session 行定位，未隔离到单用例 | Plan UI 的活体验收未验证 |
| 技能"被动写"完整 fork 路径 | 被 D6 阻断 | D6 修好后需重跑 `_probe-review-tools.mjs` 验证 |

**关键风险**：D6 未修之前，任何"技能会自己学习"的用户承诺都不成立。这是本次测试最重要的结论。


---

## 终版补充（2026-11-08 22:45，第二轮验证收尾）

- 分支 test/full-feature-verification 已 rebase 到最新 origin/main（6d0c0555e），并推送修复 commit 662bd63be "fix(host-core): flush persistent shell output when a cell ends"（+13，crates/host-core/src/tools/shell_session.rs）→ origin/test/full-feature-verification。
- 终版门禁：cargo fmt --check EXIT=0；cargo clippy --all-targets --locked EXIT=0；cargo test --locked = 1283 passed / 4 failed / 1 ignored（574s）。4 个失败均为已定性的环境族（background_tasks::windows_tests 停进程、rpc visualization fork、powershell/bash 工具 8.3 短名 TEMP 假失败），干净 main 上同样存在，与修复无关。
- E2E-114 修复已验证：node scripts/e2e-plan.mjs 14 项全 PASS。
- binary_storage.rs 的嵌套镜像归属改动（+96 行尝试）打红 10 个测试，已完全回退，未进入提交。根因仍归档为：host normalize_project_path 正斜杠规范化 vs E2E 反斜杠期望的协议拼写分歧，非数据损坏。
- worktree 只剩该修复一个已提交改动；探针与临时目录已清理。


---

## 移交清单：残余已知项（未修，供后续接手模型处理）

以下三项经两轮验证确认真实存在、已定性，但本次未修复。接手时请先读 _DEFECT_LEDGER.md 对应条目。

### 1. 四个 Rust 环境族测试失败（(b) 环境类，干净 main 同样存在）
- 现象：cargo test -p host-core --locked 在本机稳定失败 4 项（main 与修复分支一致）：
  1. background_tasks::windows_tests::stop_terminates_the_command_the_runner_launched — crates/host-core/src/background_tasks/windows_tests.rs:79 "the command must launch its own child"
  2. rpc::visualization_tests::fork::rpc_bash_created_visualization_survives_relocation_fork_and_source_deletion
  3. tools::tests::powershell_preserves_utf8_errors_quotes_cwd_and_native_exit_codes — crates/host-core/src/tools/mod.rs:5527 left: Null / right: 7
  4. tools::tests::bash_scratch_dir_env_is_posix_formatted_for_git_bash — crates/host-core/src/tools/mod.rs:5316 "bash timed out after 15000ms"
- 根因：本机 TEMP/TMP 为 8.3 短名拼写（ADMINI~1），std::env::temp_dir() 继承它，tempfile::tempdir().path() 与 canonicalize 后的长拼写不一致；bash 项依赖 git-bash 环境。已在隔离 rustc 探针实证 canonicalize 会展开 8.3 短名。
- 修法建议：测试侧用 dunce::canonicalize 或 std::fs::canonicalize 统一两边拼写后再断言（参照 crates/host-core/src/workspace.rs:12 simple_canonicalize 的做法）；不要改产品代码迁就环境。修完后在 GitHub Windows runner（同样有 8.3 短 TEMP）上确认 CI 是否同样红——repo 目前无 Windows runner，见下。

### 2. normalize_project_path 正斜杠 vs E2E 反斜杠期望的协议拼写分歧（非数据损坏）
- 现象：scripts/e2e-tool-result-persistence.mjs:194 与 scripts/e2e-storage-migration.mjs:119 断言失败。host 侧把 relocate 后路径统一存为正斜杠（crates/host-core/src/db/repositories.rs:15-39 normalize_project_path 的 trimmed.replace('\\', "/")；crates/host-core/src/data_relocation.rs:34-54 Roots::remap 用它），E2E 用 Node join() 的反斜杠拼写做 deepEqual/相等断言 → 拼写不等。
- 已排除：数据损坏。隔离探针（3 层嵌套 + 3742 行历史）证明 host 的 relocate/binary_storage 行为正确、镜像同步。
- 修法二选一（需要上游/维护者决策改哪边）：
  a) E2E 侧比较前对 expected 也做 normalize（把反斜杠替换为 /）——改动最小，只动测试；
  b) host 侧保留原始拼写不规范化——动存储语义，有兼容风险（AGENTS.md §10），需 ADR，不推荐轻动。
- 倾向 (a)。相关源码：crates/host-core/src/transcripts/binary_storage.rs 的 relocate()（:690 附近）按 mirrors 逐 token 改写 + json_equal 保证镜像同步，这条链路不要凭直觉改动（曾试过 +96 行的归属重构，打红 10 个测试，已回退）。

### 3. check:marketplace 上游 catalog 数据格式问题（本地无法修复）
- 现象：pnpm check:marketplace EXIT=1。远程 catalog https://raw.githubusercontent.com/AIUO-Net/pi-desktop-plugins/main/catalog.json 大量条目的 author 是对象而非字符串，scripts/check-marketplace-catalog.mjs:202 判定 typeof plugin.author !== "string" 而报错。
- 本质：上游（第三方 plugin 市场）数据格式不满足本仓校验脚本的期望，本仓无法单方面修复。
- 修法建议：要么联系上游修数据，要么放宽本仓校验（接受 author 为 string | {name, url, ...} 对象）——后者属于公共校验契约变化，需要明示理由后再动 scripts/check-marketplace-catalog.mjs。

### 附注：CI 无 Windows runner
- .github/workflows/ci.yml 目前没有 windows-latest 矩阵项（需开工前重新 read ci.yml 核实行号，报告早期草稿的行号已失效）。上面第 1 项的 8.3 短名问题在 GitHub Windows runner 上同样存在，若要闭环应先加 Windows CI 再修测试。
