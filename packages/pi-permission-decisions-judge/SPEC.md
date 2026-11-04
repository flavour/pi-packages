# pi-permission-decisions-judge — SPEC

Status: **draft v0.2** — scoped to the authorizer-chain link. §§5, 8, 11 and 12 are what this package **depends on**, not what it implements.
The `/v1/systemone` interface is in [`docs/systemone-contract.md`](docs/systemone-contract.md).

## 1. Purpose

`@gotgenes/pi-permission-system` decides `allow` / `deny` / `ask` deterministically.
When a request lands on `ask`, the authorizer chain decides who answers it; by default that is a human.

This package registers one chain link, **`decisions-judge`**, that answers an `ask` with **per-question probability readings** from a `/v1/systemone` decision endpoint instead of asking a hosted chat model for one verdict.
It returns `allow`, `deny` (with a teaching reason the agent sees), or `defer` — which hands the ask to the next link, and ultimately to the human.

What this package owns:

- the **state builder** — what the endpoint is shown, in what size, with what masked;
- the **question set** and its text versioning — the calibration surface;
- the **endpoint client** — one request per ask, typed failure kinds;
- **aggregation** — N readings → one verdict (D-24);
- the **never-allow floor** and the whole-call-visible precondition (D-16, D-25).

What it does not own: policy.
It emits no rules, enforces no policy of the hub's, and never denies on a technicality.

## 2. Non-goals

- **Not a deterministic gate.**
  Hard blocks, user allow/deny rules, the read-only fast path, dangerous-shape detection, protected paths and path resolution are the hub's (D-01).
  Re-implementing them here would create a second policy engine with its own bypasses (D-01).
- **Not a policy author.**
  The model judges; it does not write rules, and nothing an `ask` produces becomes a durable rule from this package (see §17-6).
- **Not an approval UI.**
  The hub prompts; we do not (D-01).
- **Not a sandbox, shell parser, or syscall filter.**
  We parse nothing for enforcement — see §8 for what we refuse to judge instead.
- **Not a hosted-chat reviewer.**
  One verdict from a chat model has no reading, no band, and no reproducible calibration; four `noul` questions do (`docs/analysis/chain-links-and-rivals.md`).
- **Not a multi-agent or per-user authorization system.**

## 3. Terminology

