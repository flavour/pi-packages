# Config matrix — status, findings and what is left (handoff)

The question this matrix exists to answer: **can N questions ride one forward pass over the state,
so latency stops scaling with question count** (the original Jev property). Two independent
mechanisms can do that, and they have different server switches:

1. **shared prompt prefix** — `server_decision_group_tasks` chunks the questions of one request by
   `params.n_parallel`; the parent stops at `n_tokens_shared` and copies the prompt to the children
   (`server-context.cpp:3853-3866`, `server-decision.cpp:1260`). Switch: `--parallel >= n_questions`.
   Only for `can_share_prompt()` types (`server-decision.h:39-52`): `OPENJEV, LEV, KEV, NIMBLE,
   PPLX_DECIDER, VLLM_DECISION2, LFM2_D1`. **`VLLM_D3` is not on that list** — so the d3 family can
   never share the state read.
2. **one ubatch for several sequences** — the state is still duplicated per question, but the
   questions are computed in the same pass. Switch: `-ub >= merged total`.

All runs: Jetson Orin NX 16GB, JetPack 7.2.1, llama.cpp `b11627-8c2134a87`, Q8_0, `-b 2048`.

## Recorded so far

| config | model | `--parallel` | `-c`/slot | `-ub` | runs on file |
|---|---|---|---|---|---|
| `d1-p2` | LiquidAI/d1-3B | 2 | 16384 | 512 | complete: core, concurrency, share, slots, ceil, env (+envwide) |
| `d1-p4` | LiquidAI/d1-3B | 4 | 8192 | 512 | **complete** (2026-10-14 15:40): core+concurrency `20261014-154039`, share+slots `20261014-154115`, ceil `20261014-154239`, env `20261014-154243`; compare table `d1-p4-compare.md` |
| `d3-mini` | vllm-d3-mini | 2 | 16384 | 512 | core, concurrency, ceil only — **no sharing/envelope probe** |
| `d3-flash` | vllm-d3-flash | 2 | 16384 | 512 | core, concurrency, ceil only — **no sharing/envelope probe** |
| `d3flash-ub2048-p2` / `-p1` / `d3mini-ub2048-p2` | — | — | 2048 | **not run — needs the server restarted on `jetson`** (no ssh key from this machine): `./run_model.sh d3flash-ub2048-p2` prints the command and waits |

`d1-p4` is `-c 32768 --parallel 4` because **32768 is `n_ctx_train` for d1-3B** — `-c 65536` buys
nothing, so 4 slots means 8192/slot. That is enough for every case here (widest per-question prompt
measured: 2239 tok, and at n=4 each slot holds one question).

## Finding 1 (settled) — prefix sharing is real on `d1-3B`, and `--parallel` is the group size

`slot_counters` reads the server's own per-slot counters, so this is proof, not inference
(`n_prompt_tokens_cache` is set to `n_tokens_shared` for a child, `server-context.cpp:3607-3609`):

| n | `--parallel 2` (pre-fix, suspect) | `--parallel 4` |
|---|---|---|
| 1 | 0/1 tasks inherit | 0/1 tasks inherit |
| 2 | 1/2 inherit 441 tok → 33% compute saved | 1/2 inherit 440 tok |
| 4 | 1/4 inherit 440 tok (2 groups of 2; sampling caught one child) | **3/4 inherit 440 tok → real compute 1304 vs 2624 reported (50.3% saved)** |
| 8 | 4/8 inherit 1764 tok | 4/8 inherit 1756 tok (two groups of four: 2 parents re-read, 4 children inherit; sampling is a lower bound) |

So the Jev property **does** hold on `d1-3B` (`LFM2_D1` is in `can_share_prompt()`), but only up to
`--parallel` questions per request: the group size is the slot count, and each group pays one state
read. `usage.input_tokens` still reports `N × (state + question)` in every case — **never use it as
a compute budget or a sharing signal** (`server-context.cpp:2345`).

Server log during a 4-question request at `--parallel 4` (849-token prompts) confirms the shape:
one `is_child = 0` parent + three `is_child = 1` children launched in the same millisecond, all four
releasing at the same `n_tokens`.

### Negative control (`d1-p1`, 2026-10-15) — the sharing signal is specific to `--parallel`

Same model, same probe, same `-c 32768`, one slot (`results/20261015-185213-d1-p1-share.md`):

| n | slot tasks | `n_inheriting` | `compute_saved_pct` | latency (915-tok state) |
|---|---|---|---|---|
| 1 | 1 | **0** | 0.0 | 0.677 s |
| 2 | 2 | **0** | 0.0 | 1.337 s |
| 4 | 3 sampled | **0** | 0.0 | 2.659 s |
| 8 | 6 sampled | **0** | 0.0 | 5.31 s |

