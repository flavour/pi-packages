# Analysis — `pi-jev-tool-guard`

Path: `/home/fran/code/pi-jev-tool-guard` · MIT · v0.1.x · "Jev-powered tool-call guard for Pi" `src/` 2369 lines (`guard.ts` 474, `config.ts` 793, `command.ts` 342, `evaluator.ts` 272, `context.ts` 252, `index.ts` 35) + `tests/` 1226 + `AGENTS.md`.
The **only project that ships a strictness scale instead of raw probabilities**, the only one with a `score` (ordinal) question alongside noul, and the only one with a **progressive state-fitting algorithm**.
Its defaults are the loosest of the five (`evaluatorFailure: "allow"`), so read it as the "usable by default" pole against `pi-jev-permit`'s "safe by default" pole.

## 1. Pipeline shape

`pi.on("tool_call") → guard(event, ctx)` (`src/index.ts:33`, `src/guard.ts:48`):

```text
config load throws          → setStatus "guard: invalid settings" + block            guard.ts:53-59
disable || !enabled || tool not in protectedTools → pass                             guard.ts:63-68
evaluateRules (per-tool precedence)                                                          guard.ts:70-88
  bash:  denyCommands → deny (hard block)
         allowedCommands → allow (suppresses even built-in danger — "an informed user choice")
         BASH_DANGER_RULES match → confirm
         alwaysConfirmCommands → confirm
  paths: protectedPaths → confirm · allowedPaths → allow
effectiveThresholds(config, tool) → per-tool thresholds derived from the 1-10 scale   guard.ts:90-96
buildGuardState (redact + fitState)                                                  guard.ts:98-104
evaluateToolRisk → allow | confirm (+ highRisk flag)                                 evaluator.ts:145-160
confirm → confirmOrBlock (ctx.ui.confirm, or block when no UI)                       guard.ts:229-256
```

No read-only fast path, no segmentation, no wrappers.
Everything in `protectedTools` (`["bash","write","edit"]`, `config.ts:5`) goes to the evaluator unless a rule decides first.

## 2. Deterministic rules

**`BASH_DANGER_RULES` (`guard.ts:172-236`, 11 patterns)** — classes no other project has: **fork bomb**; **system power/shutdown** (`shutdown|reboot|poweroff|halt|init 0|6`); **destructive SQL** (`drop|truncate table|database|schema`); **container/workload destruction** (`docker rm -f`, `docker system prune`, `docker volume rm`, `docker network prune`, `kubectl delete`); **registry publish** (`npm|pnpm|yarn|bun publish|unpublish|deprecate`); **raw device redirect** (`> /dev/sdX|nvmeXnY|mmcblkN`) in addition to `dd of=/dev/`; `pipe-to-shell` (also `python|node`); force-push incl.
`--mirror|--delete`; recursive `rm`; disk tools; world-writable; recursive chown.
Regexes again use `[^\n;&|]*?` between verb and flag, so they do not cross separators.

**Polarity differs from every other project**: "A match forces confirmation; it never blocks outright (an explicit deny rule can still hard-block)" (`guard.ts:163-170`).
The deterministic layer *routes to the human*, it does not decide.
That is coherent here because the evaluator sits behind it and the default failure mode is allow — but it means the deterministic layer is not a safety floor.
Our §5.3 should keep the floor (`hard-deny`) *and* take this idea for the classes where a human is the right destination (power/shutdown, SQL destructive, kubectl delete).

**Rule precedence is documented explicitly** (`guard.ts:238-243`): deny > allow (allow beats built-in danger) > built-in danger (confirm) > always-confirm; for paths, protected > allowed.
Note that an explicit allow outranks a built-in danger pattern — a deliberate "informed user choice" call, the opposite of `pi-auto-permission-gate`'s "hard-deny rules remain non-overridable".
Pick one and write it down; ours should be non-overridable for the hard-deny set only.

**Matching is `commandContains`** — substring, not glob, not argv.
Weakest matcher of the five.

