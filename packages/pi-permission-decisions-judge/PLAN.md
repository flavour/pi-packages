# pi-permission-decisions-judge — PLAN

Future work for this package only.
Work already done — the fit-gap mining, the ecosystem rounds, the skeleton build — is in git history and in `docs/` (`analysis/`, `fit-gap.md`, `mined-assets.md`, `decisions.md`).

## Where the package stands

| State           | Detail                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Implemented     | the chain link, floor, state builder, endpoint client, aggregation, config load (`src/`, README source map)             |
| Green           | `pnpm --filter pi-permission-decisions-judge check test` — typecheck plus 70 tests, verified 2026-10-20                 |
| Exercised       | `pnpm live-check` drives the real link against the configured endpoint over the scenario table                          |
| Not done        | enabled in a live Pi session; breaker and in-flight limiting; startup chain report; calibration corpus; thresholds      |
| Shipped posture | `dryRun: true` by default and thresholds provisional (D-14) — the corpus that would justify other values does not exist |

Order matters: M0 unblocks issue filing and CI-scoped work, M2 makes the link safe to enable, M4/M5 are what let `dryRun` stop being the default.

## M0 — Monorepo onboarding

Blocks everything else: an issue about this package cannot be filed yet.

- [ ] Add `pi-permission-decisions-judge` to the `Package` dropdown in **both** `.github/ISSUE_TEMPLATE/bug_report.yml` and `.github/ISSUE_TEMPLATE/feature_request.yml`.
- [ ] Create the matching `pkg:pi-permission-decisions-judge` label, or confirm the repo files package issues some other way.
- [ ] Add the row to the root `README.md` Packages table.
- [ ] Write `.pi/skills/package-pi-permission-decisions-judge/SKILL.md` — architecture, priorities, testing context, and the upstream-assumptions table for the inference server (D-23, SPEC §17-9).
- [ ] Confirm `.pi/settings.json` loads the package and that a `private: true` package needs no npm mirror entry.
- [ ] **Settle the release question and record it.**
      D-11 says local-path install from the checkout, no npm publish; if that changes, the releasing skill's new-package checklist applies.
- [ ] Split `docs/decisions.md` into `docs/decisions/NNNN-<slug>.md` keeping the `D-NN` ids (D-15, amended by D-27), and **write the decisions `src/` cites that do not exist**: `src/` cites D-23, D-24, D-25 and D-26, and the file stops at D-16 plus D-27.

## M1 — the link (closed)

The skeleton exists and behaves as SPEC §4–§10 describe: floor and preconditions before any network call, one request per ask, min-rule aggregation, every failure path a `defer`.
It is the artefact SPEC v0.2 was rewritten against.

## M2 — failure policy under stress

Until this lands the link is not safe to enable outside `dryRun`: one dead endpoint currently means one connection attempt per ask, per tool call, in parallel batches included.

- [ ] Breaker: consecutive failures open it and short-circuit to `defer`; half-open after a cooldown.
      The mined constants are `breakerAfter: 3`, `cooldownMs: 60000` (`docs/mined-assets.md` §8, from `pi-jev-permit/src/config.ts:101-105`) — taken because two implementations shipped them, not because they were tuned here.
      The **unbreakable set** never depends on the circuit: the floor still runs when the circuit is **open**, so credential-path and protected-path shapes are never waved through because the endpoint happens to be down — the mined breaker keeps hard denies and deny rules running for the same reason.
- [ ] Treat a transport reset as a **breaker event, never a retry** — an over-limit request can kill the server, so retrying a reset is how one bad call takes the endpoint down for the whole session.
- [ ] Check request size **before** sending, conservatively, and learn the size ceiling from the endpoint at startup rather than hard-coding a number.
- [ ] In-flight limiting: a semaphore of one or two, so a parallel tool batch cannot stampede a single-throughput endpoint; identical sibling calls from one assistant message share one judgment.
      Both must be race-safe — tool calls in one message run in parallel (`docs/pi-api.md`).