Every task lands on `slot 0`; `inherited_tokens` is 0 everywhere; marginal cost is **≈660 ms per
extra question** at every step (1→2, 2→4, 4→8) and `latency_ratio` at n=4 is **3.93** — "at the slot
floor". Compare `--parallel 4`: 3/4 inherit, 50.3% compute saved, **0.485 s** for the same request.
So sharing is a property of `--parallel`, not of the probe, and it is worth **≈5.5× at n=4**.

One honest limit on the counter half of the evidence: with a single slot the tasks serialize, so the
slot-counter sample cannot catch inheritance even if any existed (the harness says so itself: "no
inherited prefix sampled this rep (children finish fast)"). The **latency** half is independent and
decisive — linear in n at one slot, sub-linear at four.


## Finding 2 (settled) — `--parallel 4` is the config to ship; readings do not move

Same model, same build, same prompts:

| metric | d1-p2 (2 slots) | d1-p4 (4 slots) |
|---|---|---|
| latency n=1 (toy state) | 0.0852 | 0.0833 |
| latency n=4 | 0.307 | **0.2038** |
| latency n=8 | 0.6044 | **0.3937** |
| latency n=12 | 0.9007 | **0.5902** |
| realistic 1q | 0.1819 | 0.1827 |
| realistic 2q | 0.3222 | 0.3145 |
| realistic 4q | 0.5951 | **0.4845** |
| realistic 4q readings | intent .9151 / rev .9033 / blast .8922 / cred .9791 | intent .9148 / rev .9031 / blast .8895 / cred .9793 |
| multiseq max drift vs alone (x2 / x4) | 0.004 / 0.004 | 0.0059 / 0.0037 |
| calibration corpus | identical to 4 dp in every case | identical to 4 dp in every case |

The two open suspicions from the partial run are both closed: **n=1 did not get slower** (0.0852 →
0.0833; the 0.162 in the partial run was the cold-start first call), and the win at 4 questions is
−19% latency for **max reading drift 0.003** — thresholds do not have to be re-calibrated per
`--parallel`.

Marginal cost at `--parallel 4`, cold cache, big state (915 tok/question): 1→2 = 91.5 ms,
2→4 = 21.2 ms/question, 4→8 = 201.7 ms/question. **Questions 2-4 are nearly free; the jump is at 5,
where a second group has to re-read the state.** That is the Jev shape, and it puts the practical
question count at **4 per request** (SPEC §6.3's 4-6 range: 5-6 costs a second state read).

## Finding 3 (settled) — the crash envelope is a non-causal artifact; `d1` is bounded by `n_ctx`/slot

`d1-3B` at `--parallel 4`, ramp `--env-pads ...220`: **2239 tok/question survives at n=1, n=2 and
n=4** (8956 tokens in one request), no crash, no reload — same as at `--parallel 2`.
`results/20261014-154243-d1-p4-env.md`.

From source: the 500 that names `n_ubatch` comes from the `!slot.can_split()` branch
(`server-context.cpp:3556`) — a causal model never takes it, which is why the `ceiling` case for `d1`
returns OK all the way up its ramp and reports no `n_ubatch`. The fatal assert is
`GGML_ASSERT((cparams.causal_attn || cparams.n_ubatch >= n_tokens_all))` (`llama-context.cpp:1898`),
and `n_tokens_all <= n_batch` is asserted two lines above. **Prediction for the d3 runs, still
untested:** with `-b 2048 -ub 2048` the assert can never fire, so expect no crash at all and the
single-question limit to move 512 → 2048 tokens.

**`--parallel` trades per-slot context for sharing** (`results/20261015-185450-d1-p1-env.md`): at
`--parallel 1` the single slot holds all 32768 tokens, so 2239 tok/question still passes at n=4
(8956 tokens in one request). At `--parallel 4` the same request must fit 8192/slot. So the shipping
config buys ≈5.5× on the common 4-question request and caps one request at ~3.5k tokens/question —
which is far above anything the gate sends, but it is the number the client's size check must use.

## Finding 4 (settled) — the conversation window is affordable on `d1-3B`

4 gate questions with a real conversation in `state.context`, at `--parallel 4`:

| turns | total input tokens | latency | readings (blast / cred / intent / rev) |
|---|---|---|---|
| 0 | 727 | 0.458 | .892 / .979 / .914 / .906 |
| 2 | 1035 | 0.533 | .881 / .981 / .871 / .903 |
| 4 | 1315 | 0.592 | .868 / .980 / .900 / .901 |
| 8 | 1875 | 0.723 | .866 / .981 / .905 / .894 |

No crash, and readings move by ≤0.043 (largest on `intent`, at 2 turns). So SPEC §10's "a recent
conversation window is optional and must degrade first" is affordable — but it costs ~0.075 s per
2 turns and the state is re-prefilled per question, so the window is still the first thing cut when
the request gets big.

## Caveat that was fixed mid-matrix (re-measure before comparing old runs)

`c_sharing` used to make a rep "cold" by **appending** `cache-bust-<r>-<pads>-<n>` to the state. The
state is the *prefix* of the prompt, so every "cold" rep still shared ~98% of its prompt with the
previous one (server log: `f_keep = 0.982`), which understated the per-question state cost — and in
`slot_counters` it could have faked a sharing signal in the very counter the case reads (the *parent*
inheriting the previous request's prefix). **The marker now goes at the start of the state** (both
`c_sharing` and `c_slot_counters`); the `d1-p4` numbers above are post-fix. The `d1-p2` rows in
`d1-p4-compare.md` are pre-fix, so treat their warm/cold split as suspect and their `slot_counters`
inheritance counts as still meaningful (a parent inheriting a stale prefix would *understate* the
parent's `processed`, not create a child).

Also: at `--parallel >= n` the latency factor `L4/L1` cannot separate "sharing" from "enough slots"
— the floor is `ceil(n/n_slots)` rounds either way. `slot_counters` is the proof; latency is only the
size of the win. That is why the `sharing_factor` verdict for `d1-p4` says "partial" at 1.19-1.59
even though sharing is proven.

## Harness changes made this session (all tested against `fake_endpoint.py`)

- `probe.py --expect-ctx-slot N` — refuses to record a run whose `n_ctx`/slot disagrees with the
  config. This caught a real error: the first `d1-p4` run was recorded with notes claiming
  `-c 65536 (16384/slot)` while the server reported 8192/slot. That JSON's notes have been patched
  to say `-c 32768 (8192/slot)` and `PARTIAL RUN`.
- `run_model.sh`: `--expect-ubatch` only for non-causal configs (a causal model cannot report
  `n_ubatch`); per-config `CtxSlot`; a `merge` step for the d3 configs (2 equal-length questions at
  ~2k merged tokens — the shape that killed the process at `-ub 512`); extended `--ceiling-pads` /
  `--env-pads`; env `URL`, `WAIT`, `OUT_DIR`, `EXTRA`, `CTX`.
- **wait-loop bug fixed**: the identity probe used `--allow-identity-mismatch`, so it always
  succeeded and `WAIT` never actually waited — it started probing the wrong config. It now exits
  non-zero until model + slots + n_ctx/slot + build match.
- `report.py`: `pickmax` for `envelope_max_ok` (several envelope probes -> take the widest survivor).
- cold-marker position fix (see the caveat above).

## Next (in order)

1. **`d3flash-ub2048-p2`** then **`d3flash-ub2048-p1`** (control) — **needs a human to restart the
   server on `jetson`**; `./run_model.sh d3flash-ub2048-p2` prints the command, waits, and records
   the flags. Check: ceiling reports `n_ubatch 2048`; merge at ~2k merged tokens returns OK instead
   of killing the process; envelope shows no crash; `slot_counters` shows **no** inherited prefix
   (d3 is not `can_share_prompt`) — that negative control matters as much as the d1 positive.
   `d3mini-ub2048-p2` only if flash is a candidate at all.
2. ~~`d1-p1` negative control~~ — **done 2026-10-15**, and it holds (see Finding 1's control table:
   0 inheriting, ≈660 ms/question, `latency_ratio 3.93`). The server is currently **still on
   `--parallel 1`**; it must go back to `--parallel 4` (the shipping config) before any further d1
   measurement is comparable to the d1-p4 rows.
3. Regenerate the cross-model matrix: `python3 report.py "results/*d1-3b*.json"
   "results/*d1-p4*.json" "results/*d1-p1*.json" "results/*d3*.json" --out results/model-matrix.md`.
   `results/d1-sharing-control.md` already compares p4 and p1 (post-fix only; the `d1-p2` rows predate
   the cold-marker fix and are excluded from new comparisons).

## What the gate needs from this (the decision it unblocks) — **decided**

SPEC §6.3 question count and the per-call latency budget:

- **Ship `--parallel 4`** (`llama-server -hf LiquidAI/d1-3B-GGUF:Q8_0 --port 9931 --slots -c 32768
  --parallel 4`). It is free at 1 question, −19% at 4, and −35% at 8.
- **Send 4 questions per request.** Questions 2-4 ride the parent's state read; a 5th starts a
  second group and pays another state read (~200 ms at realistic size). So the §6.3 range narrows
  from "4-6" to **4, or 5-6 only if the extra reading is worth ~0.2 s**.
- Keep the state small anyway (~200 tok): the state is prefilled once **per group**, so with 4
  questions the token cost is still ~4× the state.
- Pin the startup check to model + build + `--parallel` + `n_ctx`/slot — all four move the numbers,
  and `--parallel` changes the *shape* of the cost curve, not just its height.
- `usage.input_tokens` is accounting only; the size check must stay conservative.
