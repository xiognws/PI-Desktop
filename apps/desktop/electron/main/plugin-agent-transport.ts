/**
 * The loopback endpoint that serves a plugin-owned agent's stream to the Rust
 * kernel (spec 07-plugins/16 §5; ADR 0258).
 *
 * A plugin agent's transport is a JavaScript callback, and the kernel has no JS
 * runner and should not grow one. Main is already the JavaScript host for a
 * session's extensions, so it answers here too: the kernel is handed a
 * Chat Completions endpoint on loopback (the same pattern the in-app providers
 * use — a loopback gateway plus its own key), and each request is served by the
 * `stream`/`complete` the plugin registered for that session and model.
 *
 * Why a listener instead of a new kernel provider kind: the kernel already
 * speaks and decodes this wire, including streaming and tool-call fragments, so
 * nothing has to be re-implemented in Rust and a plugin agent streams exactly as
 * it does under the Node runtime. What crosses the boundary is ids and model
 * metadata — never a plugin credential, which the kernel never receives because
 * the plugin's own transport fetches nothing the host knows about.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Api, AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai";
import { KernelChunkWriter, contextFromKernelRequest } from "./plugin-agent-wire";

/** One request body is a whole turn's context; beyond this it is not a prompt. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const ENDPOINT_PREFIX = "/v1/plugin-agent/";

/** The transport one plugin agent serves, for the session asking for it. */
export type PluginAgentAnswer = {
  providerId: string;
  /** The model the plugin declared, which its callback expects to be handed. */
  model: Model<Api>;
  stream(context: Context, options: { signal?: AbortSignal }): AssistantMessageEventStream;
};

export type PluginAgentTransportDeps = {
  /**
   * Resolve the agent for this session, key and model — reading the session's
   * trusted extension set and its live Runner, so a reload is picked up by the
   * next turn rather than by the next app launch.
   */
  resolve(input: {
    sessionId: string;
    agentKey: string;
    modelId: string;
  }): Promise<PluginAgentAnswer | undefined>;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
};

/** What a launch needs to point the kernel at one plugin agent. */
export type PluginAgentEndpoint = {
  baseUrl: string;
  apiKey: string;
  model: Model<Api>;
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("plugin agent request is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
  });
}

/**
 * One session's loopback endpoint for plugin agents.
 *
 * `endpoint()` is called once per launch (main builds a provider spec per turn);
 * the listener itself starts on the first call and lives with the app. A request
 * that names an agent the session no longer has is answered with a provider
 * error frame, which the kernel reports as a failed turn rather than a silent
 * empty reply.
 */
export class PluginAgentTransport {
  private readonly deps: PluginAgentTransportDeps;
  /** Loopback key: the kernel sends it as `Authorization: Bearer …`. */
  private readonly apiKey = randomBytes(32).toString("base64url");
  private server?: Server;
  private port = 0;
  private listening?: Promise<void>;

  constructor(deps: PluginAgentTransportDeps) {
    this.deps = deps;
  }

  /**
   * Point one launch at a plugin agent's transport.
   *
   * Resolves the agent first: an agent the session cannot serve fails the launch
   * with `MODEL_NOT_CONFIGURED` instead of starting a turn whose first request
   * would come back empty.
   */
  async endpoint(input: {
    sessionId: string;
    agentKey: string;
    modelId: string;
  }): Promise<PluginAgentEndpoint | undefined> {
    const answer = await this.deps.resolve(input).catch((error: unknown) => {
      this.deps.log("warn", "plugin agent resolve failed", {
        sessionId: input.sessionId,
        error: String(error),
      });
      return undefined;
    });
    if (!answer) return undefined;
    await this.listen();
    const baseUrl = `http://127.0.0.1:${this.port}${ENDPOINT_PREFIX}${encodeURIComponent(
      input.sessionId,
    )}/${encodeURIComponent(input.agentKey)}`;
    return { baseUrl, apiKey: this.apiKey, model: answer.model };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.listening = undefined;
    this.port = 0;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private listen(): Promise<void> {
    if (this.listening) return this.listening;
    this.listening = new Promise<void>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handle(request, response);
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("plugin agent transport did not bind a loopback port"));
          return;
        }
        this.port = address.port;
        this.server = server;
        resolve();
      });
    });
    return this.listening;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "POST" || !url.pathname.startsWith(ENDPOINT_PREFIX)) {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${this.apiKey}`) {
      response.writeHead(401).end();
      return;
    }
    const rest = url.pathname.slice(ENDPOINT_PREFIX.length).split("/");
    const sessionId = decodeURIComponent(rest[0] ?? "");
    const agentKey = decodeURIComponent(rest[1] ?? "");
    if (!sessionId || !agentKey || rest[2] !== "chat" || rest[3] !== "completions") {
      response.writeHead(404).end();
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(request));
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error) } }));
      return;
    }
    const record = body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
    const modelId = typeof record.model === "string" ? record.model : "";
    const answer = await this.deps.resolve({ sessionId, agentKey, modelId }).catch(() => undefined);

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const writer = new KernelChunkWriter((chunk) => response.write(chunk));
    if (!answer) {
      writer.fail(`plugin agent "${agentKey}" is not registered for this session`);
      response.end();
      return;
    }
    // The turn is over when the kernel drops the connection (Stop, abort, or the
    // process going away); the plugin gets that as its own signal.
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.once("close", abort);
    response.once("close", abort);
    try {
      const stream = answer.stream(
        contextFromKernelRequest({ messages: record.messages, tools: record.tools, model: modelId }),
        { signal: controller.signal },
      );
      for await (const event of stream) writer.event(event);
      writer.complete(await stream.result());
    } catch (error) {
      this.deps.log("warn", "plugin agent stream failed", {
        sessionId,
        agentKey,
        error: String(error),
      });
      writer.fail(error instanceof Error ? error.message : String(error));
    } finally {
      request.off("close", abort);
      response.off("close", abort);
      response.end();
    }
  }
}

/**
 * The transport this process installed.
 *
 * One per app, installed by the module that owns main's extension bridge — the
 * same place the trusted set for a session is decided, so the two cannot drift.
 * Read lazily by the launch resolver, which runs before any turn.
 */
let installed: PluginAgentTransport | null = null;

export function installPluginAgentTransport(deps: PluginAgentTransportDeps): PluginAgentTransport {
  installed = new PluginAgentTransport(deps);
  return installed;
}

export function pluginAgentTransport(): PluginAgentTransport | undefined {
  return installed ?? undefined;
}

/** Drop the installed transport (tests, and shutdown). */
export async function resetPluginAgentTransport(): Promise<void> {
  const current = installed;
  installed = null;
  await current?.close();
}
