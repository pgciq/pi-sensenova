# pi-sensenova

Pi extension for [SenseNova](https://platform.sensenova.cn/docs), with dynamic model discovery.

## Install

```bash
pi install npm:pi-sensenova
```

Or install from git:

```bash
pi install git:github.com/pgciq/pi-sensenova
```

## Configuration

Set the API key before starting pi:

```bash
export SENSENOVA_API_KEY="your-api-key"
```

The provider uses `https://token.sensenova.cn/v1` and registers as `sensenova`. It starts with a seed model catalog and refreshes it from `/v1/models` in the background. A successful catalog refresh is persisted for offline starts.

## Usage

```bash
pi --model sensenova/deepseek-v4-flash "你好"
```
