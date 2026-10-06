# OCodeProxy

Local gateway that exposes OpenCode Zen upstream as OpenAI / Responses / Anthropic-compatible endpoints.

```text
SDK / Client (OpenAI / Anthropic) --> localhost:6446 --> opencode.ai /zen/v1
```

> **Disclaimer.** OCodeProxy is an independent, unofficial third-party project.
> It is not affiliated with, endorsed by, or supported by OpenCode (sst),
> Anthropic, or OpenAI in any way. All trademarks belong to their respective
> owners. This gateway exists for interoperability and research purposes only;
> users are solely responsible for complying with the terms of service of any
> upstream provider they connect through it.

## Status

Early development (`v0.1.2-t1`). The API, config, and behavior will change without notice. Not production-ready.

> **Stability warning.** OCodeProxy is experimental software under active development.
> It is an unofficial gateway: upstream changes at `opencode.ai` can break it at
> any time, and there are no stability guarantees of any kind.
>
> ZenDiet rewrites proxied requests to save context (tool-output trimming,
> deduplication, and — only when explicitly enabled — tool-description slimming).
> Trimming is conservative by default, but any request rewriting carries a small
> risk of altering model behavior. The experimental slimming mode (`ZEN_TOOL_SLIM=1`)
> goes further and may degrade tool selection.
>
> If a session starts acting strangely, switch ZenDiet to `safe` or `off`
> (Settings menu, live, no restart) and retry before reporting a bug.

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
| `MODELS_DEV_URL` | `https://models.dev/api.json` | Catalog metadata source (empty disables) |
| `MODELS_DEV_FILE` | `./models-meta.json` | Cached catalog metadata |
| `MODELS_DEV_TTL_MS` | `86400000` | Metadata refresh interval (1 min – 30 days) |
| `PROXY_CONFIG_FILE` | `./proxy-config.json` | Persisted upstream proxy URL |
| `UPSTREAM_PROXY` / `ALL_PROXY` / `HTTPS_PROXY` | `""` | Egress proxy, e.g. `socks5://127.0.0.1:1080` (uppercase names only) |
| `ZEN_AUTH_MODE` | `public` | Upstream Zen auth mode, sent as `Authorization: Bearer ...` |
| `ZEN_DIET` | `balanced` | Context optimization mode (`balanced`, `safe`, `aggressive`, `off`) |
| `ZEN_TOOL_SLIM` | `""` (off) | Experimental tool-description slimming (`1` truncates long tool descriptions to their first sentence; may degrade tool selection) |
| `FALLBACK_ATTEMPTS` | `3` | Distinct models to try in fallback chain (`1-10`); `1` means a single attempt, never a same-model retry |
| `FALLBACK_DELAY_MS` | `300` | Delay between fallbacks (`0-10000`) |
| `BUFFERED_SSE_MAX_BYTES` | `20971520` (20MB) | Cap for buffered (non-stream) upstream SSE/JSON (`1MB-100MB`); exceeded responses return `413 buffer_limit_exceeded` instead of buffering unbounded RAM |
| `OC_VERSION` | auto | Pinned `opencode/x.y.z` User-Agent version, refreshed from npm every 6h |
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
| `i` | Server info panel (status, upstream, models, metadata, keys) |
| `q` or `Ctrl+C` | Graceful shutdown |

Prompts auto-disable when stdin is not a TTY (CI, Docker, background jobs).

Request log format:

```text
[HH:MM:SS] METHOD path STATUS_CODE durationms[ diet -Xk (tools N%)]
```

The `diet` suffix appears on proxied requests when ZenDiet is enabled: estimated
tokens saved by optimization and the pre-diet tool-results share of context.

## How It Works

- Normalization (`lib/convert.mjs`): Chat / Responses / Anthropic translation, fingerprint decoy tools, assistant reasoning blocks.
- Repair (`lib/repair.mjs`): closes user-interrupted orphan tool calls with cancellation stubs, folds consecutive user messages (chat + Responses shapes).
- ZenDiet (`lib/zendiet.mjs`, `lib/zendiet/*`): context governor (pressure calculation, sha256 deduplication with ANSI-normalized hashing, noise stripping with repetition collapse, huge-output emergency reduction, test/diff preservation, opt-in tool-description slimming).
- Routing (`lib/models.mjs`): alias resolution, discontinued-model filter, `chat` vs `muse-spark* responses` partition.
- Fallback (`lib/fallback.mjs`): candidate model list, buffered retry (`collectWithFallback`) and pre-headers stream failover (`tryStreamFallback`, dropped if the client disconnects).
- Buffered SSE (`lib/buffered.mjs`): incremental non-stream aggregation (chat + Responses event shapes) with a byte cap; only aggregated content plus a 64k error-detection head is retained, never the full raw payload.
- Errors (`lib/errors.mjs`): Zen errors mapped to OpenAI / Anthropic shapes, network details sanitized.
- IDs / keys (`lib/ids.mjs`, `lib/keys.mjs`): `ses_*` / `msg_*` ids, `ocp-` key generation and masking.

