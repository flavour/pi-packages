# Analysis — the chain links and the rivals (skim pass)

Tarballs in `/tmp/eco`.
Full treatment for the hub in `pi-permission-system-hub.md`; this file is the rest of the field, one section per package, only what changes our SPEC.

---

## `@mzwing/pi-permission-auto-review` — the closest rival (1 489 LOC, v0.9.1, MIT)

> "adds Codex-style automatic permission reviews to `@gotgenes/pi-permission-system`.
> Each ask is judged by OpenAI's `codex-auto-review` model against a bundled adaptation of the OpenAI Codex Guardian policy; **whatever it cannot decide falls through to the normal prompt**."

Registers the link named `auto-review`; the operator adds `"authorizerChain": ["auto-review"]`.
Pins the hub to **37.x – 40.x** (the local pinning convention).
Requires Pi ≥ 1.2.0.

Config: `{provider, model, reasoning: off…max, timeoutMs, includeBaselinePolicy, additionalPolicy?}`.
Defaults: `openai-codex` / `codex-auto-review` / `reasoning: low` / **`timeoutMs: 90000`** (total budget across retries).
`/permission-auto-review` edits config interactively and applies it **without reloading the session**; subcommands `show path reset [global|project] help`.
The footer shows whether the reviewer is registered and **how many asks it allowed / denied / deferred** this session.

From the published `.d.ts` (the tarball ships only bundled JS + declarations, no sources):

- `POLICY_REVISION: string` and `FIXED_REVIEW_PROTOCOL: string` — the policy is **versioned**, and the protocol wrapper is separate from the policy text.
  Matches our "versioned criteria" idea; we should carry a `criteriaRevision` into every decision record.
- Trust-aware transcript selection: *"Keeps the first and latest trusted records unconditionally, then other trusted records newest first, then the newest untrusted ones; the untrusted cap never evicts an authorization that was already selected."* plus a `TranscriptStats` struct counting retained / omitted / truncated per class (`directUserEntries…`, `userInteractionEntries…`, `latestTrustedEntryRetained`).
  **This is the state builder we need**, and the stats are what make a truncation decision auditable instead of silent.
- `findToolCallInput(sessionEntries, toolCallId)` — *"The complete structured arguments of the assistant tool call that raised an ask, which the ask itself only previews."* **Fact: the ask gives a preview only.**
  Anything that judges content must recover the real arguments from session entries.
  Our five mined projects never noticed this.
- `buildReviewPrompt` doc: *"The request is never truncated: a reviewer must not approve an action it saw only in part."*
  Truncation is allowed for the transcript, never for the thing being decided.
  This directly contradicts `pi-jev-tool-guard`'s `fitState` ladder (which truncates the call itself) and our SPEC §10 budget ladder.
- Verdict shape: `{riskLevel: low|medium|high|critical, userAuthorization: unknown|low|medium|high,
  outcome: allow|deny, rationale}` — the Codex two-axis model, four levels each, parsed from a chat
  completion.

**What it does not do:** no local endpoint, no probabilities, no thresholds, no calibration, no per-question evidence.
It asks one trained-for-this model for one verdict.
That is the axis our design differs on — and it is the design a reviewer will ask us to justify against.

---

## `@gotgenes/pi-permission-model-judge` — the first-party link (v3.0.0)

