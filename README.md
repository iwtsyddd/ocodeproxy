# OCodeProxy

Local gateway that exposes OpenCode Zen upstream as OpenAI / Responses / Anthropic-compatible endpoints.

```text
SDK / Client (OpenAI / Anthropic) --> localhost:6446 --> opencode.ai /zen/v1
```

## Status

Early development (`v0.1.0-t1`). The API, config, and behavior will change without notice. Not production-ready.

Protocol maturity is uneven:

| Protocol | Endpoint | State |
|---|---|---|
| Anthropic Messages | `POST /v1/messages` | Primary path. Most complete and actively hardened: dedicated streaming translators, tool_use mapping, stop_reason mapping, image/document handling, Anthropic error shape. |
| Anthropic token counting | `POST /v1/messages/count_tokens` | Local heuristic only (`input_tokens`). Not upstream-backed. |
| OpenAI Chat | `POST /v1/chat/completions` | Maintenance mode: bugfixes only. No `response_format` / structured outputs, `stream_options.include_usage` ignored, usage is stubbed. |
| Responses API | `POST /v1/responses` | Works (direct passthrough for `muse-spark*`, converted path for chat models). Second most complete after Anthropic. |
| Models | `GET /v1/models`, `GET /v1/models/:id` | Works, with caveats (see below). |

If you only need one protocol, use Anthropic.

Priority: Anthropic is the primary path, Responses is secondary, OpenAI Chat is maintenance mode (bugfixes only, no new fields).

## Quick Start

Requires Node.js >= 18.

```bash
npm install
npm start
```

Point any client at it:

```bash
export OPENAI_BASE_URL="http://localhost:6446/v1"
export OPENAI_API_KEY="<key-from-api-keys.json>"

curl "$OPENAI_BASE_URL/models" \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

Health check:

```bash
curl -s http://localhost:6446/health | python3 -m json.tool
```

Scripts:

```bash
npm start   # production
npm run dev # node --watch
npm test    # node --test test/*.test.mjs (unit tests only, no integration tests)
```

## Endpoints

All endpoints except `/health`, `/`, and `/api/hello` require a local API key via `Authorization: Bearer ...` or `x-api-key`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Server info + endpoint list |
| `GET` | `/health` | Status, version, port, model count, proxy flags |
| `GET` | `/v1/models` | OpenAI-style model list from local cache with debounced upstream refresh |
| `GET` | `/v1/models/:id` | Single model. 404 on unknown or discontinued |
| `POST` | `/v1/chat/completions` | Chat completions, `stream: true/false` |
| `POST` | `/v1/responses` | Responses API, `stream: true/false` |
| `POST` | `/v1/messages` | Anthropic Messages, `stream: true/false` |
| `POST` | `/v1/messages/count_tokens` | Local token heuristic, returns `input_tokens` |
| `HEAD` / `GET` | `/api/hello` | Local static probe, never forwarded upstream |

All proxied responses include `x-zen-served-by: ocodeproxy`.

Error shape follows the protocol you called:

- OpenAI / Responses: `{ error: { message, type, code } }`
- Anthropic: `{ type: "error", error: { type, message } }`

## Configuration

Priority: CLI flag > env var > default.

```bash
node server.mjs -p 8080
node server.mjs --port 8080
```

| Variable | Default | Description |
|---|---|---|
| `PROXY_PORT` | `6446` | Listening port |
| `KEYS_FILE` | `./api-keys.json` | Local API keys (auto-created, `0600`) |
| `MODELS_FILE` | `./models.json` | Cached model list |
| `PROXY_CONFIG_FILE` | `./proxy-config.json` | Persisted upstream proxy URL |
| `UPSTREAM_PROXY` / `ALL_PROXY` / `HTTPS_PROXY` | `""` | Egress proxy, e.g. `socks5://127.0.0.1:1080` (uppercase names only) |
| `ZEN_AUTH_MODE` | `public` | Upstream Zen auth mode, sent as `Authorization: Bearer ...` |
| `FALLBACK_ATTEMPTS` | `3` | Models to try in fallback chain (`1-10`) |
| `FALLBACK_DELAY_MS` | `300` | Delay between fallbacks (`0-10000`) |
| `OC_VERSION` | auto | Pinned `opencode/x.y.z` User-Agent version, refreshed from npm every 6h |
| `PROXY_VERSION` | `16` | Reported in `/health` as `proxy_version` |
| `AI_SDK_VER` / `BUN_VER` | `4.0.23` / `1.3.13` | User-Agent fingerprint parts |
| `OPENCODE_CLIENT` / `OPENCODE_PROJECT` | `cli` / `global` | `x-opencode-*` headers |

