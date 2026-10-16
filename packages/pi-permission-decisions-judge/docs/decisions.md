# Decisions

Simplified ADRs, one file.
Format: id, status, decision, why, consequences, source.
Cite these ids from `SPEC.md` the way `@gotgenes/pi-permission-system` cites `[ADR 0007] §7` — a spec sentence should be able to point at the argument behind it.

---

## D-01 — Depend on the hub; build only an `authorizerChain` link

**Status:** accepted (2026-10-15).
**Decision:** `pi-auto-mode` is a Pi extension that registers one link, `auto-mode`, with `@gotgenes/pi-permission-system`'s authorizer chain.
We do not build a deterministic gate.
SPEC §5 (L0–L4) becomes "the hub's policy layer, plus the config we ship"; SPEC §7 (the model tier) and the state builder are ours.
**Why:** the hub is 31 382 LOC on its 40th release, parses bash with `tree-sitter-bash`, fails closed on unparseable input and on indirection wrappers (`bash -c`, `eval`, `sudo`, `env`, `xargs`, `find -exec`), matches path denies against symlink-resolved forms, gates MCP/skill/aliased-shell surfaces, forwards subagent asks, and states as a non-goal that model judgment does not belong in its core — "model-assisted judging of an `ask` attaches as a chain link over the authorizer seam instead."
Our entire contribution is the thing they deliberately leave open.
Re-implementing their layer with regexes would lose bypass knowledge we do not know we need.
**Consequences:** hard runtime dependency (their own docs treat a missing link as fail-safe: more prompting, never less).
We inherit their config file as the coverage knob (D-04) and their review log as our decision record (D-08).
Our authority is capped by their bounded-delegation checkpoint (D-09).
Version pin follows the local convention — auto-review pins "37.x – 40.x".
**Source:** `docs/analysis/pi-permission-system-hub.md`.

---

## D-02 — Develop inside the fork: `packages/pi-permission-decisions-judge` in `~/code/pi-packages`

**Status:** accepted (2026-10-15), superseding my recommendation of "depend on npm, fork for emergencies".
**Decision:** the link is a package in the forked monorepo at `~/code/pi-packages/packages/pi-permission-decisions-judge`, alongside `pi-permission-system` and `pi-permission-model-judge`.
`origin` is `git@github.com:flavour/pi-packages.git`; the hub copy in the same workspace is ours to patch if we must.
**Why:** the seam's own decision record (`docs/decisions/0007-model-judge-authorizer-chain-adr.md`, 257 lines) and the first-party link's source are then locally readable, the package layout, tests, schema generation and CI conventions are copyable, and a patch to the hub never requires waiting on a release.
**Consequences:** we inherit their tooling and workflow wholesale (D-12); the root package is `private: true`, so there is no repo-root package to install (D-11); a new package must be wired into `.pi/settings.json`, the root README table and **both** issue templates or it cannot be reported at all; **update 2026-10-15:** `upstream = git@github.com:gotgenes/pi-packages.git` is configured and fetched (fork in sync at `29a0da4e`), and we may edit the fork freely — including `packages/pi-permission-system/` — with the standing instruction to **minimise conflicts**: keep edits inside our own package where possible, one commit per carried hub patch, and list every carried patch in `FORK.md` with the upstream issue that would replace it.
**Source:** user instruction; `docs/analysis/pi-packages-monorepo.md`.

---

## D-03 — The decision endpoint is configuration; the pinned model is a validated default

**Status:** accepted (2026-10-15).
**Decision:** `endpoint.baseUrl`, `model`, thresholds and question set all live in config.
The pinned `LiquidAI/d1-3B-GGUF:Q8_0` + measured envelope is the **shipped default and the only validated profile** (calibration is deferred by D-14, so the word "calibrated" is not available yet), not a lock.
Switching model is supported; switching without re-calibrating is supported but reported as uncalibrated.
**Why:** the space is moving fast (d3-flash/d3-mini are non-causal and behave differently; the hub itself requires Pi 1.0.0 in its current major).
Locking to one GGUF file makes the project obsolete on someone else's release schedule.
**Consequences:** every decision record carries `model` + `criteriaRevision` + `endpointBuild`, so an uncalibrated profile is visible after the fact rather than inferred.
Startup must print which profile is in use and whether it is calibrated.
Thresholds become per-profile, not global — a threshold tuned on d1-3B is meaningless on another model.
**Source:** user instruction; `bench/results/CONFIG_MATRIX.md` (model-dependent ceiling and assert).

