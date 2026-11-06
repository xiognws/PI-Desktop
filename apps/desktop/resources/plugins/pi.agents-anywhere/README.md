# Agents Anywhere Remote Plugin for Pi-Desktop

本插件基于开源跨设备 Agent 工作台 **[Agents Anywhere](https://www.agents-anywhere.com/)**（[GitHub 仓库](https://github.com/anywhere-labs/Agents-Anywhere)），为 **Pi-Desktop** 提供手机端（iOS / Android / Web）远程查看、实时会话控制与交互审批能力。

无论你是在通勤路上、会议室还是外出，只需在手机端打开 Agents Anywhere，即可随时随地查看 PC 上的 Agent 任务进度、发问交互与进行敏感工具审批。

---

## 一、核心特性

- **跨设备反向隧道（无需公网 IP）**：基于加密 WebSocket 长连接（WSS），PC 桌面端主动向 Agents Anywhere 中继服务发起连接，实现毫秒级双向穿透，无需配置动态域名、端口映射或公网 IP。
- **双向会话流同步**：手机端与 PC 桌面端实时双向同步会话历史、运行中状态、模型输出与错误中断。
- **思考流式展开与折叠（对齐 ChatGPT 体验）**：在手机端完整实时呈现大模型深层思维链（Chain of Thought），思考时流式展开，正式回答吐出后平滑收拢为单行摘要。
- **远程全功能控制**：支持远程创建会话、输入 Prompt、中止卡死任务、切换工作区项目。
- **敏感工具远程审批（Human-in-the-loop）**：当桌面 Agent 执行修改关键文件或执行 Bash 危险脚本等操作时，手机端即时收到弹窗审批提示，随时一键点击「允许 / 拒绝」。
- **安全沙箱与最小权限原则**：严格受 Pi-Desktop 插件沙箱架构监管，权限限定在 `desktop.control` 与 `net.websocket`，网络白名单强制限制在 `api.agents-anywhere.com` 与 `web.agents-anywhere.com`，本地凭据加密落盘。

---

## 二、工作原理与架构

```text
+-------------------------------------------------------------------------------+
|                       手机端 / 远程客户端 (iOS / Android / Web)                 |
|             (在 TestFlight / 应用商店下载，或访问 web.agents-anywhere.com)        |
+---------------------------------------+---------------------------------------+
                                        |
                    WSS / HTTPS 安全连接 (TLS 1.3 + JWT)
                                        |
+---------------------------------------v---------------------------------------+
|                 Agents Anywhere Server (Cloud 或 个人自托管服务)                |
|                    设备认证中心 · 消息路由网关 · 离线通知推送                     |
+---------------------------------------+---------------------------------------+
                                        |
                 反向 WSS 隧道 (Long-lived WebSocket + 25s 心跳保活)
                                        |
+---------------------------------------v---------------------------------------+
|                     Pi-Desktop 本地工作台 (Windows / macOS)                    |
|                                                                               |
|  +-------------------------------------------------------------------------+  |
|  | [插件] pi.agents-anywhere (运行于 Pi 插件沙箱进程)                       |  |
|  | • AnywhereClient: 鉴权握手、心跳保活、自动重连 (指数退避)               |  |
|  | • DesktopBridge: 协议转译 (Agents Anywhere RPC <-> pi.desktop.invoke)   |  |
|  | • panel.html: 嵌入在右侧工作区原生的管理面板                            |  |
|  +---------------------+-----------------------------+---------------------+  |
|                        |                             |                        |
|           pi.desktop.invoke(...)            pi.events.on(...)                 |
|                        |                             |                        |
|  +---------------------v-----------------------------v---------------------+  |
|  |                 Pi-Desktop 宿主核心 (Host Core & Runtime)               |  |
|  |         会话持久化 (SQLite) · Agent 调度 · 深度思考流 · 工具权限执行         |  |
|  +-------------------------------------------------------------------------+  |
+-------------------------------------------------------------------------------+
```

---

## 三、插件目录结构

```text
pi.agents-anywhere/
├── manifest.json       # 插件清单（声明权限、面板视图与网络白名单）
├── main.js             # 核心服务进程（WebSocket 客户端、RPC 路由器、事件监听）
├── views/
│   └── panel.html      # Pi-Desktop 右侧工作面板界面（Tailwind CSS 极简风格）
└── README.md           # 本说明文档
```

---

## 四、安装与使用全流程指南

### 1. 安装插件

#### 方式 A：插件中心市场一键安装（推荐，全网用户）
1. 打开 Pi-Desktop 桌面端，点击左下角 **「设置」** $\rightarrow$ **「插件 (Plugins)」** $\rightarrow$ **「插件市场」**；
2. 搜索 **`Agents Anywhere`** 或 **`远程助手`**；
3. 点击 **「安装」**，在弹出的权限请求卡片中点击 **「允许并启用」**。

#### 方式 B：从本地 `.piplug` 文件离线安装
1. 下载预编译打包好的 `pi.agents-anywhere-1.0.0.piplug`；
2. 在 Pi-Desktop 的插件设置页面选择 **「从文件安装插件 (Install from file)」**；
3. 选择该文件即可完成秒级安装并启用。

#### 方式 C：开发者模式加载源码
1. 进入 Pi-Desktop 的「设置 $\rightarrow$ 插件 $\rightarrow$ 开发中插件」；
2. 点击「加载未打包插件」，选择本仓库的 `plugins/pi.agents-anywhere` 目录。

---

### 2. 手机端生成连接凭据
1. 在手机上安装 **Agents Anywhere**：
   - **iOS / iPadOS**：通过 [TestFlight 邀请链接](https://testflight.apple.com/join/GKGaut99) 安装；
   - **Android**：下载 [APK 安装包](https://www.agents-anywhere.com/download)；
   - **移动端浏览器 / 电脑端浏览器**：直接访问 [web.agents-anywhere.com](https://web.agents-anywhere.com)。
2. 注册并登录您的账号；
3. 点击底部导航栏的 **「设备 (Devices)」** $\rightarrow$ **「添加设备 (Add Connector)」**；
4. 复制生成的专属凭证信息：
   - `Connector ID`（格式如：`conn_xxxxxxxxxxxx`）
   - `Connector Token`（密钥，格式如：`cxt_xxxxxxxxxxxx`）

---

### 3. 桌面端一键配对绑定
1. 在 Pi-Desktop 中，点击右侧工作区面板中的 **「远程助手」** 标签（带有 🔗 图标）；
2. 在面板配置栏中填入：
   - **服务端地址**：保持默认 `https://api.agents-anywhere.com`（若为私有化部署则填写个人域名）；
   - **Connector ID**：粘贴手机端生成的 ID；
   - **Connector Token**：粘贴手机端生成的密钥；
   - **设备识别名**：可自定义输入易辨认的名称，例如 `办公室台式机` 或 `MacBook Pro`。
3. 点击 **「保存并立即连接」**；
4. 面板顶部的状态指示灯将在 1~2 秒内转变为绿色 **「在线 (已连接)」**，日志窗口提示 `已成功向云端注册 Pi Desktop 运行时`。

---

### 4. 开始手机端远程操作
1. 打开手机上的 Agents Anywhere，在设备列表中点击刚刚绑定的桌面设备；
2. 手机端将即时拉取当前电脑上的全部会话与工作区；
3. **日常交互操作**：
   - **发送 Prompt**：在手机上输入任务需求（如“分析当前工程中的性能瓶颈并给出优化方案”），点击发送；
   - **查看思考过程**：手机端将实时同步渲染模型的思考过程（Thinking 链），回答开始生成后自动收折为摘要；
   - **远程审批**：当 Agent 尝试执行代码或修改文件时，手机端会弹出审批确认卡片，点击「允许」即可驱动桌面端继续执行。

---

## 五、常见问题排查（FAQ）

#### Q1：保存后状态一直显示“离线”或提示连接失败？
- **检查网络环境**：请确保 PC 能正常访问公网。如果使用了 Clash / Mihomo / 系统代理，建议将 `aiuo.net` 和 `agents-anywhere.com` 加入直连白名单。
- **核对凭据**：请确认复制的 `Connector ID` 和 `Token` 没有多余的空格。

#### Q2：手机端发送消息后桌面端没有响应？
- 检查桌面端 Pi-Desktop 是否处于打开状态（插件依赖 PC 端运行时执行任务）；
- 检查 Pi-Desktop 右侧的「远程助手」日志窗口，确认是否有收到 `session.send_message` 的 RPC 请求日志。

#### Q3：私有化部署的 Agents Anywhere 服务端支持吗？
- 完全支持。在桌面端面板将「服务端地址」改为你的私有服务域名（支持自建 Docker），手机端切换到对应服务器即可。

---

## 六、开源协议与贡献

- 遵循 **MIT License** 开源协议；
- 欢迎提交 Issue 与 Pull Request 共同完善跨设备 Agent 生态！
