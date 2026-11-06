/**
 * Agents Anywhere Remote Bridge Plugin for Pi-Desktop
 * Copyright (c) 2026 Anywhere-Labs & PI-Desktop Contributors
 */

// 1. 桌面能力转译桥接
class DesktopBridge {
  async getWorkspace() {
    try {
      if (typeof pi.workspace?.get === "function") {
        const ws = await pi.workspace.get();
        return ws ? { path: ws.path, name: ws.name } : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  async listSessions() {
    try {
      const result = await pi.desktop.invoke({
        operation: "session/collaboration/list",
        args: [{}]
      });
      return Array.isArray(result) ? result : [];
    } catch (e) {
      console.error("[Anywhere:Bridge] listSessions error:", e);
      return [];
    }
  }

  async createSession(title, task) {
    try {
      const result = await pi.desktop.invoke({
        operation: "session/collaboration/spawn",
        args: [{
          title: title || "远程移动会话",
          task: task || "通过 Agents Anywhere 移动端初始化任务",
          notifyOnCompletion: true
        }]
      });
      return result?.sessionId || "";
    } catch (e) {
      console.error("[Anywhere:Bridge] createSession error:", e);
      return "";
    }
  }

  async sendMessage(sessionId, content) {
    try {
      await pi.desktop.invoke({
        operation: "session/collaboration/send",
        args: [{
          sessionId,
          content,
          kind: "message",
          notifyOnCompletion: true
        }]
      });
      return true;
    } catch (e) {
      console.error("[Anywhere:Bridge] sendMessage error:", e);
      return false;
    }
  }

  async cancelTask(sessionId) {
    try {
      await pi.desktop.invoke({
        operation: "session/collaboration/cancel",
        args: [{ sessionId }]
      });
      return true;
    } catch (e) {
      console.error("[Anywhere:Bridge] cancelTask error:", e);
      return false;
    }
  }
}

// 2. Agents Anywhere WebSocket 客户端与 RPC 路由器
class AnywhereClient {
  constructor(config, bridge) {
    this.config = config;
    this.bridge = bridge;
    this.socketId = null;
    this.isConnected = false;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.logHistory = [];
  }

  log(msg) {
    const time = new Date().toLocaleTimeString();
    const entry = `[${time}] ${msg}`;
    console.log(`[AgentsAnywhere] ${msg}`);
    this.logHistory.unshift(entry);
    if (this.logHistory.length > 50) this.logHistory.pop();
  }

  getStatus() {
    return {
      connected: this.isConnected,
      serverUrl: this.config.serverUrl,
      deviceName: this.config.deviceName,
      connectorId: this.config.connectorId,
      logs: this.logHistory
    };
  }

  async connect() {
    if (this.isConnected) return;
    if (!this.config.connectorId || !this.config.connectorToken) {
      this.log("等待配对配置：未提供 Connector ID 或 Token");
      return;
    }

    const wsUrl = `${this.config.serverUrl.replace(/^http/, "ws").replace(/\/+$/, "")}/connector/v2/rpc`;
    this.log(`正在连接到 Agents Anywhere 服务端: ${wsUrl}`);
    if (typeof pi.net?.fetch === "function") {
      try {
        await pi.net.fetch({
          url: `${this.config.serverUrl.replace(/\/+$/, "")}/healthz`,
          timeoutMs: 3000
        });
      } catch {}
    }

    try {
      const res = await pi.net.websocket.connect({
        url: wsUrl,
        headers: {
          "Authorization": `Connector ${this.config.connectorId}:${this.config.connectorToken}`,
          "X-Connector-Version": "2.0.0",
          "X-Device-OS": process.platform || "desktop",
          "X-Device-Name": encodeURIComponent(this.config.deviceName || "Pi-Desktop")
        },
        timeoutMs: 10000
      });

      this.socketId = res.socketId;
      this.isConnected = true;
      this.log("WebSocket 隧道建立成功，开始注册设备能力...");

      this.setupEventListeners();
      this.startHeartbeat();
      await this.registerRuntime();
    } catch (err) {
      this.log(`连接失败: ${err?.message || err}，5秒后自动重试`);
      this.scheduleReconnect();
    }
  }

  async registerRuntime() {
    const ws = await this.bridge.getWorkspace();
    await this.sendNotification("runtime.discover", {
      runtimes: [
        {
          id: "pi-desktop",
          name: "Pi Desktop",
          version: "1.0.0",
          capabilities: [
            "chat",
            "thinking_stream",
            "tool_approvals",
            "workspace_inspection"
          ],
          workspace: ws
        }
      ]
    });
    this.log("已成功向云端注册 Pi Desktop 运行时，设备已就绪");
  }

  setupEventListeners() {
    this._onMessage = async (event) => {
      if (event.socketId !== this.socketId) return;
      try {
        const msg = JSON.parse(event.data);
        await this.handleIncomingRpc(msg);
      } catch (err) {
        console.error("[AgentsAnywhere] Parse JSON error:", err);
      }
    };

    this._onClose = (event) => {
      if (event.socketId !== this.socketId) return;
      this.log("WebSocket 连接已关闭");
      this.cleanup();
      this.scheduleReconnect();
    };

    this._onError = (event) => {
      if (event.socketId !== this.socketId) return;
      this.log(`WebSocket 发生异常: ${JSON.stringify(event.error)}`);
    };

    pi.events.on("net:websocket:message", this._onMessage);
    pi.events.on("net:websocket:close", this._onClose);
    pi.events.on("net:websocket:error", this._onError);
  }

  async handleIncomingRpc(msg) {
    if (!msg || !msg.method) return;
    const { id, method, params } = msg;
    let result = null;
    let error = null;

    this.log(`收到移动端 RPC 请求: ${method}`);

    try {
      switch (method) {
        case "runtime.discover":
          result = {
            runtimes: [
              {
                id: "pi-desktop",
                name: "Pi Desktop",
                capabilities: ["chat", "thinking_stream", "tool_approvals"]
              }
            ]
          };
          break;

        case "session.discover":
          result = { sessions: await this.bridge.listSessions() };
          break;

        case "session.create":
          const newSessionId = await this.bridge.createSession(params?.title, params?.task);
          result = { sessionId: newSessionId };
          this.log(`远程创建新会话: ${newSessionId}`);
          break;

        case "session.send_message":
          const ok = await this.bridge.sendMessage(params.sessionId, params.content);
          result = { success: ok };
          this.log(`向会话 ${params.sessionId} 派发远程指令`);
          break;

        case "session.interrupt":
          const cancelled = await this.bridge.cancelTask(params.sessionId);
          result = { success: cancelled };
          this.log(`远程中止会话 ${params.sessionId}`);
          break;

        case "ping":
          result = { pong: Date.now() };
          break;

        default:
          error = { code: -32601, message: `Method '${method}' is not implemented on Pi Desktop` };
      }
    } catch (e) {
      error = { code: -32000, message: e?.message || "Internal error" };
    }

    if (id !== undefined) {
      await this.sendResponse(id, result, error);
    }
  }

  async syncTimeline(sessionId, update) {
    await this.sendNotification("timeline.sync", {
      sessionId,
      timestamp: Date.now(),
      ...update
    });
  }

  async sendResponse(id, result, error) {
    if (!this.socketId) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, result, error });
    await pi.net.websocket.send({ socketId: this.socketId, data: payload });
  }

  async sendNotification(method, params) {
    if (!this.socketId || !this.isConnected) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    await pi.net.websocket.send({ socketId: this.socketId, data: payload });
  }

  startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.sendNotification("heartbeat", { clientTime: Date.now() }).catch(() => {});
    }, 25000);
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }

  async disconnect() {
    this.cleanup();
    if (this.socketId) {
      try {
        await pi.net.websocket.close({ socketId: this.socketId });
      } catch {}
      this.socketId = null;
    }
    this.log("已断开远程连接");
  }

  cleanup() {
    this.isConnected = false;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this._onMessage) pi.events.off("net:websocket:message", this._onMessage);
    if (this._onClose) pi.events.off("net:websocket:close", this._onClose);
    if (this._onError) pi.events.off("net:websocket:error", this._onError);
  }
}