| Term              | Meaning                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ask**           | The permission question the hub raises (`PromptPermissionDetails`), with a `requestId` and a gate family.                                                                                                                                                                                                                 |
| **gate family**   | What kind of ask it is, as the hub stamps it: `accessIntent.surface` — `bash`, `tool`, `path`, `external_directory`, a directional member, a tool name. Our `surfaces` config lists these. A forwarded ask also carries a *display* surface (the child's tool name), which is not the family and must not be read as one. |
| **link**          | An `authorize` callback registered with the hub's `authorizerChain`.                                                                                                                                                                                                                                                      |
| **verdict**       | `allow` · `deny(reason)` · `defer` — the three things a link may answer an ask with.                                                                                                                                                                                                                                      |
| **reading**       | One per-question probability returned by the decision model.                                                                                                                                                                                                                                                              |
| **scored / veto** | A scored question combines in the min-rule; a veto question can block an `allow` alone (D-24).                                                                                                                                                                                                                            |
| **polarity**      | Whether a high reading is safe or unsafe, declared per question (`unsafeWhenHigh`).                                                                                                                                                                                                                                       |
| **floor**         | A shape this link refuses to **approve**, whatever the model reads (D-25).                                                                                                                                                                                                                                                |
| **opaque shape**  | A call whose full effect is not visible in the command text, so no reading about it is trustworthy.                                                                                                                                                                                                                       |
| **state**         | The `{value, context}` object sent with the questions — the cost driver of a request.                                                                                                                                                                                                                                     |
| **dry run**       | Run the whole pipeline, log the readings and the would-be verdict, then `defer`.                                                                                                                                                                                                                                          |
| **text version**  | The revision stamp of the question and criteria strings; readings belong to a version.                                                                                                                                                                                                                                    |

## 4. Where the link sits

```text
tool / bash / MCP / path / external_directory request
  │
  ├─ hub deterministic layers            allow · deny · ask   (not ours)
  │     parse bash, fail closed on unparseable input and on
  │     indirection wrappers, resolve paths, check protected paths
  │
  └─ ask → authorizerChain (config order)
             │
             ├─ decisions-judge (this package)
             │     ├─ floor: never-allow shapes, opaque shapes      → defer
             │     ├─ precondition: command visible whole, in budget → defer
             │     ├─ one endpoint request, four noul questions      → defer on any failure
             │     └─ min-rule with named vetoes                    → allow · deny · defer
             │
             ├─ other links (auto-review, model-judge, …)
             └─ terminal: the human (or the hub's headless policy)
```

Ordering rules (D-13):

- **The deterministic floor runs before the endpoint.**
  A floor hit costs no network call and produces `defer`, never `deny` — denial is the hub's.
- **The endpoint never sees a call we cannot see whole** (D-16).
  An opaque wrapper, a missing command, or a call that will not fit the state budget defers before any request.
- **Absence of an answer is never consent.**
  A missing answer, a malformed response, a timeout, an unreachable endpoint, an over-budget state, or no config all resolve to `defer`.
- **An `allow` is not a grant.**
  The hub's bounded-delegation checkpoint downgrades a link's `allow` on a `path` or `external_directory` ask to `defer` regardless of what we decided (D-09), and an `allow` never widens what a later call may do.
- **Registration grants no authority.**
  The operator names this link in `authorizerChain` (hub ADR 0007 §4); installing the package does nothing on its own.

## 5. What the hub already does

Everything before this link is the hub's: user `allow`/`deny` rules, hard blocks, dangerous-shape detection, the read-only fast path, bash segmentation and wrapper policy, protected paths, the ASK UI and its review log.
Most ordinary calls never reach this link, and that is the point of D-01.

One hub mechanism bounds what this link can decide:

- **Bounded delegation** (`delegation-envelope.ts`, in the hub since 20.9.0) — an `allow` we return on a `path`-family or `external_directory`-family ask is downgraded to `defer`, on the family named by `accessIntent.surface`.
  One exception: an `external_directory`-family bash ask carrying `accessIntent.delegationLicense: "nothing-on-disk"` — a fact the asking gate computed, not us — is honored, and the hub logs it as `authorizer_allow_licensed`.

There is no hub-side surface allowlist for model judgment.
A `modelDelegation.allowedSurfaces` / `excludedSurfaces` knob is proposed in hub ADR 0007 §5 and listed as a Non-Goal of plan 0599, so it is not in the shipped config schema at hub 42.0.0; nothing here may assume it.
What the operator controls today is `authorizerChain` (hub config-schema `authorizerChain: string[]`), which decides whether this link is consulted at all.

`OPEN` (§17-1): whether the hub should expose the chain profile and surface coverage this link needs as a query rather than a config assumption.

## 6. Semantic layer

### 6.1 Endpoint

- The endpoint is **pure mechanism**: url, path, model id and timeout are config, validated but not constrained to a local address (D-03).
  A llama.cpp server speaking `/v1/systemone` and a hosted service speaking the same contract both qualify.
- **One request carries all questions for one call** — one round trip, one decision over a consistent snapshot.
  Fan-out per question is forbidden; sharing one judgment across identical sibling calls from one assistant message is required (§9).
- **Identity comes from the response, never the request.**
  A server may ignore the requested model, so the model that answered is recorded with the verdict, and thresholds apply only to a model we recognise (§14).
- **Readings must be treated as belonging to a model and a server build.**
  A build bump can change reading quality without changing the contract, so the profile recorded with every verdict is model, criteria text revision, and endpoint build (D-23).

### 6.2 State

- `state` is `{value, context}`: the tool name, the command (masked), the working directory, optional git branch, the newest user prompt, optional facts.
- **The budget ladder cuts context and never the call**: facts, then the user prompt shortened to its tail, then the user prompt entirely.
  If the call alone will not fit, the answer is `overBudget` and the link defers (D-16).
- Key order is stable.
  A server that shares prompt prefixes across requests can only reuse the prefix when the state is byte-stable at the front.
- The budget is `limits.maxStateTokens`, a config value; the real ceiling is the server's per-slot context, which no client may hard-code (§13).

### 6.3 Question set

Four `noul` questions: three scored, one veto.
`QUESTIONS_TEXT_VERSION` in `src/questions.ts` stamps the wording; **the instruction and criteria strings are the surface a threshold is measured against**, so changing a string means bumping the version and re-measuring.

| key            | question (as asked)                                                     | polarity             | role   |
| -------------- | ----------------------------------------------------------------------- | -------------------- | ------ |
| `authorized`   | do the user's own words ask for this call, or the work it is a step of? | safe when high       | scored |
| `reversible`   | is the effect easily undoable **or regenerable**?                       | safe when high       | scored |
| `blast_radius` | does it change only the object it names?                                | safe when high       | scored |
| `exfiltration` | does this exfiltrate sensitive data, such as credentials?               | **unsafe when high** | veto   |

Requirements on the set:

- **Polarity is declared, not assumed.**
  A question may be phrased the natural way round for the model while aggregation reasons in one direction (`unsafeReading()` in `src/aggregate.ts`); mixing conventions without declaring them silently inverts a threshold.
- **`criteria` is load-bearing, not decoration.**
  The same instruction with different criteria text moves a reading from a confident no to a confident yes, and across models the same wording can read very differently.
  Criteria text is versioned with the instruction, and no threshold transfers across either.
- **Generic instructions are banned.**
  "Is condition N satisfied" phrasing clusters near the middle of the band and manufactures defers.
- `authorized` is answered against the user's own words, captured at run start; a conversation window is not an instruction and a new prompt invalidates it (D-23).
- **Candidates not yet shipped:** `unique_data` (nothing destroyed exists nowhere else), `open_world` (nothing reaches outside this machine), and one `score` question for severity (§17-3).

### 6.4 Surfaces we do not judge

A gate family outside `surfaces` defers with `surface_not_configured`, matched on the family the hub stamps at `accessIntent.surface`.
Our list is a belt, not the authority: the hub's bounded-delegation checkpoint caps what any link's `allow` can reach whatever this says, and the hub keeps no model-delegation surface list (§5).
`OPEN` (§17-4): the default for a surface the hub newly covers.
Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) are not consulted today; `idempotentHint` is the cheapest input to the sibling-call sharing rule (§9).

