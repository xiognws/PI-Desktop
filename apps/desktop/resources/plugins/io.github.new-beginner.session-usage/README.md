# 会话用量增强版（Session Usage Plus）

PI-Desktop 插件。在**右侧工作面板顶部的视图菜单 → 会话用量**查看会话的 token 用量，无需另开窗口。

**当前版本：1.6.4**。发布采用运行文件白名单，开发记录和截图不进入当前仓库与安装包。子代理按钮和回复明细只显示 **子代理1、子代理2……**，编号无法确认时显示 **子代理？**。内部身份仍用于准确统计与去重，代理按钮随会话动态出现，按模型独立汇总。权限不变，**不改宿主或队列**。

本项目由 **new-Beginner** 维护，fork 自 [LectWolf/pi-session-usage](https://github.com/LectWolf/pi-session-usage)，保留原作者贡献和 GPL-3.0-only 许可证。1.6.2 起采用独立插件 ID，不覆盖原版市场条目。**安装增强版前停用原版**，避免重复的 `/usage` 命令和视图；旧插件设置不会自动迁移。

只发布插件源码、合成测试、必要发布脚本、使用说明和许可证。本地任务记录、验证日志、截图、凭据和真实会话数据不应提交；历史提交不因当前分支的删除而自动消失。

1.6.4 适配官方发布 MCP 支持的 locale 字段；统计逻辑和权限不变。中文历史更新记录保留在仓库的 [CHANGELOG.md](https://github.com/new-Beginner/pi-session-usage/blob/main/CHANGELOG.md)，全局更新日志仍在 manifest 中。

**覆盖边界：**PI-Desktop 0.18.0 主代理完成时独立保存检查点；只统计明确完成且有真实 usage 的快照，不统计 streaming，不按正文估算。宿主不为子代理保存独立检查点，因此子代理仍需可读的队列/JSONL/SQLite 来源；队列满且子代理尚未保存时仍无法实时显示。不是逐 token 计数，不宣称读取所有代理的内存事件。

**1.2.0 升级须知：**需要 PI-Desktop ≥ 0.17.0，并重新加载/安装以确认新增的 **`renderer.extension` 高风险权限**。仅保存开发插件文件不会授予新权限。

输入框输入 **`/usage`**，或命令面板搜「用量」，可恢复跟随当前会话、刷新用量并显示摘要与入口提示；命令不弹窗，也不会自动展开右侧面板。

- 插件 id：`io.github.new-beginner.session-usage`
- 许可证：[GPL-3.0-only](./LICENSE)
- 源码 / 主页：https://github.com/new-Beginner/pi-session-usage
- 原版作者：[LectWolf](https://github.com/LectWolf/pi-session-usage)

## 会显示什么

- 输入（未命中缓存）
- 缓存命中 / **缓存创建**（Claude 的 `cache_creation_input_tokens`，含 5m / 1h）
- 输出、思考
- **命中率** = 缓存命中 /（未命中输入 + 缓存命中 + 缓存创建）
- 逐次用量柱状图、明细、按模型拆分（有助手记录时对应回复；数据库 operation 无时间/耗时则明确标示未记录）

### 切换主代理与子代理

- 没有子代理且总和与主代理完全一致时，隐藏顶部及累计、历史图的代理选择器，直接展示主代理数据。新增首个子代理时自动出现选择器并默认查看总和。
- 有子代理时显示 **总和、主代理、子代理1、子代理2……**；顶部选择同时切换累计和历史图，两者不同则显示「自定义」。回复明细始终跟随历史图，模型区不受影响。
- 子代理按照首次识别顺序编号，只显示「子代理1」「子代理2」等短名称，编号无法确认时显示「子代理？」。同名、同模型不会混算；内部仍以 `delegationId` 和调用血缘识别。复用调用合并成同一个子代理，完成、失败或停止后按钮和历史仍保留。
- **按模型**从全会话的去重请求统计，同一模型跨主代理及全部子代理合并；多模型显示 **总和、模型A、模型B……**，只有一个模型时隐藏筛选。缺少模型身份的逐次记录列为未知模型。
- 图表选择哪个代理，明细就显示该代理的请求并标明身份。悬停/键盘聚焦柱子查看对应请求；累计和模型选择不会改变明细。普通刷新保持选择与滚动；切换会话不会遗留不存在的子代理，返回同会话恢复本次面板中保留的选择。
- 未知归属只计入**总和**，不猜测主/子代理。已有真实用量在运行中和读取异常时保持可见；不再显示黄色告警、统计不完整和内部诊断码。没有可显示数据时仅用灰色空状态说明，不伪造零。
- 全局范围下方显示会话级对账，精确列出总和、主代理、子代理和未归属的次数/Token，不使用 k/M 缩写凑平。切换任一区域范围不会改变这份会话对账。未知记录补齐相同 operation 的身份后自动移入主/子分区，累计不重计。
- 仅有回合汇总时显示可用累计，不伪造历史柱、回复明细或模型次数。存在逐次记录时不叠加无法关联的汇总。

**统计依据：**对选中会话合并 `sessions/<id>.jsonl`、`sessions/<id>.inflight.json` 中 schema=1、身份匹配且 status 为 complete/error/aborted 的助手真实用量、`pi.sqlite` 的 `turns.usage_json`，以及 `session-message-outbox.json` 中明确属于该会话的用量/助手元数据。`parentToolCallId` 提供真实血缘；裸 operation 缺少血缘只计入总和。按 operationId 精确关联，兼容 `desktopUsage` 和 `message:<sessionId>:<messageId>` 身份，同一 operation 取较大的已报告总量。不按模型或时间猜归属，不重复相加 aggregate 和 operations。检查点覆盖/删除及队列排空不撤回已测得用量，后续落盘补元数据但不重计。插件设置只保存最近 16 个明确查看过会话的完成 token/身份元数据，等待本次明确会话身份后才恢复；不保存正文、思考、工具参数或 cost。这些官方本机格式并非稳定 SDK，宿主升级可能需要适配。

### 查看历史回复用量

- 累计统计下方的 **Token 用量趋势** 中，每根柱子代表一次可验证的 operation 或带用量助手回复，不是整轮用户提问。工具调用后的模型输出也会单独计数。仅数据库记录无回复时间时按持久化顺序展示，不伪造时间或耗时。
- 柱高 = 输入 + 缓存命中 + 缓存创建 + 输出；思考单独显示在明细中，不另行堆叠，避免可能与输出重复。原有合计算法保持不变。
- 鼠标停在柱子上，下方明细显示该次模型、时间、耗时、命中率及 Token；移到柱间空隙、卡片或面板外后保留最后查看的回复。上方累计数据不变，明细范围始终跟随图表。
- 可用 Tab 聚焦柱子查看；鼠标或键盘最近选择的记录持续保留，失焦不恢复最新。
- 长会话可横向滚动，首次定位最新；普通更新保留所选记录与位置。主代理或子代理每新增一条完成用量，自动显示最新记录并滚动到末尾，不需要等待整个会话结束；重复通知不打断查看。切换会话重置，没有逐次用量的记录不虚构成柱子。

## 跟随当前对话

- 默认显示 **跟随当前会话**：主界面 A → B → A 时，用量随实际显示的对话切换；当前会话正在生成时也不会被旁边的聊天抢走。
- 在视图顶部手动选择历史会话，会进入 **固定查看**；点击 **跟随当前会话** 或运行 `/usage` 恢复自动跟随。
- 可见视图每秒检查轻量会话上下文。已选 JSONL、完成检查点、SQLite/WAL 和待持久化队列变化以固定 25 毫秒短窗口触发合并，立即唤醒 `usage.watch`；不等整个任务结束。每 750 毫秒仅检查文件状态，为监听失效/漏通知兜底，空闲时不重复解析正文或查库。不监听 SHM；最多 20 秒的等待只是空闲保活。
- 打开会话搜索时不替换输入框；若主界面已切换，顶部提示待更新，关闭搜索后立即更新。同一会话保留滚动位置，换会话重置。
- 空白会话显示暂无带用量的回复；无会话、未授权或识别失败时明确提示，绝不拿最近会话冒充当前会话。

识别来自主界面的 `data-session-pane` / `data-visible` 属性，空白会话补充读取选中行的 `data-sidebar-session-row`。这些是 **0.17.0 已核实的 DOM 标记，不是稳定 SDK 会话接口**，未来宿主改动可能需要适配；有多个候选或缺少标记时会停止自动跟随并提示，可手动选择历史会话。`session:activated` 尚未实现，因此不能靠该事件获取当前会话。

## 安装

1. 打开 [Releases](https://github.com/new-Beginner/pi-session-usage/releases)，下载最新的 `io.github.new-beginner.session-usage-*.piplug`
2. PI-Desktop → **插件** → **安装 .piplug**
3. 确认权限：`ui.view` 和 `renderer.extension`
4. 展开右侧工作面板，从顶部视图菜单选择 **会话用量**

开发加载：插件页 **加载开发插件**，选本目录。

**从旧版本升级：**重新加载本目录并确认 `renderer.extension` 权限。若显示“等待主界面会话识别”，请检查权限及宿主版本，然后重新打开对话。如果视图菜单没有出现，检查插件是否已启用，且激活范围包含当前项目（或设为全局）。

## 权限与安全说明

| 权限 | 用途 |
| --- | --- |
| `ui.view` | 在右侧工作面板显示会话用量 |
| `renderer.extension` | 在主界面观察会话 ID 属性，通过白名单 `plugin.call` 传给用量后台；宿主将此权限标为高风险 |

主界面扩展不读取消息或输入框正文、不导入宿主私有状态仓库、不使用内部 IPC、不改主界面。后台只提取本机 JSONL、完成检查点、SQLite 和队列中的用量/归属元数据；不返回或保存消息正文、思考、工具参数/结果、队列键、cost 或凭据，不联网、不注册 Agent 工具，所有宿主来源只读。`rendererActions` 仅声明 `plugin.call`，只允许 `usage.setContext`，不授权读取草稿或插入文字。

### 发布隐私边界

- `.gitignore` 排除任务记录、截图、验证记录、`.env`、令牌/私钥文件、数据库及真实会话文件；已跟踪文件须先停止跟踪，忽略规则不能清除 Git 历史。
- 安装包只允许 `manifest.json`、`main.js`、两份 renderer、`README.md` 和 `LICENSE` 共 6 个文件；打包脚本拒绝缺失文件和符号链接，不扫描整个工作区。
- 忽略规则和文件白名单不能识别源码中的硬编码密钥。提交和发布前仍需进行脱敏凭据扫描；扫描无发现不等于绝对安全。

## 开发

验证：`node --check main.js`、`node --check renderer/session-context.mjs`、`node --test scripts/*.test.js scripts/*.test.mjs`（Node ≥ 22.13，含 `node:sqlite`）。测试使用临时合成 JSONL/SQLite/WAL/队列/检查点/DOM，覆盖满队列下四次独立完成更新、流式/身份/格式拒绝、跨来源去重、检查点覆盖/删除、切换与 reload 恢复、主/子归属、监听兜底、迟到响应及明细联动。

浏览器检查：`node scripts/usage-browser-check.cjs`，需要 playwright-core 和 Chrome/Chromium；可用 `PLAYWRIGHT_MODULE`、`BROWSER_EXECUTABLE` 指定路径。运行真实后台与 scratch 合成来源，通过模拟宿主桥接连接 Chrome，验证 JSONL-only、SQLite/WAL-only、queue-only、checkpoint-only 自动刷新及浅/深 × 320/420/590 布局。生成的 `output/playwright/` 截图仅保留本地，不提交、不打包。

发布白名单回归：`python scripts/pack.test.py`。所有测试只使用临时合成文件，不读取实际令牌。

在 PI-Desktop 中优先使用官方 `PluginCheck` 校验、`PluginPack` 打包；它们使用与安装器相同的规则。仓库也保留原有打包脚本供现有发布流程使用：

```text
python scripts/pack.py
# → dist/io.github.new-beginner.session-usage-<version>.piplug
```

发版：改 `manifest.json` 的 `version`，提交后打标签并推送。

```text
git tag v1.6.4
git push origin v1.6.4
```

GitHub Actions 会核对 tag 与版本号、打 `.piplug`、创建 Release。

官方市场通过 [plugins.aiuo.net](https://plugins.aiuo.net) 创建独立插件、绑定本 fork 并提交 tag 审核；审核通过后平台同步至 [AIUO-Net/pi-desktop-plugins](https://github.com/AIUO-Net/pi-desktop-plugins)。不要向分发仓库提交源码或手改 catalog。

需要 PI-Desktop ≥ 0.17.0。参考[官方视图文档](https://github.com/vastsa/PI-Desktop/blob/main/docs/plugin-development.md#68-work-panel-view)和[renderer 扩展接口](https://github.com/vastsa/PI-Desktop/blob/main/packages/plugin-sdk/src/renderer.ts)。
