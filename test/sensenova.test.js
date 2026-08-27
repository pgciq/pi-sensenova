import assert from "node:assert/strict";
import test from "node:test";
import extension from "../extensions/sensenova.ts";

function getProviderConfig() {
  let config;
  extension({
    registerProvider(_name, providerConfig) {
      config = providerConfig;
    },
  });
  return config;
}

test("uses a valid model array when refresh falls back to the cache", async () => {
  const config = getProviderConfig();
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
  const config = getProviderConfig();
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

test("awaits catalog persistence after successful discovery", async () => {
  const config = getProviderConfig();
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