---

## D-04 — Coverage control lives in the hub's config; we assert it at startup

**Status:** accepted (2026-10-15).
**Decision:** we do not maintain our own rule engine or our own hard-deny floor.
We ship a config snippet and a startup assertion that the surfaces we need reach the chain.
**Why:** the hub's default `"*"` is `ask` (least privilege), so out of the box every request the deterministic layer does not explicitly allow reaches the chain — coverage is the default state, not something we have to claim.
A private floor would drift from their parser and give false confidence.
**Consequences:** a startup check must resolve `checkPermission` for the surfaces we care about and warn loudly if a surface resolves to `allow` (our model would be silently skipped).
If the hub is not installed or the link is not named in `authorizerChain`, we say so plainly rather than pretending to guard.
**Open sub-question for the next round:** whether we keep *any* own floor (see open questions).
**Source:** user instruction "leave this to the Hub"; `docs/configuration.md` §Policy Reference.

---

## D-05 — Mined catalogues become attributed test fixtures; production code stays ours

**Status:** accepted (2026-10-15).
**Decision:** no mined code runs in production.
Mined *patterns* land in `tests/fixtures/` with a `// from <package> (MIT) <file>:<line>` header and an expected verdict, and our own matchers are tested against them.
**Why:** the literal patterns are recorded bypasses, not style.
`pi-auto-permission-gate:684` carries the lookahead `(?!\/private\/tmp\/(?![^\s"';&|]*\.\.)[^\s"';&|])` — someone learned not to hard-deny `rm -rf /private/tmp/x` unless it contains `..`.
Re-deriving "the shape" discards that, and no test would catch the loss.
**Consequences:** MIT attribution obligations (`NOTICE.md` + headers on fixture files), and a test suite that is partly a museum.
Under D-01 most of these fixtures become **regression fixtures for the hub's parser**, not for code we write — which is a cheaper way to keep the knowledge.
**Source:** user instruction; `docs/mined-assets.md`.

---

## D-06 — Mining depth: four full analyses, the rest skimmed

**Status:** accepted (2026-10-15).
**Decision:** full — hub, `@mzwing/pi-permission-auto-review`, `pi-jev`, `r4vi/pi-auto-mode`.
Skim-and-note — `pi-permission-classifier`, `@gotgenes/pi-permission-model-judge`, `@geohar/pi-permissions-analyzer`, `pi-safety-guards`, `MasRii/pi-permission-system`.
Out — jev browser/wiki/router/compaction, plan-mode packages, standalone guards the hub now covers.
**Consequences:** `docs/analysis/chain-links-and-rivals.md` holds the skims; a skim that changes a SPEC section gets promoted to its own file.
**Source:** user instruction.

---

## D-07 — Ship `--parallel 4`, four questions per request, ~200-token state

**Status:** accepted (2026-10-15), now with a measured negative control.
**Decision:** the default endpoint config is `--parallel 4 -c 32768` (8192 tokens/slot), requests carry 4 questions, and the state budget starts near 200 tokens.
**Why:** at `--parallel 4`, `n=4` showed 3/4 tasks inheriting the shared prefix and a 4-question request cost 0.485 s.
The `d1-p1` control (same model, same probe, one slot) shows the opposite: **`n_inheriting = 0` and `compute_saved_pct = 0.0` at every n**, every task on `slot 0`, and latency linear in question count — 0.677 s (n=1) → 1.337 s (n=2) → 2.659 s (n=4) → 5.31 s (n=8) at a 915-token state, ≈660 ms per extra question, `latency_ratio 3.93` "at the slot floor".
Sharing is therefore a property of `--parallel`, not an artifact of the probe, and it is worth ~5.5× at n=4.
**Consequences:** the gate's client must pin startup checks to model, build, `--parallel` and `n_ctx`/slot, because the latency model changes qualitatively with `--parallel`.
A 5th question starts a second group and pays another state read, so question count is a hard 4 unless the state is tiny.
**Source:** `bench/results/20261015-185124-d1-p1*`, `bench/results/d1-p4-compare.md`.

