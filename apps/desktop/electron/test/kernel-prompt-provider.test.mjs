import assert from "node:assert/strict";
import test from "node:test";

const { adaptKernelProvider } = await import("../main/kernel/kernel-prompt.ts");

/*
 * The launch payload's provider as the kernel's provider spec.
 *
 * The failure this guards shipped: the adapter matched `openai-completions` (the
 * pi-runtime spelling) but the app's own `API_STYLES` default is
 * `chat_completions`, so every provider a user had not re-styled by hand failed
 * with KERNEL_PROMPT_INVALID before the turn started.
 */

const base = {
  baseUrl: "https://api.example.test/v1",
  apiKey: "sk-test",
  modelId: "test-model",
};

test("accepts the app's default chat_completions wire", () => {
  const result = adaptKernelProvider({ ...base, apiStyle: "chat_completions" });
  assert.equal(result.unsupported, undefined);
  assert.equal(result.provider?.kind, "openai");
});

test("accepts the pi-runtime spelling of the same wire", () => {
  const result = adaptKernelProvider({ ...base, apiStyle: "openai-completions" });
  assert.equal(result.provider?.kind, "openai");
});

test("accepts an anthropic provider", () => {
  const result = adaptKernelProvider({ ...base, apiStyle: "anthropic_messages" });
  assert.equal(result.provider?.kind, "anthropic");
});

test("treats a provider with no apiStyle as chat completions", () => {
  const result = adaptKernelProvider({ ...base });
  assert.equal(result.provider?.kind, "openai");
});

test("accepts the wires the kernel selects by apiStyle, and carries no kind", () => {
  for (const apiStyle of ["responses", "google_generative_ai"]) {
    const result = adaptKernelProvider({ ...base, apiStyle });
    assert.equal(result.unsupported, undefined, apiStyle);
    assert.equal(result.provider?.apiStyle, apiStyle, apiStyle);
    // `kind` wins over `apiStyle` inside the kernel, so carrying both would select
    // the Chat Completions wire while the row asked for something else.
    assert.equal(result.provider?.kind, undefined, apiStyle);
  }
});

test("refuses a wire the kernel does not speak instead of flattening it", () => {
  for (const apiStyle of ["openai_codex_responses", "pi_messages", "opencode_go"]) {
    const result = adaptKernelProvider({ ...base, apiStyle });
    assert.match(result.unsupported ?? "", /provider\.apiStyle\(/, apiStyle);
    assert.equal(result.provider, undefined, apiStyle);
  }
});

test("refuses a provider without an endpoint or a credential", () => {
  assert.match(
    adaptKernelProvider({ apiKey: "sk-test" }).unsupported ?? "",
    /provider\.baseUrl/,
  );
  assert.match(
    adaptKernelProvider({ baseUrl: base.baseUrl }).unsupported ?? "",
    /provider\.apiKey/,
  );
});

test("an authless provider needs no key and says so", () => {
  const result = adaptKernelProvider({
    baseUrl: base.baseUrl,
    authKind: "none",
    apiStyle: "chat_completions",
  });
  assert.equal(result.unsupported, undefined);
  assert.equal(result.provider?.kind, "openai");
  assert.equal(result.provider?.authKind, "none");
  assert.equal("apiKey" in (result.provider ?? {}), false);
});

test("carries headers and the model's output budget through", () => {
  const result = adaptKernelProvider({
    ...base,
    apiStyle: "chat_completions",
    headers: { "x-test": "1" },
    modelConfig: { maxOutputTokens: 4096, contextWindow: 128000 },
  });
  assert.deepEqual(result.provider?.headers, { "x-test": "1" });
  assert.equal(result.provider?.defaultMaxTokens, 4096);
  // The context window is read elsewhere; it must not leak into the provider spec.
  assert.equal("contextWindow" in (result.provider ?? {}), false);
});
