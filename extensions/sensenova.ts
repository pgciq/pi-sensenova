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
import { Image, Markdown } from "@earendil-works/pi-tui";

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
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
  appendSenseNovaImage = (image) => pi.appendEntry("sensenova-generated-image", image);
  pi.registerEntryRenderer("sensenova-generated-image", (entry, _options, theme) => {
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
      return new Markdown(`Generated image unavailable: ${fileLink(image.path ?? "unknown path")}`, 1, 0, theme);
    }
  });

  pi.registerProvider("sensenova", {
    name: "SenseNova",
    baseUrl,
    // Keep this as an env reference even when the variable is absent. Pi can
    // then mark the provider as unconfigured instead of trying to use a
    // literal placeholder key during startup.
    apiKey: `$${apiKeyEnv}`,
    api: "openai-completions",
    streamSimple: streamSenseNova,
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