## Auto mode (Claude Code)

If Claude Code shows "this session isn't eligible" for no-charge classifier requests, that is expected behind this gateway and harmless: auto mode keeps working, its classifier requests are treated as normal requests.

Why: classifier verdicts come from the upstream model server. This proxy's upstream is OpenCode Zen (OpenAI-compatible), which has no classifier-review mechanism and never returns `safeguard_results` — there is nothing to forward, and faking verdicts would be unsafe. What the gateway does guarantee:

- Unknown request fields (e.g. `safeguards`) are accepted and ignored, never a 400.
- Client tool-use ids round-trip unmodified whenever the upstream echoes them.

## Known Limitations

Honest list of things that are stubbed, partial, or intentional hacks:

- **Usage tokens are estimated.** Streaming `message_start`, non-streaming responses, and TUI traffic stats report estimated `input_tokens` based on request content and ZenDiet optimization, including the fingerprint decoy tools every upstream request carries. Streaming `output_tokens` is estimated as `ceil(chars/4)` (thinking + text + tool JSON). Aggregates report upstream usage when provided.
- **`count_tokens` is a heuristic.** Character-length based (+85/image, +20/document), not a real tokenizer. Accepts gateway aliases and provider-routed Claude ids like other routes; any other unknown id 404s with a did-you-mean hint.
- **Mid-stream failures abort the stream.** After headers are sent, an upstream error/timeout/empty-end tears down the client connection (destroyed socket, stats still recorded) instead of emitting a fake `stop` / `end_turn`. Clients see an error rather than truncated "success". Pre-headers failures still map to proper HTTP error responses, and scheduled stream-fallback retries are dropped if the client already disconnected.
- **Gateway retry headers on buffered errors.** `retry-after` / `x-should-retry` / `anthropic-ratelimit-unified-*` forwarding applies to all buffered (non-streaming) error paths; post-headers streaming errors still can't carry them.
- **Fallback retries bill upstream.** Every fallback attempt resends the full prompt, so one user request can bill 2–3× upstream on 429/5xx. Non-retryable statuses (e.g. 400) are never retried, and the same model is never retried twice in a chain.
- **Claude Code model mapping.** Only exact gateway aliases (`claude-sonnet-4-5`, `claude-opus-4-8`, …) and provider-routed ids (`bedrock/…`, `vertex_ai/…`) resolve to the default model. Any other unknown id — including bare `claude-*` typos — 404s with a did-you-mean hint instead of silently running the wrong model. `/v1/models` advertises canonical `claude-*` aliases plus real ids; `?limit=` is honored. `max_tokens` is required per spec (`0` returns an empty pre-warm message). `output_config.effort` and `thinking: adaptive/enabled` map to `reasoning_effort`; `thinking`/`redacted_thinking` blocks are dropped before upstream (no preserved-thinking check against Zen); the `x-anthropic-billing-header` attribution block is stripped before folding `system` into upstream `instructions`. Streaming translators emit each content block exactly once with sequential indices (thinking only when reasoning arrives before any text/tools, otherwise token-counted) so Claude Code never sees a malformed event sequence.
- **Decoy tools.** Every upstream request injects `bash` / `glob` / `grep` / `read` fingerprint tools that are stripped from outputs. Upstream behavior may change if Zen starts validating these.
- **Model list is filtered.** Zen inventory is the source of truth; `DISCONTINUED_MODELS` stays authoritative for exclusions. Free detection is name-based (`*free*`, `big-pickle`) plus cost-based (`cost.input/output == 0` from the models.dev catalog), so suffixless free models are kept when Zen serves them. models.dev also provides `context_window` / `max_output_tokens` / `description` for `/v1/models`; `status: deprecated` there is informational only and never filters. Without metadata (fetch failed, disabled via `MODELS_DEV_URL=""`), the gateway degrades to name-based behavior.
- **Upstream coupling.** All traffic goes to `opencode.ai/zen/v1/*` with a forged `opencode/...` User-Agent. Upstream changes can break the proxy at any time.
- **Tests are unit-only.** 337 tests cover `lib/` converters, errors, models, catalog, fallback, buffered SSE, streaming SSE line splitter, session store, repair, and zendiet. `server.mjs` routes have no integration tests.
- **Intentional spec deviations (Anthropic path).** `max_tokens: 0` returns an empty pre-warm message without an upstream call (extension, not Anthropic behavior). Attribution detection matches any leading `system` text containing both `cc_version=` and `cch=` — a `system` prompt that merely mentions those substrings alongside real instructions is dropped as a whole. `thinking: between_tools` maps to `reasoning_effort: none`. Buffered (non-stream) upstream payloads larger than `BUFFERED_SSE_MAX_BYTES` return `413 buffer_limit_exceeded` instead of buffering unbounded RAM. Streaming SSE keeps only one incomplete line (1MB cap): exceeding it returns `413 buffer_limit_exceeded` before headers, or aborts the stream after headers.
- **Interrupted sessions are repaired.** User-cancelled tool calls leave orphan `tool_use` blocks that strict upstreams reject with `400 invalid parameters`. The gateway auto-closes each orphan with a `[Tool execution was cancelled or rejected by user]` stub and folds runs of consecutive `user` messages into one, before diet/forwarding. This repair always runs (independent of ZenDiet mode) because unrepaired requests cannot succeed upstream.
- **Tool slimming is experimental.** `ZEN_TOOL_SLIM=1` (or the Settings toggle) shortens tool descriptions over 300 chars to their first sentence. Names, parameters and schemas are never touched and tools are never dropped, but the model may select tools less accurately. Off by default; toggle live without restart.