// 3. 插件生命周期绑定
const bridge = new DesktopBridge();
let client = null;

async function activate() {
  console.log("[pi.agents-anywhere] Plugin starting up...");

  // 从 storage 读取用户配置。宿主没有暴露 storage API 时回退到默认配置，
  // 不能让一次可选的持久化读取把整个插件激活链打断。
  let storedConfig = null;
  try {
    const settingsApi = pi.plugin && typeof pi.plugin.getSettings === "function" ? pi.plugin : null;
    if (settingsApi) {
      const settings = (await settingsApi.getSettings()) || {};
      storedConfig = settings.connector_config || null;
    } else if (pi.storage && typeof pi.storage.get === "function") {
      storedConfig = await pi.storage.get("connector_config");
    }
  } catch (err) {
    console.warn("[pi.agents-anywhere] Failed to read connector_config:", err && err.message ? err.message : err);
  }
  storedConfig = storedConfig || {
    serverUrl: "https://api.agents-anywhere.com",
    connectorId: "",
    connectorToken: "",
    deviceName: "My-Pi-Desktop"
  };

  client = new AnywhereClient(storedConfig, bridge);
  client.log("Agents Anywhere 插件就绪");

  // 自动连接
  if (storedConfig.connectorId && storedConfig.connectorToken) {
    client.connect();
  }

  // 监听桌面端轮次结束事件
  pi.events.on("session:turnEnded", async (event) => {
    if (client && client.isConnected) {
      await client.syncTimeline(event.sessionId, {
        phase: "turn_ended",
        reason: event.reason
      });
    }
  });

  // 监听桌面端工作区切换
  pi.events.on("workspace:changed", async (workspace) => {
    if (client && client.isConnected) {
      await client.syncTimeline("global", {
        type: "workspace_changed",
        workspace: workspace ? { path: workspace.path, name: workspace.name } : null
      });
    }
  });

  // 与面板（Webview）通信
  // bus.subscribe 需要 manifest 里的 bus.subscribe 权限；缺失时宿主会拒绝注册，
  // 这里捕获拒绝，避免变成 unhandled rejection 把激活链打断。
  const subscribe = (topic, handler) => {
    if (!pi.bus || typeof pi.bus.subscribe !== "function") return;
    try {
      const pending = pi.bus.subscribe(topic, handler);
      if (pending && typeof pending.catch === "function") {
        pending.catch((err) => {
          console.warn("[pi.agents-anywhere] bus.subscribe rejected for " + topic + ": " + (err && err.message ? err.message : err));
        });
      }
    } catch (err) {
      console.warn("[pi.agents-anywhere] bus.subscribe threw for " + topic + ": " + (err && err.message ? err.message : err));
    }
  };

  subscribe("anywhere.get_status", async () => {
    return client ? client.getStatus() : { connected: false, logs: [] };
  });

  subscribe("anywhere.save_config", async (newConfig) => {
    try {
      const settingsApi = pi.plugin && typeof pi.plugin.setSettings === "function" ? pi.plugin : null;
      if (settingsApi) {
        await settingsApi.setSettings({ connector_config: newConfig });
      } else if (pi.storage && typeof pi.storage.set === "function") {
        await pi.storage.set("connector_config", newConfig);
      }
    } catch (err) {
      console.warn("[pi.agents-anywhere] Failed to persist connector_config:", err && err.message ? err.message : err);
    }
    if (client) await client.disconnect();
    client = new AnywhereClient(newConfig, bridge);
    await client.connect();
    return { success: true };
  });
}

// 启动插件
activate().catch((err) => {
  console.error("[pi.agents-anywhere] Failed to activate:", err);
});
