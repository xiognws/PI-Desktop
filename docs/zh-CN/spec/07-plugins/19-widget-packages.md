# 规格 19：扩展件（Widget Packages）

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/19-widget-packages) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

扩展件是用户自己放进来、可以直接跑起来的代码，不是随安装包分发的代码。工具包
（`07-plugins/01`…）：只有元数据与资源，在「工具」页列出并开关，没有运行时。插件
（`07-plugins/01`）：由插件注册表负责安装、版本和权限门。扩展件夹在两者中间：用户
把文件夹拷到自己的数据目录，启动时扫描、在 agent sidecar 里加载、通过 RPC 调用。
它拿到的权限比插件*更多*——插件的扩展是 agent 里的一个钩子，扩展件则是 agent 调用、
并且能回调宿主的程序。

## 1. 存放位置

`<userData>/widgets/<folder>/`——一个文件夹一个包，一个文件夹一个清单。不随安装包
捆绑：目录为空就是空的「工具」条目。宿主在启动时和每次 `widgets.list` 时只扫一层；
读不到可读清单的文件夹保留它的行并说明原因（与工具包同一规则，
`host-core/src/tool_packages.rs`）。

路径由 host-core（`widgets_packages_dir`）解析，渲染层从不解析。渲染层通过 IPC 只
能看到摘要。

## 2. 清单

`widget.json`，schema 版本 1：

```json
{
  "schemaVersion": 1,
  "apiVersion": 1,
  "id": "example.tide-probe",
  "name": "Tide probe",
  "version": "0.1.0",
  "description": "Reads a clock and remembers a note.",
  "author": "optional",
  "permissions": ["read", "host"],
  "actions": [
    { "name": "now", "description": "Returns the current time.", "params": {} }
  ]
}
```

- `id` 是主键；第二个文件夹使用同一 id 时，它的行保留并标记 `duplicate id <id>`。
- `apiVersion` 决定 runner 的 API 面。构建不认识的版本是加载错误，不是静默降级。
- `permissions` 是请求，不是授权。未知名称会被丢弃。
- `actions` 是唯一可调用面。没有列在这里的动作，即使模块注册了也无法被调用。

上限：64 个包，每个包 512 个文件、8 MB。

## 3. 入口模块

`index.js` / `index.mjs` / `index.cjs`，按此顺序解析。模块**默认导出**一个函数——
即激活钩子。它拿到扩展件 API 并注册 action：

```js
export default async function activate(api) {
  api.log("tide-probe activated");
  api.action("now", async () => ({ now: new Date().toISOString() }));
  api.action("remember", async ({ args, call }) => {
    const listed = await call("memory.list", {});
    return { requested: typeof args?.note === "string" };
  });
}
```

没有注册任何 action 的模块仍会加载并报告 0 个 action；激活钩子抛错的模块报为错误
行，绝不半注册。

## 4. 运行位置

在 **agent sidecar**（`packages/agent-runtime`）内、sidecar 自己的进程里——不在
Electron 主进程，不在渲染层。几条后果值得说明：

- 崩溃的包带走的是 sidecar 而不是窗口；现有的 `settleCrashedSession` 路径已经处理
  了这种情况。
- 注册表是**进程级**的，不是会话级：否则两个窗口会把同一个模块加载两次、副作用
  翻倍。
- sidecar 在应用退出时被拆除；v1 中包没有卸载钩子。

## 5. 双向调用

**客户端 → 包。** 渲染层 → IPC `pi-desktop/widgets/invoke` → sidecar
`widget.invoke` `{ widgetId, action, args }` → runner → action 处理器。结果是
`{ value, durationMs, logs }`，受 `WIDGET_INVOKE_TIMEOUT_MS`（30 秒）约束。未知的
扩展件或 action 是错误，不是空结果。

**包 → 宿主。** 在 action 内，`call(method, params)` 经 sidecar 的
`ParentHostProxy` 回到主进程的正常 RPC 路径。这与 agent 自己使用的是同一条通道，
因此 host-core 的校验原样生效。v1 中只有 `CAPABILITY_HOST_METHODS` 里的方法
（`memory.recall`、`memory.list`、`memory.stats`、`workspace.get`、`app.health`）
可达，并且需要已授予 `host` 权限；其余一切在离开 sidecar 之前就被拒绝。

**agent → 包。** `Capability` agent 工具（`action: list | invoke`，外加 `widgetId` /
`actionName` / `args`）让模型可以枚举已安装的包，并在回合中调用它们的 action。它只
在 agent 模式注册，和它旁边的扩展工具集一样（`runtime.ts` 的 `activeTools()`）。

## 6. 权限

五级：`read`、`write`、`net`、`agent`、`host`。manifest 提出请求，由 host-core 决定
授予什么：

| 级别 | 授予 |
| --- | --- |
| `read` | 读取包文件夹内的文件 |
| `write` | 写入包文件夹及其数据目录 |
| `net` | 出站网络 |
| `agent` | `call` 进入 agent 作用域的宿主方法 |
| `host` | `call` 进入 `CAPABILITY_HOST_METHODS` |

未受信任的包被沙箱限制为 `read` + `write`。没有 `host` 权限却调用宿主方法的 action
会以 `widget <id> has no host permission` 失败，宿主侧完全看不到这次调用——这在
`packages/agent-runtime/src/widgets/index.test.ts` 中有断言。

## 7. 信任，以及摘要为什么存在

v1 中没有任何东西给扩展件包签名，也没有任何东西校验签名。替代方案是**摘要冻结**：

- host-core 对包的相对路径、长度与字节计算 SHA-256（跳过点目录）。
- 首次出现：该行为 `untrusted`，在用户于扩展件页面确认这个摘要之前，启用开关会被
  拒绝。
- 已确认：`trusted`，确认的摘要持久化到 `<data>/widgets/state.json`。
- 之后文件被改动：`modified`——授权被撤回，权限回落到沙箱，该行变成警告色。
- 重新确认时发送用户当前看到的摘要；如果期间文件又被改动，host-core 会回答
  `changed on disk since it was reviewed`，而不是信任此刻磁盘上的任意内容。

最后那条校验才是重点：确认固定的是*具体的字节*，而不是一个路径。它阻止了审核与点击
之间的静默替换，也让「我拷进来了新版本」成为可见事件，而不是不可见的权限提升。

## 8. 状态

`<data>/widgets/state.json`：`{ "disabled": [id…], "trusted": { "<id>": "<digest>" } }`，
写临时文件后再重命名。损坏的状态用默认值替换，而不是阻塞列表。

## 9. 界面

| 层 | 项目 |
| --- | --- |
| host-core | `widgets.list`、`setEnabled`、`setTrusted`、`dir` |
| IPC | `pi-desktop/widgets/{list,runtime,setEnabled,setTrust,reveal,invoke}` |
| 渲染层 | `pages/CapabilitiesPage.tsx`、`pages/ToolsPage.tsx` 上的入口按钮 |
| Sidecar | `widget.{sync,list,invoke,logs,clear}` |

「工具」页保留入口按钮（包数量，打开该页）。扩展件页面负责启用、信任、定位与 action
列表；它从不直接碰文件系统。

## 10. 分发

把包目录打包成 zip 交给别人，对方把该文件夹放进自己的 `widgets` 目录即可。v1 没有
市场、没有版本协商、没有更新通道——插件侧的对应内容见 `14-plugin-roadmap.md`，为什么
留在插件注册表之外见 ADR 0384。
