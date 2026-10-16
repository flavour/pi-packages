# pi-auto-mode — PLAN

Working directory: `/home/fran/code/pi-auto-mode`

This plan deliberately **stops short of implementation design**.
Phase 3 produces the implementation plan; no code is written before that is reviewed.

    Phase 0  baseline            (done 2026-10-14)
    Phase 1  fit-gap & mining    (5 projects + endpoint probe)  done, 2 runs blocked on a restart
    Phase 2  refine SPEC         (nine conflicts + §17)          ← next task
    Phase 3  build impl plan     (IMPL_PLAN.md, milestones, test strategy)
    GATE     no implementation before Phase 3 is signed off

## Phase 0 — Baseline

- [x] `SPEC.md` (draft v0.1) exists — done.
- [x] `PLAN.md` exists — done.
- [x] `docs/endpoint.md` — decision endpoint probed live, contract + measurements recorded;
      SPEC §6.1/§6.3/§10/§13 updated from it — done.
- [x] `git init` in `pi-auto-mode`; commit drafts — **done 2026-10-14**.
- [x] Confirm the Pi API surface the spec assumes, against the installed release — **done 2026-10-14**, evidence in [`docs/pi-api.md`](docs/pi-api.md).
      Four spec corrections needed: trust is a `project_trust` **event** (no `ctx.isProjectTrusted()` in 1.2.0, which all five prior projects call), argument rewriting is by mutating `event.input` in place (not via the result), `terminate` is a batch-scoped hint, and **tool calls in one assistant message can run in parallel** — so the refusal breaker and repeat ledger must be race-safe.
      Two gaps closed: `user_bash` is hookable (SPEC §17-8) and nested calls fire `tool_call` with `parentToolCallId`.
      Annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`/ `openWorldHint`) and `ctx.mode` are available for §6.4 and §8.2.
- [x] Decide doc layout: `docs/analysis/<project>.md`, `docs/fit-gap.md`,
      `docs/mined-assets.md`, `docs/decisions.md`, `docs/calibration.md` — **done**; layout in use,
      plus `docs/endpoint.md` and `docs/pi-api.md`. `docs/decisions.md` and `docs/calibration.md` are
      created in Phase 2/3.

## Phase 1 — Fit-gap & mining — **complete 2026-10-14** except two blocked server-restart runs

### 1.0 Method (same rubric for every project)

For each project, fill in the same grid so the five are comparable:

- [x] **Pipeline shape** — layer order, where the model is consulted, what never reaches it.
- [x] **Deterministic rules** — hard-block list, dangerous-shape patterns, allow/deny rule syntax, segmentation, wrapper stripping, protected paths.
      **Copy the actual regexes.**
- [x] **Question set** — exact instruction text, **criteria text**, mode/severity classification, per-question thresholds.
      Note: on `jetson`, criteria text moved a reading from 0.073 to 0.977 for the same call, so mined question sets are only reusable together with their criteria and their thresholds.
- [x] **Aggregation** — how per-question probabilities become a verdict (the §7 question).
- [x] **Thresholds** — shipped defaults, where they came from, whether calibration data exists.
      Flag anything that was calibrated against hosted TypeSafe Jev: those numbers do **not** transfer to `jetson`'s model.
- [x] **Middle tier** — is there an ask-the-user band?
      What UI?
      What does headless do?
- [x] **Failure policy** — timeout/retries/breaker, fail-open vs fail-closed, cancellation.
- [x] **Coverage** — which tools; what happens to tools it did not think of; MCP/annotations.
- [x] **Privacy** — redaction, what is and is not sent, key storage.
- [x] **UI/UX details worth stealing** — widget format, block-reason wording, settings pages,
      commands.
- [x] **Tests & eval** — test style, replay corpora, calibration harness, fixtures worth reusing.
- [x] **Fit-gap verdict** — % of SPEC requirements met; what is missing; what is wrong for us.
- [x] **License / attribution** — can we vendor code, or only re-implement ideas?

Deliverables:

- [x] `docs/analysis/pi-auto-permission-gate.md` — **done 2026-10-14**
- [x] `docs/analysis/pi-auto-permissions.md` — **done**
- [x] `docs/analysis/pi-jev-auto-mode.md` — **done**
- [x] `docs/analysis/pi-jev-permit.md` — **done**
- [x] `docs/analysis/pi-jev-tool-guard.md` — **done**
- [x] `docs/fit-gap.md` — **done**: matrix over SPEC §4-§15, the 15 assets to take, the nine
      cross-project conflicts that need our decision, and what no project covers.
- [x] `docs/mined-assets.md` — **done**: verbatim regexes, question/criteria text, aggregation
      pseudocode, threshold tables with provenance, failure/breaker constants, redaction patterns,
      UI copy, config schemas, replay fixtures — all with `file:line` refs.

### 1.1 Per-project focus (provisional hypotheses — confirm or kill them)

**`pi-auto-permission-gate`** (`/home/fran/code/pi-auto-permission-gate`) — verdict: **~35% of the SPEC**; mine it for the pattern catalogue and the approval queue, nothing else.

- [x] Hard-deny vs soft-rule split — **confirmed**, and the allow-cannot-override-hard-deny rule is real (`hardDenyReasons` runs before user rules).
      Hard-deny is 8 patterns, deliberately small.
- [x] Chained-command allow matching — **confirmed**: every live segment must match; `cd/tail/head/wc/
      sleep` are inert helpers.
- [x] Exclusions it declares — **confirmed**: `splitSimpleSegments` returns `undefined` for command
      substitution, heredocs, subshells, escapes and redirects-to-file.
- [x] `mktemp`/`$TMPDIR` tracking — **answered**: it is *not* tracked; instead the two "unresolved target" hard-deny rules refuse a dangerous verb whose object is a variable/glob, so the dangerous case never needs variable tracking.
      That is the cheaper design — adopt it, and keep `pi-jev-permit`'s `resolveLiteralAssignments` for the same-command-assignment case.
- [x] Fail-closed with no UI — **partly**: it does not block; it queues to a browser approval server (loopback + Bearer token + CSRF) and only blocks when the approver is unreachable (`HumanDecision.unavailable`).
      This is our best §8.2 RPC answer.
- [x] Gap: no semantic model — **confirmed**; the deterministic layer is worth reusing wholesale
      (41 patterns + hard-deny), the rest is not applicable.

**`pi-extensions/packages/pi-auto-permissions`** — verdict: **~40%**; the only project that treats *everything* as a model call, and the only one with an MCP story.

- [x] Authorization model — **confirmed**: only user messages grant permission; assistant text, tool
  output and env vars are excluded from the evidence window by construction (6 turns, 16 000 chars,
  newest-first, `role === "user"` only).
- [x] Three outcomes — **confirmed**: `approve` / `revise` (constraint violated → block + feedback) /
  `ask_user`; the agent gets the reviewer's reason verbatim, which `pi-jev-auto-mode` argues against.
- [x] Rule syntax — **confirmed**: `{pattern: string, flags, level, group, label, message}`, empty policy by default, `new RegExp` per rule, no caps, no anchors, multi-line allowed (a real ReDoS / bypass surface).
  We keep regex but add caps + multi-line rejection.
- [x] Gap: general LLM, not a decision model — **confirmed**, and it shows: no noul, no thresholds, no fast path, no breaker.
  What transfers is the evidence-lineage/fingerprint invalidation, the `n_ctx`-derived token budget, and the MCP argument projection.

**`pi-jev-auto-mode`** (closest relative — `docs/design.md`, `docs/calibration.md`, `docs/security.md` read in full) — verdict: **~70%**; the architecture to mirror, the thresholds to discard.

- [x] `mode` × `severity` taxonomy — **confirmed**, and the reason hazard questions cannot be
  `required` is documented: a required question's middle band resolves to "not satisfied", so a hazard
  question would block on *unfamiliarity* rather than on evidence.
- [x] `gateScope: all | matched` — **confirmed**, and the `curl -d @~/.ssh/id_ed25519` story is real
  (the call matched no rule, so it was never judged; default `all`, and `matched` is documented as
  "not a safe auto mode").
- [x] Per-rule thresholds + calibration — **confirmed**: 13 fixtures, one request each, 2026-09-17, hosted `jev-latest`, ±0.05.
  The four calibration lessons in `docs/mined-assets.md` §7 are the most transferable part of that project.
- [x] Middle band → **block** by default (`uncertain: deny|ask|allow`) — **confirmed**.
  Keep our ASK default, but adopt its mechanism for keeping the band narrow (hazard-mode questions ignore the band).
- [x] Records, `display: compact|full`, protected-path escalation, trusted-project tighten-only —
  **confirmed**; `appendEntry` keeps records out of LLM context on purpose.
- [x] Reuse candidate `src/jev/*` — **yes for shape, no for code**: it is TypeSafe-SDK-shaped (`{noul:[{question,criteria}]}`, `choices`, `usage`), while `jetson:9931` takes `{questions:[{id,type,question,criteria}], values, max_tokens: 1}`.
  Re-implement against `docs/endpoint.md`; the `Breaker` and `Ledger` classes are directly portable.

**`pi-jev-permit`** — verdict: **~75%**, the strongest of the five; the `combine()` table and the question split are the two things to lift.

- [x] Three-question split and the **100/125 refusals** evidence — **confirmed**, documented at
  `src/gate.ts:240-251` with the 0.40-0.59 "I cannot tell" band and the extremes (private key 0.02,
  recursive wipe of `/` 0.02).
- [x] `combine()` — **confirmed** as the strongest existing answer to SPEC §7: two-sided bands,
  `q_critical` blocks alone, `q_risk` blocks only when authorization is weak, priority-ordered
  `decidingRule`, `authorization = allow - 0.2`.
- [x] Segments-not-strings, wrapper stripping, inert `VAR=value`, read-only fast path — **confirmed**
  (`splitChain` + taint, `effectiveCommandIndex`, `resolveLiteralAssignments`, `readOnlyProblem`).
- [x] Repeat-skip (N=2, same turn, identical, model-allowed only) — **confirmed**, and it is *not* the
  only fail-open layer: the breaker (3 refusals) and `onUnavailable: degraded` are two more; the
  `unbreakable` set (credentials, protected paths) is excluded from all three.
- [x] `onUnavailable: degraded` + breaker — **confirmed**, half-open via `cooldownMs`, and the
  "couldn't even run `ls`" argument for keeping the fast path alive.
- [x] Widget format + `/jev-permit allow` — **confirmed**: 60 s TTL, one use, consumed at decision time,
  credential class excluded, refusals listed oldest-first.
- [x] `test/fixtures/replay-hard-cases.txt` — **yes**, 8 lines, copied into `docs/mined-assets.md` §12
  together with the `jq … | @json` corpus builder.
- [x] Transport comparison — **done**: `{baseUrl}/v1/systemone` (permit) is the same contract as `jetson:9931/v1/systemone`; `{baseUrl}/api/alpha/decisions` (auto-mode) is the older hosted shape.
  Keep `systemone`, drop the SDK and the API-key path.

**`pi-jev-tool-guard`** — verdict: **~55%**; contributes four things no other project has.

- [x] 1-10 `threshold` scale → `{reviewProbability, highRiskProbability, severityReview}` +
  `BUILTIN_TOOL_THRESHOLD_BOOST {bash: +3}` — **confirmed**, and it is the friendlier UX: ship a scale,
  calibrate the floats behind it (SPEC §17-1).
- [x] Its seven questions — **confirmed** as the closest match to our `reversible` question, **but with inverted polarity** (`true` = hazard present).
  Do not mix conventions in one question set.
  The `score` (0-3 severity with written anchors) is a new question type for us.
- [x] UI/RPC behaviour — **confirmed**: prompt in TUI/RPC, block when `!ctx.hasUI` unless
  `headlessRisk: "allow"`; `highRisk` only changes the dialog title, so the human always decides.
- [x] Fail-open default — **confirmed** (`evaluatorFailure: "allow"`, the only project of the five that defaults that way) and **argued against**: with no fast path and no protected-path defaults, an unreachable endpoint means no gate at all.
  Its one good idea there is notifying once per failure reason instead of every call.
- [x] Global vs project settings editing — **confirmed**, plus the asset we did not expect:
  `provenance: Record<string, "default"|"global"|"project"|"derived">` and
  `projectOverrides: full | none`.

### 1.2 Endpoint probe (`http://jetson:9931/v1/systemone`)

**Done — probed live 2026-10-13; evidence in [`docs/endpoint.md`](docs/endpoint.md)**, folded into SPEC §6.1/§6.2/§6.3/§10/§13.
Established: no auth; `noul`/`choice`/`score` types and their response shapes (incl.
`confidence`); keys echoed in `answers`; `usage` token counts; `/health`, `/v1/models`, `/slots`, `/props`; **options are free, questions are not** (same four concerns: 0.209 s / 218 tok as one `choice` with 4 options vs 0.580 s / 674 tok as 4 `noul`); `input_tokens = N × (state + question)`; ~130 ms marginal per question at realistic state size; state size is the cost driver; batching beats fan-out and slot-splitting buys nothing; readings deterministic; ceiling is server-config-dependent; the server ignores the requested model.

Remaining endpoint work, in priority order:

- [x] **Conversation-window cost.**
      **Closed for `d1-3B`** (2026-10-14, `--only envelope` at `--parallel 2` and `--parallel 4`): a 2/4/8-turn window runs clean, readings within 0.04, and 2 239 tok/question survives at n=1/2/4.
      The b11606 crash is non-causal/d3 specific (`llama-context.cpp:1898` asserts only for non-causal attention).
      Cost is latency + slot space, so the window is the first thing to cut when a request gets large (`bench/results/CONFIG_MATRIX.md`).
- [ ] **Decide the client's per-request size budget** (in tokens, from `n_ctx`/slot minus the question overhead) and the shape of the startup ceiling probe.
      **Shape settled**: for a causal model the limit is `n_ctx` per slot, not `n_ubatch`; over-limit still crashes the endpoint, so check size before sending and treat connection-reset as a breaker event, not a retry event.
      The number is Phase 2 work — see GUARD's `fitState` ladder in `docs/mined-assets.md` §8 for the degradation order to implement.
- [ ] **How does `confidence` enter the tier table?**
      A `score`/`choice` reading can come back flat (severity level 1.145 at confidence 0.046).
      Decide whether low confidence alone forces ASK, or only in combination with a mid-band `noul` reading.
      **No mined precedent** — none of the five reads `confidence` at all (`docs/fit-gap.md` §17 table).
- [ ] Startup ceiling probe: discover the token limit without hard-coding it (it was ~2 100 on one server config and >12 000 on another).
      Read it from `/props` (`n_ctx` per slot) instead of probing by crashing the endpoint.
- [ ] Model identity from the **response** `model` field (the server ignores the requested model when one is loaded), and refuse semantic judgments on an unexpected model rather than apply thresholds calibrated for another one.
      **Pinned set decided**: model, build, `--parallel`, `n_ctx`/slot.
- [ ] Cold start after a server restart; prompt-cache behaviour across *similar* (not identical) requests.
      **Partly closed**: cold start measured (the 0.162 s n=1 outlier was cold), prefix sharing proven by slot counters; *similar-but-not-identical* states are unmeasured, which matters because our state builder must keep a stable key order to keep the prefix reusable.
- [x] Fix the question count from measurement on the pinned model — **closed at 4 per request on `--parallel 4`** (questions 2-4 ride the parent's state read; a 5th starts a second group).
      Not taken from the mined projects' lists (`pi-jev-permit` used 3, `pi-jev-auto-mode` more, both against a different server).
- [ ] **Use `bench/probe.py` for all of this** — one harness, JSON + Markdown per run, `report.py` diffs runs across models/builds, `bench/fake_endpoint.py` mocks the endpoint so the harness (and later the gate's client) is testable with no network.
      Usage and the per-case question table are in `bench/README.md`.
      Remaining measured items:
  - [x] `--only multiseq` on each model — **closed, no drift worth worrying about.**
        d3-mini and d3-flash at b11627: max drift 0.000 alone vs batched x2/x4.
        `d1-3B`: max drift 0.004, and the same question repeated at n=1/2/4/8 returns identical readings (spread 0.0).
        So the calibration corpus can be run per-question; the shipped batch shape does not change readings.
  - [x] `--only envelope` + conversation window on `d1-3B` — **closed, no crash.**
        OK at 639 tok/question for n=1/2/4 (2 556 tok total), and the 4-question gate request with a 2/4/8-turn window runs clean with readings within 0.04.
        The b11606 crash is therefore d3/non-causal specific (`llama-context.cpp:1898` asserts only for non-causal attention), and the gate can send the conversation window on `d1-3B`.
        Evidence: `bench/results/20261014-131110-d1-3b-p2-env.md`.
        **Re-measured with a wider ramp (`--env-pads ...220`): 2239 tok/question survives at n=1/2/4 (8 956 tok in one request), no crash.**
        For a causal model the limit is `n_ctx` per slot, not `n_ubatch`.
        Evidence: `bench/results/20261014-145200-d1-3b-p2-envwide.md`.
  - [ ] **Server-config matrix — the next task, and it needs the server restarted on `jetson`** (no ssh key from this machine, so the human runs the command; `bench/run_model.sh <config>` prints it, waits, and records the flags into provenance).
        **Status and findings: `bench/results/CONFIG_MATRIX.md` — start there.**
    - [x] `d1-p4` — `d1-3B --parallel 4 -c 32768` (32768 = `n_ctx_train`, so 4 slots = 8192/slot).
          **Closed 2026-10-14 (all four runs, clean): `bench/results/CONFIG_MATRIX.md` + `d1-p4-compare.md`.**
          Prefix sharing is proven by the server's own counters — at n=4, **3/4 tasks inherit 440 tok** (real compute 1304 vs 2624 reported); at n=8, two groups of four.
          Latency: realistic 4q 0.595 -> **0.485 s**, n=8 0.604 -> 0.394 s, n=1 unchanged (0.085 -> 0.083; the earlier 0.162 was cold start).
          Readings move ≤ 0.003, so thresholds do not need re-calibrating per `--parallel`.
          Marginal cost (cold, 915 tok state): 1→2 = 92 ms, 2→4 = 21 ms/q, 4→8 = 202 ms/q — **questions 2-4 ride the parent's state read, a 5th starts a second group.**
          The cache-bust marker was moved to the start of the state before this run (the old appended marker left "cold" reps 98% warm, and could have faked a parent inheriting a stale prefix in `slot_counters`); the d1-p2 rows in the compare table are pre-fix.
    - [ ] `d3flash-ub2048-p2` / `d3flash-ub2048-p1` — `vllm-d3-flash -b 2048 -ub 2048`, with 2 and 1 slots.
          **Blocked on a human: needs the server restarted on `jetson`** (no ssh key from this machine) — `bench/run_model.sh d3flash-ub2048-p2` prints the command, waits for the endpoint to match, and records the flags.
          Deprioritised: the shipping decision (`--parallel 4`, 4 questions, `d1-3B`) is already settled by the d1 rows; what these runs add is the negative control (`d3` must show **no** inherited prefix) and the crash-envelope prediction (`-ub == -b` ⇒ the assert can never fire).
          Does raising `n_ubatch` remove the assert (ceiling case must report 2048), and do N equal-length questions then ride one ubatch (a *batched* forward pass — the state is still duplicated, unlike prefix sharing)?
          `--parallel 1` is the control: no merging, so no assert at any size.
          Prediction from source, to be tested: the fatal assert is `(causal_attn || n_ubatch >= n_tokens_all)` and `n_tokens_all <= n_batch` is asserted two lines earlier (`llama-context.cpp:1896-1898`), so with `-ub == -b` it can never fire — expect **no crash at all** and the single-question limit to move 512 -> 2048.
          `d3` is not in `can_share_prompt()`, so `slot_counters` must show **no** inherited prefix: that is the negative control that makes the d1 positive meaningful.
    - [ ] `d3mini-ub2048-p2` — same flags, cheaper model, if flash is too slow to be a candidate.
    - [ ] Note for the gate's client: `usage.input_tokens` sums every question task's full prompt (`server-context.cpp:2345`) **even when the prefix is shared**, so it overstates compute whenever `--parallel >= n_questions`.
          Do not use it for a token budget; use it for accounting only, and keep the size check conservative.
  - [x] Negative control `d1-p1` (`--parallel 1`) — **done 2026-10-15**, and it holds: 0 inheriting tasks at every n, all tasks on `slot 0`, `compute_saved_pct 0.0`, latency linear in n (0.677 → 1.337 → 2.659 → 5.31 s at a 915-tok state, ≈660 ms/question, `latency_ratio 3.93`).
        Sharing is therefore a property of `--parallel`, not of the probe (≈5.5× at n=4).
        **The server is still on `--parallel 1` — put it back to `--parallel 4` before measuring more.**
  - [ ] `--suite core,concurrency` then `--only envelope` on `LiquidAI/d1-omni-600M` (`d3-mini`, GGUF arch `qwen35`, 4.8B): does it share state (it is `VLLM_D3`, so expect no), where is its crash envelope, does a 2-4 turn conversation window survive.
        Not yet served — deprioritise behind the config matrix.
- [ ] **Model bake-off — optional, lowest priority.**
      Not a latency question (4 questions at ~0.6 s is workable; the blog's state-sharing models would save only a few hundred ms).
      Only worth a server restart + corpus run if we want 8+ questions per call or find `d1-3B` separating known-hard cases poorly.
      **Update from the b11606 source:** `can_share_prompt()` (`tools/server/server-decision.h:39-52`) covers `OPENJEV, LEV, KEV, NIMBLE, PPLX_DECIDER, VLLM_DECISION2, LFM2_D1` — `VLLM_D3` is excluded, and `is_joint()` (one prompt for all questions) is `CLEF` only.
      Those are the candidates if we ever want state sharing — but `d1-3B` (`LFM2_D1`) is already on that list and still measured `N × (state + question)`, so measure before believing it.

### 1.3 Ecosystem round 2 — the permission-system hub — **complete 2026-10-15**

Searching npm for `keywords:pi-package` (12 077 packages) showed the five local checkouts were ~20% of the field: ~25 relevant packages, and the centre of gravity is a hub we had never seen.

- [x] `docs/analysis/pi-permission-system-hub.md` — `@gotgenes/pi-permission-system` v40.2.1, 31 382 LOC, MIT, itself a fork of `MasRii/pi-permission-system`.
      Deterministic layer over tool / bash (`tree-sitter-bash`) / MCP / skill / path / `external_directory` + directional read-write surfaces; fails closed on unparseable bash and on indirection wrappers; symlink-resolved path denies; aliased shell tools (`shellTools`); subagent ask forwarding; `promptTimeoutMs` (timeout denies, and says "nobody answered"); `0600` review log with name-bound redaction (ADR 0010 refuses shape-guessing, measured); project trust observed, not decided.
- [x] The seam: `registerAuthorizer(name, authorize)` → `authorize(details, query, log)` →
      `allow | deny(reason) | defer`; chain order is config (`authorizerChain`), a missing link is
      fail-safe (more prompting), registration alone grants no authority, and **a link's `allow` on a
      `path`/`external_directory` ask is downgraded to `defer`** (bounded-delegation checkpoint).
- [x] `docs/analysis/chain-links-and-rivals.md` — `@mzwing/pi-permission-auto-review` (closest rival:
      Codex Guardian policy, `riskLevel` × `userAuthorization`, versioned `POLICY_REVISION`, trust-aware
      transcript + `TranscriptStats`, `findToolCallInput` because **the ask carries only a preview**,
      "the request is never truncated"), `pi-permission-classifier`, `@gotgenes/pi-permission-model-judge`
      (deny-only because of the cap), `@geohar/pi-permissions-analyzer` (dry-run prompt dump + scenario
      override + log viewer = our eval-harness pattern), `pi-safety-guards`, `r4vi/pi-auto-mode` (our
      name; `failOpen: true` default), `pi-jev` (only other local `systemOne` user, `PI_JEV_BASE_URL`).
- [x] **D-01 in `docs/decisions.md`: we build only an `authorizerChain` link and stop building a deterministic gate.**
      D-03 (endpoint stays config, pinning is a validated default), D-04 (coverage lives in hub config, we assert it), D-08 (their review log is our record), D-09 (our link can never approve a path ask) follow from it.
- [ ] Not yet examined: `MasRii/pi-permission-system` (fork parent — needed before we decide how far to
      diverge), `@gotgenes/pi-permission-explain` (overlaps our rationale-to-agent design),
      `pi-rtk-optimizer` (the `rtk` wrapper `pi-jev-permit` had a compat test for).

### 1.4 Phase 1 exit criteria

- [x] All five analyses + fit-gap matrix + mined-assets written — **done 2026-10-14** (`docs/analysis/*.md`, `docs/fit-gap.md`, `docs/mined-assets.md`).
      Coverage verdicts: `pi-jev-permit` ~75%, `pi-jev-auto-mode` ~70%, `pi-jev-tool-guard` ~55%, `pi-auto-permissions` ~40%, `pi-auto-permission-gate` ~35%.
      None of the five targets a local decision endpoint, so the client, the model/build/`--parallel`/`n_ctx` startup check, the token-based state budget and the prefix-cache-aware state builder are net-new work.
- [ ] **Phase 2 must decide the conflicts listed in `docs/fit-gap.md`** — breaker consequence (allow vs lockdown), whether an allow rule can override a dangerous shape, whether project config may loosen, whether the model's rationale reaches the agent, what the middle band resolves to, question polarity, rule syntax (glob vs regex), config validation strictness, and how many thresholds a user sees.
      Each has at least one sourced candidate answer.
      **Shrunk by D-01 (2026-10-15):** rule syntax, project-loosening, the breaker consequence and how many thresholds a *user* sees are now the hub's shipped decisions we inherit, not ours.
      What is left for us: question polarity, the middle band (`defer`), aggregation, `confidence`, and whether the model's rationale reaches the agent (their `deny` carries a teaching `reason`, so the channel exists — we decide what goes in it).
- [x] Every SPEC §17 open question has at least one candidate answer sourced from a project — **done 2026-10-14**, table in `docs/fit-gap.md`.
      Four have no precedent and stay ours: model swap (2a), how `confidence` enters the tier table (2b), the uncovered-tool default (5), and `user_bash` (8) — none of the five hooks anything but `tool_call`, so all five are bypassed by `!` commands.
- [ ] Endpoint contract documented from a real exchange — **done** (`docs/endpoint.md`);
      remaining endpoint items in §1.2 above are closed or explicitly deferred.
- [x] A first **measured baseline** on `jetson` — **done** for `d1-3B` (latency vs question count, token cost, determinism, concurrency, prefix sharing, crash envelope, conversation window) and recorded in `docs/endpoint.md` + `bench/results/CONFIG_MATRIX.md`.
      Question count is settled at **4 per request on `--parallel 4`**; thresholds still come from the Phase 3 calibration harness, not from the mined projects.
- [ ] License/attribution note for anything we intend to vendor.

## Phase 2 — Refine the SPEC

Inputs, in the order they should be consumed: `docs/decisions.md` (**D-01…D-09 settle the architecture — read these first**), `docs/analysis/pi-permission-system-hub.md` + `docs/analysis/chain-links-and-rivals.md` (the ecosystem we now build inside), `docs/fit-gap.md` (matrix + conflicts + the §17 candidate table), `docs/mined-assets.md` (verbatim material), `docs/pi-api.md` (four spec corrections), `bench/results/CONFIG_MATRIX.md` (settled endpoint decisions: `--parallel 4`, 4 questions/request, ~200-token state, `n_ctx`-per-slot ceiling).

- [ ] **First: rewrite SPEC §4 and §5 for link-first (D-01).**
      §5 (L0–L4) becomes "the hub's policy layer + the config we ship", not a layer we implement; §4's diagram gains the chain (`ask` → `authorizerChain` → terminal); §7/§8 must stop claiming the model approves writes (D-09: a link's `allow` on `path`/`external_directory` is downgraded to `defer`); §11 splits into hub config (coverage, `authorizerChain`, path recipes) and link config (endpoint, model, thresholds, question set); §15 becomes the hub's published API contract plus a pin range (auto-review pins "37.x – 40.x").
      Expect this to delete more SPEC text than it adds.
- [ ] **Then: the L5 conflicts** (the shrunk list in §1.4) — question polarity, what `defer` means and when we choose it, aggregation, `confidence`, rationale-to-agent.
      One entry each in `docs/decisions.md`.
- [ ] Confirm **D-02** (dependency + emergency fork vs fork-and-rebase) — it decides SPEC §15.
- [ ] Resolve the three redaction/truncation conflicts the ecosystem exposed, per channel:
      name-bound masking (hub, for logs) vs shape-based masking (ours, for the outbound request);
      and "the request is never truncated" (auto-review) vs our §10 budget ladder that truncates the
      call itself.
- [ ] Then the four §17 questions with no mined precedent: `confidence` in the tier table (2b),
      the uncovered-tool default (5), `user_bash` (8 — now known to be hookable, `docs/pi-api.md`),
      and the model-swap question (2a, deferred).
- [ ] Resolve the remaining SPEC §17 questions in `docs/decisions.md`.
      Highest priority: **§7 aggregation**, then §9 unavailable policy, then §6.3 question set.
- [ ] Rewrite SPEC §6.3/§7 with the chosen aggregation model and a worked example per tier.
- [ ] Fix the question set to **4-6 questions** (endpoint latency + state-size cost), each with versioned instruction **and criteria** text; state which are mined vs newly written.
      Keep the hazard/authorization split (`pi-jev-permit`) and consider one `score` question for severity (`pi-jev-tool-guard`); 4 questions is the measured per-request ceiling at `--parallel 4`.
- [ ] Apply the four SPEC corrections from `docs/pi-api.md`: trust via the `project_trust` event (§11), argument rewriting by mutating `event.input` (§8), `terminate` semantics (§8), and race-safe per-turn counters under parallel sibling calls (§7/§9).
      Add annotations (`readOnlyHint`/`destructiveHint`/`openWorldHint`) to §6.4 as routing hints only, and branch §8.2 on `ctx.mode` as well as `hasUI`.
- [ ] Fix the config schema (SPEC §11) and rule syntax; write a full example config file.
      Include per-field provenance (`pi-jev-tool-guard`) and the length/count caps + warn-don't-guess validation (`pi-jev-permit`).
- [ ] Fix the mode/headless matrix (SPEC §8) including RPC — `pi-auto-permission-gate`'s approval
      queue is the only mined answer; decide whether we vendor the idea or block.
- [ ] Set threshold defaults **only if** Phase 1 produced calibration numbers — it did not (no corpus yet), so keep them **provenance-labelled** and make calibration a Phase 3 milestone.
      Ship the 1-10 strictness scale shape (`pi-jev-tool-guard`) with rows to be derived later.
- [ ] Cut anything mining showed to be unnecessary; add anything mining showed we had missed
      (uncovered-tool handling, `user_bash`, nested calls via `parentToolCallId`, the `fitState`
      degradation ladder, stable key order for prefix-cache reuse, key-name redaction).
- [ ] **Spec hole found during mining**: §4 names an **L4 repeat-of-already-approved** layer, but §5 has no section for it (§5.1-§5.4 cover L0-L3 + dangerous shapes).
      Write §5.5 from `pi-jev-permit`'s `Ledger` (repeat allowance N=2, same turn, identical input, model-allowed only, `unbreakable` exclusion for credentials/protected paths) and make it race-safe for parallel sibling calls (`docs/pi-api.md` item 3) with hierarchical `toolCallId` handling (item 6).
- [ ] Add a "Rejected ideas" section: what each mined project does that we deliberately do not
      (fail-open defaults, substring rule matching, `gateScope: matched`, per-project loosening,
      showing model rationales to the agent, hosted-TypeSafe threshold values).
- [ ] SPEC → **v1.0**, reviewed and accepted.
      Acceptance criteria (SPEC §16) made testable.

Still open from Phase 1: `d3flash-ub2048-p2`/`-p1` (negative control: `d3` must show **no** inherited prefix) — blocked on a human restarting the server on `jetson`, and deprioritised.
The `d1-p1` control is **done** (2026-10-15) and holds.
The shipping config is settled by the d1 rows; the server is currently left on `--parallel 1` and should go back to `--parallel 4`.

## Phase 3 — Build the implementation plan

> **2026-10-15: the skeleton was built ahead of this plan**, on the instruction "stop with the detail questions, build something we can evaluate".
> `IMPL_PLAN.md` was not written; the code in `src/` plus the README source map is the artefact for now, and it typechecks, has 70 passing tests, and runs against the live endpoint.
> Phase 2 (the SPEC rewrite) is still open and should now be done against what the code actually does rather than against the draft.

- [ ] **Where the code lives (D-02):** `~/code/pi-packages/packages/pi-permission-decisions-judge`, a package in the forked monorepo.
      Copy the layout from `pi-permission-model-judge` (`src/ test/ config/ schemas/ scripts/ docs/ AGENTS.md README.md LICENSE biome.json tsconfig.json vitest.config.ts`; `pi.extensions: ["./src/index.ts"]`; zod → `schemas/*.schema.json` via `scripts/generate-schema.ts`; peer dep `@gotgenes/pi-permission-system >=27.0.0`).
- [ ] **Monorepo onboarding checklist** (`.pi/skills/releasing` §Adding a new package): `.pi/settings.json`
      load path `../packages/<pkg>`; root `README.md` Packages table; the `Package` dropdown in **both**
      `.github/ISSUE_TEMPLATE/*.yml` (required + blank issues disabled ⇒ unreportable if skipped);
      `.pi/skills/package-<pkg>/SKILL.md`; package-list scripts need nothing.
- [ ] **Upstream-assumptions table** in the package skill, for **llama.cpp** rather than Pi: each
      assumption (`can_share_prompt()` covers `LFM2_D1`; `n_prompt_tokens_cache = n_tokens_shared` for a
      child; the `n_ubatch` assert for non-causal models; `usage.input_tokens` is accounting only) with
      its source file and how it breaks (`behavioral-silent` / `compile-time` / `coverage-gap`).
- [ ] Module decomposition and the seams (link registration / state builder / decision client /
      aggregation / records / settings / UI) — each independently testable, no network in unit tests.
- [ ] Milestones (D-13: the model is allow-capable from M1 — there is no deny-only milestone):
      **M1** link registration + state builder + endpoint client + aggregation, verdicts
      `allow | deny | defer`, **with the slice-2 envelope in scope**: hard exclusions, deciding-origin
      attribution, non-persistence of an allow, `modelDelegation.allowedSurfaces` scoping (initially
      `["bash"]`), and D-16's no-`allow`-on-a-partially-visible-call rule;
      **M2** unavailable/breaker → `defer`, headless/RPC; **M3** settings + commands + startup chain
      check; **M4** eval harness (dry-run prompt dump + scenario override + log viewer);
      **M5** corpus + thresholds (D-14, later phase).
- [ ] Test strategy per milestone: unit, fake-transport, replay corpus, redaction assertions,
      headless-mode tests, live calibration harness.
- [ ] Data/record format: the hub's `AuthorizerLog` entries keyed by `requestId` (D-08) — field table like model-judge's "What it records", so "did the judge run, did it reach the model, and why did it defer?"
      is answerable without guesswork.
- [ ] Migration/rollout: how to enable on an existing setup without other gates double-firing, and what
      `authorizerChain` + `modelDelegation` snippet we ship (D-10).
- [ ] Risk list with mitigations (latency → defer; false blocks → agent stalls; endpoint down → defer;
      **decomposition infidelity** — `bash -c "safe; evil"` allowed on the safe piece alone, mitigated by
      D-16's whole-call-visible precondition; secret leakage).
- [ ] **Distribution (D-11, accepted):** local-path install from the checkout on each machine
      (`pi install ./packages/pi-permission-decisions-judge`); no npm, and never `pi install git:` on
      the monorepo root (it auto-loads every package in the repo, including future upstream ones).
- [ ] **Docs home (D-15):** this package holds SPEC, PLAN, `docs/` and `bench/`; `~/code/pi-auto-mode` is retired.
      Split `docs/decisions.md` into `docs/decisions/NNNN-<slug>.md` (their convention) when the first new ADR is written, keeping the `D-NN` ids as aliases.
- [ ] Deliverable: `IMPL_PLAN.md`.
      **Stop.**
      **No implementation until it is signed off.**

## Standing rules for all phases

- Analysis is read-only: do not modify the five source projects.
- Quote with `file:line` references in `docs/mined-assets.md`; do not paraphrase a number that
  has a source.
- Prefer measuring over recalling: any threshold we ship must trace to a measurement on `jetson:9931`, not to another project's default.
  The hosted-Jev calibration numbers in `pi-jev-auto-mode/docs/calibration.md` and `pi-jev-permit` are **not transferable** — reuse their method, not their values.
- The five projects are independent review targets — Phase 1 sub-tasks can run in parallel.
