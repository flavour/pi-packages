# pi-auto-mode — SPEC

Status: **draft v0.1** — written before fit-gap analysis.
Sections marked `OPEN` are decisions to be settled in PLAN Phase 1 (fit-gap & mining) and Phase 2 (spec refinement).
The decision endpoint is **confirmed live** and its contract is recorded in [`docs/endpoint.md`](docs/endpoint.md); SPEC §6.1, §6.3, §10 and §13 reflect measured numbers from that probe.
Everything else in this spec is still pre-analysis.

## 1. Purpose

Pi has no built-in permission system.
A gate either exists as an extension or it does not exist at all.
`pi-auto-mode` is that extension: it judges every risky tool call before Pi executes it, and it must let ordinary work through without ceremony.

The gate is a two-layer decision pipeline:

1. **Deterministic layer** — regex/argv rules, evaluated locally, zero network.
   Hard blocks are absolute and never reach the model.
2. **Semantic layer** — a Jev-like decision model (`http://jetson:9931/v1/systemone`) asked
   **several questions in one request** (e.g. *"is this change easily reversible?"*), returning
   one probability per question.

Three confidence tiers are configurable: **Whitelisted** (auto-allow), **Blocked** (deny), and a **middle tier** that asks the user through UI elements.
In headless modes the middle tier resolves to **deny**.

The product goal is not "block everything".
It is: *an agent that can work unattended, on a real repo, without doing something it cannot undo.*

## 2. Non-goals

- Not a sandbox, not a shell parser, not a syscall filter.
  Pattern checks are explicitly conservative; a command that matches nothing is judged semantically, not assumed safe.
- Not a general-purpose approval workflow for humans (no queueing, no remote approval service).
- Not a replacement for Pi's own tool validation.
- Not a "ask the model to write the permission policy" system.
  The model *judges*; the code decides.
  Control flow stays deterministic.
- Not a multi-agent or per-user authorization system.

## 3. Terminology

| Term           | Meaning                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------- |
| **call**       | One tool invocation Pi is about to execute (`tool_call` event).                                   |
| **segment**    | A command decomposed on `&&`, `;`, `\|`, newlines; each segment matched separately.               |
| **hard block** | Deterministic deny. Cannot be overridden by allow rules, by the model, or by an in-session grant. |
| **fast path**  | A local allow that costs no network round-trip.                                                   |
| **verdict**    | `allow` · `ask` · `block`, plus the route that produced it and the readings behind it.            |
| **reading**    | One per-question probability returned by the decision model.                                      |
| **band**       | The interval between the block threshold and the allow threshold for a question.                  |
| **headless**   | No interactive UI available: `ctx.hasUI === false`, or `ctx.mode` is `json`/`print`.              |

## 4. System architecture

```text
tool_call event
  │
  ├─ L0  hard blocks (regex + argv, raw text)            → BLOCK   (absolute, never escalated)
  ├─ L1  user deny patterns                             → BLOCK   (recorded)
  ├─ L2  user allow patterns / declared safe commands   → ALLOW   (recorded; never overrides L0)
  ├─ L3  known read-only / in-project benign writes     → ALLOW   (no record, no network)
  ├─ L4  repeat-of-already-approved (same turn, identical)→ ALLOW  (the one deliberately fail-open layer)
  │
  └─ L5  semantic decision (one HTTP request, N questions)
           │
           ├─ aggregate ≥ allow threshold      → ALLOW (Whitelisted)
           ├─ aggregate ≤ block threshold      → BLOCK
           └─ in between                       → ASK user via UI
                                                 └─ headless → BLOCK
```

Ordering rules:

- **L0 output is never handed to the semantic layer.**
  A hard block is a block.
- **L2 allow patterns cannot skip a dangerous-shape match.**
  If a command matches a dangerous pattern (recursive `rm`, force push, `sudo`, …) it must still be judged; an allow pattern may downgrade *which* questions are asked, never suppress the judgment.