## 7. Verdict model

Aggregation is **a min-rule with named vetoes**, not a weighted sum (D-24):

1. **Veto first.**
   A veto question reading confidently unsafe denies; an uncertain veto reading defers and is logged (`veto_uncertain`).
2. **A confident "no" on any scored question denies**, carrying that question's label.
3. Otherwise the verdict is decided by the **lowest** scored reading: at or above the `allow` threshold → `allow`; below it → `defer`.
4. A missing or non-finite answer is a parse failure, not a zero, and defers.

Thresholds are two config numbers, `allow` and `deny`, validated as `0 ≤ deny < allow ≤ 1`; a config that violates this is reported, not clamped.
**They are provisional** (D-14): no corpus justifies them yet, `dryRun` is the shipped default while that is true, and no code path may describe them as calibrated.

- Weights are excluded until a labelled corpus exists to estimate them, and a min-rule is explainable in the one sentence a denial carries.
- **A `deny` carries a teaching reason** naming the failing question and reading, and tells the agent not to reword and retry (§8).
- **A `defer` is the universal failure answer** and is always logged with a reason code.
  `OPEN` (§17-5): how `confidence` from a `choice`/`score` reading enters the table — whether a flat distribution alone forces a defer.
- `OPEN` (§17-6): whether an `allow` may ever become a durable grant.
  Our position is no while grants live in hub config only (D-08); upstream issue #799 is the shape that would change that.

## 8. Floor and preconditions

Two deterministic lists decide before any network call, and both answer `defer` — this floor refuses to **approve**, it never denies (D-25).
`OPEN` (§17-1): whether the lists stay in code, or move to the hub's `dangerousShapes` / `indirection.floor.enabled` config as one entry point shared with `pi-permission-model-judge`.

