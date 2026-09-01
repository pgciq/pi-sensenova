// SenseNova provider (OpenAI-compatible) — https://platform.sensenova.cn/docs
// Base URL: https://token.sensenova.cn/v1 ; auth via SENSENOVA_API_KEY env var
//
// Model discovery: registers a fast seed list on startup, then refreshes
// from /v1/models in the background.  Discovered models are persisted to disk
// and re-used on subsequent starts when the API is unreachable.

import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

// The TUI package is provided by pi at runtime. Keep it optional so print/RPC
// usage and lightweight provider tests do not fail if it is not installed.
let Image;
let Markdown;
try {
  ({ Image, Markdown } = await import("@earendil-works/pi-tui"));
} catch {
  Image = undefined;
  Markdown = undefined;
}

// The theme passed to custom entry renderers is a general UI theme and does
// not implement Markdown methods such as `heading()`. Use pi's Markdown theme
// factory instead of passing that renderer theme directly to Markdown.
let getMarkdownTheme;
try {
  getMarkdownTheme = (await import("@earendil-works/pi-coding-agent")).getMarkdownTheme;
} catch {
  getMarkdownTheme = undefined;
}

// Convert an absolute path to a clickable Markdown link. The TUI renders
// `[label](url)` as an OSC 8 hyperlink, so the saved file opens in one click.
function fileLink(p, label = p) {
  return `[${label}](${pathToFileURL(String(p)).href})`;
}

// `openAICompletionsApi` lives on the bare `@earendil-works/pi-ai` export in
// older pi-ai builds but moved to the `@earendil-works/pi-ai/api/openai-completions.lazy`
// subpath in newer ones. Resolve it defensively so the extension loads on both.
let appendSenseNovaImage = null;

const openAICompletionsApi = await (async () => {
  try {
    return (await import("@earendil-works/pi-ai/api/openai-completions.lazy")).openAICompletionsApi;
  } catch {
    return (await import("@earendil-works/pi-ai")).openAICompletionsApi;
  }
})();

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
const IMAGE_EDIT_IDS = new Set(["sensenova-u1.5-lite"]);

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

// SenseNova's /v1/models returns OpenRouter-style pricing in USD per token,
// as strings (e.g. { prompt: "0.0000001", completion: "0.0000002" }). Map it
// into pi's cost model; absent/unparseable values default to zero.
function modelCost(model) {
  const pricing = model?.pricing ?? {};
  const read = (...keys) => {
    for (const key of keys) {
      const value = Number(pricing[key]);
      if (pricing[key] !== undefined && pricing[key] !== null && pricing[key] !== "" && Number.isFinite(value)) {
        return value;
      }
    }
    return 0;
  };
  return {
    input: read("prompt", "input"),
    output: read("completion", "output"),
    cacheRead: read("input_cache_read", "cache_read", "cacheRead"),
    cacheWrite: read("input_cache_write", "cache_write", "cacheWrite"),
  };
}

