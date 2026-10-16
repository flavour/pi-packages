# bench — reusable endpoint probe

One harness for any llama.cpp decision endpoint (`/v1/systemone`), any model, any build.
Every case writes structured JSON; the same run renders Markdown tables.
Runs are diffable across models and builds, which is what the bake-off (PLAN Phase 1) needs.

```text
probe.py         the probe: case registry -> results/<stamp>-<label>.json + .md, index.jsonl
report.py        diff N runs side by side (Markdown)
run_model.sh     one server CONFIG (model + --parallel + -b/-ub + -c) -> the four runs, attributed
fake_endpoint.py mock decision server modelling b11606/vllm-d3 behaviour, for offline testing
retest_flash.py  the original one-off script (kept: it produced docs/endpoint.md's numbers)
envelope_flash.py the original envelope mapper (kept)
```

## the question the matrix exists to answer

Jev's original endpoint answered N questions from one read of the state, so latency barely moved with question count.
Do these llama.cpp decision models do that?
Two mechanisms can get there:

1. **shared prompt prefix** (`server_decision_group_tasks`, only for `can_share_prompt()` types, grouped in chunks of `--parallel`): the parent computes the state once, children inherit it and compute only their question tail.
   Switch: `--parallel >= n_questions`.
2. **one ubatch for several sequences** (non-causal models, e.g. the d3 family): the state is still duplicated per question, but the questions are computed in the same forward pass.
   Switch: `-ub >= merged total`, which is also what removes the `n_ubatch` assert.

`sharing` measures (1) through latency, `slot_counters` proves (1) through the server's own per-slot counters, `ceiling`/`envelope` map (2).
The number to compare across configs is `prefix reuse n=N` and `factor L4/L1` in the report.

## against a real endpoint

```bash
./run_model.sh                      # the config matrix + the llama-server command for each config
WAIT=600 ./run_model.sh d1-p4       # wait for the server, then record all four runs for that config
python3 report.py "results/*d1-p4*.json" --out results/d1-p4-compare.md
```

