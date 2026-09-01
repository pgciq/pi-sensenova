import assert from "node:assert/strict";
import test from "node:test";
import extension from "../extensions/sensenova.ts";

// The extension guards the usage tracker and model commands with module-level
// flags (so pi reloads don't double-register handlers), so all tests share a
// single runtime instance.
const runtime = createRuntime();

function createRuntime() {
  let name;
  let config;
  const commands = new Map();
  const entries = [];
  const eventHandlers = new Map();
  extension({
    registerProvider(providerName, providerConfig) {
      name = providerName;
      config = providerConfig;
    },
    registerCommand(commandName, command) {
      commands.set(commandName, command);
    },
    registerEntryRenderer() {},
    appendEntry(key, data) {
      entries.push({ key, data });
    },
    on(eventName, handler) {
      eventHandlers.set(eventName, handler);
    },
  });
  return { name, config, commands, entries, eventHandlers };
}

test("registers the SenseNova OpenAI-compatible provider", () => {
  const { name, config } = runtime;
  assert.equal(name, "sensenova");
  assert.equal(config.name, "SenseNova");
  assert.equal(config.baseUrl, "https://token.sensenova.cn/v1");
  assert.equal(config.apiKey, "$SENSENOVA_API_KEY");
  assert.equal(config.api, "openai-completions");
  assert.equal(typeof config.streamSimple, "function");
  assert.equal(typeof config.refreshModels, "function");
});

test("seeds the documented text models", () => {
  const { config } = runtime;
  assert.deepEqual(config.models.map((model) => model.id), [
    "sensenova-6.7-flash-lite",
    "deepseek-v4-flash",
    "glm-5.2",
  ]);
  assert.equal(config.models[0].reasoning, true);
  assert.deepEqual(config.models[1].input, ["text"]);
});

test("registers model inspection and usage commands", () => {
  const { commands } = runtime;
  assert.deepEqual([...commands.keys()], [
    "sensenova-models",
    "sensenova-usage",
  ]);
});

test("models command includes capabilities and supports filtering", async () => {
  const { commands, entries } = runtime;
  await commands.get("sensenova-models").handler("vision", {
    mode: "tui",
    hasUI: false,
    modelRegistry: {
      getAll: () => [{
        provider: "sensenova",
        id: "sensenova-6.7-flash-lite",
        name: "sensenova-6.7-flash-lite",
        input: ["text", "image"],
        reasoning: true,
        sensenovaOutputModalities: ["text"],
      }, {
        provider: "sensenova",
        id: "deepseek-v4-flash",
        name: "deepseek-v4-flash",
        input: ["text"],
        reasoning: true,
        sensenovaOutputModalities: ["text"],
      }],
    },
  });
  assert.equal(entries.at(-1).key, "sensenova-models");
  assert.match(entries.at(-1).data.markdown, /sensenova-6\.7-flash-lite/);
  assert.doesNotMatch(entries.at(-1).data.markdown, /deepseek-v4-flash/);
  assert.match(entries.at(-1).data.markdown, /Context.*Max Output/);
});

test("image output models are flagged in the models table", async () => {
  const { commands, entries } = runtime;
  await commands.get("sensenova-models").handler("image", {
    mode: "tui",
    hasUI: false,
    modelRegistry: {
      getAll: () => [{
        provider: "sensenova",
        id: "sensenova-u1.5-lite",
        name: "sensenova-u1.5-lite",
        input: ["text", "image"],
        reasoning: false,
        sensenovaOutputModalities: ["image"],
      }],
    },
  });
  assert.match(entries.at(-1).data.markdown, /sensenova-u1\.5-lite/);
  assert.match(entries.at(-1).data.markdown, /✓/);
});

test("usage command renders an empty-state message with no recorded usage", async () => {
  const { commands, entries } = runtime;
  await commands.get("sensenova-usage").handler("", { mode: "tui", hasUI: false });
  assert.equal(entries.at(-1).key, "sensenova-usage");
  assert.match(entries.at(-1).data.markdown, /No SenseNova assistant usage/);
});

test("message_end handler accumulates usage and the usage command renders it", async () => {
  const { commands, entries, eventHandlers } = runtime;
  const handler = eventHandlers.get("message_end");
  assert.equal(typeof handler, "function");

  handler({ message: {
    role: "assistant",
    provider: "sensenova",
    model: "deepseek-v4-flash",
    usage: {
      input: 100,
      output: 50,
      totalTokens: 150,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0003 },
    },
  } });
  handler({ message: {
    role: "assistant",
    provider: "sensenova",
    model: "deepseek-v4-flash",
    usage: {
      input: 200,
      output: 40,
      totalTokens: 240,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0005 },
    },
  } });

  await commands.get("sensenova-usage").handler("", { mode: "tui", hasUI: false });
  const markdown = entries.at(-1).data.markdown;
  assert.match(markdown, /deepseek-v4-flash/);
  assert.match(markdown, /2\s+\|\s+300\s+\|\s+90\s+\|\s+390/);
  assert.match(markdown, /\$0\.000800/);
  assert.match(markdown, /\*\*Session total:\*\* \$0\.000800/);
});

test("non-sensenova assistant messages are ignored by the usage tracker", () => {
  const { eventHandlers } = runtime;
  const handler = eventHandlers.get("message_end");
  handler({ message: { role: "assistant", provider: "anthropic", model: "claude", usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 1 } } } });
  handler({ message: { role: "user", provider: "sensenova", model: "x", content: "hi" } });
  handler({ message: undefined });
});

test("uses a valid model array when refresh falls back to the cache", async () => {
  const { config } = runtime;
  const cachedModels = [{
    id: "cached-model",
    name: "Cached model",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  }];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("offline");
  };

  try {
    const result = await config.refreshModels({
      signal: new AbortController().signal,
      stored: { provider: "sensenova", models: cachedModels },
      publish: async () => true,
    });
    assert.deepEqual(result, cachedModels);
    assert.ok(Array.isArray(result));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns seed models when discovery has no cache", async () => {
  const { config } = runtime;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("offline");
  };

  try {
    const result = await config.refreshModels({
      signal: new AbortController().signal,
      publish: async () => true,
    });
    assert.deepEqual(result.map((model) => model.id), [
      "sensenova-6.7-flash-lite",
      "deepseek-v4-flash",
      "glm-5.2",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("maps API pricing into model cost", async () => {
  const { config } = runtime;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [{
      id: "priced-model",
      pricing: { prompt: "0.0000015", completion: "0.000006", input_cache_read: "0.0000003" },
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    const result = await config.refreshModels({
      signal: new AbortController().signal,
      publish: async () => true,
    });
    assert.deepEqual(result[0].cost, {
      input: 0.0000015,
      output: 0.000006,
      cacheRead: 0.0000003,
      cacheWrite: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("awaits catalog persistence after successful discovery", async () => {
  const { config } = runtime;
  const originalFetch = globalThis.fetch;
  let published = false;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [{ id: "remote-model" }],
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    const result = await config.refreshModels({
      signal: new AbortController().signal,
      publish: async ({ persist }) => {
        assert.equal(persist.provider, "sensenova");
        assert.equal(persist.models[0].id, "remote-model");
        await Promise.resolve();
        published = true;
        return true;
      },
    });
    assert.equal(published, true);
    assert.equal(result[0].id, "remote-model");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
