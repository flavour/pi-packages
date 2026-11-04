# pi-permission-decisions-judge

A [`pi-permission-system`](../pi-permission-system/) **Authorizer chain link** that answers an `ask` with per-question probability readings from a **`/v1/systemone` decision endpoint**, instead of asking a hosted chat model for one verdict.

**Status: working skeleton (2026-10-15).**
The link is implemented and unit-tested, and it runs end to end against the live endpoint (`pnpm live-check`).
It is **not yet enabled in a live Pi session** — that needs the two config edits below.
The schema default for `dryRun` is `false` (`src/config.ts`), so a trial sets it to `true` explicitly until a corpus justifies the thresholds (D-14).

## What it does

`pi-permission-system` decides `allow` / `deny` / `ask` deterministically.
When a request lands on `ask`, the authorizer chain decides who answers it; by default that is a human.
This package registers a link named **`decisions-judge`** that reads the ask, builds a bounded state (`limits.maxStateTokens`, default 320 estimated tokens), asks the endpoint four `noul` questions — three scored, one veto (D-24) — and returns `allow`, `deny` (with a teaching reason), or `defer` to the rest of the chain.

Order of the decision (D-13): deterministic refusals first, then the endpoint, then the min-rule.
Every failure path — no config, surface out of scope, no command visible, opaque wrapper, state over budget, endpoint down, unparseable answer — resolves to `defer`.
This link never invents policy and never denies on a technicality.

**It emits no rules and enforces no policy of the hub's:** the deterministic layer stays the policy owner, and the chain owner's bounded-delegation checkpoint downgrades an `allow` on a `path`-family or `external_directory`-family ask to `defer` regardless of what this package decides — the one exception is an `external_directory` bash ask carrying the `nothing-on-disk` license its gate computed, which the hub honors and logs.

## Enabling it

Two deliberate edits enable it, one in `pi-permission-system`'s config and one in this package's own config:

```jsonc
{ "authorizerChain": ["decisions-judge"] }
```

Naming the link is what grants it authority; installing the package grants nothing.

Endpoint, model, thresholds and question set live in **this** package's own config file, not theirs (`docs/decisions.md` D-01, D-04).
Config is read from `<agentDir>/extensions/pi-permission-decisions-judge/config.json` and `<cwd>/.pi/extensions/pi-permission-decisions-judge/config.json` (project over global) — the same layout the hub and `pi-permission-model-judge` read, so one `.pi/extensions/` directory holds a repository's whole permission layer.
The project file is read only on a trusted project: it chooses the endpoint that receives your prompt and the command under judgment, and `thresholds.allow` decides when that endpoint's reading becomes an `allow`.
An untrusted checkout gets no vote, and the skipped path is reported at session start.
No config file at all means the operator is declining the link and nothing registers — see `config/config.example.json`.

The hub bounds which surfaces a link may judge with a hard-coded checkpoint, not a config key: a link's `allow` on an `external_directory` or `path` ask is downgraded to `defer`, so this link can only ever rule a bash-shaped non-path ask.
A configurable surface list is not in the hub today, and hub plan `docs/plans/0599-register-authorizer-seam.md` lists it as a Non-Goal, so do not add such a key to a config file.
The hub's config schema is strict, so an unknown key rejects the whole scope config fail-closed and leaves every ask unpolicied.

## Running it

```bash
pnpm install                                                   # repo root
pnpm --filter pi-permission-decisions-judge check test         # typecheck + unit tests
pnpm --filter pi-permission-decisions-judge live-check         # real endpoint, fixed scenarios
pnpm --filter pi-permission-decisions-judge live-check -- --dry-run
```

`live-check` drives the real link (same code path a session uses) against the endpoint in the example config and prints each reading, the verdict, and whether it drifted from what the scenario expects.
It is not a test — it is how the question set and thresholds get reviewed.
The scenarios in `scripts/live-check.ts` cover ordinary work (`npm test`, a scoped build-directory delete, an install), an out-of-band push, a secret read, and the deterministic refusals (`sudo …`, `bash -c "…"`, `git reset --hard …`); the expected verdict for each is declared in the scenario table, so a drift is one glance.

## Source map

| File               | Role                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------- |
| `src/extension.ts` | Pi wiring: config load, latest user prompt capture, register from `permissions:ready` |
| `src/judge.ts`     | the `authorize` callback — the order described above                                  |
| `src/floor.ts`     | never-allow shapes and opaque-wrapper shapes (D-16, D-25)                             |
| `src/state.ts`     | state builder, budget ladder, outbound secret-shape masking                           |
| `src/questions.ts` | the four `noul` questions; the strings **are** the calibration surface                |
| `src/systemone.ts` | the only place that touches the network                                               |
| `src/aggregate.ts` | min-rule with named vetoes (D-24)                                                     |
| `src/config.ts`    | zod config + load/merge/validate                                                      |

## Install

Local-path install from this workspace checkout — **not** `pi install git:` on the repository root, which would auto-load every package in the monorepo:

```bash
pi install ./packages/pi-permission-decisions-judge
```

## Where things are

| Path                                      | What                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `SPEC.md`                                 | the specification of this link                                                                          |
| `PLAN.md`                                 | future work for this link                                                                               |
| `docs/decisions.md`                       | the settled architecture decisions (D-01…D-16, D-27)                                                    |
| `docs/analysis/`                          | one file per prior project mined, including `pi-permission-system-hub.md` and `pi-packages-monorepo.md` |
| `docs/fit-gap.md`, `docs/mined-assets.md` | what prior art covers, what it does not, and verbatim material                                          |
| `docs/systemone-contract.md`              | the `/v1/systemone` interface we implement, and what the client must defend against                     |
| `docs/pi-api.md`                          | Pi 1.2.0 extension-API facts and four SPEC corrections                                                  |
| `test/fake_endpoint.py`                   | offline decision-endpoint mock (behaviour modelled on llama.cpp b11606 + vllm-d3)                       |
| `config/`, `src/`, `test/`, `scripts/`    | the implemented link (see the source map above)                                                         |

## Prior art

Five local projects (`pi-jev-auto-mode`, `pi-jev-permit`, `pi-jev-tool-guard`, `pi-auto-permissions`, `pi-auto-permission-gate`) and the published Pi permission ecosystem (`@mzwing/pi-permission-auto-review`, `pi-permission-classifier`, `@gotgenes/pi-permission-model-judge`, `@geohar/pi-permissions-analyzer`, `pi-jev`, `pi-auto-mode` by `r4vi` — unrelated to this package despite the name).
All MIT; mined catalogues are kept as attributed test fixtures, not vendored code (D-05).