`run_model.sh` records the flags in `--notes` and refuses to record a run whose model, build, slot count (`--expect-slots`, i.e. `--parallel`) or reported `n_ubatch` (`--expect-ubatch`, read back from the ceiling case's 500 body) disagrees.
`--expect-ubatch` is only applied to the non-causal d3 configs: the error that names `n_ubatch` comes from the `!can_split()` branch (`server-context.cpp:3556`), which a causal model never takes, so `d1` cannot report it.
We have no ssh key for `jetson`, so the script cannot restart the server: it prints the command to run there and waits (`WAIT` seconds — the wait probe exits non-zero until model + slot count + build match, so it cannot record a run against the wrong config).
Env: `URL`, `WAIT`, `OUT_DIR`, `EXTRA` (extra probe args), `CTX` (override `-c` if the model will not load).

Manual runs still work:

```bash
python3 probe.py --url http://jetson:9931 --label d3-mini --suite core,concurrency
python3 probe.py --url http://jetson:9931 --label d3-mini-env --only envelope   # crashes the server on purpose
python3 probe.py --url http://jetson:9931 --label d1-p4-share --only sharing,slot_counters
python3 report.py "results/*d3-mini*.json" --out results/d3-mini-compare.md
```

`--only multiseq,realistic` runs single cases (searches every suite, no `--suite` needed).
`--reps` controls the latency-vs-n repetitions.
`--max-per-question-tokens` (default 200) skips cases whose estimated per-question prompt exceeds it — see Safety.
`--ceiling-pads` / `--env-pads` set the size ramps (PAD repeats, ~10 tokens each).
The ceiling sweep has to *cross* `n_ubatch` before the server names it, so a `-ub 2048` run needs a ramp past 2048 tokens; `run_model.sh` passes the wider ramps and records the config in the run notes.

## offline (no network, no GPU)

```bash
python3 fake_endpoint.py --port 8099 --crash-above 250 &
python3 probe.py --url http://127.0.0.1:8099 --label smoke --suite core,concurrency
```

The mock reproduces the shapes that matter: tokens = questions x (state + question), a hard process death when >=2 questions exceed the per-question limit, a clean 500 for a single oversized question, deterministic readings.
Use it to test the harness, and in Phase 3 to test the gate's client with no network (PLAN Phase 3 requires that).

## what each case answers

| case                   | question it answers                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`             | which model/build/slots/n_ctx is actually answering — every other number is meaningless without this                                                        |
| `token_accounting`     | is the state re-processed per question? `tokens/question` flat vs falling = sharing or no sharing                                                           |
| `latency_vs_n`         | latency vs question count, interleaved order, medians + marginal ms/question                                                                                |
| `options_sweep`        | does the number of *options* inside one question cost anything                                                                                              |
| `encoding_equivalence` | same content as 1 choice x4 options vs 4 noul questions — latency and tokens                                                                                |
| `realistic`            | the gate's actual request shape (1/2/4 questions, anchored criteria), latency + tokens + readings                                                           |
| `multiseq`             | **does a reading depend on what shares the batch with it** — the behavioural test of llama.cpp #30408                                                       |
| `state_size`           | marginal cost per question vs state size (bounded by the safety budget)                                                                                     |
| `determinism`          | identical request x5 — distinct answer sets                                                                                                                 |
| `calibration`          | the criteria-sensitivity corpus (exfil pair, reversibility anchors, generic band)                                                                           |
| `concurrency`          | batched vs fan-out across slots, wall time and total tokens                                                                                                 |
| `envelope`             | where it stops working: largest ok tokens/question at n=1/2/4, plus a conversation window in `state.context`                                                |
| `ceiling`              | non-destructive version: a single oversized question returns a 500 naming `n_ubatch` — that is how a run's `-ub` gets recorded (non-causal models only)     |
| `merge`                | which questions get merged into one slot batch (`can_batch_with` needs equal prompt length); needs `--destructive`                                          |
| `sharing`              | latency vs n at four state sizes, warm and cold: `factor L4/L1` ~4 = state re-read per question, ~1 = read once                                             |
| `slot_counters`        | **proof** of prefix sharing: poll `/slots` during a request; a child slot reports `n_prompt_tokens_cache` = the prefix it inherited instead of computing it |

## Safety — read before running `envelope`

On llama.cpp b11606 with `vllm-d3-flash`, a request with **>=2 questions whose per-question prompt is over ~254 tokens kills the server process** (connection refused until the model reloads, ~24 s).
One question over ~512 tokens returns a clean HTTP 500.
So:

- the default `--max-per-question-tokens 200` keeps every non-envelope case inside that;
- `--only envelope` deliberately crosses it, records each crash and the observed reload time,
  and waits for `/health` before continuing — expect several reloads;
- the `conversation_window` sub-case is the one to watch on a new model: it puts a real conversation into `state.context` and asks 4 questions, which is exactly the shape the gate will send.
  If it crashes at 2-4 turns, the gate must send a summary, not the window.

Crashes are recorded in `meta.crashes` with recovery time, and the report shows a `crashes during run` row — a run with crashes is not comparable to a clean one.

Measured on `d1-3B` (`--parallel 2`, `-ub 512`, 16384/slot) with the ramp extended to `--env-pads ...220`: **2239 tok/question survives at n=1, n=2 and n=4** (8956 tokens in one request), no crash, no reload.
For a causal model the limit is `n_ctx` per slot, not `n_ubatch`, so the b11606 crash is specific to the non-causal d3 family.
Evidence: `results/20261014-145200-d1-3b-p2-envwide.md`.

## when a new model or build lands

1. `--suite core,concurrency` (clean run, no crashes expected)
2. `--only envelope` (map its limits; expect reloads)
3. `report.py "results/*<label>*.json"` — the comparison table is the artifact
4. check `multiseq max drift` before trusting any threshold: if batched readings differ from
   alone readings, calibrate in the exact batch shape the gate ships.