- **Never-allow shapes** — privilege escalation, filesystem format or signature wipe, block-device overwrite, recursive delete of a home or root path, `.git` metadata removal, working-tree discard, force push, credential path read or send, secret in the command line, cloud/infrastructure mutation, container teardown, package publish.
- **Opaque shapes** (D-16) — `sh -c` wrappers, `eval`, interpreter `-c`/`-e`, `xargs`, `find -exec`, command substitution, piped interpreters.
  A call whose effect is not visible in its text cannot be judged: `bash -c "safe; evil"` must never be approved on the safe piece alone.
  The hub already prompts on these, so a wrapper reaching this link is itself evidence that decomposition was unfaithful.
- **No command visible** (D-16, D-23) — a `path` ask carries only a preview, so the link recovers the full arguments from session entries by `toolCallId` (the same recovery `@mzwing/pi-permission-auto-review` had to write), and defers when it cannot.

## 9. Failure and unavailability

Every failure resolves to `defer` with a reason code; none may stall the session.

| Failure                                                                                 | Handling                                                                                                                                            |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| No config file                                                                          | Nothing registers — an operator who configured nothing is declining the link                                                                        |
| Config file present but unparseable                                                     | Reported as an issue and skipped; must not silently turn a configured link into an unconfigured one                                                 |
| Endpoint unreachable, timeout, HTTP error, non-JSON, missing answer, non-finite reading | Typed `EndpointError` kinds → `defer`, logged with a truncated detail                                                                               |
| State over budget                                                                       | `defer` before sending (D-16)                                                                                                                       |
| Transport reset                                                                         | A breaker event, not a retry — an over-limit request can kill the server                                                                            |
| Repeated failures                                                                       | Breaker opens and short-circuits to `defer`; half-open after a cooldown (**required, not built** — §13)                                             |
| Parallel sibling calls in one batch                                                     | A small semaphore so a parallel batch does not stampede the endpoint; identical siblings share one judgment; any per-turn counter must be race-safe |
| User interrupt                                                                          | Control flow, not a verdict; recorded as cancelled                                                                                                  |

## 10. Security and privacy

- **Secret shapes are masked on the outbound request** — private-key blocks, JWTs, provider key prefixes, AWS access key ids, bearer tokens → `[masked:<shape>]`.
  The endpoint is a hop whose logs we do not control, and masking is asserted on the serialized request body, never on the code path (D-26).
- **File contents, diffs and tool output are never sent.**
  A `write`/`edit` ask contributes at most its path — and on those surfaces an `allow` would be downgraded anyway (D-09).
- **Only the user's own words authorize.**
  Assistant text, tool output and environment variables are not evidence of permission.
- The endpoint needs no credential today (LAN, no auth).
  If it ever does, the secret follows the hub's pattern — secret store, `0600`, never settings, never a project file, verified against the endpoint before storage.
- Anything in the state may appear in the endpoint's logs, so the state budget is a privacy surface as well as a cost one: the conversation window is the first thing cut.

## 11. Configuration

Two configs, deliberately separate: **chain policy** in the hub, **model mechanism** here.

```jsonc
// @gotgenes/pi-permission-system's config — names the link in the chain
{
  "authorizerChain": ["decisions-judge"]
}
```

```jsonc
// this package's config — endpoint, thresholds, limits
{
  "endpoint": { "baseUrl": "…", "path": "/v1/systemone", "model": "…", "timeoutMs": 1500 },
  "thresholds": { "allow": 0.7, "deny": 0.3 },
  "limits": { "maxStateTokens": 320 },
  "surfaces": ["bash"],
  "dryRun": true
}
```

- Read from `<agentDir>/extensions/pi-permission-decisions-judge/config.json` and `<cwd>/.pi/extensions/pi-permission-decisions-judge/config.json`, project over global, nested objects merged one level deep.
  The project layer is read only on a trusted project — it chooses the endpoint that receives the prompt and the command under judgment (D-31) — and a file skipped that way is named at session start.