---

## D-08 — Our decision record is the hub's review log, not a private ledger

**Status:** accepted (2026-10-15).
**Decision:** use the injected `AuthorizerLog` (`review` / `debug`, keyed by `requestId`) for audit, and their `decidedBy` vocabulary (`authorizer_allowed` / `authorizer_denied` / …).
No private JSONL.
**Why:** their log is already `0600` in a `0700` dir, name-bound redaction is already applied, and the `permissions:decision` broadcast already exists for observation.
A second log would disagree with the first about what happened.
**Consequences:** our per-question evidence has to fit their record shape (`event` + `details`), and anything richer (probabilities per question, criteriaRevision, latency) goes in `details`.
Their log records payload (the bash command string, a tool-input JSON preview), so what we put in `details` inherits their sensitivity rules — see the open question on redaction.
**Source:** `docs/cross-extension-api.md` §AuthorizerLog; `docs/configuration.md` §Log file sensitivity.

---

## D-09 — Our link can never approve a path or external-directory ask; design as if told

**Status:** accepted as a constraint (2026-10-15).
**Decision:** the question set and the tier model assume the semantic layer can only decide **bash, MCP, skill, and non-path tool surfaces**, and can always deny or defer.
Path/`external_directory` allows are downgraded to `defer` by the chain owner.
**Why:** "a link's `allow` on an excluded surface *family* (`external_directory` or `path`, including each family's directional members) is downgraded to `defer`, so a buggy or over-eager judge can never approve access outside your policy.
Deny and defer are never capped. … a `write` blocked by a `path` rule is capped."
This is also why the first-party `model-judge` link is deny-only.
**Consequences:** SPEC §7/§8 must stop claiming the model approves writes.
A path question (`path_not_protected`) can still exist as **evidence shown to the human**, but it can never change an outcome by itself — so it must not be part of the allow score.
Expect our link to spend a large fraction of its calls returning `defer`; that is the designed shape, not a failure.
**Source:** `docs/configuration.md` §Authorizer chain.

---

## D-10 — Default chain posture: we replace the hosted judge; coexistence is opt-in

**Status:** accepted (2026-10-15).
**Decision:** the shipped config puts only our link in `authorizerChain` (replacing `auto-review` / `classifier` / `model-judge` for the surfaces we cover).
A documented alternative chains ours first and a hosted judge second, so anything we `defer` reaches a smarter model.
**Why:** chain order and membership are the hub's config, not ours, so "configurable" means we ship both snippets and **report the actual chain at startup** rather than pretending to control it.
**Consequences:** our `defer` threshold is what makes the coexistence chain safe, and the startup check must read the effective policy (`query.checkPermission` / the hub config) and warn when another link sits ahead of us — because then we never see what it already decided.
Fast-first means we can `allow` something a hosted judge would have denied: that is the explicit cost of the default, and D-13's phasing is what bounds it.
**Source:** user instruction (Q14); `docs/configuration.md` §Authorizer chain invariants.

---

## D-11 — Distribution: local-path install from the checkout

