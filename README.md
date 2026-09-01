# pi-sensenova

Pi extension for [SenseNova](https://platform.sensenova.cn/docs), an OpenAI-compatible provider. It registers the `sensenova` provider with a seed model catalog, then refreshes the catalog from `/v1/models` in the background and persists it for offline starts.

## Install

```bash
pi install npm:pi-sensenova
```

Or install from git:

```bash
pi install git:github.com/pgciq/pi-sensenova
```

To try it for a single run without persisting:

```bash
pi -e .
```

## Configuration

Set the API key before starting pi:

```bash
export SENSENOVA_API_KEY="your-api-key"
```

- **Base URL:** `https://token.sensenova.cn/v1`
- **Provider id:** `sensenova`
- **Auth:** `SENSENOVA_API_KEY` env var (the key is kept as an env reference, so pi marks the provider unconfigured rather than sending a placeholder when the variable is absent)

## Features

- **OpenAI-compatible streaming** — text models stream through pi-ai's `openai-completions` API.
- **Reasoning / thinking models** — `deepseek-v4-flash`, `deepseek-v4-pro`, and `glm-5.2` expose a thinking-effort level map (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`).
- **Image generation** — models matching `sensenova-u1`, `sensenova-u1.5`, `sensenova-u1-fast`, `sensenova-u1.5-fast` (and `sensenova-u1.5-lite`) route to the verified `/v1/images/generations` endpoint. Generated images are saved under `.pi/generated-images/`; supported terminals also receive a TUI `Image` entry, while print/RPC mode reports the saved path.
- **Image editing** — `sensenova-u1.5-lite` routes to `/v1/images/edits` when the prompt includes reference images.
- **Dynamic model discovery** — a seed list is available immediately; the full list is fetched from `/v1/models` and cached. Discovered models survive restarts and offline starts.

## Seed models

| Model id              | Notes                          |
| --------------------- | ------------------------------ |
| `sensenova-6.7-flash-lite` | Reasoning-capable text model |
| `deepseek-v4-flash`   | Reasoning-capable text model   |
| `glm-5.2`             | Reasoning-capable text model   |

Models discovered via `/v1/models` are added automatically.

## Model discovery (non-blocking)

`pi-sensenova` registers a **seed** model catalog synchronously at load (so pi starts instantly) and refreshes it from `/v1/models` **in the background** via pi's `refreshModels` callback — it never blocks startup on the network.

- The seed list is always available immediately, even offline or without `SENSENOVA_API_KEY`.
- A successful background refresh replaces the seed list and is persisted to pi's provider cache, so discovered models survive restarts and offline starts.
- Every network call is bounded by a timeout and degrades to the seed list on any failure.

## Usage

```bash
pi --model sensenova/deepseek-v4-flash "你好"
```

Generate an image (text prompt) with an image model:

```bash
pi --model sensenova/sensenova-u1.5-lite "一只戴帽子的猫"
```

## Commands

The extension registers the following commands:

| Command | Description |
|---|---|
| `/sensenova-models [image\|vision\|audio\|video\|reasoning\|tools]` | List SenseNova models with capabilities, context/output limits; an optional filter narrows the table. |
| `/sensenova-usage` | Show token/cost usage accumulated in the current Pi process. |

Examples:

```text
/sensenova-models
/sensenova-models vision
/sensenova-models image
/sensenova-usage
```

`/sensenova-usage` is based on `message_end` usage reported by completed assistant messages and is therefore local to the current Pi process. SenseNova's OpenAI-compatible API does not expose a uniform account-level billing/usage endpoint through this provider, so this command is not an account invoice.

## Development

The extension depends on `@earendil-works/pi-ai` (a peer dependency provided by pi at runtime). `createAssistantMessageEventStream` is imported from the bare package, and `openAICompletionsApi` is resolved defensively: newer pi-ai builds expose it only via the `@earendil-works/pi-ai/api/openai-completions.lazy` subpath, while older builds export it from the bare package. The fallback import keeps the extension loading on both layouts. Validate with:

```bash
node --test
```