## Authentication

Keys are stored in `api-keys.json` as `{ "name": "key" }`:

```jsonc
{
  "admin": "ocp-...",
  "user-default": "ocp-..."
}
```

Send the key either way:

```bash
-H "Authorization: Bearer ocp-..."
-H "x-api-key: ocp-..."
```

Optional per-request upstream override:

```bash
-H "x-zen-key: <upstream-key>"
# alias: x-opencode-key
```

- Comparison is constant-time (`crypto.timingSafeEqual`).
- Corrupt key file is backed up to `api-keys.json.corrupt-<ts>.bak` and regenerated.
- Keys can be managed live via Settings (generate / regenerate / view masked).

## Usage Examples

OpenAI Chat (stream):

```bash
curl -N http://localhost:6446/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "muse-spark",
    "messages": [{ "role": "user", "content": "Hello from OCodeProxy!" }],
    "stream": true
  }'
```

OpenAI client (Python):

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:6446/v1", api_key="ocp-...")
resp = client.chat.completions.create(
    model="muse-spark",
    messages=[{"role": "user", "content": "What time is it?"}],
)
print(resp.choices[0].message)
```

Anthropic Messages:

```bash
curl -N http://localhost:6446/v1/messages \
  -H "x-api-key: $OPENAI_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "muse-spark",
    "max_tokens": 256,
    "messages": [{ "role": "user", "content": "Translate to French: hello world" }]
  }'