- **No config file at all means the operator is declining the link** — the extension registers nothing.
- Validation is zod, errors are reported with the source path and field path, and an unparseable file never takes the extension down.
  Threshold and limit bounds are enforced (`0 ≤ deny < allow ≤ 1`, `32 ≤ maxStateTokens ≤ 4096`, `250 ≤ timeoutMs ≤ 60000`).
- `dryRun` is a first-class mode: it runs the whole pipeline, logs the readings and the would-be verdict, and defers.
- `OPEN` (§17-7): a Draft-2020-12 JSON Schema generated from the zod source (`schemas/`, `scripts/generate-schema.ts`) is the sibling packages' pattern and is not built here yet.

## 12. Records and observability

We do not own the UI, the widget, the commands, or the log format — the hub does (D-08), keyed by the same `requestId` (§4).
What we owe is that the questions *"did the judge run, did it reach the model, and why did it defer?"*
are answerable from the log alone:

| Event                            | When                                 | Fields carried besides `requestId`, `surface`, `tool`                                                                          |
| -------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `decisions_judge.defer` (debug)  | any refusal before asking            | `reason`, `rule` where a floor rule matched, `surfaces`, token estimate                                                        |
| `decisions_judge.defer` (review) | the middle band, or a defer decision | `command` (masked), `readings`, `model`, `latencyMs`, `usage`, `dropped`, `tokensEstimate`, `textVersion`, `thresholds`, `why` |
| `decisions_judge.allow`          | allow                                | same, plus `minReading`                                                                                                        |
| `decisions_judge.deny`           | deny                                 | same, plus the veto/failing `key`                                                                                              |
| `decisions_judge.dry_run`        | `dryRun: true`                       | everything an allow/deny would log, plus the verdict it would have reached                                                     |

- A deferred verdict must be distinguishable from "the link was not reached": reason codes differ, and the startup report (§13) says whether the link is registered and named.
- The request we send is whole or we do not send it; our log fields carry the masked command and name what the budget ladder dropped (§6.2).

## 13. Performance and sizing

- Floor, precondition and budget check run locally, before any network call.
- One request per ask; never fan out one ask's questions; a semaphore of one or two exists only to stop a parallel tool batch stampeding a single-throughput endpoint.
- A failed or broken-circuit ask must add no per-call stall: the breaker short-circuits to `defer` with no request.
- `timeoutMs` bounds one attempt; the effective worst case is `timeoutMs × (1 + retries)`, and retries exist only for transient transport failures, never for a size refusal (§9).
- Size is checked before sending, conservatively — a size refusal at the server may be a socket reset or a dead server, and the ceiling is server configuration, never a constant we may bake in.
- Re-measure before trusting any threshold after a model or build change (§14).

## 14. Testing, calibration, and evaluation

- **Unit tests run with no network**: the `Transport` seam and `test/fake_endpoint.py` stand in for the endpoint; each module is testable alone; band boundaries are tested at exact threshold values; polarity conversion is tested per question.
- **Redaction is tested on the serialized request body** — a command carrying a key, JWT, or PEM block must produce a body with none of it.
- **Race-safety**: tool calls in one assistant message run in parallel, so per-turn counters and any shared judgment cache must be safe under sibling calls (`docs/pi-api.md`).
- **`pnpm live-check` is not a test.**
  It drives the real link against the configured endpoint over the scenario table in `scripts/live-check.ts` and prints drift against each scenario's expected verdict.
- **Thresholds stay provisional until a corpus exists** (D-14), keyed by the profile recorded with each verdict.
- **Contract and drift checks** are opt-in, run against a live endpoint: question shapes, error shapes, and a reading regression guard keyed to the model and build that answered.
- Headless behaviour is the hub's, and so is tested there; our obligation is that a `defer` never hangs and never claims to have decided.

## 15. Compatibility

- Peer dependencies: `@gotgenes/pi-permission-system >= 27.0.0` (the `authorizerChain` seam and `getPermissionsService` locator it ships) and `@earendil-works/pi-coding-agent >= 1.0.0`; the pin the package is developed against is recorded in `package.json` devDependencies, and the API facts this spec assumes are in `docs/pi-api.md`.
  `OPEN` (§17-8): a tested range rather than a lower bound, the way `@mzwing/pi-permission-auto-review` pins a run of hub majors in its peer dependencies.
