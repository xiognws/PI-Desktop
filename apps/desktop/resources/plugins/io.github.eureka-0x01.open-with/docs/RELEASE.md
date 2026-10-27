# 0.1.0 发布资料

## 商店填写信息

- 名称：Open With
- 插件 ID：`io.github.eureka-0x01.open-with`
- 版本：`0.1.0`
- 分类：开发工具、效率工具
- 源码仓库：<https://github.com/Eureka-0x01/open-with>
- 源码目录：`.`
- 发布引用：`refs/tags/v0.1.0`
- 最低宿主版本声明：PI-Desktop `>=0.9.0`；该范围沿用已有配置，尚未逐版本实机验证。
- 安装包：`io.github.eureka-0x01.open-with-0.1.0.piplug`
- 版本说明：见根目录 `CHANGELOG.md` 中的 0.1.0。

简介：在 PI-Desktop 输入框旁，通过资源管理器或自定义应用打开当前项目目录；支持管理打开方式、保存选中项和显示程序图标。

## 能力与数据流

| 触发 | 读取的数据 | 执行的动作与保存位置 |
| --- | --- | --- |
| 加载按钮或打开菜单 | 插件设置中的应用列表、选中项与图标 | 只显示插件自己的按钮和弹层 |
| 添加或编辑应用 | 用户填写的名称、程序路径；Windows 上检查盘符绝对路径是否存在 | 保存到插件设置；调用系统 PowerShell 和 System.Drawing 读取程序图标，存为 PNG data URI |
| 选择应用 | 已保存的应用 ID | 保存选中项，不启动外部程序 |
| 点击主按钮 | 当前工作区路径、选中程序及参数 | 使用 Node `spawn` 启动程序，将目录替换到 `{{dir}}` 参数，不等待程序退出 |
| 删除应用 | 已保存的应用 ID | 只删除插件设置条目；内置文件管理器不可删除 |

唯一声明权限为 `renderer.extension`。渲染模块在宿主主窗口运行，通过白名单 `plugin.call` 调用自己的主进程方法：`open`、`list`、`select`、`add`、`update`、`remove`。

主进程使用 Node 原生文件存在性检查和进程启动能力，不经过宿主文件 API 的权限网关。该能力需要纳入源码审核。插件不发起网络请求、不访问剪贴板、不主动写入或删除项目文件，也不携带可执行程序或远程加载代码。外部应用由用户指定，运行后具有其自身的文件与网络访问能力。

## 静态兼容性检查

对照 PI-Desktop 官方源码提交 `e219a3e4c0e4cc73ddacde78005987a85d5977d6`：

- 清单规范包含 `renderer.extension`、`renderer`、`rendererActions` 和 `rendererCallMethods`。
- Renderer SDK 包含 `composerControl` 左侧插槽、`pi.ui.injectStyle`、`pi.ui.openLayer` 与 `pi.dispatch("plugin.call", ...)`。
- 主进程导出 `onLoad`、`onUnload` 和 `onRendererCall`，与插件声明对应。
- 使用该提交的官方 devkit 执行 `check` 和 `pack`；通过 Node 24 的 TypeScript 支持运行官方源码，仅通过解析钩子将本地 `.js` 导入映射到对应 `.ts` 文件，没有修改校验或打包逻辑。

官方检查器的两个提示需要人工解释：

- `permission.high-risk`：`renderer.extension` 为高风险权限，安装时须由用户明确授权。
- `contributes.empty`：检查器只检查 `contributes`，本插件界面实际由 `renderer` 注册，不使用面板或命令贡献点。

静态检查与模拟宿主调用不等于真实 PI-Desktop 安装测试，也不代表商店审核已通过。

2026-10-18 已完成：JavaScript 语法检查，以及模拟宿主下的默认选中、内置应用保护、路径校验、切换不启动、跨加载保留选中、目录参数传递、删除回落和无工作区提示检查。模拟挂起的 PowerShell 图标提取在约 1 秒后回退，保存成功；测试没有启动真实外部应用。

## 提交前的实机验证

以下项目仍须在实际 PI-Desktop 中验证；未勾选表示未完成：

- [ ] 安装 0.1.0 的 `.piplug`，批准权限后能看到按钮。
- [ ] 未打开项目时点击主按钮，显示明确提示。
- [ ] 默认按钮能打开当前项目的系统文件管理器。
- [ ] 添加实际安装的 exe，能保存并显示图标或默认图标。
- [ ] 列表点选只切换；点击主按钮才启动程序并传入项目目录。
- [ ] 重启宿主后应用列表和选中项保留。
- [ ] 编辑、删除自定义应用正常，删除选中应用后回落文件管理器。
- [ ] 禁用或卸载插件后，按钮、样式与弹层移除。
- [ ] 测试慢速图标提取：图标读取在 1 秒后回退默认图标，为宿主 `plugin.call` 的 2 秒时限留出设置保存与通信时间；仍须实机确认慢速机器上的保存表现。

## 提交到插件中心

1. 在 <https://plugins.aiuo.net> 用 GitHub 登录，进入 My Plugins → Create plugin。
2. 通过 GitHub App 绑定 `Eureka-0x01/open-with`。
3. 选择 `v0.1.0` 对应源码，上传同一提交生成的安装包，填写版本说明及能力说明。
4. 确认安装包 SHA-256 与发布附件的校验值一致，提交审核。

绑定仓库、实际安装测试和商店审核均为独立步骤。不要将已打包或已上传 GitHub 描述成已经上架。

官方参考：

- <https://github.com/vastsa/pi-desktop-plugins/blob/main/CONTRIBUTING.md>
- <https://github.com/vastsa/PI-Desktop/blob/main/docs/spec/07-plugins/02-plugin-manifest-schema.md>
- <https://github.com/vastsa/PI-Desktop/blob/main/packages/plugin-sdk/src/renderer.ts>