"reviews `external_directory` asks and auto-denies mistyped paths with a corrective reason."
Read together with the bounded-delegation cap (a link's `allow` on `path`/`external_directory` is downgraded to `defer`), the shape is forced: **a path judge can only ever deny.**
That is why the first-party link is deny-only and why its teaching reason is its main output.
Worth copying the teaching-reason discipline; nothing else in the field does it well.

---

## `pi-permission-classifier` — 2 522 LOC, v0.5.2

Registers the link `classifier`: "a light model reviews each permission `ask` and returns allow, deny, or defer, so clearly benign requests are approved automatically, clearly bad ones are rejected with a short teaching reason, and only genuinely uncertain ones reach you.
Think of it as a Claude-Code-style auto-approve mode, without giving up the permission gate: your deterministic policy still runs first."

Same pitch as ours, hosted light model.
Full treatment deferred; the interesting question is how it decides *when to defer* — that is the middle band we still have to design.

---

## `@geohar/pi-permissions-analyzer` — 918 LOC, v0.3.1 — **the eval-harness pattern**

> "analyzes and probes the auto-review classifier **in isolation** — for validating `additionalPolicy` rules, inspecting prompt construction, and testing model verdicts without going through the full permission gate."

1. **Dry run** — "build the exact prompt the classifier would receive and inspect it, without calling any model (zero cost)". 2.
   **Live call** — send it, see the verdict. 3.
   **Custom scenarios** — override the permission-request fields to test specific commands/paths/surfaces. 4.
   **Log viewer** — inspect real decisions from the review log.

This is our `bench/probe.py` + `replay` idea, already built for a different link.
Our Phase 3 eval harness should copy this shape (dry-run prompt dump, scenario override, log viewer) and probably reuse their vocabulary so a user can point the analyzer at our link later.

---

## `pi-safety-guards` — 1 666 LOC, v1.0.2

"Bash safety rules for Pi: rules live in the configuration file, with per-rule actions, messages and custom matchers."
A rival L1/L2 that overlaps the hub's `bash` surface.
Redundant once we depend on the hub; note only that it exposes **custom matchers** (user-supplied predicates), which the hub does not.

---

## `pi-auto-mode` (r4vi) — 1 171 LOC, v0.1.3 — **our name, live on npm since 2026-10-04**

"A pi extension that re-implements Claude Code style auto mode with a two-stage tool-call classifier."
Config: `{enabled, classifierModel: "github-copilot/gpt-5.4-mini", failOpen: true, maxConsecutiveDenials: 3, …}`.
Standalone — it does not use the hub; it ships its own `approval-server.mjs` (HTTP queue, random 24-byte bearer session token) and its own browser queue.

Notable mechanics: `MAX_CONSECUTIVE_DENIALS = 3` / `MAX_TOTAL_DENIALS = 20` → **lockdown**; `CRITICAL_REASONS = {"sudo", "cloud or infrastructure change", "disk shred/wipe", "partition editor"}`; hard-deny patterns include writes to shell startup files, `authorized_keys` injection, cron mutation, TLS-weakening flags; `NO_RETRY_NOTICE` = "Do not retry this action in another form (rewording, splitting, scripts, or other tools).
If the task needs it, tell the user why in plain text and wait."; classifier prompt built from command + reasons + cwd + git branch + user preferences + history.

**`failOpen: true` by default** is the opposite of the hub's fail-closed stance — a useful contrast to cite when we justify our own unavailable-path behaviour.

---

## `pi-jev` — 2 786 LOC, v0.7.0 — **the only other local-endpoint System One user**

`src/jev.ts` resolves `PI_JEV_BASE_URL` (README: `export PI_JEV_BASE_URL=http://localhost:8000`) and `PI_JEV_API_KEY`, uses `@typesafe-ai/sdk`, and calls `client.systemOne({...})` with `noul` questions (`src/gate.ts:151`).
Ships `bin/jev-gate-runner.ts` — the gate runs as a **separate process**.
Also carries `router.ts`, `model-router.ts`, `orchestrator.ts`, `skills.ts`, `thinking.ts`, `designer.ts`, `tool-guard.ts`: semantic tool routing plus model switching bundled with the gate.

This is the closest thing to our endpoint idea, and it is *not* built on the hub, so it duplicates the deterministic layer.
Its questions are uncalibrated and its state shape is undocumented.
Our differentiator against it: hub integration (no duplicated gate), calibration data, and a pinned model with a measured envelope.

---

## Not yet examined

- `MasRii/pi-permission-system` — the fork parent; needed before we decide how far to diverge.
- `@gotgenes/pi-permission-ai-guard`, `-bash-cmd-checker`, `-explain` — more links; `-explain` is the
  one that overlaps our rationale-to-agent design.
- `@bismawy/pi-jev-eye`, `pi-jev-guard`, `@riposta/pi-jev` — jev-branded guards, probably hosted.
- `@casualjim/pi-heimdall`, `@firstpick/pi-extension-safety-guard`, `cc-safety-net`, `@hasna/hooks`,
  `pi-auto-approve`, `@agentapprove/pi` — standalone guards, superseded by the hub dependency.
- `pi-rtk-optimizer` — the `rtk` command wrapper `pi-jev-permit` had a compat test for; still unknown.
