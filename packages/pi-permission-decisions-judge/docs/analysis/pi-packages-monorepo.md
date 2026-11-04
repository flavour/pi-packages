# Analysis — `~/code/pi-packages` (our fork) and the seam's own decision record

`origin = git@github.com:flavour/pi-packages.git`, HEAD `29a0da4e`, at upstream `pi-permission-system 40.2.1`.
**No `upstream` remote is configured** — pulling upstream means either GitHub's "Sync fork" button (which writes into `origin`) or adding the remote.
Decide which (see `docs/decisions.md` D-02).

## What the monorepo is

pnpm workspace, `packages/*`, root package `@gotgenes/pi-packages` **`private: true`**, no `pi` field.
Nine packages: `pi-autoformat`, `pi-colgrep`, `pi-github-tools`, `pi-nocd`, `pi-permission-model-judge`, `pi-permission-system`, `pi-session-tools`, `pi-subagents`, `pi-subagents-worktrees`.

`pnpm-workspace.yaml` matters: `linkWorkspacePackages: false`, with the reason written out — "pi-subagents-* extension packages consume their siblings from the npm registry (the published tarball ships the bundled `dist/public.d.ts`), not via workspace symlinks — a symlinked sibling would resolve `exports.types` to the gitignored, unbuilt `dist` on a fresh checkout.
Cross-package links must opt in explicitly with the `workspace:` protocol."
Plus a `catalog:` for shared versions, `allowBuilds` (including `tree-sitter-bash: true`), `minimumReleaseAge` supply-chain policy and `trustLockfile`.

Tooling: **pnpm only, never npm/npx**.
`biome` + `eslint` + `rumdl` (markdown lint, pinned to 0.2.24 with a measured reason in a workspace comment) + two custom lint scripts (`invisible-characters.mjs`, `unicode-escapes.mjs`).
`prek` hooks: `committed` rejects a malformed Conventional Commits header; pre-commit rejects stray invisible characters and literal Unicode escapes in prose.
`mise.toml` for tool versions, `cliff.toml` for changelogs, `vitest` everywhere, `tsconfig.base.json`.

## The workflow we would be joining (root `AGENTS.md`, 156 lines)

Issue-driven, staged, with per-stage sessions: `/plan-issue #N` → `/tdd-plan` or `/build-plan` → automatic `pre-completion-reviewer` subagent → `/ship #N` (verifies CI, closes issue, dispatches release) → `/retro`.
Plans and retro notes are committed (`docs/plans/`, `docs/retro/NNNN-<slug>.md`) and the retro file is the cross-session context bridge.
Worktrees per issue, `main` kept linear by rebasing.

Six stated principles, each of which reads like a rule we should adopt verbatim:

1. **Verify against the real surface, not the document about it** — `--help`, the compiled `.js`,
   `pnpm view <pkg> versions` before a fact lands in a gate, a dependency floor, or a security boundary.
2. **State what you checked, not what you conclude.**
3. **Provenance belongs in git.**
4. **A number a command can produce is never authored** — run the command, write what it printed.
5. **Mechanism is forever; docs are reversible** — prefer a config pattern over a new runtime mechanism.
6. **Keep scope tight** — small reversible changes; **ask before removing functionality or changing
   defaults**.

There is a skill per package (`package-<name>`, 27–339 lines) and an index table of "before you do X, load skill Y".
Our package would need `package-pi-permission-decisions-judge`.

**The `upstream-assumptions` table is the pattern worth stealing.**
`model-judge`'s skill carries a watchlist: every assumption it makes about Pi internals, the upstream file, and *how it breaks* (`behavioral-silent` / `compile-time` / `coverage-gap`), e.g. "`Model.api` decides the forced `toolChoice` spelling … breaks as behavioral-silent: a wrong spelling degrades to `auto` and the model answers in prose".
We need the same table for **llama.cpp**: `can_share_prompt()` including `LFM2_D1`, `n_prompt_tokens_cache = n_tokens_shared` for a child, the `n_ubatch` assert for non-causal models, `usage.input_tokens` accounting — each with the source file and how it breaks us.

## Adding a package (`.pi/skills/releasing` §"Adding a new package")

1. `.pi/settings.json` — add the `../packages/<pkg>` load path; add the
   `{ "source": "npm:@gotgenes/<pkg>", "extensions": [], "skills": [] }` disable entry **only after the
   first npm publish** (before that, an `npm:` reference makes Pi `npm install` a nonexistent package).
2. Root `README.md` — the Packages table, and the no-dedicated-skill note unless we ship a skill.
3. `.github/ISSUE_TEMPLATE/{bug_report,feature_request}.yml` — add the package to the `Package`
   dropdown in **both** forms; it is `required: true` and `blank_issues_enabled: false`, so a package
   missing there **cannot be reported at all**.
4. Package-list scripts (`scripts/release/lib.sh`, `scripts/issue-package-labels.sh`) enumerate
   `packages/*/package.json`, so they need no edit.
5. First release is manual (npm Trusted Publishing cannot create a package): `pnpm login`, `pnpm --filter @gotgenes/<pkg> publish --access public --no-git-checks`, tag `<pkg>-v<version>`, then configure the Trusted Publisher.
   **We are not publishing to npm**, so this whole branch is inert for us — which is exactly why distribution needs its own decision (D-11).

