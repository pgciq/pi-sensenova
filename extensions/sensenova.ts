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
  const id = model.id;
  const entry = {
    id,
    name: model.id || id,
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
  // If env var is set, use $VAR reference so pi picks it up; otherwise
  // use a placeholder so the provider still shows in --list-models and
  // the user gets a clear auth error instead of a silent skip.
  const apiKeyRef = process.env[apiKeyEnv] ? `$${apiKeyEnv}` : "<missing>";
  if (!process.env[apiKeyEnv]) {
    console.error(`[pi-sensenova] SenseNova: ${apiKeyEnv} is not set. Provider will be listed but API calls will fail until the env var is configured.`);
  }

  pi.registerProvider("sensenova", {
    name: "SenseNova",
    baseUrl,
    apiKey: apiKeyRef,
    api: "openai-completions",
    models: SENSENOVA_SEED.map((id) => convertModel({ id })),

    async refreshModels({ signal, stored, publish }) {
      let models;
      try {
        models = await fetchModels(baseUrl, signal);
      } catch (error) {
        // If we have a cached catalog from a previous refresh, use it
        if (stored) return stored;
        // Otherwise keep the seed list (caller still has it)
        throw error;
      }

      if (models.length > 0) {
        // Persist the catalog so it survives restarts & offline starts
        publish({ persist: { provider: "sensenova", models } });
        return models;
      }

      // No models returned — keep whatever we have
      return stored ?? undefined;
    },
  });
}
