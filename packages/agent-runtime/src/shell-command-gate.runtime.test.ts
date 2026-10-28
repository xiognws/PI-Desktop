import { createServer, type ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";
import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

/**
 * The user path: the model asks for a destructive shell command, the runtime
 * refuses it before the host is reached, and the refusal arrives in the
 * transcript as a tool error naming the rule.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  delete process.env.PI_DESKTOP_SHELL_GATE;
});

type Item = { type?: string; role?: string; name?: string; call_id?: string; output?: unknown };
type Request = { tools: Array<{ name?: string }>; input: Item[] };

function respond(res: ServerResponse, command?: string) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (data: { type: string; [key: string]: unknown }) =>
    res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  send({ type: "response.created", response: { id: "resp_fixture" } });
  const args = { command: command ?? "" };
  const text = "Understood. I will not run that command.";
  const item = command
    ? {
        id: "fc_fixture",
        type: "function_call",
        call_id: "call_fixture",
        name: "Bash",
        arguments: JSON.stringify(args),
        status: "completed",
      }
    : {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      };
  send({
    type: "response.output_item.added",
    output_index: 0,
    item: command ? { ...item, arguments: "", status: "in_progress" } : { ...item, content: [], status: "in_progress" },
  });
  send(
    command
      ? { type: "response.function_call_arguments.delta", output_index: 0, delta: JSON.stringify(args) }
      : { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
  );
  send({ type: "response.output_item.done", output_index: 0, item });
  send({
    type: "response.completed",
    response: {
      id: "resp_fixture",
      status: "completed",
      output: [item],
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    },
  });
  res.end();
}

async function runTurn(command: string, options: { gateOff?: boolean } = {}) {
  if (options.gateOff) process.env.PI_DESKTOP_SHELL_GATE = "off";
  const requests: Request[] = [];
  let firstReceived!: () => void;
  const received = new Promise<void>((resolve) => {
    firstReceived = resolve;
  });
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const request = JSON.parse(raw) as Request;
    requests.push(request);
    if (requests.length === 1) {
      firstReceived();
      respond(res, command);
    } else respond(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address missing");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const provider: RuntimeProviderConfig = {
    id: "fixture",
    name: "Fixture",
    baseUrl,
    modelId: "fixture",
    apiKey: "fixture-key",
    apiStyle: "responses",
    supportsReasoning: false,
    supportedThinkingLevels: ["off"],
    modelConfig: {
      source: "generic",
      name: "Fixture",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 2000,
    },
  };
  const history: UiMessage[] = [];
  const events: AgentEventEnvelope[] = [];
  const hostCalls: string[] = [];
  const runtime = new DesktopAgentRuntime({
    sessionId: "fixture",
    mode: "agent",
    provider,
    history,
    thinkingLevel: "off",
    compactionSettings: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    subagents: [],
    host: {
      call: async <T>(method: string): Promise<T> => {
        if (method === "session.appendMessage") return undefined as T;
        hostCalls.push(method);
        throw new Error("a gated shell command must never reach the host");
      },
      onNotification: () => () => {},
    },
    onEvent: (event) => {
      events.push(event);
    },
  });
  const pending = runtime.prompt("Force-push main.");
  void pending.catch(() => undefined);
  cleanups.push(async () => {
    await runtime.dispose();
    await pending.catch(() => undefined);
  });
  await received;
  await pending;
  const toolOutput = requests[1]?.input.find(
    (item) => item.type === "function_call_output" && item.call_id === "call_fixture",
  );
  return { requests, events, hostCalls, toolOutput };
}

it("refuses a destructive shell command before the host runs it", async () => {
  const { requests, events, hostCalls, toolOutput } = await runTurn("git push --force origin main");

  const serialized = JSON.stringify(toolOutput?.output);
  expect(serialized).toContain("shell command gate");
  expect(serialized).toContain("destructive git operation");
  expect(serialized).toContain("Nothing was run");
  // The refusal is a tool error, not a host failure or an agent crash.
  expect(hostCalls).toEqual([]);
  expect(events.find((event) => event.event.type === "tool_end")?.event).toMatchObject({
    type: "tool_end",
    isError: true,
  });
  expect(events.some((event) => event.event.type === "error")).toBe(false);
  // The turn continues: the model gets the block reason and answers.
  expect(requests).toHaveLength(2);
});

it("does not gate when the escape hatch disables it", async () => {
  const { hostCalls } = await runTurn("git push --force origin main", { gateOff: true });
  // With the gate off the call reaches the host, which this fixture refuses, so
  // the assertion is that the gate did not intercept it first.
  expect(hostCalls).toContain("tools.execute");
});