function convertModel(model) {
  const id = typeof model?.id === "string" ? model.id : String(model?.id ?? "");
  const outputModalities = Array.isArray(model?.output_modalities)
    ? model.output_modalities
    : /^(sensenova-u1(?:\.5)?(?:-fast|-lite)?)$/.test(id)
      ? ["image"]
      : ["text"];
  const inputModalities = IMAGE_EDIT_IDS.has(id)
    ? ["text", "image"]
    : Array.isArray(model?.input_modalities)
      ? model.input_modalities
      : TEXT_ONLY_IDS.has(id)
        ? ["text"]
        : ["text", "image"];
  const entry = {
    id,
    name: id,
    reasoning: false,
    input: inputModalities.includes("image") ? ["text", "image"] : ["text"],
    cost: modelCost(model),
    ...detectLimits(id),
    // Private metadata consumed by streamSenseNova. Pi ignores unknown fields.
    sensenovaOutputModalities: outputModalities,
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
// Dedicated image generation API
// ---------------------------------------------------------------------------

function latestUserContent(context) {
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  return [...messages].reverse().find((message) => message?.role === "user");
}

function latestTextPrompt(context) {
  const user = latestUserContent(context);
  if (!user) return "";
  if (typeof user.content === "string") return user.content;
  return (user.content ?? [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function latestReferenceImages(context) {
  const user = latestUserContent(context);
  if (!user || typeof user.content === "string") return [];
  return (user.content ?? []).filter((part) => part?.type === "image");
}

async function saveGeneratedImage(image, modelId) {
  const directory = join(process.cwd(), ".pi", "generated-images");
  await mkdir(directory, { recursive: true });
  const mime = image?.mime_type ?? "image/png";
  const extension = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
  const filename = `${modelId}-${Date.now()}.${extension}`;
  const filePath = join(directory, filename);
  if (image?.b64_json) {
    await writeFile(filePath, Buffer.from(image.b64_json, "base64"));
  } else if (image?.url) {
    const download = await fetch(image.url);
    if (!download.ok) throw new Error(`Unable to download generated image: HTTP ${download.status}`);
    await writeFile(filePath, Buffer.from(await download.arrayBuffer()));
  } else {
    throw new Error("Image API returned neither url nor b64_json");
  }
  return { filePath, mimeType: mime };
}

function streamImageGeneration(model, context, options) {
  const stream = createAssistantMessageEventStream();
  const output = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };

  (async () => {
    try {
      stream.push({ type: "start", partial: output });
      const prompt = latestTextPrompt(context);
      if (!prompt) throw new Error("Image generation requires a text prompt");
      const references = latestReferenceImages(context);
      const endpoint = references.length
        ? "https://token.sensenova.cn/v1/images/edits"
        : "https://token.sensenova.cn/v1/images/generations";
      const request = references.length
        ? {
            model: model.id,
            images: references.map((image) => ({
              image_url: `data:${image.mimeType};base64,${image.data}`,
            })),
            prompt,
            n: 1,
            response_format: "url",
            output_format: "png",
          }
        : {
            model: model.id,
            prompt,
            n: 1,
            response_format: "url",
            output_format: "png",
          };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.SENSENOVA_API_KEY ?? ""}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: options?.signal,
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? `SenseNova image API HTTP ${response.status}`);
      }
      const image = payload?.data?.[0];
      if (!image) throw new Error("Image API returned no image data");
      const saved = await saveGeneratedImage(image, model.id);
      const filePath = saved.filePath;
      appendSenseNovaImage?.({ path: filePath, mimeType: saved.mimeType });
      const result = image.url
        ? `![Generated image](${image.url})\n\nSaved local copy: ${fileLink(filePath)}\n\nImage URL (valid for 24 hours): ${image.url}`
        : `Generated image saved to: ${fileLink(filePath)}`;
      output.content.push({ type: "text", text: result });
      stream.push({ type: "text_start", contentIndex: 0, partial: output });
      stream.push({ type: "text_delta", contentIndex: 0, delta: result, partial: output });
      stream.push({ type: "text_end", contentIndex: 0, content: result, partial: output });
      output.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

function streamSenseNova(model, context, options) {
  const modalities = model.sensenovaOutputModalities;
  const imageModel =
    (Array.isArray(modalities) && modalities.includes("image")) ||
    /^(sensenova-u1(?:\.5)?(?:-fast|-lite)?)$/.test(model.id);
  if (imageModel) {
    return streamImageGeneration(model, context, options);
  }
  return openAICompletionsApi().streamSimple(model, context, options);
}

// ---------------------------------------------------------------------------
// Extension entry point (synchronous — no network on startup)
// ---------------------------------------------------------------------------

export default function (pi) {
  const baseUrl = "https://token.sensenova.cn/v1";
  const apiKeyEnv = "SENSENOVA_API_KEY";
  const discovery = { models: SENSENOVA_SEED.map((id) => convertModel({ id })) };
  appendSenseNovaImage = (image) => pi.appendEntry("sensenova-generated-image", image);
  if (typeof Image === "function") {
    pi.registerEntryRenderer?.("sensenova-generated-image", (entry, _options, theme) => {
      const image = entry.data ?? {};
      // pi passes an entry-renderer `theme` that lacks `fallbackColor()`, which
      // `Image.render` calls. Wrap it so inline previews render and never throw.
      const imageTheme = theme && typeof theme.fallbackColor === "function"
        ? theme
        : { fallbackColor: (s) => (theme && theme.fg ? theme.fg("toolOutput", s) : s) };
      try {
        const data = readFileSync(image.path).toString("base64");
        return new Image(data, image.mimeType || "image/png", imageTheme, { maxWidthCells: 80, maxHeightCells: 30 });
      } catch {
        if (typeof Markdown === "function") {
          return new Markdown(`Generated image unavailable: ${fileLink(image.path ?? "unknown path")}`, 1, 0, theme);
        }
        return image.path ?? "unknown path";
      }
    });
  }

  pi.registerProvider("sensenova", {
    name: "SenseNova",
    baseUrl,
    // Keep this as an env reference even when the variable is absent. Pi can
    // then mark the provider as unconfigured instead of trying to use a
    // literal placeholder key during startup.
    apiKey: `$${apiKeyEnv}`,
    api: "openai-completions",
    streamSimple: streamSenseNova,
    models: discovery.models,

    async refreshModels({ signal, stored, publish, allowNetwork }) {
      // `stored` is a catalog entry ({ models: [...] }), not the model array
      // itself. Returning the entry here makes Pi try to use an object as a
      // model list when the network is unavailable, which aborts startup.
      const cachedModels = Array.isArray(stored?.models) ? stored.models : undefined;
      const seedModels = SENSENOVA_SEED.map((id) => convertModel({ id }));

      // The first refresh phase only restores persisted state. Do not make a
      // network request until Pi has confirmed that network access is allowed.
      if (allowNetwork === false || signal.aborted) {
        const fallback = cachedModels?.length ? cachedModels : seedModels;
        discovery.models = fallback;
        return fallback;
      }

      let models;
      try {
        models = await fetchModels(baseUrl, signal);
      } catch {
        // Model discovery is optional. Always leave Pi with a valid array so
        // an offline/unauthenticated startup cannot terminate the process.
        const fallback = cachedModels?.length ? cachedModels : seedModels;
        discovery.models = fallback;
        return fallback;
      }

      if (models.length > 0) {
        // Persist the catalog so it survives restarts & offline starts.
        await publish({ persist: { provider: "sensenova", models } });
        discovery.models = models;
        return models;
      }

      // No models returned — keep the cached catalog or the seed list.
      const fallback = cachedModels?.length ? cachedModels : seedModels;
      discovery.models = fallback;
      return fallback;
    },
  });

  registerModelCommands(pi, discovery);
  installUsageTracker(pi);
  registerUsageCommand(pi);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const CAPABILITY_FLAGS = {
  reasoning: "reasoning",
  vision: "vision",
  image: "image",
  video: "video",
  audio: "audio",
  tools: "tools",
};

function showMarkdown(pi, ctx, key, markdown) {
  if (ctx?.mode === "tui") pi.appendEntry(key, { markdown });
  else if (ctx?.hasUI) ctx.ui.notify(markdown, "info");
  else console.log(markdown);
}

function registerMarkdownRenderer(pi, key) {
  if (typeof Markdown !== "function" || typeof getMarkdownTheme !== "function") return;
  pi.registerEntryRenderer?.(key, (entry) =>
    new Markdown(entry.data?.markdown ?? "", 1, 0, getMarkdownTheme()),
  );
}

function getModelCatalog(ctx, discovery) {
  const registered = ctx?.modelRegistry?.getAll?.() ?? [];
  const models = registered.filter((model) => model.provider === "sensenova");
  return models.length > 0 ? models : discovery.models;
}

function formatSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

// Pi costs are USD per token; display them as USD per million tokens.
function formatPrice(perToken) {
  const n = Number(perToken);
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  const perMillion = n * 1_000_000;
  return `$${perMillion < 0.01 ? perMillion.toPrecision(2) : perMillion.toFixed(2)}`;
}

function modelCapabilities(model) {
  const caps = model.capabilities ?? {};
  const outputModalities = Array.isArray(model.sensenovaOutputModalities)
    ? model.sensenovaOutputModalities
    : [];
  return {
    reasoning: caps.reasoning ?? model.reasoning ?? false,
    vision: caps.vision ?? (Array.isArray(model.input) && model.input.includes("image")) ?? false,
    image: caps.image ?? (outputModalities.includes("image") || /^(sensenova-u1(?:.5)?(?:-fast|-lite)?)$/.test(model.id)) ?? false,
    video: caps.video ?? false,
    audio: caps.audio ?? false,
    tools: caps.tools !== false,
  };
}

function registerModelCommands(pi, discovery) {
  if (typeof pi.registerCommand !== "function") return;

  pi.registerCommand("sensenova-models", {
    description: "List SenseNova models with capabilities and limits; optional filter: image, vision, tools, reasoning, audio, video.",
    handler: async (args, ctx) => {
      const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
      const filter = tokens.find((token) => token in CAPABILITY_FLAGS);
      const mark = (value) => value ? "✓" : "—";
      const rows = getModelCatalog(ctx, discovery)
        .map((model) => ({ model, ...modelCapabilities(model) }))
        .filter((row) => !filter || row[CAPABILITY_FLAGS[filter]])
        .sort((a, b) => a.model.id.localeCompare(b.model.id));
      const markdown = [
        `# SenseNova models${filter ? ` (filter: ${filter})` : ""}`,
        "",
        "| Model | Display Name | Reasoning | Vision | Image | Video | Audio | Tools | Context | Max Output | Input $/M | Output $/M |",
        "|---|---|:---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---:|---:|",
        ...rows.map((row) => `| \`${row.model.id}\` | ${row.model.name || row.model.id} | ${mark(row.reasoning)} | ${mark(row.vision)} | ${mark(row.image)} | ${mark(row.video)} | ${mark(row.audio)} | ${mark(row.tools)} | ${formatSize(row.model.contextWindow)} | ${formatSize(row.model.maxTokens)} | ${formatPrice(row.model.cost?.input)} | ${formatPrice(row.model.cost?.output)} |`),
        "",
        "_Capabilities come from SenseNova model metadata when available; `—` means the capability was not advertised._",
        rows.length ? "" : "_No models match the filter._",
      ].join("\n");
      showMarkdown(pi, ctx, "sensenova-models", markdown);
    },
  });
  registerMarkdownRenderer(pi, "sensenova-models");
}

// SenseNova does not provide a billing/usage endpoint in its OpenAI-compatible
// API. Track the usage reported by completed assistant messages instead. This
// is process-local Pi usage, not an account-level SenseNova invoice.
const SENSENOVA_SESSION_USAGE = new Map();
let usageHookInstalled = false;

function installUsageTracker(pi) {
  if (usageHookInstalled || typeof pi.on !== "function") return;
  usageHookInstalled = true;
  pi.on("message_end", (event) => {
    const message = event?.message;
    if (message?.role !== "assistant" || message.provider !== "sensenova") return;

    const key = `${message.provider}/${message.model}`;
    const row = SENSENOVA_SESSION_USAGE.get(key) ?? {
      provider: message.provider,
      model: message.model,
      turns: 0,
      input: 0,
      output: 0,
      total: 0,
      cost: 0,
    };
    const usage = message.usage ?? {};
    const cost = usage.cost ?? {};
    const input = Number(usage.input) || 0;
    const output = Number(usage.output) || 0;
    const total = Number(usage.totalTokens) || input + output;
    const turnCost = Number(cost.total);

    row.turns += 1;
    row.input += input;
    row.output += output;
    row.total += total;
    row.cost += Number.isFinite(turnCost) ? turnCost : 0;
    SENSENOVA_SESSION_USAGE.set(key, row);
  });
}

function registerUsageCommand(pi) {
  if (typeof pi.registerCommand !== "function") return;

  pi.registerCommand("sensenova-usage", {
    description: "Show SenseNova token/cost usage accumulated in the current Pi process.",
    handler: async (_args, ctx) => {
      const rows = [...SENSENOVA_SESSION_USAGE.values()]
        .sort((a, b) => a.model.localeCompare(b.model));
      const totalCost = rows.reduce((sum, row) => sum + row.cost, 0);
      const markdown = [
        "# SenseNova session usage",
        "",
        "_This is usage reported by completed assistant messages in the current Pi process, not a SenseNova account billing dashboard._",
        "",
        "| Model | Turns | Input Tokens | Output Tokens | Total Tokens | Cost |",
        "|---|---:|---:|---:|---:|---:|",
        ...rows.map((row) => `| ${row.model} | ${row.turns} | ${row.input.toLocaleString()} | ${row.output.toLocaleString()} | ${row.total.toLocaleString()} | $${row.cost.toFixed(6)} |`),
        "",
        rows.length
          ? `**Session total:** $${totalCost.toFixed(6)}`
          : "_No SenseNova assistant usage recorded in this Pi process yet._",
      ].join("\n");
      showMarkdown(pi, ctx, "sensenova-usage", markdown);
    },
  });
  registerMarkdownRenderer(pi, "sensenova-usage");
}
