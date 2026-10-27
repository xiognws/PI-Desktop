# PI Canvas

## English

PI Canvas 0.1.5 presents local interactive React canvases in PI-Desktop's **right work panel**. Open PI Canvas in the work-panel view menu after installing. No detached panel is declared or opened. The public host SDK cannot reveal/focus this view; tool selection returns opened=false and an existing visible view adopts it when safe.

The English/Chinese workbench supports source versions, persistent JSON state, themes, Design mode context copying and host-authorized project TSX/JSX import. Generated files import only @codex-canvas/sdk. Failed source retains the successful publication; failed candidate rendering retains the active iframe. canvas_status reports iframe readiness, not screenshots or focus.

The trusted backend has Node access to its private data and packaged assets. External project reads use host permissions. Generated React runs only in script-only sandbox iframes, without same-origin access or networking. The default package does not read chats, edit drafts or send messages. Clipboard copying is explicit. No desktop.control grant is requested; optional sending requires a separately authorized build and user action. Back up the library before uninstalling; no automatic migration is performed.

0.1.2 has real native-view and user layout evidence. 0.1.5 release checks and marketplace status are tracked in the source repository; do not assume GitHub publication is marketplace approval.

## 简体中文

PI Canvas 0.1.5 在 PI-Desktop **右侧工作面板**呈现本地交互画布。安装后从视图菜单选择 PI Canvas；不声明、不创建独立窗口。公开宿主 SDK 暂不能自动展开或聚焦视图，因此工具返回 opened=false，已有可见视图在安全点接收新选择。

工作台跟随宿主中英文，支持源码版本、持久状态、主题、Design mode 复制上下文和宿主授权的 TSX/JSX 导入。生成代码只从 @codex-canvas/sdk 导入。源码编译失败保留成功发布，候选视图失败保留活动 iframe。canvas_status 的就绪心跳不是截图或聚焦证明。

可信 Node 后端访问插件私有库与随包资源；外部项目读取走宿主权限。生成 React 仅在脚本沙箱 iframe 中运行，禁止同源访问和网络。默认包不读聊天、不改草稿、不发消息；剪贴板复制来自明确操作。不申请 desktop.control；可选发送需另外授权的构建与用户操作。卸载前请备份，不自动迁移数据。

0.1.2 已有原生侧栏与用户布局确认；0.1.5 的检查和市场状态在源码仓库记录，GitHub 发布不等于市场审核通过。

Source / 源码: https://github.com/payAgain/pi-canvas

[SDK](docs/SDK.md) · [Skill](skills/pi-canvas.md). MIT; upstream notices are preserved in docs/ and vendor/.