```

Responses API:

```javascript
const res = await fetch("http://localhost:6446/v1/responses", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model: "muse-spark",
    input: "Summarize OCodeProxy in one sentence.",
    stream: false
  })
});
console.log(await res.json());
```

## Terminal UI

On boot a status card is printed (port, model count, endpoints). Keys:

| Key | Action |
|---|---|
| `s` / `p` | Open Settings (port hot-swap, outbound proxy, UA version check, model refresh, keys) |
| `q` or `Ctrl+C` | Graceful shutdown |

Prompts auto-disable when stdin is not a TTY (CI, Docker, background jobs).

Request log format:

```text
[HH:MM:SS] METHOD path STATUS_CODE durationms
```

## How It Works

- Normalization (`lib/convert.mjs`): Chat / Responses / Anthropic translation, fingerprint decoy tools, assistant reasoning blocks.
- Routing (`lib/models.mjs`): alias resolution, discontinued-model filter, `chat` vs `muse-spark* responses` partition.
- Fallback (`lib/fallback.mjs`): candidate model list, buffered retry (`collectWithFallback`) and pre-headers stream failover (`tryStreamFallback`).
- Errors (`lib/errors.mjs`): Zen errors mapped to OpenAI / Anthropic shapes, network details sanitized.
- IDs / keys (`lib/ids.mjs`, `lib/keys.mjs`): `ses_*` / `msg_*` ids, `ocp-` key generation and masking.

## Known Limitations

Honest list of things that are stubbed, partial, or intentional hacks:

- **Usage tokens are stubbed.** Streaming `message_start` and non-streaming responses report `input_tokens: 0`. Streaming `output_tokens` is estimated as `ceil(chars/4)` (thinking + text + tool JSON). Aggregates report `0` when upstream omits usage.
- **`count_tokens` is a heuristic.** Character-length based (+85/image, +20/document), not a real tokenizer. Accepts Claude model ids (mapped to the default model for the 404 check).
- **Mid-stream failures are masked.** After headers are sent, upstream errors/timeouts end the stream as a normal `stop` / `end_turn` instead of surfacing an error.
- **Gateway retry headers on buffered errors.** `retry-after` / `x-should-retry` / `anthropic-ratelimit-unified-*` forwarding applies to all buffered (non-streaming) error paths; post-headers streaming errors still can't carry them.
- **Claude Code model mapping.** Unknown `*claude*` / `*anthropic*` model ids (Claude defaults, provider-prefixed ids, gateway aliases) resolve to the default model instead of 404. `/v1/models` advertises canonical `claude-*` aliases plus real ids; `?limit=` is honored. `max_tokens` is required per spec (`0` returns an empty pre-warm message). `output_config.effort` and `thinking: adaptive/enabled` map to `reasoning_effort`; `thinking`/`redacted_thinking` blocks are dropped before upstream (no preserved-thinking check against Zen); the `x-anthropic-billing-header` attribution block is stripped before folding `system` into upstream `instructions`. Streaming translators emit each content block exactly once with sequential indices (thinking only when reasoning arrives before any text/tools, otherwise token-counted) so Claude Code never sees a malformed event sequence.
- **Decoy tools.** Every upstream request injects `bash` / `glob` / `grep` / `read` fingerprint tools that are stripped from outputs. Upstream behavior may change if Zen starts validating these.
- **Model list is filtered.** Only `*free*` models plus `big-pickle` are kept, with an anti-shrink guard. Alias and deprecation lists are hardcoded.
- **Upstream coupling.** All traffic goes to `opencode.ai/zen/v1/*` with a forged `opencode/...` User-Agent. Upstream changes can break the proxy at any time.
- **Tests are unit-only.** 117 tests cover `lib/` converters, errors, models, and fallback. `server.mjs` routes have no integration tests.
- **Intentional spec deviations (Anthropic path).** `max_tokens: 0` returns an empty pre-warm message without an upstream call (extension, not Anthropic behavior). Attribution detection matches any leading `system` text containing both `cc_version=` and `cch=` — a `system` prompt that merely mentions those substrings alongside real instructions is dropped as a whole. `thinking: between_tools` maps to `reasoning_effort: none`.

## Project Structure

```text
OCodeProxy/
├── server.mjs          # express app, TUI, all /v1 routes
├── lib/
│   ├── convert.mjs     # chat / responses / anthropic converters
│   ├── models.mjs       # discovery, alias, fallback list
│   ├── errors.mjs       # upstream error mapping
│   ├── fallback.mjs     # collect / stream fallback orchestration
│   ├── keys.mjs         # key gen / mask / validate
│   ├── ids.mjs          # session/message ids
│   └── content.mjs      # content helpers + token estimate
├── test/               # node:test suites (convert, errors, models...)
├── package.json        # scripts: start / dev / test
└── .gitignore          # node_modules, secrets, local files
```

## Testing

```bash
npm test
```

| Suite | Covers |
|---|---|
| `convert.test.mjs` | Message / tool translation |
| `responses.test.mjs` | Responses API aggregation |
| `models.test.mjs` | Alias, deprecation, fallback |
| `errors.test.mjs` | Zen to OpenAI / Anthropic mapping |
| `fallback.test.mjs` | Retry orchestration |
| `ids-keys.test.mjs` | ID format, key validation |
| `sampling.test.mjs` | Sampling / conversion edge cases |

Never commit real keys: `api-keys.json`, `models.json`, `proxy-config.json`, and `.env` are git-ignored.

## Security Notes

- Keys file is written with `0600`, atomically via temp file + rename.
- Auth uses constant-time comparison.
- JSON body limit `10mb`, with protocol-correct `413` / `400` shapes.
- Upstream network errors are sanitized — no internal addresses or stacks leak to clients.

## License

MIT. See `LICENSE`.