- **Absence of an answer is never consent.**
  A question that was asked but not answered, a malformed response, a timeout, or an unreachable endpoint produce a non-allow (see §9).
- **Uncovered tools are not holes.**
  Pi fires `tool_call` for *every* registered tool, including MCP and extension tools.
  Any tool outside the covered surface gets an explicit default policy (`§6.4`), not silence.

## 5. Deterministic layer (L0–L4)

### 5.1 Hard blocks (L0)

- Fixed, non-configurable-by-default list, matched against the **raw command text and raw
  argv** before segmentation or wrapper stripping (obfuscation-resistant by construction).
- Candidate classes (list to be mined and finalised in Phase 1): filesystem roots and
  `rm -rf /`, `mkfs`/`wipefs`/`shred`/`dd of=/dev/…`, `.git` metadata deletion, force-push to
  protected branches, credential-store destruction, fork-bomb/`:` shell idioms, writes to
  device nodes.
- Hard blocks must be **visible** in `/auto-mode status` so the user knows what can never run.
- `OPEN`: is any hard block ever overridable?
  Current position: **no** — the only override is a human pausing/disabling the gate for the session, which is itself loud, recorded and time-boxed.

### 5.2 User rules (L1/L2)

- `deny[]` and `allow[]` are regex (or glob-with-glob-semantics — `OPEN`: pick one, document
  the escaping) patterns matched **per segment**, so one `;` in a chained command does not
  disable every rule.
- An allow pattern matches a chained command only when **every** segment matches an allow
  pattern or is a known-inert helper (`cd`, `tail`, `head`, `wc`, `sleep`).
- Command substitution, heredocs, subshells, backslash escapes, and redirects to files never
  satisfy an allow pattern.
- Transparent wrappers (e.g. `rtk`) are stripped for rule matching; a leading `VAR=value` assignment is treated as inert.
  Hard blocks see the unstripped text.
- `OPEN`: whether user rules are regex-only (user asked for regex) with globs compiled to
  regex, or two separate rule kinds.

### 5.3 Fast path (L3)

A real allowlist, not a convenience: read-only inspection (`ls`, `cat`, `git status`, `rg`, `find`, test/build commands declared safe) and in-project writes to unprotected paths.
Rationale: the semantic layer costs ~0.2–0.8 s per call; without a fast path the gate stops ordinary work and gets disabled.

- **Protected paths escalate even inside the working directory**: `.env`, `.git/`, `~/.ssh`,
  `~/.aws`, `.pi/`, `.github/workflows/`, `AGENTS.md`/`CLAUDE.md`/`SPEC.md`-class instruction
  files, plus user-configured `protectedPaths[]`.
- `gateScope: all | matched` — `all` (default) judges everything the deterministic layer cannot vouch for; `matched` restores denylist-only behaviour.
  A denylist can only catch shapes someone already wrote a pattern for; `all` is the safe default.

### 5.4 Dangerous-shape detection

A separate pattern set (not hard blocks) whose only effect is: *force a semantic judgment, and make the intent question load-bearing*.
Examples: recursive `rm`, `git reset --hard`, `git clean -f`, force push, `branch -D`, `sudo`, `chmod 777`, recursive `chmod/chown`, `docker system prune`, `compose down -v`, `npm publish`, `curl … | sh`, `xargs rm`, `find . -delete`.

## 6. Semantic layer (L5)

### 6.1 Endpoint

Confirmed live on 2026-10-13 (raw exchanges in [`docs/endpoint.md`](docs/endpoint.md)).