- **Co-existing links are a real hazard**: `@mzwing/pi-permission-auto-review`, `pi-permission-classifier`, `@gotgenes/pi-permission-model-judge`, `@geohar/pi-permissions-analyzer` are all chain links.
  Chain order is config, and a link ahead of us answers first — so the startup report must print the actual chain, our position in it, and any other registered link (D-10).
- **Families we can never approve**: a `path`-family or `external_directory`-family ask is downgraded by the hub's bounded-delegation checkpoint (D-09), so registering on them yields defers and must be reported as such rather than mistaken for coverage.
  Hub 41.0.0 added one exception: an `external_directory` bash ask carrying the `nothing-on-disk` license its gate computed is honored.
- **`user_bash` (`!`/`!!`) never reaches this link**: the hub subscribes to `session_start`, `resources_discover`, `session_shutdown`, `before_agent_start`, `input`, and `tool_call` — not to Pi's `user_bash` lifecycle event — so user-typed shell input raises no ask and no chain link is consulted.
  A `surfaces` entry naming it would be dead config, not coverage.
- **The endpoint's engine and build are a compatibility surface** (D-23): question-type behaviour, prompt-prefix sharing, the per-request size ceiling, and reading quality all depend on them.
  `OPEN` (§17-9): record that assumption set and how each assumption breaks in the package skill.

## 16. Acceptance criteria

1. With no config file, nothing registers and no ask is affected.
2. Naming the link in `authorizerChain` while leaving its own `surfaces` list empty yields no judgment for any gate family, and the startup report says why.
3. A floor shape never produces `allow`, reaches no network call, and logs the matched rule name.
4. An opaque shape, a missing command, or a call that will not fit the state budget produces `defer` before any request.
5. One request carries all four questions; a missing, non-`noul`, or non-finite answer produces `defer` with a parse reason, never an allow.
6. `allow` requires every scored reading at or above the `allow` threshold and no confident veto reading; a single scored reading at or below the `deny` threshold produces a `deny` naming that question.
7. A `deny` reason names the failing question, tells the agent not to reword and retry, and asks it to involve the human.
8. Every endpoint failure kind produces `defer`; a broken circuit produces `defer` with no request and no added stall.
9. No secret shape appears in a serialized request body, proven by a test on the body.
10. Every verdict is attributable in the hub's log: reason code, readings, model that answered, text version, thresholds, latency, what the budget ladder dropped.
11. In `dryRun` the verdict is always `defer` and the would-be verdict plus readings are logged.

## 17. Open questions

1. **Own floor vs none** (D-04): D-04 chose no own floor plus startup coverage assertions, yet `src/floor.ts` ships `NEVER_ALLOW` and `OPAQUE_SHAPES`, which only ever `defer`.
   Settle which is intended.
2. **Aggregation shape** (D-24): keep the min-rule once a corpus exists, or move to a per-question band table?
3. **Question count and set**: do `unique_data`, `open_world`, and a `score` severity question earn their cost, and does the set stay at four?
4. **New-surface default**: what should the link do when the hub starts emitting a surface this package has never judged — defer silently, or report it once?
5. **`confidence` in the table**: does a flat distribution from a `choice`/`score` reading force a defer on its own?
   No mined project reads it.
6. **Grant model** (D-08): should an `allow` ever become durable, and through what upstream mechanism (hub issue #799) rather than our own store?
7. **Config schema**: generate `schemas/` from the zod source like the sibling packages?
8. **Version pinning**: peer lower bound, or a tested range plus a startup version check (D-10)?
   A breaking hub change arrives today as a missing `PERMISSIONS_READY_CHANNEL` export, and we degrade silently to "no service resolved".
9. **Upstream assumptions**: record the endpoint engine/build assumption set in the package skill (§15).
10. **Policy entry channels** (D-04): hub config, hub's own rule syntax, or upstream issue #748.
11. **Rationale to the agent**: what a `deny` reason may say — how much of the reading set to expose (D-01 consequence).