## Project Structure

```text
OCodeProxy/
├── server.mjs          # express app, TUI, all /v1 routes
├── lib/
│   ├── convert.mjs     # chat / responses / anthropic converters
│   ├── catalog.mjs      # models.dev metadata sidecar (windows, descriptions)
│   ├── models.mjs       # discovery, alias, fallback list
│   ├── errors.mjs       # upstream error mapping
│   ├── fallback.mjs     # collect / stream fallback orchestration
│   ├── buffered.mjs     # incremental buffered SSE + byte cap
│   ├── sse.mjs         # streaming SSE line splitter (offset search + line cap)
│   ├── session.mjs      # bounded LRU session store + TTL sweep
│   ├── keys.mjs         # key gen / mask / validate
│   ├── ids.mjs          # session/message ids
│   ├── content.mjs      # content helpers + token estimate
│   ├── repair.mjs       # orphan tool-call stubs + user folding
│   ├── zendiet.mjs      # ZenDiet context governor coordinator
│   └── zendiet/         # safety, analyzer, dedup, classifier, reducers, tools
├── test/               # node:test suites (convert, errors, models, zendiet...)
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
| `catalog.test.mjs` | models.dev parsing, free-by-cost, alias fallback |
| `errors.test.mjs` | Zen to OpenAI / Anthropic mapping |
| `fallback.test.mjs` | Retry orchestration |
| `buffered.test.mjs` | Incremental SSE aggregation, byte cap, split-chunk safety, bounded aux fetch |
| `sse.test.mjs` | Streaming line splitter (boundaries, CRLF, multibyte, line cap) |
| `ids-keys.test.mjs` | ID format, key validation |
| `sampling.test.mjs` | Sampling / conversion edge cases |
| `session.test.mjs` | Bounded LRU session store (TTL expiry, LRU cap, sweep) |
| `zendiet.test.mjs` | Safety invariants, pressure, dedup, tool reducers, failure hard-caps |
| `zendiet-tools.test.mjs` | Tool-description slimming (shapes, thresholds, opt-in wiring) |
| `repair.test.mjs` | Orphan tool-call stubs, user-message folding (chat + Responses shapes) |

Never commit real keys: `api-keys.json`, `models.json`, `proxy-config.json`, and `.env` are git-ignored.

## Security Notes

- Keys file is written with `0600`, atomically via temp file + rename.
- Auth uses constant-time comparison.
- JSON body limit `10mb`, with protocol-correct `413` / `400` shapes.
- Bounded per-user session store (1000 LRU entries cap, 30 min TTL, 5 min periodic sweep) prevents memory exhaustion from key spam.
- Auxiliary service fetches (models.dev metadata, opencode models discovery, npm version check) capped by `AUX_FETCH_MAX_BYTES` (default 10MB) with immediate socket destruction on cap exceeded to protect against OOM from rogue or corrupted upstreams.
- Buffered upstream SSE/JSON capped by `BUFFERED_SSE_MAX_BYTES` (default 20MB); exceeded buffered responses return `413 buffer_limit_exceeded`.
- Streaming upstream SSE keeps only one incomplete line (1MB cap); a giant line without newlines returns `413 buffer_limit_exceeded` before headers, or aborts the stream after headers.
- ZenDiet tool output reducers enforce hard caps (`DEFAULT_FAILURE_MAX_CHARS` = 10,000, emergency `HUGE_TOOL_CHARS` = 8,000) on all tool results, including failure traces, massive git diffs, and test outputs. Megabytes of error dumps (e.g. `cat huge.log` with errors) can never bypass compression into upstream context.
- Upstream network errors are sanitized — no internal addresses or stacks leak to clients.

## License

MIT. See `LICENSE`.
