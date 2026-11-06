# pi-newapi

A [pi](https://pi.dev) extension that adds a `newapi` provider for your [NewAPI](https://github.com/QuantumNous/new-api) gateway. It discovers models accessible to your API token, registers their protocols and capabilities, and uses pi's built-in streaming implementations for text, images, reasoning, and tool calls.

Uses pi's native provider authentication and model-refresh lifecycle. Tested with **pi 1.5.0** (`@earendil-works/pi-coding-agent`) and **NewAPI v1.0.0-rc.48**. Requires Node.js 22.19 or newer. No build step is required.

## Install and connect

From this checkout:

```sh
pi install /absolute/path/to/pi-newapi
pi
```

In pi, run `/login newapi`. Enter your gateway URL and a **NewAPI relay API token** from the dashboard's API Tokens page. Pi stores both together in its normal credential store, `~/.pi/agent/auth.json`. Then use `/model` to select a `newapi` model.

Alternatively, configure the process environment before starting pi:

```sh
export NEWAPI_BASE_URL='https://your-newapi-instance.example'
export NEWAPI_API_KEY='sk-your-newapi-token'

pi --list-models newapi
pi --provider newapi --model 'your-model-id'
```

Use the token issued by your gateway, rather than an upstream provider key or dashboard access token. The token must have access to an enabled chat channel. A saved `/login` credential takes precedence over environment credentials, including its saved gateway URL. To switch gateways, use `/login newapi` again; use `/logout` to remove saved credentials before using environment credentials.

The gateway can be a root URL or end in `/v1`. Reverse-proxy prefixes such as `https://host/newapi/v1` are preserved. Use the final URL: discovery does not follow redirects. `.env` files are not loaded automatically; export their contents explicitly if you use [.env.example](.env.example).

For development without installation:

```sh
pi -e ./src/index.ts --list-models newapi
```

## Inspect and refresh

- `/newapi` shows the API, capability source, context/output limits, image and reasoning support, pricing status, and skipped models.
- `/newapi refresh` forces authenticated discovery again, for example after changing channels or token permissions.
- `/reload` reloads the extension and `newapi.json` after configuration changes.
- `pi --offline --list-models newapi` uses the cached catalog without network discovery. Offline mode does not provide local inference.

Successful catalogs are stored in pi's `models-store.json`, with a five-minute refresh interval. A temporary gateway failure retains the last usable catalog and reports the error. HTTP 401/403 clears it. Cache entries are scoped to the gateway, token, extension configuration, and pi catalog version; changing credentials cannot restore another token's catalog. No raw API key is written to the model cache.

If discovery fails on the first connection, the provider remains registered so `/login` and `/newapi refresh` can recover it. Without a prior cache or explicit static configuration, there are no models to select.

## Protocol selection

`GET /v1/models` supplies each model's `supported_endpoint_types`. The extension registers an API and the corresponding base URL for each model:

| NewAPI endpoint type | Pi API | Request path |
| --- | --- | --- |
| `openai-response` | `openai-responses` | `/v1/responses` |
| `openai` | `openai-completions` | `/v1/chat/completions` |
| `anthropic` | `anthropic-messages` | `/v1/messages` |
| `gemini` | `google-generative-ai` | `/v1beta/models/{model}:streamGenerateContent` |

Selection uses this order:

1. An explicit per-model `api` override.
2. The global `api` setting or `NEWAPI_API` override.
3. The first supported chat protocol in the gateway's endpoint list, preserving its order.
4. When endpoint metadata is missing or empty, the matching pi model's supported API, or Chat Completions for an unknown model.

For example, `["anthropic", "openai"]` selects Anthropic Messages, and `["openai-response", "openai"]` selects Responses. `["openai", "openai-response"]` selects Chat Completions unless overridden. A failed request does not automatically switch protocols.

NewAPI's endpoint hints can be aggregated across channels. They are not a complete guarantee that a particular token's routed channel supports every advertised protocol. Correct a misleading hint with a per-model override after checking your channel. An override also adjusts the protocol's base path automatically.

Recognized image-generation, embedding, reranking, video, and other non-chat operations are excluded from the coding model list. In particular, `["image-generation", "openai"]` does not make an image model a chat model. Common non-chat IDs are also excluded when the gateway only advertises a channel protocol. Arbitrary aliases cannot always be classified from `/v1/models`; disable them explicitly when necessary. A nonempty endpoint list with no supported chat API is skipped and explained by `/newapi`.

## Capabilities and aliases

NewAPI's endpoint metadata does not supply complete reasoning, vision, or token-limit information. For exact model IDs, the extension uses the installed pi catalog to fill in these capabilities. Protocol-specific thinking mappings and compatibility flags are retained when the API matches. Your gateway can impose lower limits, which you can override.

Unknown models remain selectable with text input, reasoning disabled, a 32,768-token context window, and a 4,096-token output limit. `/newapi` identifies these defaults and pi shows a warning. These are fallback settings, not verified capabilities. For an alias, use `reference` to identify its actual model. For an unrecognized model, configure its capabilities explicitly.

Create `~/.pi/agent/newapi.json`, or `$PI_CODING_AGENT_DIR/newapi.json` when using a custom agent directory. You can select another file with `NEWAPI_CONFIG`. For example:

```json
{
  "modelOverrides": {
    "my-codex-alias": {
      "reference": { "provider": "opencode", "id": "gpt-5-codex" },
      "api": "openai-responses"
    },
    "my-claude-alias": {
      "reference": { "provider": "anthropic", "id": "claude-sonnet-4-5" },
      "api": "anthropic-messages",
      "contextWindow": 100000,
      "maxTokens": 16000
    },
    "non-chat-alias": { "enabled": false }
  }
}
```

The alias must appear in the gateway catalog; overrides do not invent model availability. `reference` copies capabilities and lets pi select model-specific request behavior while preserving the gateway's model ID in requests and conversation history. The referenced provider/ID must exist in your installed pi catalog; the Codex example above uses its `opencode` catalog entry for metadata only. Requests still go to your NewAPI gateway. The limits in this example are illustrative. See [newapi.example.json](newapi.example.json) for a complete editable configuration.

Supported per-model fields are `enabled`, `reference`, `api`, `name`, `input`, `reasoning`, `thinkingLevelMap`, `contextWindow`, `maxTokens`, `cost`, and `compat`. Partial `thinkingLevelMap` overrides preserve inherited entries, including `null` restrictions. `chat: true` explicitly bypasses the non-chat classifier for an alias you have verified supports chat. Compatibility settings use pi's model schema. Pi's normal `models.json` overrides are also composed above the provider, including explicit provider/model endpoint URLs. `/newapi` describes this extension's registered catalog; use `newapi.json` for its capability reporting and cache invalidation. When changing an API family through a `models.json` model definition, supply its matching `baseUrl` too.

## Configuration reference

| JSON field | Environment override | Meaning |
| --- | --- | --- |
| `baseUrl` | `NEWAPI_BASE_URL` | Gateway URL, unless one is saved with the login credential. |
| — | `NEWAPI_API_KEY` | Relay token when no saved credential is present. |
| — | `NEWAPI_CONFIG` | Path to the extension's JSON configuration file. |
| `models` | `NEWAPI_MODELS` | Optional model allowlist; environment form is comma-separated IDs. Discovery still supplies metadata. |
| `api` | `NEWAPI_API` | Explicit API override for every model without its own override. |
| `discovery` | — | Defaults to `true`. Set `false` only for explicit static configuration. |
| `contextWindow` | `NEWAPI_CONTEXT_WINDOW` | Context default for unknown models. |
| `maxTokens` | `NEWAPI_MAX_TOKENS` | Output default for unknown models. |
| `modelOverrides` | — | Configuration keyed by exact gateway model ID. |

Environment settings override the corresponding JSON fields. A saved login's URL and key take precedence over connection settings. Per-model limits take precedence over pi catalog metadata, which takes precedence over global defaults. An explicitly configured output limit must not exceed the effective context window.

Pi's `models.json` can also supply `providers.newapi.apiKey`; offline restoration uses that same resolved key. Supply the discovery gateway through `newapi.json` or `NEWAPI_BASE_URL`. Explicit `models.json` endpoint overrides control inference URLs without changing the discovery URL.

If your server disables `/v1/models`, use static mode with an explicit list and verified settings:

```json
{
  "discovery": false,
  "models": ["my-model"],
  "modelOverrides": {
    "my-model": {
      "api": "openai-responses",
      "input": ["text", "image"],
      "reasoning": true,
      "contextWindow": 128000,
      "maxTokens": 16000
    }
  }
}
```

Replace these example capabilities with those supported by your model and channel. Static mode performs no discovery and cannot verify token access. `NEWAPI_MODELS` by itself remains an allowlist and does not enable static mode.

Gateway prices can differ from upstream prices and depend on token groups and channel settings. The extension therefore does not copy upstream prices. Unconfigured rates are zero in pi's cost display and reported as **unknown** by `/newapi`; this does not mean requests are free. Set per-model `cost` rates (`input`, `output`, `cacheRead`, `cacheWrite`, in currency units per million tokens) if you need estimates. Omitted rates remain zero. NewAPI's billing is authoritative.

## Validation and development

```sh
npm install
npm run check
npm test
```

The automated suite covers NewAPI catalog interpretation, request construction for aliases, thinking-level restrictions, endpoint overrides, native authentication, scoped caching, transient and authentication failures, offline refresh, cancellation, command diagnostics, and the documented configuration examples. It delegates wire-format parsing to pi's existing implementations.

To exercise the actual gateway and installed extension:

```sh
NEWAPI_TEST_BINARY=/absolute/path/to/new-api npm run validate:newapi
```

[scripts/validate-newapi.ts](scripts/validate-newapi.ts) starts the official NewAPI executable with a fresh temporary database and creates local test channels and relay tokens. It checks the real `/v1/models` output, filtering, all four inference protocols, images, reasoning settings, streamed tool calls and results, a Gemini alias with signed tool-history replay, token restrictions/revocation, package installation, first-run CLI use, and offline persistence with both saved and `models.json` credentials. It removes its temporary data afterward. `PI_TEST_CLI` can select another pi executable.

The upstream responses are deterministic fixtures. The test validates pi → NewAPI → upstream routing and protocol handling; it does not call a paid model service or establish the capabilities of your own gateway's aliases. The validated combination is pi 1.5.0 and NewAPI v1.0.0-rc.48.

Design references: [pi native provider documentation](https://pi.dev/docs/latest/custom-provider), [pi's Radius lifecycle](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/radius.ts), [Cloudflare authentication](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/cloudflare-auth.ts), and [NewAPI endpoint ordering](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.48/common/endpoint_type.go).
