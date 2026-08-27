// SenseNova provider (OpenAI-compatible) — https://platform.sensenova.cn/docs
// Base URL: https://token.sensenova.cn/v1 ; auth via SENSENOVA_API_KEY env var
//
// Model discovery: registers a fast seed list on startup, then refreshes
// from /v1/models in the background.  Discovered models are persisted to disk
// and re-used on subsequent starts when the API is unreachable.

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

const effortMap = { minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };

const REASONING_IDS = new Set([
  "sensenova-6.7-flash-lite",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "glm-5.2",
]);

const TEXT_ONLY_IDS = new Set([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "glm-5.2",
]);

function detectLimits(id) {
  if (id.startsWith("sensenova-6")) return { contextWindow: 262144, maxTokens: 65536 };
  if (id.startsWith("deepseek-v4")) return { contextWindow: 1048576, maxTokens: 65536 };
  if (id.startsWith("glm-5")) return { contextWindow: 1048576, maxTokens: 131072 };
  if (id.startsWith("sensenova")) return { contextWindow: 262144, maxTokens: 65536 };
  // Sensible defaults for unknown models
  return { contextWindow: 131072, maxTokens: 32768 };
}

function isReasoningModel(id) {
  if (REASONING_IDS.has(id)) return true;
  if (id.startsWith("deepseek") || id.startsWith("glm-")) return true;
  return false;
}

function convertModel(model) {
  const id = typeof model?.id === "string" ? model.id : String(model?.id ?? "");
  const entry = {
    id,
    name: id,
    reasoning: false,
    input: TEXT_ONLY_IDS.has(id) ? ["text"] : ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...detectLimits(id),
  };

  if (isReasoningModel(id)) {
    entry.reasoning = true;
    entry.thinkingLevelMap = effortMap;
    entry.compat = { supportsReasoningEffort: true, supportsDeveloperRole: false };
  }

  return entry;
}

// ---------------------------------------------------------------------------
// Seed models (available immediately on startup)
// ---------------------------------------------------------------------------

const SENSENOVA_SEED = [
  "sensenova-6.7-flash-lite",
  "deepseek-v4-flash",
  "glm-5.2",
];

// ---------------------------------------------------------------------------
// Dynamic model fetch (shared by startup & refreshModels)
// ---------------------------------------------------------------------------

async function fetchModels(baseUrl, signal) {
  const apiKey = process.env["SENSENOVA_API_KEY"];
  const headers = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl}/models`, { headers, redirect: "follow", signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const payload = await res.json();
  // OpenAI /v1/models returns { data: [{ id, ... }] }
  const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return data
    .filter((m) => m && m.id)
    .map(convertModel);
}

// ---------------------------------------------------------------------------
// Extension entry point (synchronous — no network on startup)
// ---------------------------------------------------------------------------

export default function (pi) {
  const baseUrl = "https://token.sensenova.cn/v1";
  const apiKeyEnv = "SENSENOVA_API_KEY";

  pi.registerProvider("sensenova", {
    name: "SenseNova",
    baseUrl,
    // Keep this as an env reference even when the variable is absent. Pi can
    // then mark the provider as unconfigured instead of trying to use a
    // literal placeholder key during startup.
    apiKey: `$${apiKeyEnv}`,
    api: "openai-completions",
    models: SENSENOVA_SEED.map((id) => convertModel({ id })),

    async refreshModels({ signal, stored, publish, allowNetwork }) {
      // `stored` is a catalog entry ({ models: [...] }), not the model array
      // itself. Returning the entry here makes Pi try to use an object as a
      // model list when the network is unavailable, which aborts startup.
      const cachedModels = Array.isArray(stored?.models) ? stored.models : undefined;
      const seedModels = SENSENOVA_SEED.map((id) => convertModel({ id }));

      // The first refresh phase only restores persisted state. Do not make a
      // network request until Pi has confirmed that network access is allowed.
      if (allowNetwork === false || signal.aborted) {
        return cachedModels?.length ? cachedModels : seedModels;
      }

      let models;
      try {
        models = await fetchModels(baseUrl, signal);
      } catch {
        // Model discovery is optional. Always leave Pi with a valid array so
        // an offline/unauthenticated startup cannot terminate the process.
        return cachedModels?.length ? cachedModels : seedModels;
      }

      if (models.length > 0) {
        // Persist the catalog so it survives restarts & offline starts.
        await publish({ persist: { provider: "sensenova", models } });
        return models;
      }

      // No models returned — keep the cached catalog or the seed list.
      return cachedModels?.length ? cachedModels : seedModels;
    },
  });
}
