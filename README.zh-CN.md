<div align="center">

<img src="docs/image/readme/logo.png" alt="Pi-Workspace" width="108" />

# Pi-Workspace

### 本地开发用的 AI Agent 桌面工作台

Electron + React 渲染层 · Rust `host-core` 持久化 · Node `agent-runtime` 执行

</div>

---

## 这是什么

Pi-Workspace 是一个本地运行的 AI Agent 桌面工作台。项目、会话、模型、插件和工作流都在同一个桌面应用里持续存在，不依赖云端账号，也不绑定某一家模型厂商。

**本地个人使用**：直接从源码构建运行，不走安装包分发。

---

## 主要能力

- **工作区结构**：Project → Session → Agent → Work，多项目多会话并行，会话跨启动继续
- **三种模式**：Agent（直接执行）/ Plan（先方案后执行）/ Goal（给目标自行推进）
- **多级编排**：Subagent（独立上下文的子智能体）+ Worker Session（拆成多个完整会话并行）
- **模型自由**：OpenAI、Anthropic、OpenAI 兼容 API、自建网关、Ollama、LM Studio、本地模型，会话内可随时切换
- **插件化**：Command、Panel、Floating Widget、Work Panel View、Agent Tool、Skill、Theme、MCP Server、Service、Message Bus
- **技能 / MCP / 记忆 / 子智能体**：全局级 `~/.agents/` 与项目级 `<项目>/.agents/` 两级配置
- **权限层**：Agent → 工具请求 → 权限层 → 允许 / 询问 / 拒绝 → 执行
- **本地优先**：数据全部本地，凭证存操作系统钥匙串，无遥测

---

## 技术栈与进程模型

```text
Renderer (React)
   ↓
Preload IPC
   ↓
Electron Main
   ↓
Rust Host Core  /  Node Agent Runtime
   ↓
pi-ai / pi-agent-core
```

| 层 | 职责 |
| --- | --- |
| `apps/desktop` | Electron 主进程 + React 渲染层 |
| `crates/host-core` | 持久化（SQLite 独占）、原生能力、host 状态 |
| `packages/agent-runtime` | Agent 执行 |
| `packages/plugin-sdk` | 插件扩展契约 |
| `packages/shared` | 跨边界契约与 schema |

---

## 本地运行

### 环境要求

- Node.js `>=22.19`
- pnpm `>=10`
- 稳定版 Rust 工具链

### 安装与启动

```bash
pnpm install
cargo build -p host-core
pnpm build:js
pnpm dev
```

### 校验

```bash
pnpm typecheck
pnpm lint
pnpm test
```

### 打包（需要时）

```bash
pnpm build
```

产物为 Electron 应用目录（未签名），仅本机使用，不需要发布流程。

---

## 数据目录

持久数据默认位于用户数据目录（Windows 下为 `%LOCALAPPDATA%\PiWorkspace\pi`），可用环境变量覆盖：

| 环境变量 | 作用 |
| --- | --- |
| `PI_DESKTOP_DATA_DIR` | 直接指定数据目录（最高优先级） |
| `PI_DESKTOP_DATA_ROOT` | 指定数据根，其下含 `data`、`userdata` 等 |

其中 `agent/AGENTS.md` 是全局 Agent 指令文件，`widgets/` 放自定义挂件，`tools/state.json` 记录工具包启用状态。

---

## 文档（本地）

- [使用手册](docs/handbook/Pi-Workspace-0.21.0-使用手册.md) —— 安装、界面、设置、挂件与工具包、故障排查
- [插件开发](docs/plugin-development.md)
- [架构说明](docs/spec/02-architecture/01-architecture.md)
- [规格目录](docs/spec/README.md)
- [界面截图](docs/guide/screenshots.md)
- [仓库开发规范](AGENTS.md)

内置插件模板：`panel-basic`、`agent-tool-basic`、`skill-pack`、`full-demo`。

---

## 备注

- 当前版本 `0.21.0`，部分插件接口与桌面能力仍在演进，升级前留意破坏性变更。
- 仓库采用 worktree 隔离开发，改动请在自己的分支与 worktree 内进行，见 [AGENTS.md](AGENTS.md)。

---

许可：GNU Lesser General Public License v3.0，详见 [LICENSE](LICENSE)。
