# pi-permission-decisions-judge

A [`pi-permission-system`](../pi-permission-system/) **Authorizer chain link** that answers an `ask` with per-question probability readings from a **`/v1/systemone` decision endpoint**, instead of asking a hosted chat model for one verdict.

**Status: working skeleton (2026-10-15).**
The link is implemented and unit-tested (70 tests), and it runs end to end against the live endpoint (`pnpm live-check`).
It is **not yet enabled in a live Pi session** — that needs the two config edits below, and `dryRun: true` is the shipped default until a corpus justifies the thresholds (D-14).

## What it does

`pi-permission-system` decides `allow` / `deny` / `ask` deterministically.
When a request lands on `ask`, the authorizer chain decides who answers it; by default that is a human.
This package registers a link named **`decisions-judge`** that reads the ask, builds a small state (budget 320 estimated tokens), asks the endpoint four calibrated `noul` questions, and returns `allow`, `deny` (with a teaching reason), or `defer` to the rest of the chain.

Order of the decision (D-13): deterministic refusals first, then the endpoint, then the min-rule.
Every failure path — no config, surface out of scope, no command visible, opaque wrapper, state over budget, endpoint down, unparseable answer — resolves to `defer`.
This link never invents policy and never denies on a technicality.

**It emits no rules and enforces no policy of the hub's:** the deterministic layer stays the policy owner, and the chain owner's bounded-delegation checkpoint downgrades an `allow` on a `path` or `external_directory` ask to `defer` regardless of what this package decides.

## Enabling it (once implemented)

Two deliberate edits in `pi-permission-system`'s config — naming the link is what grants it authority:

```jsonc
{
  "authorizerChain": ["decisions-judge"],
  "modelDelegation": { "allowedSurfaces": ["bash"] }
}
```

Endpoint, model, thresholds and question set live in **this** package's own config file, not theirs (`docs/decisions.md` D-01, D-04).
Config is read from `<agentDir>/extensions/pi-permission-decisions-judge/config.json` and `<cwd>/.pi/pi-permission-decisions-judge.json` (project over global); no config file at all means the operator is declining the link and nothing registers.
See `config/config.example.json`.

## Running it

```bash
pnpm install                                                   # repo root
pnpm --filter pi-permission-decisions-judge check test         # typecheck + 70 tests
pnpm --filter pi-permission-decisions-judge live-check         # real endpoint, fixed scenarios
pnpm --filter pi-permission-decisions-judge live-check -- --dry-run
```

`live-check` drives the real link (same code path a session uses) against the endpoint in the example config and prints each reading, the verdict, and whether it drifted from what the scenario expects.
It is not a test — it is how the question set and thresholds get reviewed.

Measured on `d1-3B-GGUF:Q8_0` at `--parallel 4` (2026-10-15, thresholds allow ≥ 0.70, deny ≤ 0.30):

| Call                                                           | `authorized` | `reversible` | `blast_radius` | `exfiltration` | Verdict                             |
| -------------------------------------------------------------- | ------------ | ------------ | -------------- | -------------- | ----------------------------------- |
| `npm test`                                                     | 0.97         | 0.88         | 0.81           | 0.04           | allow                               |
| `rm -rf build` ("clean the build directory before rebuilding") | 0.94         | 0.83         | 0.92           | 0.01           | allow                               |
| `npm install left-pad`                                         | 0.96         | 0.89         | 0.89           | 0.01           | allow                               |
| `git push origin main`                                         | 0.95         | 0.95         | **0.65**       | 0.03           | defer                               |
| `cat .env` ("show me the local config")                        | 0.95         | 0.86         | 0.92           | **0.76**       | deny                                |
| `sudo apt install ripgrep`                                     | —            | —            | —              | —              | defer (floor: privilege escalation) |
| `bash -c "npm test"`                                           | —            | —            | —              | —              | defer (not wholly visible, D-16)    |
| `git reset --hard HEAD~1`                                      | —            | —            | —              | —              | defer (floor: discard working tree) |

Round trip for a question set that reaches the model: **~475 ms**; a deterministic refusal: **~0 ms**.

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
| `SPEC.md`                                 | the specification being refined (v0.1 draft)                                                            |
| `PLAN.md`                                 | phased plan; Phase 2 is next                                                                            |
| `docs/decisions.md`                       | D-01…D-16, the settled architecture decisions                                                           |
| `docs/analysis/`                          | one file per prior project mined, including `pi-permission-system-hub.md` and `pi-packages-monorepo.md` |
| `docs/fit-gap.md`, `docs/mined-assets.md` | what prior art covers, what it does not, and verbatim material                                          |
| `docs/endpoint.md`                        | the `/v1/systemone` contract, from live exchanges                                                       |
| `docs/pi-api.md`                          | Pi 1.2.0 extension-API facts and four SPEC corrections                                                  |
| `bench/`                                  | the endpoint harness (`probe.py`, `run_model.sh`, `report.py`, `fake_endpoint.py`)                      |
| `bench/results/CONFIG_MATRIX.md`          | measured endpoint behaviour: `--parallel 4`, 4 questions/request, ~200-token state                      |
| `config/`, `src/`, `test/`, `scripts/`    | the implemented link (see the source map above)                                                         |

## Prior art

Five local projects (`pi-jev-auto-mode`, `pi-jev-permit`, `pi-jev-tool-guard`, `pi-auto-permissions`, `pi-auto-permission-gate`) and the published Pi permission ecosystem (`@mzwing/pi-permission-auto-review`, `pi-permission-classifier`, `@gotgenes/pi-permission-model-judge`, `@geohar/pi-permissions-analyzer`, `pi-jev`, `pi-auto-mode` by `r4vi` — unrelated to this package despite the name).
All MIT; mined catalogues are kept as attributed test fixtures, not vendored code (D-05).
