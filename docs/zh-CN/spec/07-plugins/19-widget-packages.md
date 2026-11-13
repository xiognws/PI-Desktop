# 规格 19：扩展件（Widget Packages）

> [英文源规格](/spec/07-plugins/19-widget-packages) 是行为的最终依据。

扩展件是用户自己放进来、可以直接跑起来的代码，不是随安装包分发的代码。

- 工具包（D695）：只有元数据与资源，在「工具」页列出并开关，不含运行时代码。
- 插件：走安装、版本、市场与权限体系，由插件注册表管。
- 扩展件：用户把文件夹拷到自己的数据目录，启动时扫描、在 agent sidecar 里加载、
  通过 RPC 双向调用——比插件钩子更大的权限，但没有插件的安装与市场负担。

## 存放位置

`<userData>/widgets/<folder>/`，一个文件夹一个包，一个包一个 `widget.json`。
不随安装包捆绑：目录为空就是空列表。宿主只扫一层，读不到清单的文件夹保留报错行，
不会静默消失。

## 清单

`widget.json`，`schemaVersion` 为 1，字段包括 `apiVersion`、`id`、`name`、
`version`、`description`、`author`、`permissions[]`（`read`/`write`/`net`/`agent`/`host`）、
`actions[]`。`actions` 是唯一可调用面——模块里注册了但没写进清单的动作不能被调用。

## 入口模块

`index.js` / `index.mjs` / `index.cjs`，**默认导出**一个函数（激活钩子），
它拿到扩展件 API 并注册 action。激活时抛错的包只让自己变成错误行，不牵连其它包。

## 运行位置

**agent sidecar** 进程内，不在 Electron 主进程、不在渲染层。注册表是进程级的，
不是会话级——否则两个窗口会把同一个包加载两次、副作用翻倍。单次调用 30 秒上限。

## 双向调用

- 客户端到包：渲染层 → `pi-desktop/widgets/invoke` → sidecar `widget.invoke`。
- 包到宿主：action 里的 `call(method, params)` 走 `ParentHostProxy` 回到主进程正常 RPC，
  仅限 `CAPABILITY_HOST_METHODS`，且需要 `host` 权限。
- agent 到包：`Capability` 工具（`list` / `invoke`），只在 agent 模式挂载。

## 信任

v1 不做签名，用**摘要冻结**替代：host-core 对包内相对路径与字节算 SHA-256。
首次出现为 `untrusted`，要在能力页确认这个摘要才能启用；确认后写进
`<data>/widgets/state.json`；文件改动后变成 `modified`、权限回落到沙箱；
带旧摘要重新确认会被拒（`changed on disk since it was reviewed`）。

## 分发

把包目录打包成 zip 交给别人，对方解到自己的 `widgets` 目录即可。v1 没有市场、
没有版本协商、没有更新通道。详见 ADR 0384。