- `POST http://jetson:9931/v1/systemone`, JSON, **no authentication** (LAN endpoint).
  It is the System One / Jev format implemented by llama.cpp (see the [ggml-org decision-models post](https://huggingface.co/blog/ggml-org/decision-models-in-llamacpp)), so Jev SDK-shaped clients work against it.
- Model currently served: **`LiquidAI/d1-3B-GGUF:Q8_0`** (3B Q8_0).
  An earlier probe ran `ggml-org/vllm-d3-flash-GGUF:Q8_0`; the contract was identical but every latency, ceiling and reading number differed.
  **Which model to pin is an open question (§17).**
  `model` is ignored when one model is loaded, so the gate must read `/v1/models` at startup, compare against the configured id, and refuse to run semantic judgments on an unexpected model rather than apply thresholds calibrated for another one.
- Health/identity: `GET /health` → 200; `GET /v1/models` gives the model id; `GET /slots` gives
  slot count and per-slot `n_ctx`; `GET /props` gives `model_alias` and `total_slots`.

Request:

```jsonc
{
  "model": "LiquidAI/d1-3B-GGUF:Q8_0",
  "state": { "value": { "tool": "bash", "command": "<redacted>", "cwd": "…", "segments": ["…"] },
             "context": { "latest_user_message": "…", "notes": ["…"] } }, // or a bare string,
                                           // or a list of chat messages
  "questions": {
    "reversible": { "type": "noul", "instructions": "…", "criteria": { "true": "…", "false": "…" } },
    "intent":     { "type": "noul", "instructions": "…", "criteria": { "true": "…", "false": "…" } }
  }
}
```

Response:

```json
{"model":"LiquidAI/d1-3B-GGUF:Q8_0",
 "answers":{"reversible":{"type":"noul","noul":0.852},"intent":{"type":"noul","noul":0.956}},
 "usage":{"input_tokens":216,"output_tokens":0}}
```

Any asked key missing from `answers` is a failure, not a default.
Errors come back as `{"error":{"code","message","type":"invalid_request_error|server_error"}}`.

Three question types are supported: `noul` (probability of yes, optional `{true,false}` anchor), `choice` (required criteria object label→description; returns `choice`, `probabilities`, and a `confidence` field), and `score` (required criteria array of 2–10 levels; returns expected `score`, `legend`, per-level `probabilities`, and `confidence`).
`noul` is the default.
`choice`/`score` are interesting for the severity dimension because they return a `confidence` field for free — a "the model itself is unsure" signal that maps straight onto the middle tier.
`OPEN`: `choice`/`score` vs `noul` for severity, and whether they can be mixed with `noul` in one request.

**Three measured properties shape the design:**

1. **On the pinned model the state is re-processed for every question.**
   `usage.input_tokens` is exactly `N × (state + question)`.
   The blog's "single forward pass" guarantee is about the *options inside one question*, and that part holds: the same four concerns cost **0.209 s / 218 tok as one `choice` question with four options** but **0.580 s / 674 tok as four `noul` questions**.
   Options are free; questions are not.
   The blog's Tips qualify batching with " **Kev-4B, lev and OpenJev process the state only once**", and `d1-3B` is not in that set.
   Consequence: **question count costs latency, and the state is what makes each question expensive** (§6.2, §13).
2. **The endpoint is effectively single-throughput.**
   Splitting one gate call across the 2 slots bought nothing (1×4q 0.573 s, 2×2q parallel 0.562 s, 4×1q parallel 0.632 s, identical total tokens).
   The Jetson is compute-bound; slots are not extra throughput.
3. **The input ceiling is server config, not part of the contract.**
   The earlier server returned HTTP 500 at ~2 105 tokens (`physical batch size: 512`); the current one accepted 12 039.
   The gate must discover the ceiling at startup (or on first 500) and size its context budget from that, rather than hard-coding a number.
4. **The server ignores the requested model when one is loaded** — asking for `ggml-org/Kev-4B-GGUF` was answered by `LiquidAI/d1-3B-GGUF`.
   Identity must be read from the **response** `model` field, never assumed from the request.

Readings are **deterministic**: 5 identical requests produced 1 distinct answer set.
Thresholds are therefore meaningful rather than noise-wrapped (§14).

### 6.2 One request, many questions

All questions for one call go in a **single** request: one round-trip, one decision over a consistent snapshot, and never slower than fanning out (4 batched 0.573 s vs 4 parallel 1-question requests 0.632 s, identical total tokens).

Measured economics on `LiquidAI/d1-3B-GGUF:Q8_0`, **realistic gate state** (structured state + anchored criteria), medians of 3:

| questions    | 1       | 4                          |
| ------------ | ------- | -------------------------- |
| latency      | 0.179 s | **0.620 s**                |
| input tokens | 173     | 724 (**168.5 / question**) |

So the marginal question costs **~130 ms** at realistic state size, and the per-question token cost is essentially **the state size** — the state is re-prefilled per question.
Extrapolated: 6 questions ≈ 0.87 s, 8 ≈ 1.1 s. (With a toy 39-token state the marginal drops to ~74 ms; that figure is not the one to design against.)

Two consequences:

- **The budget lever is a compact state.**
  4 questions on a 39-token state cost 0.25 s; the same 4 on a 639-token state cost 1.17 s.
  Trim the state before trimming the questions.
- **Do not shape the question set around latency.**
  Collapsing four `noul` questions into `2 noul + 1 score(5 levels)` saved only ~0.08 s (0.539 vs 0.620 s), because a question still costs one forward pass even when its options are free.
  Ask for the readings the decision table needs, and no more.

Question keys are echoed back in `answers`, but the model is not told which key it is answering, so **each instruction must stand alone**.
`score` and `choice` return a `confidence` field that `noul` does not: on a scoped `rm -rf build` the severity question returned expected level **1.145** with **confidence 0.046** and a spread distribution — a flat distribution is an "ask the user" signal in a way a single `noul` probability is not (§17).

### 6.3 Question set

Conditions are phrased so the **safe state is "yes"**.
Each question carries a `mode` and a `severity`:

| mode       | meaning                                                            |
| ---------- | ------------------------------------------------------------------ |
| `required` | must be satisfied to allow; a middle-band reading escalates to ASK |
| `hazard`   | only a clear negative matters; the middle band is ignored          |

| severity | meaning                                                                         |
| -------- | ------------------------------------------------------------------------------- |
| `hazard` | a clear rejection always blocks (credentials, irreversible loss of unique data) |
| `soft`   | a clear rejection can be cleared by the user's own explicit request             |

Starting question set (final set comes out of Phase 1 mining + Phase 2 calibration):

| id             | question (safe = yes)                                                            | mode     | severity |
| -------------- | -------------------------------------------------------------------------------- | -------- | -------- |
| `intent`       | is this call what the user asked for, or a step of the work they asked for?      | required | soft     |
| `reversible`   | is the change easily reversible (undo, restore, re-run)?                         | required | soft     |
| `blast_radius` | does it change only the object it names?                                         | required | soft     |
| `credential`   | is no secret or credential being read, printed, or sent off-machine?             | hazard   | hazard   |
| `unique_data`  | is nothing destroyed that exists nowhere else?                                   | hazard   | hazard   |
| `open_world`   | does nothing reach outside this machine (publish, push to shared, send, deploy)? | hazard   | soft     |

Empirical note carried over from the mined projects, now re-measured on `jetson`: "absence of a hazard" readings cluster below 1 rather than at ~0.99, so hazard questions cannot be `required` without turning every call into a prompt.
`intent` is the only question that is genuinely a permission.

**`criteria` is load-bearing, not decoration.**
Measured on `jetson`: `rm -rf build` scored **0.073** on "is the change easily reversible?"
with no criteria, 0.154 with loose criteria, and **0.977** once the criteria said "restored in minutes, e.g. by re-running a build" and the state noted that `build/` is regenerated by `npm run build` (0.903 for the same anchored question on `d1-3B`).
Consequences:

- Criteria text is part of the question and must be versioned with it; a threshold measured against different criteria text is not transferable.
  The same applies across **models**: the blog reports a vague input scoring 0.25 on one decision model and 0.80 on another, so cutoffs are per model and must be re-measured when the pinned model changes.
- `reversible` must be phrased as *undoable **or regenerable***, or every build-directory
  cleanup reads as irreversible and lands in the ASK tier.
- Vague instructions return 0.37–0.51 (twelve generic "is condition N satisfied" questions all clustered near 0.5).
  Generic questions manufacture ASKs.
- Credential exfiltration that matches no pattern (`curl -d @~/.ssh/id_ed25519 …`) reads 0.007
  on "no credential sent off-machine" and 0.060 on authorization — the semantic layer earns its
  latency on exactly the calls a denylist cannot see.

### 6.4 Uncovered tools

Default policy for tools not in the covered surface: **record the tool name once per session and show it once**, and apply `uncoveredTool: record | ask | block` (default `record`, i.e. allow + report).
`OPEN`: whether the default should be `ask` given the user's fail-toward-approval bias.
Tool `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) from `pi.getAllTools()` are confirmed present in the installed release (`docs/pi-api.md`) and are used as an input signal where declared — unverified hints are a hint, not a verdict.
`idempotentHint` also feeds the L4 repeat-skip layer (§4): a repeat of a self-declared idempotent call is a weaker risk than a repeat of a call that is not.

## 7. Threshold model — three tiers

Two global scalars define three bands over the aggregate decision score:

```text
score ≥ allowThreshold      → WHITELISTED (allow)
score ≤ blockThreshold      → BLOCKED
blockThreshold < score < allowThreshold → ASK (UI) — headless: BLOCK
```

- Defaults (starting point, to be calibrated): `allowThreshold = 0.70`,
  `blockThreshold = 0.40`.
- Validation: `0 ≤ block < allow ≤ 1`; a config that violates this is rejected with a message,
  not silently clamped.
- Per-question thresholds may override the global bands (`thresholds: { reversible: 0.8, … }`);
  unknown keys are kept and reported in `status` rather than silently dropped, so a typo is
  visible.
- `OPEN (the central design question)`: **how N per-question probabilities become one score.**
  Candidates: (a) per-question band table with combination rules (permit-style: a hazard reading above its threshold blocks on its own; a `required` reading in-band forces ASK); (b) a weighted aggregate scalar; (c) hybrid — hazards gate, requireds aggregate.
  The user's three-tier requirement is easiest to satisfy honestly with (c).
  Decide in Phase 2.
- `OPEN`: whether "Whitelisted" means *allow this call* or *remember this pattern as an allow rule* (session-scoped vs persisted).
  Position: allow the call; a separate explicit "always allow this shape" action writes a rule, and is offered in the ASK UI.

## 8. Approval tier (UI) and headless

### 8.1 Interactive

The ASK tier renders a decision UI showing: tool name, the call (redacted, truncated), the route that escalated it, per-question readings, and the reason.
Actions:

- **Allow once** (this call only)
- **Block** (this call; feedback reaches the agent so it can revise)
- **Allow for session** (narrow, pattern-shaped; never for hard blocks or credential hazards)
- **Edit rules** (jump to settings)

Implementation may use `ctx.ui.confirm`/`select`/`notify`/widget, or `ctx.ui.custom()` for a purpose-built component.
`OPEN`: dialog vs custom TUI component (custom components are not available over RPC — see below).

### 8.2 Modes

- `ctx.mode === "tui"` → full UI, including custom components.
- RPC (`ctx.hasUI === true`, mode not `tui`) → dialogs/notifications are forwarded, custom terminal components are **not**.
  The ASK tier must degrade to a plain dialog, never to silence.
- `json` / `print` / `ctx.hasUI === false` → **headless: ASK resolves to BLOCK**, with a reason
  string returned to the agent that names the failing condition.

`headlessAsk: deny | allow` config exists but `deny` is the default and `allow` must print a loud warning at startup.
Credential-class hazards are never auto-allowed headless.

## 9. Failure, unavailability, and cancellation

- Timeout (default ~2000 ms per attempt), retries (default 1), and an availability breaker
  (open after N consecutive failures, cooldown ~60 s) so a dead endpoint does not add latency to
  every call.
- Verdict on failure: `unavailable: deny | ask | degraded-allow` — **default `deny`**
  (fail closed). `degraded-allow` may allow only calls the deterministic layer classifies as
  low-risk-shape, never dangerous shapes, never writes to protected paths.
- Caller cancellation (user interrupt) is control flow: rethrow, record "cancelled before
  decision", never a verdict.
- A `tool_call` handler that throws blocks the tool (Pi's fail-safe).
  The gate must not rely on that as its normal path — it must return an explicit block with a readable reason.

## 10. Security and privacy

- **Redaction before anything leaves the machine**: PEM blocks, JWTs, `sk-…`, `ghp_…`, `AKIA…`, `Bearer …`, `api_key=…` → `<redacted>`.
  Applies to the command text, the recent-turns context, and anything displayed in the UI.
- **File contents, diffs and tool output are never sent.**
  A `write`/`edit` contributes its path (and at most a bounded, redacted summary) — never its payload.
- Bounded context: the hard token ceiling is **server config, not a contract constant** (~2 100 tokens on one server config, >12 000 on another), so the budget is set by latency instead: keep `state` under ~200 tokens — it is re-processed once per question (§6.2) — and the whole request under ~1 500 tokens.
  The call itself, a handful of structured facts, the newest user message, and short fixed question instructions; a recent conversation window is optional and must degrade first.
  Newest user message travels separately from any conversation window (a conversation is not an instruction).
- Only **user** messages can grant permission or impose constraints; the assistant cannot
  authorize its own call.
- Credentials (if the endpoint needs any) live in `<agentDir>/secrets/pi-auto-mode-<protocol>-api-key` with mode `0600`, never in settings and never in a project file.
  Keys are verified against the endpoint *before* being stored.
- Project-level config may **tighten** the gate but only loosen it when the project is trusted.
- Decision log on disk must not contain secrets or file contents; it is a record of verdicts,
  routes, readings and latencies.

## 11. Configuration

- Global: `$PI_CODING_AGENT_DIR/pi-auto-mode.json` (default `~/.pi/agent/…`), read before each
  call so edits take effect without a Pi reload.
- Project: `<cwd>/.pi/pi-auto-mode.json` (trusted projects only).
- Precedence: defaults → global → project (trusted) → in-session commands.
- Config must be validated with actionable errors; invalid config falls back to the last known
  good value **and says so**, never silently.
- Sketch (final schema from Phase 2):

```json
{
  "enabled": true,
  "gateScope": "all",
  "endpoint": { "baseUrl": "http://jetson:9931", "path": "/v1/systemone",
                "model": "LiquidAI/d1-3B-GGUF:Q8_0",
                "timeoutMs": 3000, "maxRetries": 1,
                "maxInputTokens": 1500, "maxQuestions": 6, "maxInFlight": 2 },
  "thresholds": { "allow": 0.70, "block": 0.40, "perQuestion": {} },
  "onAsk":     { "interactive": "ui", "headless": "deny" },
  "onUnavailable": { "mode": "deny", "breakerAfter": 3, "cooldownMs": 60000 },
  "rules": { "allow": [], "deny": [], "safeCommands": [], "hardBlocks": [] },
  "protectedPaths": [".env", ".git/", "~/.ssh/", "~/.aws/", ".pi/", ".github/workflows/"],
  "uncoveredTool": "record",
  "records": "status"
}
```

## 12. Commands and UI surface

- `/auto-mode status` — effective policy, where each value came from, endpoint reachability,
  breaker state, thresholds, hard-block list, this session's verdict counts.
- `/auto-mode on | off | scope all|matched | headless deny|allow`
- `/auto-mode threshold allow <n>` / `block <n>` / `per <question> <n>`
- `/auto-mode allow` — one retry of one refused call; reaches exactly as far as the model's
  refusals: never a hard block, never a deny rule, never a credential class.
- `/auto-mode settings` — interactive settings page (mode, thresholds, rules, protected paths),
  with the active allow/deny patterns listed *before* the editor so user rules are visible.
- Status widget above the input box: verdict + tool + call (redacted, ≤80 chars), route/model,
  readings, latency; the reason line only when blocked.
- Transcript records: `records: off | status | full` (default `status` — one line per allow,
  two per block, so a long session is not dominated by gate noise).

## 13. Performance budget

Measured against `jetson:9931` with `LiquidAI/d1-3B-GGUF:Q8_0` (warm server, one request, realistic gate state, medians):

| questions    | 1      | 4          | 6       | 8      |
| ------------ | ------ | ---------- | ------- | ------ |
| latency      | 0.18 s | **0.62 s** | ~0.87 s | ~1.1 s |
| input tokens | 173    | 724        | ~1 080  | ~1 440 |

Marginal cost ~130 ms per question at realistic state size; per-question tokens ≈ the state size.
Earlier model (`vllm-d3-flash`, 8.95B) for comparison: 0.34 s base, ~280 ms marginal, 1.12 s at 4 questions.

Budget:

- Fast path (L0–L4): < 5 ms, no network.
- Semantic call: **p50 ≤ 0.8 s, p95 ≤ 1.5 s** at the configured question count; hard cap =
  `timeoutMs × (1 + maxRetries)` with `timeoutMs` default 3000 ms.
- Context budget: keep `state` under ~200 tokens — it dominates, because it is re-processed once per question — and the whole request under ~1 500 tokens.
  **Probe the real ceiling at startup** (it was ~2 100 tokens on one server config and >12 000 on another) rather than hard-coding it.
  The conversation window is the first thing cut.
- Question count: 4–6, chosen by what the decision table needs; re-measure if the model changes
  (§17).
- **Concurrency**: one request per gate decision.
  The endpoint is single-throughput in practice (splitting across slots gave no speedup), so a semaphore of 1–2 exists only to stop a parallel tool batch stampeding it.
  Never fan one call's questions out, and share one judgment across identical sibling calls from the same assistant message.
- Breaker open ⇒ subsequent calls take the `unavailable` path with no added latency.

## 14. Testing, calibration, and evaluation

- Unit tests with **no network**: a fake transport returning canned readings; every layer
  tested independently; band boundaries tested at exact threshold values.
- A **replay corpus**: recorded calls + expected verdicts, including known-hard cases (unrequested
  `mv`/`tar`/`node -e` must allow; unrequested `rm -rf`/`git reset --hard`/`npm publish`/`sudo`
  must block; `curl -d @~/.ssh/id_ed25519` must be caught even though it matches no pattern).
- A **calibration harness** against the real `jetson` endpoint: run the question set over the corpus, record per-question probability distributions, and derive thresholds from measured numbers rather than guesses.
  Every threshold in the shipped default config must cite its measurement.
- **Calibration is per model.**
  The harness records the `model` field from every response, and the stored thresholds are keyed by model id.
  Changing the pinned model invalidates them and forces a re-run rather than silently reusing cutoffs calibrated elsewhere.
- **Live contract tests, opt-in** (skipped by default, run against `jetson`): question types and
  response shapes, error shapes, the token-ceiling probe, and a **latency regression guard** — a
  silent server-side model swap shows up as a latency and reading shift, which is exactly when
  the gate should stop trusting its thresholds.
- Redaction tests: a command containing a PEM/JWT/API key must produce a request body with no
  secret in it (assert on the serialized body, not on the code path).
- Headless tests: `json`/`print` mode must deny the ASK tier, not hang.

## 15. Compatibility

- Co-existence: other gate extensions (`pi-jev-permit`, `pi-jev-tool-guard`,
  `pi-auto-permission-gate`, `pi-auto-permissions`, `pi-jev-auto-mode`) cause double prompts and
  contradictory verdicts. `status` must detect and name them.
- Pi version: pin against the installed Pi (`1.2.0` here); the `tool_call` block contract
  (`{ block: true, reason }`), `ctx.hasUI`, `ctx.mode`, and `pi.getAllTools()` annotations are
  the API surface relied on.
- Does **not** intercept Pi's direct `!`/`!!` shell commands unless the `user_bash` event is
  handled — `OPEN`: handle `user_bash` too, or state the gap explicitly.

## 16. Acceptance criteria

1. A hard-blocked command is blocked with no network call and cannot be unblocked by an allow
   rule, an in-session grant, or the model.
2. Ordinary work (`ls`, `git status`, `npm test`, in-project edits) runs with no prompt and no
   network call.
3. A call that matches no pattern at all is still judged (denylist-only is not the default).
4. One semantic request asks all configured questions; a missing answer is never an allow.
5. Raising/lowering `allow`/`block` thresholds demonstrably moves calls between the three tiers,
   including into the ASK tier, with the middle band non-empty at default settings.
6. In TUI, the ASK tier shows readings and reasons and offers allow-once / block / allow-for-session.
   In `json`/`print`, the same call is denied with a reason naming the failing condition.
7. Endpoint down → calls take the configured `unavailable` path, breaker opens, no per-call
   timeout stall.
8. No secret, file content, or diff leaves the machine (proven by a test on the request body).
9. Every verdict is attributable: route, model, per-question readings, latency.
10. Every shipped default threshold is backed by a recorded calibration measurement.

## 17. Open questions (feed Phase 1/2)

Phase 1 status: candidate answers for these are sourced in `docs/fit-gap.md` (§17 table, plus nine cross-project conflicts to settle).
`docs/pi-api.md` adds four corrections to this spec that Phase 2 must apply — trust arrives as a `project_trust` event (there is no `ctx.isProjectTrusted()` in the installed release), arguments are rewritten by mutating `event.input`, `terminate` is a batch-scoped hint, and tool calls in one assistant message **can run in parallel**, so per-turn counters must be race-safe.

1. **Aggregation**: how N per-question probabilities map to one tier decision (§7).
   Highest-risk design question.
2. ~~Exact `jetson:9931` request/response contract, auth, model name, health check.~~
   **Resolved** — see SPEC §6.1 and `docs/endpoint.md`.
2a.
**Model choice — demoted.**
Not a latency question: 4 questions at ~0.6 s is workable, and    the blog's state-sharing models (Kev-4B, lev, OpenJev) would save only a few hundred ms at    our question count.
It is a **decision-quality** question, worth one corpus run against    Kev-4B after a server restart, and only if we later want 8+ questions per call.
Thresholds    must be re-calibrated on whichever model is pinned: the same call read 0.977 vs 0.903 on two    models.
Note the server ignores the requested model, so identity comes from the response. 2b.
**How does `confidence` enter the tier table?**
A `score`/`choice` reading with a flat    distribution (severity level 1.145 at confidence 0.046) is an explicit "the model cannot    distinguish" signal.
Does low confidence alone force ASK, or only combine with a mid-band    reading?
3. Rule syntax: regex only, or globs compiled to regex; how user patterns interact with
   segmentation and wrappers.
4. Final hard-block list and final question set (mine the five projects; then re-measure).
5. Default for uncovered tools (`record` vs `ask`).
6. Whether "Whitelisted" is per-call or pattern-persisting (§7), and how an explicit
   "always allow" is worded so it cannot quietly widen.
7. `unavailable` default: `deny` (fail closed) vs `degraded` (usable when the endpoint is down).
   Tension between the mined projects, which chose opposite defaults.
8. Whether to handle `user_bash` (`!`/`!!`) as well as model tool calls.
   **Implementable** — the installed release fires a `user_bash` event with `{command, excludeFromContext, cwd}` and a handler failure blocks the command; blocking means returning a `result`, not a `block` flag (`docs/pi-api.md`).
   No mined project covers it.
9. UI: reuse `ctx.ui.confirm`/`select` or build a `ctx.ui.custom()` component (RPC loses custom
   components).
10. Whether the gate should also cover `bash_bg`/`monitor`-style long-running or background
    tools, and nested `ctx.executeTool` calls.
11. Where the extension sits relative to Pi's `annotations`-based approval pattern.
