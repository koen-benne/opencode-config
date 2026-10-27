---
name: bonzai-manage-models
description: Use when the user wants to manage LLM models in their opencode config — adding, removing, swapping, upgrading, or listing available models from Bonzai. Also use when they mention "models", "bonzai", "model roster", or want to see what's available.
---

# Bonzai Model Management

Manage the LLM model roster in `opencode.jsonc` via the Bonzai LiteLLM proxy.

## Start here

Ask the user what they want to do:
- **List** what's configured vs what's available
- **Add** new models
- **Swap** one model for another
- **Remove** models they no longer use
- **Change defaults** (model, small_model, agent overrides)

## 1. Read current config

Read `~/.config/opencode/opencode.json`. Identify:
- All configured models under each provider's `models` key
- The `model` and `small_model` defaults
- Any agent-level `model` overrides
- The API key source in the provider `options`. This setup uses `{env:BONZAI_API_KEY}`.

## 2. Fetch available models from Bonzai

Use the `BONZAI_API_KEY` environment variable:

```bash
curl https://api-v2.bonzai.iodigital.com/v1/models \
  --silent \
  -H "Authorization: Bearer $BONZAI_API_KEY" \
  | jq '.data[] | .id' -r | sort | uniq
```

## 3. Filter and present

The raw model list includes a lot of cruft (embedding models, image models, rerankers, whisper, TTS, realtime, old aliases, etc). Filter to only models usable as chat/code assistants in opencode:
- Must support tool calling
- Must have reasonable context window (>100k)
- Must support text input/output
- Ignore duplicates/aliases (e.g., `claude-sonnet-4-6` and `claude-sonnet-4-6-bedrock` are the same model — pick the bedrock variant for Anthropic)

Group by provider family: Anthropic, OpenAI, Google, Mistral, etc.

## 4. Get user decisions

Present what's new/available that they don't have. Ask what they want to do. Don't assume "upgrade" — they might want to keep old models, add alternatives, or just clean house.

## 5. Look up metadata on models.dev

For each model to add/update, fetch `https://models.dev/<lab>/<model-slug>` (the model detail page). Extract:
- `release_date`
- Context window → `limit.context`
- Max output → `limit.output`
- Pricing (input/output per million tokens) → `cost.input`, `cost.output`
- Capabilities: `reasoning`, `tool_call`, `temperature`
- Whether it accepts attachments (images/PDFs)

For cache pricing: if not on the model page, use standard ratios (Anthropic: cache_read = input/10, cache_write = input*1.25; OpenAI: cache_read = input/10, cache_write = 0).

Note: models.dev often shows $0.00/$0.00 for newly released models where pricing hasn't been populated yet. In that case, estimate from the model family's known pricing or ask the user.

## Provider routing rules

- **Anthropic models**: ALWAYS use the `bedrock` provider with `eu.anthropic.*` model IDs. The bedrock provider sends `anthropic-beta` headers required for features like interleaved thinking and fine-grained tool streaming.
- **OpenAI models**: Use the `bonzai-universal` provider with plain model names (e.g., `gpt-5.6-luna`).
- **Google/Gemini models**: Use the `bonzai-universal` provider.
- **Other models**: Use `bonzai-universal` unless there's a specific reason not to.

## Model ID patterns on Bonzai

- Bedrock Anthropic: `eu.anthropic.claude-{tier}-{version}` (e.g., `eu.anthropic.claude-opus-5`)
- Bonzai Universal: plain model name as listed by the API (e.g., `gpt-5.6-luna`, `gemini-3.6-flash`)

## Config entry format

```jsonc
"model-id": {
  "name": "Human Readable Name",
  "release_date": "YYYY-MM-DD",
  "attachment": true,
  "reasoning": true,
  "temperature": true|false,
  "tool_call": true,
  "family": "claude-opus", // optional, for grouping
  "modalities": {
    "input": ["text", "image", "pdf"],
    "output": ["text"]
  },
  "limit": {
    "context": 1000000,
    "output": 128000
  },
  "cost": {
    "input": 5.0,      // $ per million tokens
    "output": 25.0,
    "cache_read": 0.5,
    "cache_write": 6.25
  }
}
```

## Notes

- Bonzai is iO digital's internal LiteLLM proxy at `api-v2.bonzai.iodigital.com`.
- The config file is JSON. Preserve its existing formatting when editing.
- After making changes, remind the user to restart opencode.
- When models.dev shows $0.00 pricing, it usually means the data hasn't been populated yet — not that it's free. Use family pricing as a guide.
