# ZenDiet bench: dirty 200k context (synthetic, no LLM)

Date: 2026-10-05. Node v24.19.0. Window: 200 000 tok, usable 191 808 (reserve 8192).
Method: synthetic fixture through `optimizeContext()` — no upstream, no real model.
Tokens are the `chars/4` heuristic everywhere, so all numbers are estimates.

## Fixture: 205 632 tok / 846 721 chars, 35 tool cycles, 98.7% — tool results

| Part | Size (approx) |
|---|---|
| 8 distinct file reads × 400 lines | ~9 500 tok each |
| 2 exact duplicate file reads | ~9 500 tok each |
| 12 topup file reads × 300 lines | ~7 100 tok each |
| 5 dirty shells (ANSI, `\r` rewrites, `%` progress, 12× repeat spam) | ~2 000 tok each |
| test pass 300 / test fail + stack | ~1 900 / ~1 000 tok |
| git diff (300 context lines + changes) | ~4 000 tok |
| grep 100 hits / npm log spam / ls ×3 (2 identical) | ~1 100 / ~2 700 / ~450 tok each |
| system + 40 tool definitions + chat text | ~2 700 tok |

Pressure before: critical, 107%. `client: claude-code` detected from UA header.
Cache directives present (`system` + `tools`), i.e. `hasCacheDirectives: true`.

## Results by mode (single run, wall time rough)

| Mode | Changed | Before → After | Saved | Pressure | Time |
|---|---|---|---|---|---|
| off | no | 205 632 → 205 632 | 0 | critical → critical | ~1 ms |
| safe | yes | 205 632 → 32 604 | 173 036 tok / 692 098 chars | critical → low | ~50 ms |
| balanced | yes | 205 632 → 24 105 | 181 536 tok / 726 088 chars | critical → low | ~40–90 ms |
| aggressive | yes | 205 632 → 24 105 | 181 536 tok / 726 088 chars | critical → low | ~35 ms |
| balanced + strictCache | yes | 205 632 → 24 105 | 181 536 tok / 726 088 chars | critical → low | ~35 ms |

Decision breakdown (from `decisions[]`):

- safe: `dedup: collapsed 3 duplicates (~18 960 tok)` + `reduction: 6 older (noise/repeat strip)` + `emergency: 21 huge`.
- balanced/aggressive: `dedup: 3 (~18 960 tok)` + `reduction: 30 older`.
- Pairing verified every run: `35 calls and 35 results`. Active turn locked to the trailing user message only.

Safe vs balanced gap is ~8 500 tok (4%): safe won't semantically trim medium outputs,
only noise + duplicates + huge-output emergency. That matches its contract.

## Cache analysis

- `assessCacheRisk(fixture, 500 tok savings)` → `high`, `allowOptimization: false`
  (savings < 3000 tok and < 5% — cache rebuild would cost more than it saves).
- `assessCacheRisk(fixture, 181 536 tok savings)` → `acceptable`, `allowOptimization: true`
  (88% relative savings — optimization clearly wins).
- Big case under `strictCache`: identical result (181 536 saved) — the gate correctly
  stays out of the way when the win is large.
- Micro-case (60 tok duplicate inside a 17 115 tok context with cache directives):
  plain mode dedups it, `strictCache` emits `cache: skipped dedup to preserve prompt cache`
  and keeps the bytes. The gate works, it just rarely triggers on real dirty contexts
  because real savings are usually far above the 3000 tok / 5% bar.

Illustrative cost math (rates from `zendiet.md`, not measured here):
205k cached input ≈ $0.06 vs 24k uncached ≈ $0.07 at $3/1M vs $0.30/1M cached —
on cache-heavy traffic the dollar win is small even when the context win is 88%.
That is exactly why the `MIN_SAVINGS 3000 / 5%` rule exists: never break a hot cache
for pennies. Real cache-hit ratio can only be measured against live upstream,
this bench does not measure it.

## Conclusions

1. On a dirty 200k context nothing is skipped anymore: every mode except `off`
   fires, pressure drops critical → low, ~88% of estimated tokens removed.
2. Dedup caught all 3 planted exact duplicates including the ANSI-decorated one
   (normalized hashing works); repetition collapse + progress-strip handled the shell/npm spam.
3. Failures preserved: the failing test block kept `AssertionError`, stack frames
   and the `fail 1` summary; the git diff kept hunk headers and `+/-` lines.
4. Gaps this bench does NOT cover (honest): partial (~90%) duplicates are only
   generically trimmed, not delta-encoded; tool schemas (~1 900 tok here) pass through
   untouched; Responses-model passthrough bypasses the diet; token counts are heuristic;
   timings are single-run rough numbers.