- [ ] Retry policy: transient transport kinds only, never a size refusal; the operator-visible worst case is `timeoutMs × (1 + retries)`.
- [ ] Tests: every `EndpointError` kind → `defer` with its reason code; breaker open → no request at all; N sibling calls in one batch → bounded requests; over-budget state → no request.
- [ ] Land the mined pattern catalogues as **attributed regression fixtures** — `test/fixtures/` with a `// from <package> (MIT) <file>:<line>` header and an expected verdict, plus the `NOTICE.md` that comes with them (D-05 names `tests/fixtures/`; this package's convention is `test/fixtures/`).
      The literal patterns are recorded bypasses, not style, and they exercise the hub's parser as much as our floor.
- [ ] Keep the posture: `defer` stays the only unavailability mode, and no `failOpen` knob appears.
      The two mined precedents that ship one — `pi-jev-tool-guard`'s `evaluatorFailure: "allow"` and `r4vi/pi-auto-mode`'s `failOpen: true` — are cited there as the contrast that justifies our fail-to-human path (`docs/analysis/chain-links-and-rivals.md`).

## M3 — operator surface

The hub owns the UI and the log (D-01, D-08); what we owe is that enabling this link is a decision an operator can make from what they see.

- [ ] Startup chain report: is the link registered, is it named in `authorizerChain`, is its surface in `modelDelegation.allowedSurfaces`, and which other links are registered ahead of it (D-10)?
      A chain link that silently never runs is the failure mode that looks like "the judge is lenient".
      *Corrected 2026-11-04:* drop the `modelDelegation.allowedSurfaces` clause from this report — the hub never shipped that block (plan 0599 lists it as a Non-Goal; SPEC §5).
      The report answers: registered, named in `authorizerChain`, and which `surfaces` entries this link will actually match against the hub's stamped family.
- [ ] Surface-mismatch warning: registering on `path` or `external_directory` produces defers by the hub's bounded-delegation checkpoint (D-09), so it must be reported as no coverage rather than mistaken for it.
- [ ] Resolve the unwritten posture on an unparseable config file: today it is reported and treated as no config; decide whether that is loud enough, and test that it never silently disables a configured link.
- [ ] Generate the config JSON Schema from the zod source (`scripts/generate-schema.ts` → `schemas/*.schema.json`), the sibling packages' pattern (SPEC §17-7), and decide whether a pre-commit hook enforces regeneration.
- [ ] Decide whether this package ships any command at all, or whether every operator surface is the hub's settings.
      If it does, the candidate is a dry-run probe ("what would this call do?"), not a new approval widget.

## M4 — evaluation harness

The pattern is proven in this ecosystem: `@geohar/pi-permissions-analyzer` ships a dry-run prompt dump, a scenario override, and a log viewer.
This is the step that produces the corpus M5 needs, so it comes before it.

- [ ] Dry-run prompt dump: capture the exact state and question text a real session produced, keyed by `requestId`, model, build, `QUESTIONS_TEXT_VERSION`.
- [ ] Scenario override: replay a captured ask through the link with the config or question text changed, and diff the verdict.
- [ ] Log viewer: answer "did the judge run, did it reach the model, why did it defer" without reading raw JSONL.
- [ ] Regression guard: re-run the scenario table per model/build/text-version pair and report reading drift.
- [ ] Keep `test/fake_endpoint.py` as the offline endpoint mock for this package's client tests; assert its shapes against a live endpoint in the drift check, not in unit tests.

## M5 — corpus and thresholds (D-14)

The gate on removing `dryRun: true` as the shipped default.

- [ ] Collect a labelled corpus through the M4 dump: known-safe, known-unsafe, and the hard middle cases, each with the user prompt that authorized (or did not authorize) it.
- [ ] Key thresholds by the recorded profile — model, server build, criteria text revision — and refuse semantic judgments on an unrecognised model rather than apply another model's thresholds (D-23).
- [ ] Calibrate or drop the `exfiltration` veto: `src/questions.ts` records its wording as never measured, so it currently gates on text no threshold was taken against.
- [ ] Re-measure whenever `QUESTIONS_TEXT_VERSION` bumps; the readings belong to the exact instruction and criteria strings.
- [ ] Label every shipped threshold with its provenance in config and docs.
- [ ] Revisit aggregation once data exists (SPEC §17-2): min-rule vs band table.

## M6 — close the SPEC

- [ ] One `docs/decisions` entry per open question in SPEC §17, in that order: own-floor (1), aggregation shape (2), question set (3), new-surface default (4), `confidence` (5), grant model (6), schema (7), pinning (8), upstream assumptions (9), policy channels (10), rationale-to-agent (11).
- [ ] Make SPEC §15's dependency claim a **tested** range plus a startup version check (SPEC §17-8) — a breaking hub change currently arrives as a missing `PERMISSIONS_READY_CHANNEL` export and we degrade to "no service resolved" silently.
- [ ] Turn SPEC §16's acceptance criteria into named tests, one per criterion.
- [ ] Prior art still unread: `MasRii/pi-permission-system` (the hub's fork parent — needed before deciding how far to diverge), `@gotgenes/pi-permission-explain` (overlaps our rationale-to-agent design), `pi-rtk-optimizer` (the `rtk` wrapper `pi-jev-permit` had a compat test for).
- [ ] SPEC → v1.0 once §17 is empty.

## Standing rules

- Thresholds we ship must trace to a measurement on our pinned model and build; the calibration numbers recorded in `pi-jev-auto-mode` and `pi-jev-permit` are **not transferable** across endpoints — reuse their method, never their values.
- Never `pi install git:` on the monorepo root — it auto-loads every package in the repo (D-11).