Package layout, copied from `pi-permission-model-judge`: `src/ test/ config/ schemas/ scripts/ docs/ README.md AGENTS.md CHANGELOG.md LICENSE biome.json tsconfig.json vitest.config.ts package.json`, with `pi: { "extensions": ["./src/index.ts"] }` (runs from TS via jiti, no build step), `zod` as a runtime dep, and peer deps `@earendil-works/pi-ai >=0.84.3`, `@earendil-works/pi-coding-agent >=0.84.3`, `@gotgenes/pi-permission-system >=27.0.0`.
Scripts: `check` (`tsc --noEmit`), `test` (`vitest run`), `gen:schema` (zod → `schemas/*.schema.json`), `lint` (biome + eslint + `rumdl check *.md docs/**/*.md`).

## What ADR 0007 says (the seam's own record, 257 lines, local at last)

`packages/pi-permission-system/docs/decisions/` holds 15 numbered ADRs; 0007 is `model-judge-authorizer-chain-adr.md`.
Four things in it change our design:

**a. `modelDelegation` is an operator-facing config in the hub**, not just the cap:

```jsonc
{ "authorizerChain": ["model-judge"],
  "modelDelegation": { "allowedSurfaces": ["bash"], "excludedSurfaces": ["external_directory"] } }
```

plus "secret-shaped path always excluded" — hardcoded, not configurable.
So the coverage knob (D-04) has a documented shape, and the surface scoping we wanted is a config line, not a feature.

> **Corrected 2026-11-04:** that is what ADR 0007 §5 *proposes*; the hub never shipped it.
> Hub plan `docs/plans/0599-register-authorizer-seam.md:42` lists a configurable `modelDelegation` block as an explicit Non-Goal, and the string is absent from the hub's config schema at 42.0.0.
> The surface scoping is therefore **our** feature, not a config line — which is why this package has a `surfaces` list and why D-04's scoping stays ours to build.

**b.**
**The config split is deliberate**: "This package declares and *enforces* the safety policy; the downstream extension declares and *uses* the model mechanism."
Two independent config files joined only by the link name, no merged schema.
And: "This package holds no model-prompt config it does not read."
Our endpoint/thresholds/questions live in **our** config file; we must not ask them to hold it.

**c.**
**Two slices, a capability gradient** — and their posture is that an allow-capable judge is *not* the default:

|              | Slice 1 — deny-first reviewer                                  | Slice 2 — allow-capable adjudicator                                                                                       |
| ------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Verdicts     | `deny`, `defer`                                                | `+ allow`                                                                                                                 |
| Risk         | strictly more restrictive — always safe                        | loosens privilege — needs full envelope                                                                                   |
| Envelope     | fail-closed only (unreachable/uncertain → defer)               | + hard exclusions, audit `origin:"authorizer:model"`, **non-persistence**, **off by default**, bounded-delegation ruleset |
| Failure mode | a wrong deny — recoverable (agent self-corrects on the reason) | **decomposition infidelity** — mis-split obfuscation (`bash -c "safe; evil"`) allowed on the safe piece alone             |

Their safety property: "a tool-augmented model can never grant more than the engine grants for the pieces it identifies" — and it "holds *only if decomposition is faithful*.
Obfuscation is the residual risk, and it is exactly why slice 2 is gated behind the whole envelope while slice 1 needs almost none.
The gradient is the argument for shipping deny-first."

**d.**
**Accepted limitations** name our scope as deliberately open: "Model provider, prompt, **confidence threshold**, and timeout are deliberately left to [#472] and the downstream package — they are tuning and mechanism, not architecture."
Also open upstream: terminal-replacement registration ("registering a backend *as* the terminal authority … built when a real non-subagent backend needs it — not now"), and a pre-`evaluate()` non-deterministic access-intent classifier, which "warrants its own decision record".

## `model-judge` as our README/skill template

Its "How it works" is a numbered gate list where every step says *(otherwise defer)*, and it **never calls the model unless a cheap deterministic pre-filter matched** (`typoPatterns`).
"It is fail-safe by construction: a missing model, invalid config, model timeout, unparseable reply, or an unsure verdict all resolve to `defer`."
It "emits no `allow`".
And "What it records" is a table of fields keyed by `requestId`, so you can answer "did the judge run, did it reach the model, and why did it defer?"
without guesswork.
Copy that structure.

Nobody in this repo contemplates a local decision endpoint — the only "local model" mention in the hub's docs is a prompt-caching anecdote (8 333 shared tokens ≈ 40 s of prompt processing).
Our package is novel inside this ecosystem.

## Distribution: `pi install git:` cannot target a monorepo subpackage

From Pi's source (`/home/fran/code/pi`, `5ab7fe74c`):

- `parseGitUrl` → `buildGitSource` accepts `host/user/project` plus an optional `#ref`
  (`packages/coding-agent/src/utils/git.ts:104-124`); the path may contain slashes but the clone is the
  **repository**, not a subdirectory.
- `installGit` clones `source.repo` into `<gitInstallRoot>/<host>/<path>` and runs the dependency
  install **at the clone root** (`core/package-manager.ts:1897-1927`).
- Resource discovery then runs over the whole clone: `collectAutoExtensionEntries` first tries the root
  `package.json`'s `pi.extensions` — our root is `private: true` with no `pi` field — and otherwise
  **walks the tree and resolves every subdirectory that has extension entries**
  (`package-manager.ts:599-648`).

So `pi install git:github.com/flavour/pi-packages` would clone the monorepo and auto-discover **all nine packages' extensions** — `pi-autoformat`, `pi-github-tools`, `pi-subagents`, … — and any package upstream adds later would auto-load on our next pull.
Suppressing them requires a disable entry per source in `.pi/settings.json`, i.e. a deny list that has to be updated whenever upstream grows.
See D-11.
