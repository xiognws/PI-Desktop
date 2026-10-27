# PI-Desktop Usage

> PI-Desktop 与 Pi CLI 的 token 用量、费用统计面板：一个插件，两个来源，分开统计，纯本地。

<p align="left">
  <img alt="PI-Desktop" src="https://img.shields.io/badge/PI--Desktop-%E2%89%A50.20.1-0485f7" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-4fbd91" />
  <img alt="network" src="https://img.shields.io/badge/network-none-f0a12b" />
</p>

PI-Desktop 的插件体系和 Pi CLI 是两套互不相通的数据：CLI 的插件、用量、MCP 都不会同步到桌面版。这个插件同时读取两边的本地会话文件，把「PI-Desktop」和「Pi CLI」作为可区分的来源，在一个面板里给出同一个口径的用量与费用。

界面按 [juejin-usage](https://github.com/juejin-cn/juejin-usage) 的成品效果复刻：灰底白卡、药丸式区间切换（选中为主题色实心）、指标卡带主题色迷你趋势线、月份 + 星期表头的日历热力图、条形排行、双环形分布图，明暗三态与主题色都可手动指定。

## 功能

- **两个来源，分开统计**：PI-Desktop 与会话目录、Pi CLI 的会话目录各自解析，来源色标（由主题色派生的同族双色）、来源分布、按来源筛选贯穿所有卡片与表格
- **八张指标卡**：总成本 / 总 Token / 输入 Token / 输出 / 缓存命中 / 缓存写入 / 总请求数 / 缓存命中率；右上角是相对上一周期的涨跌胶囊（上升绿、下降红，上一周期没有流量时直接给绝对差额），右下角是同区间的迷你趋势线、颜色跟随涨跌方向，中间一行是请求数、占比或缓存命中率
- **使用趋势（双轴曲线）**：左轴 Token、右轴费用，五条单调三次平滑曲线（成本虚线 / 缓存创建 / 缓存命中 / 输入 / 输出），缓存命中带渐变填充，底部居中图例，标题下方显示当前窗口的起止时刻，悬停给出该点五项数值
- **趋势（柱状图）**：Token ↔ 费用两种口径；「今天」按小时、一年以内按本地日历日、更长跨度按自然月分桶，Token 口径按输入 / 输出 / 缓存堆叠
- **来源与项目排行**：横向进度条 + 图标 + 请求数 + 费用；项目默认列出 Token 最多的 3 项，占比按整个窗口计算（不是只占这 3 项）；CLI 会话按会话首行的 cwd 归到真实项目
- **双环形分布**：来源分布与模型分布分开两张卡，各自 Token ↔ 费用切换，模型列出前 6 名并把其余合并成「其他模型」，所以中心合计等于整窗合计；图例与扇区都可点击隐藏（取消的项转为静音色、占比显示「—」，不再拿半透明数字冒充占比），但至少保留一项可见
- **活跃热力图**：今年至今的每日 Token 强度，带月份表头与星期列；深浅按活跃日的四分位划分，某一天爆到几亿 Token 也不会把其余日子压成同一档；悬停任一方块弹出当日卡片——日期、等级、总用量与按模型拆分的份额条（前 5 名 + 「其他模型」），点任意方块在下方明细行固定当日 Token、费用与请求数，再次点击取消
- **区间**：今天 / 7D / 30D / 90D / 全部，外加「自定义」——预设（当天 / 近 24 小时 / 近 7 天 / 近 14 天 / 近 30 天 / 全部）、起止时间输入、自绘日历选日、结束时间跟随当前时刻；偏好会记住
- **主题色**：蓝 / 紫 / 绿 / 琥珀 / 玫红五套强调色，外加无极调色盘（任选十六进制色，拖动即时预览）；使用趋势、7D 趋势、来源分布、模型分布的配色都由主题色按色相步进派生，换色即时生效，选择会记住
- **切换动画**：卡片入场、面积线绘制、柱状生长、环形淡入旋转、排行条展开，并遵循系统「减少动态效果」设置
- **来源汇总**：来源卡底部给出合计 Token / 请求数 / 费用与来源占比条
- **热力图铺满整行**：今年至今，单元格随面板宽度伸缩；面板窄于 640px 时改为横向滚动，每格仍保持可点击
- **顶栏常驻**：滚动时区间、来源、明暗与主题色控件固定在面板顶部，不必滚回顶端
- **明暗三态**：跟随系统 / 亮面 / 暗面；语言（中文 / English）跟随 PI-Desktop 外观
- **无网络、无遥测、无剪贴板**：只读本地文件；缓存只写插件自己的数据目录，宿主没有提供数据目录时退回系统临时目录

## 数据来源

| 来源 | 目录 | 用数字段 | 项目归属 |
| --- | --- | --- | --- |
| PI-Desktop | `~/.pi-desktop/sessions/*.jsonl` | `message.meta.usage`（`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `cost.total` / `costStatus`）；`compaction.desktopUsage` | 会话文件里没有 cwd，通过宿主的项目目录补齐 |
| Pi CLI | `~/.pi/agent/sessions/**/*.jsonl` | `message.usage`（`input` / `output` / `cacheRead` / `cacheWrite` / `cost.total`）；`compaction.usage` | 会话首行的 `cwd` |

- 总 Token 恒为 `输入 + 输出 + 缓存读 + 缓存写`，不信任载荷里的 `totalTokens`
- 缓存命中率 = `缓存读 / (输入 + 缓存读)`，不含输出与缓存写
- `aggregation: "aggregate"` 的桌面用量以聚合总额为准：展开逐条 `operations`，若子项之和不等于聚合总额，差额补记成一条记录——既不重复计数，也不静默漏计
- 没有价格的记录仍然计入 Token，费用显示 `≈$x`（部分记录缺价）或 `—`（整行缺价）
- 只读会话文件里的用量字段与时间戳，**消息正文、工具输出、文件内容都不会落入插件缓存**
- 来源图标取自官方仓库：Pi（`earendil-works/pi` README 引用的 pi.dev logo）与 PI-Desktop（`vastsa/PI-Desktop`），来源与许可见 `views/assets/README.md`

## 安装

### 从插件市场安装

在 PI-Desktop 的「插件 → 插件市场」搜索 **用量统计 / Usage Statistics** 安装（插件中心：<https://plugins.aiuo.net>），然后从工作面板的视图菜单选择「用量统计」。

### 本地开发加载

1. 「插件」页 →「加载开发插件」→ 选择本仓库目录
2. 工作面板视图菜单 →「用量统计」
3. 改动 `main.js` / `src/` / `views/` 后宿主会自动重载

### 从打包文件安装

```bash
npm run pack
# dist/io.github.techd81.pi-desktop-usage-<version>.piplug
```

把生成的 `.piplug` 拖进「插件」页即可按用户安装路径验证。

## 使用

- **区间**：今天 / 7D / 30D / 90D / 全部，以及任意自定义窗口；跨度 ≤ 2 天按小时分桶，一年以内按本地日历日，更长跨度按自然月分桶
- **来源筛选**：点「PI-Desktop」或「Pi CLI」做多选，点「全部来源」清空筛选
- **刷新**：重新扫描两个目录；首扫视会话总量而定（本机会话目录在数百个文件、GB 级体量，会在时间预算内分几轮扫完），之后增量扫描只读追加部分
- **扫描进度**：单次扫描有时间预算，未扫完会显示进度并自动续扫，避免撞上面板调用超时
- **打开方式**：右侧工作面板的视图菜单里选「用量统计」（内嵌，随面板宽度换列）；或在「扩展」页点「打开面板」按钮，或按 `Ctrl/Cmd+Shift+U`，用独立窗口看同一套数据
- **出错与空状态**：查询失败时顶部显示原因与「重试」；没有记录时列出两个数据目录，目录不存在会单独标注

## 权限与隐私

`manifest.json` 声明四个权限：

| 权限 | 用途 |
| --- | --- |
| `ui.view` | 在工作面板里提供「用量统计」视图 |
| `ui.panel` | 「扩展」页的「打开面板」按钮用它把同一个视图开成独立窗口（不影响工作面板里的内嵌视图） |
| `keyboard.globalShortcut` | 把「打开面板」绑到全局快捷键 `Ctrl/Cmd+Shift+U`；宿主不允许插件往左侧导航栏加按钮，快捷键是最接近的直达入口 |
| `desktop.control` | 只用于三个**只读**目录操作：`providers/list`（模型到供应商的映射）、`session/list`、`project/list`（项目归属）。宿主把这个权限标为高风险，因为它是能读到桌面状态的能力；本插件只调用这三个 op |

- 不会调用任何会话、Agent、项目写入类操作；富化失败只会退化成占位显示（供应商名退回原始 id、项目显示「未归属」），**统计数字一条都不少**
- 不访问网络、不上传、不读写剪贴板、不调用 shell
- 缓存只写插件自己的数据目录：`cache/state.json`、`cache/records.jsonl`、`cache/enrich.json`；宿主未提供数据目录时退回 `%TEMP%/pi-desktop-usage`

## 已知限制

- 从 Pi CLI 导入到 PI-Desktop 的会话会在两侧各计一次（来源列能看出重复，可分别筛选排除）
- 桌面会话的项目归属依赖宿主的项目目录；宿主未给出时归入「未归属」
- 压缩摘要（compaction）的用量单独计入，不会与消息用量重复
- 缓存可随时重建：删除插件数据目录，或在面板点「刷新」前清空缓存

## 开发

```bash
npm test          # node:test：适配器 / 聚合 / 增量扫描 / 后端通道 / 视图纯函数 / 打包
npm run typecheck # tsc 检查 JSDoc 类型
npm run probe     # 真实数据对账（只读，结果写临时目录）
npm run pack      # 生成 .piplug 并打印 sha256
npm run icon      # 重新绘制插件图标（512×512 PNG）
```

面板可以脱离宿主预览：用浏览器打开 `test/harness.html`（内置假宿主和示例数据），布局、明暗主题与全部交互都能直接检查。

两个扫描根可以用环境变量改到别处，便于对测试数据或另一台机器的会话做核对：`PI_DESKTOP_USAGE_HOME`、`PI_DESKTOP_USAGE_CLI_ROOT`、`PI_DESKTOP_USAGE_DESKTOP_ROOT`。

`npm run probe` 会把本插件的统计与独立来源比对：

- PI-Desktop ↔ `pi.sqlite` 的 `turns.usage_json.totalTokens`
- Pi CLI ↔ 旧版 `pi-usage-statistics` 缓存的 `records.jsonl` 求和

本机实测：桌面侧与宿主数据库完全一致；CLI 侧与原始 JSONL 求和逐位一致。旧版缓存把同一会话记账为两倍（历史双计），所以 CLI 这一行的对账会显示约 2× 的差异。

### 目录结构

```
main.js              插件入口（onLoad / onUnload / onPanelInvoke）
src/backend.js       通道路由、缓存生命周期、带预算的扫描
src/adapters/        Pi CLI 与 PI-Desktop 会话适配器
src/lib/             规范化、增量扫描、记录缓存、聚合、只读富化、路径
views/               面板（原生 HTML/CSS/JS + 内联 SVG 图表）
scripts/pack.mjs     store-only zip 打包与 manifest 校验
scripts/probe.mjs    真实数据对账
test/                node:test 测试与脱敏 fixture
```

## English summary

A PI-Desktop plugin panel that aggregates token usage and cost from **both** PI-Desktop (`~/.pi-desktop/sessions`) and the Pi CLI (`~/.pi/agent/sessions`), keeping the two sources visibly apart, and following the juejin-usage visual language. It is read-only, offline and local-first: no network, no telemetry, no clipboard. `desktop.control` is declared solely for `providers/list`, `session/list` and `project/list` so provider names and project paths can be shown; every enrichment failure degrades to a placeholder instead of changing the numbers.

```bash
npm test && npm run pack
```

## License

MIT — see [LICENSE](LICENSE).

`views/assets/pi-cli.svg` and `views/assets/pi-desktop.png` are the two upstream
project marks, used only to label the data sources in the panel. They stay under
their own licenses (MIT and LGPL-3.0) and are not covered by this repository's
MIT grant — see [views/assets/README.md](views/assets/README.md) for provenance.