**Status:** accepted (2026-10-15) — option (a), reluctantly.
**Decision:** on each machine, clone the fork and `pi install ./packages/pi-permission-decisions-judge`.
No npm publish, and no `pi install git:` on the monorepo root.
**Why:** `pi install git:` clones the whole repository and, because the root `package.json` is `private: true` with no `pi` field, Pi walks the tree and auto-loads **every** subdirectory with extension entries — all nine of their extensions, plus any package upstream adds later (`package-manager.ts:599-648`, `1897-1927`).
Suppressing those needs a per-package deny entry that has to grow with upstream, which is a silent failure mode: a stranger's extension loads into your agent because someone upstream committed a folder.
**Consequences:** every machine needs the checkout (and `pnpm install` in it, since our package's deps resolve from the workspace); updates are `git pull` + a Pi restart, not a package-manager bump; the `.pi/settings.json` `npm:` disable entry from their add-a-package checklist stays unadded (adding it before a publish makes Pi `npm install` a nonexistent package).
Revisit upstreaming once the link works.
**Source:** user instruction (Q19); Pi source facts above.

---

## D-12 — Adopt the monorepo's conventions and workflow wholesale

**Status:** accepted (2026-10-15).
**Decision:** inside `pi-packages` we follow their rules as written: pnpm only; `vitest` + `tsc --noEmit`; biome/eslint/rumdl + the invisible-character and unicode-escape lint scripts; Conventional Commits enforced by `committed`; package layout copied from `pi-permission-model-judge` (`src/ test/ config/ schemas/ scripts/ docs/ AGENTS.md README.md LICENSE biome.json tsconfig.json vitest.config.ts`, `pi.extensions: ["./src/index.ts"]`, zod-generated JSON schema); a `package-pi-permission-decisions-judge` skill; ADRs in `packages/<pkg>/docs/decisions/`.
**Why:** their six principles are the discipline our own plan keeps failing to state — "verify against the real surface, not the document about it", "state what you checked, not what you conclude", "a number a command can produce is never authored", "ask before removing functionality or changing defaults".
Fighting the tooling would cost more than adopting it.
**Consequences:** our package skill must carry an **upstream-assumptions table** — for us that means llama.cpp, not Pi: `can_share_prompt()` covering `LFM2_D1`, `n_prompt_tokens_cache = n_tokens_shared` for a child, the `n_ubatch` assert for non-causal models, `usage.input_tokens` being accounting only — each with the source file and how it breaks (`behavioral-silent` / `compile-time` / `coverage-gap`).
Their issue-driven flow (`/plan-issue` → `/tdd-plan` → pre-completion review → `/ship`) is heavier than we need for a personal fork; adopt the parts that cost nothing (commit lint, tests, schema, skill) and skip the GitHub-only stages until we file issues.
**Source:** root `AGENTS.md`, `.pi/skills/releasing`, `packages/pi-permission-model-judge`.

---

## D-13 — Deterministic denies first; the Decisions Model is allow-capable from the first shipped milestone

**Status:** accepted (2026-10-15), **overriding my proposal to ship deny-first first**.
**Decision:** the deterministic layer (the hub's policy, plus hard exclusions) denies before the model is consulted, and the model's verdict set is `allow | deny | defer` from M1.
There is no "deny-only milestone" — a link that cannot approve is not the product.
**Why:** user instruction — "I am not OK for the Decisions Model not to be able to Allow."
ADR 0007 §6's capability gradient is accepted as a **risk description, not a schedule**: it names the failure mode of an allow-capable judge as **decomposition infidelity** (`bash -c "safe; evil"` allowed on the safe piece alone) and states the safety property holds only if decomposition is faithful.
**Consequences:** the slice-2 envelope is therefore **M1 scope, not deferred**: hard exclusions, attribution of the deciding origin, non-persistence of an allow, and an operator-scoped blast radius (`modelDelegation.allowedSurfaces`, initially `["bash"]`).
Their "off by default" posture is honoured a different way: the package is opt-in by naming it in `authorizerChain` (their invariant 3 — registration alone grants no authority) and its surface scope is a separate explicit config line, so turning it on is two deliberate edits, not a default.
D-16 is what makes the allow path defensible at 3B scale.
**Source:** user instruction (Q18); ADR 0007 §6.

---

## D-16 — No `allow` on a call we cannot see whole

**Status:** accepted (2026-10-15) — the mitigation that makes D-13's allow path defensible.
**Decision:** `allow` requires that the judge saw the whole call; otherwise the verdict is `defer`.
Concretely: never truncate the request (truncate the transcript, never the call — `@mzwing/pi-permission-auto-review`: "a reviewer must not approve an action it saw only in part"); never allow on a partially-parsed or wrapper-opaque command; recover the full tool arguments from session entries rather than judging the ask's `toolInputPreview`.
**Why:** this closes decomposition infidelity at the judge end.
The hub already prompts on indirection wrappers (`bash -c`, `eval`, `sudo`, `env`, `xargs`, `find -exec`) and on partial parses, so those asks reach us precisely when the decomposition is unfaithful — and a 3B answering `allow` on the safe piece of `bash -c "safe; evil"` is the exact accident ADR 0007 warns about.
**Consequences:** the question set needs a precondition question ("is the whole effect of this call visible to you?") whose `false` answer forces `defer` regardless of the other scores; the state builder's budget ladder ends in `defer` rather than in truncation; and a call too big for the slot is a `defer`, not a partial judgement.
**Source:** ADR 0007 §6; `docs/analysis/chain-links-and-rivals.md` (never-truncate rule, `findToolCallInput`).

---

## D-15 — Docs live in the package; `pi-auto-mode` is retired

**Status:** accepted (2026-10-15).
**Decision:** everything — `SPEC.md`, `PLAN.md`, `docs/`, `bench/` — now lives at `packages/pi-permission-decisions-judge/` in the fork, grafted with its full git history (`git subtree add`, merge `f15bb8d9`).
`~/code/pi-auto-mode` is retired.
**Naming:** package `pi-permission-decisions-judge` (singular `permission`, matching `pi-permission-system` and `pi-permission-model-judge`); chain link `decisions-judge`, which is what the operator types in `authorizerChain`.
"Local" was rejected as a name because locality is an implementation detail — anything speaking the `/v1/systemone` API qualifies, including a hosted service.
**Why:** their principle 3 ("provenance belongs in git") and principle 4 ("a number a command can produce is never authored") argue for keeping the measurement harness next to the numbers it produces, in the same repo as the code that consumes them.
**Consequences:** their markdown lint (`rumdl`) and commit-header lint (`committed`) apply to our prose once hooks/CI run (neither `prek` nor `rumdl` is installed in this checkout, so the `prepare` hook skipped); `docs/decisions.md` should be split into `docs/decisions/NNNN-<slug>.md` when the first new ADR is written, keeping the `D-NN` ids as aliases so existing citations survive; the package has **no `package.json` yet** on purpose — adding one changes the workspace and the lockfile, which is Phase 3 work.
**Source:** user instruction (Q22).

---

## D-14 — Calibration corpus is a later phase, not a Phase-2 blocker

**Status:** accepted (2026-10-15), deferred.
**Decision:** we build the labelled corpus and tune thresholds in a later phase; nothing in Phase 2 or 3 may claim "calibrated".
**Consequences:** D-03's wording must say *validated default*, not *calibrated default*, until the corpus exists; the tier table ships with thresholds marked provisional; and the eval harness should be built before the corpus (dry-run prompt dump + scenario override + log viewer, the `@geohar/pi-permissions-analyzer` shape) so the corpus is measured by something we already trust.
**Source:** user instruction (Q17).

---

## Open questions (not decisions yet)

1. **Own floor vs none** — under D-04, do we keep any hard-deny patterns of our own, given the hub already fails closed on unparseable bash and denies through symlink-resolved paths?
   *Update 2026-10-15:* the hub's `modelDelegation.excludedSurfaces` plus "secret-shaped path always excluded" is a documented knob for exactly this; the answer is probably "no floor, one config line".
2. **Redaction channel** — the hub masks only name-bound values and refuses shape-guessing with measured reasoning (ADR 0010: heredoc masking gave "six false positives and no true ones").
   Our outbound state plan masks shape.
   Different channels (local `0600` log vs a request to a LAN server whose logs we do not control) — needs a per-channel rule, not one global stance.
3. **Truncation** — auto-review: "The request is never truncated: a reviewer must not approve an action it saw only in part."
   Our §10 ladder truncates the call.
   Which wins when the call does not fit the slot?
4. **Policy entry channels** — upstream issue #799 is still deciding how approvals may persist (durable approval persistence is parked).
   Our §17-6 grant model must not pre-empt it.
5. **How do we pull upstream?**
   — **resolved:** `upstream` remote configured; rebase onto `upstream/main`, keep hub edits minimal and ledgered (D-02).
6. **Naming** — **resolved:** package `pi-permission-decisions-judge`, chain link `decisions-judge`
   (D-15).
7. **Where do the design docs live?**
   — **resolved:** in the package (D-15).
8. **Does a model `allow` create a durable grant?**
   — D-13 says non-persistent (per-call), but the hub already has a grant-scope dialog (ADR 0006) and upstream issue #799 is still deciding durable persistence.
   Don't invent a private grant model that a future upstream feature strands.