**Protected paths**: `rules.protectedPaths` defaults to `[]` (`config.ts:165`) — no built-in protected-path table at all.
Our §5.3 must keep auto-mode/permit's built-in table.

## 3. Question set

Six noul + one **`score`** (`evaluator.ts:11-63`), asked together in one request:

| id                  | question (abridged)                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intentMismatch`    | "Does `pendingTool` conflict with or go beyond the user's objective…?"                                                                                                                        |
| `excessiveScope`    | "Would it affect more files, systems, users, or data than the objective requires?"                                                                                                            |
| `sensitiveExposure` | "Could it read, transmit, reveal, overwrite, or persist credentials, private data, or security-sensitive configuration?"                                                                      |
| `destructiveChange` | "Could it delete data, overwrite substantial content, rewrite history, damage configuration, or make a disruptive system change?"                                                             |
| `externalImpact`    | "Could it publish, deploy, push, install globally, change shared remote state, or affect systems outside the current working copy?"                                                           |
| `hardToReverse`     | "Would recovering from an incorrect operation be difficult, incomplete, costly, or require unavailable backups?"                                                                              |
| `severity`          | **`score`**: "How severe would the consequences be if `pendingTool` were incorrect or unauthorized?" over 4 ordered levels (no meaningful harm / limited harm / serious harm / critical harm) |

Every noul carries a **two-sided `criteria`** (`noul(question, {true, false})`) — the most explicit criteria text of the five, e.g. `hardToReverse.false` = "readily reversible with normal source control or local file recovery".
Note the **polarity**: here `true` = the hazard is present, so a *high* probability is bad.
`pi-auto-mode` and `pi-jev-permit` both invert this ("safe state = yes") so that a lazy model defaults to safe.
**Our SPEC must state the polarity convention explicitly and keep it uniform** — this project is the counter-example, and mixing the two conventions in one question set is a silent-aggregation bug factory.

**`score` is the mined question type we don't have.**
A 4-level ordinal with written anchors, returned as an integer 0-3, validated with `isRangeNumber(score, 0, 3)`.
It gives a severity tier without a calibrated probability, which is much easier to measure on a 3B model than a fine-grained `p`.
Our §6.3 should consider one `score` question for severity plus noul questions for conditions, and our §7 can use the score as a **floor** (see §4).

No anti-injection instruction anywhere in the questions or state — the weakest §5.4 story of the five alongside `pi-auto-permissions`.

## 4. Aggregation

`evaluator.ts:145-160`:

```text
triggered = questions with p >= reviewProbability, sorted desc
top       = max p over the six
review    = triggered.length > 0 || severity >= severityReview
highRisk  = top >= highRiskProbability || severity >= 2
decision  = review ? "confirm" : "allow"
```

So: **any single question over its line → ASK** (no AND-ing, no weighted sum — the §7 candidate (a) "any hazard blocks" shape, but routed to a human rather than a block), and `highRisk` is a flag that changes the dialog title (`"high-risk bash"` vs `"review bash"`) — it does **not** remove the human's ability to approve.
The `severity >= 2` term is a deterministic floor from the ordinal question.
`triggered` is kept sorted so the reason string can name the dominant risk (`describeEvaluation`, `guard.ts`).

## 5. Thresholds — the best mined answer to SPEC §17-1

The user never sets a probability.
They set **`threshold: 1-10` (default 5)**, and `THRESHOLD_TABLE` (`config.ts:102-112`) expands it:

| level | reviewProbability | highRiskProbability | severityReview |
| ----: | ----------------: | ------------------: | -------------: |
|     1 |               0.9 |                0.95 |              3 |
|     2 |              0.85 |                 0.9 |              3 |
|     3 |               0.8 |                0.85 |              3 |
|     4 |               0.7 |                0.75 |              2 |
|     5 |               0.6 |                0.65 |              2 |
|     6 |               0.5 |                0.55 |              2 |
|     7 |               0.4 |                0.45 |              2 |
|     8 |               0.3 |                0.35 |              1 |
|     9 |               0.2 |                0.25 |              1 |
|    10 |               0.1 |                0.15 |              1 |

Invariants stated in the comment (`config.ts:96-101`): each row keeps `reviewProbability < highRiskProbability`, and the severity line moves with the level.
Plus **`BUILTIN_TOOL_THRESHOLD_BOOST = {bash: +3, write: 0, edit: 0}`** (`config.ts:89-94`) and `toolThresholds` per-tool overrides on the same 1-10 scale (`effectiveToolThreshold`/`effectiveThresholds`, `:121-144`), with the note "the evaluator only sees those values".

This is the design our §17-1 should ship: **one human-facing strictness knob + a per-tool boost, expanded internally to per-question lines.**
It also gives us the Phase 2/3 measurement story: the scale is what a user tunes, the probabilities are what *we* calibrate from a corpus, and the table is the mapping between them.
Adopt it, with our own rows derived from the `d1-3B` distribution rather than these numbers.

## 6. Middle tier

`confirm` → `ctx.ui.confirm(title, rationale + redacted/truncated input + "Allow this tool call?")`.
**No UI (`ctx.hasUI === false`) → block, unless `headlessRisk: "allow"`** (`guard.ts:235-239`) — a setting, default `block`.
The confirm body is `truncate(JSON.stringify(redactSecrets(event.input), null, 2), 2400)` — pretty-printed, redacted, capped.
`highRisk` only changes the title, so the human always has the last word.
Notifications: `showAllowed` (default false), `showEvaluatorFailures` (true), `showProjectOverride` (true).

## 7. Failure policy

`EvaluationFailure = missing_api_key | cancelled | request_failed | invalid_response` (`evaluator.ts:66-71`).
All of them → `status: "unavailable"` with `decision = evaluatorFailure === "allow" ? "allow" : "block"` (`evaluator.ts:176-186`) — **`evaluatorFailure` defaults to `"allow"`** (`config.ts:153`), i.e. fail-open by default, the only project of the five that does.
`retry: {maxRetries: 0}`, `timeoutMs: 2000` default (`config.ts:151-152`) — a 2 s budget, the tightest of the five, and the closest to our §13 latency numbers.
Failures are notified **once per reason** (`reportedFailures` set, `guard.ts:43`, `notifyFailureOnce`) so a down endpoint doesn't spam the user every call — a cheap UX detail worth copying.
Config-load failure → block (`guard.ts:53-59`) and a session-start status line "guard: invalid settings" + notify "protected calls will be blocked" (`index.ts:22-31`).

## 8. Coverage

`protectedTools` is a **config list** over the fixed `["bash","write","edit"]` universe (`config.ts:5-6, 21`); `isProtectedTool` returns false for anything else, so MCP/`user_bash`/unknown tools pass silently (`guard.ts:152-156`).
Same hole as the others, but here it is at least a named
config key — which makes the §6.4 default ("protected tools: …, unknown tools: judge|block|allow")
a natural extension of this shape.

## 9. Privacy — the state builder we should copy

`buildGuardState` (`context.ts:47-96`) → `{cwd, userObjective, recentConversation[], pendingTool:{name, input, truncated}}`, with `recentMessages: 6`, `maxCharacters: 12_000`, `redactSecrets: true`, `includeToolResults: false`.

**Redaction is two-layered and the first layer is unique to this project** (`context.ts:35-45`, `redactSecrets` `:99-109`): a **key-name** pass over the whole input object — `/(api[-_]?key|token|secret|password|passwd|authorization|credential|private[-_]?key|access[-_]?key)/i` → `"[REDACTED]"` — plus value patterns (PEM, and the rest).
Key-name redaction is the right tool for **arbitrary MCP tool inputs**, where you cannot predict the value's shape; none of the other four projects has it.
Take both layers.

**`fitState(state, maxCharacters)` (`context.ts:161-206`)** is a deterministic, ordered degradation ladder, checked against `serializedLength` at each step:

1. drop oldest conversation messages, keeping ≥ 1;
2. **middle-truncate the tool input** and set `pendingTool.truncated = true`;
3. drop the rest of the conversation;
4. middle-truncate `userObjective`;
5. middle-truncate `cwd`.
`truncateMiddle` keeps head and tail around a `\n...[TRUNCATED]...\n` marker — for a command the head carries the verb and the tail the target, which is exactly the decision-relevant material.
The `truncated` flag travels **in the state**, so the model can be told the evidence is incomplete.
This matches our Phase 1 finding ("the conversation window is affordable but is the first thing to cut") and our §13 size guard; adopt the ladder, the flag, and the middle-truncation.

**`stableStringify` sorts object keys before measuring (`context.ts:222-232`).**
For us this is not cosmetic: our measured prefix-cache behaviour means a state whose key order varies between requests destroys the shared prefix and re-pays the state read per question group.
**Every state we build must be serialized with a stable key order** — add it to SPEC §6.2 as a hard requirement.

Compaction/branch summaries are handled as entries (`entryToGuardMessages`, `:111+`).

## 10. UI/UX

Status line `tool-guard …` updated on every call (`updateGuardStatus`), including an "invalid settings" state.
Notifications for allows (off by default), evaluator failures (once), and project overrides.
`/tool-guard` command (`command.ts`, 342 lines) for status/settings.
Confirm dialog body is pretty-printed redacted JSON capped at 2400 chars.

## 11. Config layering — the provenance idea

`loadToolGuardConfig({cwd, projectTrusted})` returns `{config, provenance: Record<string, "default"|"global"|"project"|"derived">, projectOverrideApplied}` (`config.ts:74-78`), with a global `projectOverrides: "full" | "none"` switch (`:9`, `:55`) and a one-time notify when a project override takes effect (`guard.ts:66`, `notifyProjectOverride`).
**Per-field provenance is the thing to steal**: a `status` subcommand that prints the effective value *and which layer set it* turns "why is this gate behaving this way" into a 5-second question.
Our §12 should require it, and our §11 should decide whether project layers may loosen (this project says yes behind a switch; `pi-jev-auto-mode` says tighten-only; `pi-jev-permit` says arrays replace wholesale).

## 12. Tests & eval

`tests/guard.test.ts` (415), `config.test.ts` (286), `command.test.ts` (221), `context.test.ts` (115), `evaluator.test.ts` (152), `package.test.ts` (53).
The evaluator tests inject `systemOne` as a function (`evaluateToolRisk({systemOne})`, `evaluator.ts:96-101`) — the same seam as permit's `fetch` injection, and the cheapest possible way to test aggregation offline.
`context.test.ts` covers `fitState`/`redactSecrets` directly, which is the pattern our §14 state-builder tests should follow.
No corpus/replay harness (weakest of the five on eval); `tests/package.test.ts` asserts package metadata.

## 13. Fit-gap verdict

**~55% of SPEC requirements met.**
Contributes four things the others do not: the 1-10 strictness scale with per-tool boost (→ SPEC §17-1); the `score` ordinal question type (→ §6.3); the `fitState` degradation ladder with `truncated` and middle-truncation (→ §6.2/§13); key-name redaction and stable-key serialization (→ §10/§6.2).
Plus per-field config provenance (→ §11/§12) and the "notify once per failure reason" detail (→ §9).

Missing/wrong for us: no read-only fast path, no segmentation/wrappers, no built-in protected paths, no anti-injection instruction, substring rule matching, no batching beyond one request, no failure taxonomy beyond four codes, no breaker, no records/log, no model-identity check, and defaults we must not inherit (`evaluatorFailure: "allow"`, `headlessRisk: "block"` is fine, `protectedPaths: []` is not).
Its hazard-true polarity must not be mixed with our safe-true questions.

## 14. License / attribution

MIT, `LICENSE` present.
Depends on `@typesafe-ai/sdk` for `noul`/`score`/`systemOne` — the question *types* are a vendor API here; ours must define them locally against the plain HTTP contract in `docs/systemone-contract.md`.
Credit `pi-jev-tool-guard` (MIT) for the threshold scale, the `score` question shape, `fitState`, and key-name redaction.
