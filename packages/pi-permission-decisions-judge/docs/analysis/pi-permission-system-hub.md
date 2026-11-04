# Analysis — `@gotgenes/pi-permission-system` (the hub)

`/tmp/eco/_gotgenes_pi-permission-system` (npm tarball, v40.2.1, published 2026-10-14, MIT, `git+https://github.com/gotgenes/pi-packages.git`, deps: `tree-sitter-bash`, `web-tree-sitter`, `zod`). 31 382 non-test LOC.
`docs/configuration.md` 1 600 lines, `docs/cross-extension-api.md` 605 lines, `CHANGELOG.md` 3 921 lines, `docs/migration/*.md` per breaking change, numbered ADRs upstream (`docs/decisions/0007…0013`).

**This is the fork-parent situation to know:** it is itself "a full fork of `MasRii/pi-permission-system` … diverged substantially in config format, internal architecture, and permission model."
Fork-then-diverge is how this ecosystem works.

## Why this file changes the plan

Its own non-goals section names our layer as a designed seam, not an accident:

> **_Model judgment in the core._** This package makes no LLM call and holds no model config; model-assisted judging of an `ask` attaches as a chain link over the authorizer seam instead.
> A link decides nothing until you name it in `authorizerChain`, and its `allow` on an excluded surface is downgraded to `defer`.

So SPEC §5 (L0–L4) is a problem someone has already spent 40 releases on, and SPEC §7 (the model tier) is the one hole they deliberately leave open.
Our whole contribution is the thing they decline to build.

## What the deterministic layer actually does (what we stop building)

- **Hides disallowed tools before the agent starts** (`isToolFullyDenied`) — no wasted turns probing for a tool that will be refused.
  Our SPEC has nothing like this.
- **Surfaces**: `*`, any tool name, `bash`, `mcp` (server / tool / proxy granularity), `skill`,
  `path`, `external_directory`, plus **directional path surfaces** (ADR 0013 adds read/write as an
  axis, so "may read, may not write" is expressible).
- **Rule syntax**: wildcard patterns → `allow` / `ask` / `deny` (`"rm -rf *": "deny"`, `"git *": "ask"`).
  Default `"*"` is **`ask`** (least privilege); no presets, no trust profiles — "common policies ship as documented recipes" (read-only mode, read-only bash allowlist, MCP discovery only, per-agent lockdown).
- **`path` rules are cross-cutting** across every tool *and* bash, and match "both the path as
  referenced and its symlink-resolved form so a deny cannot be evaded through a symlink alias".
- **Bash is parsed with `tree-sitter-bash`**, and it **fails closed**: an internal gate error blocks;
  a command it could not resolve in whole or part prompts rather than passes; an **indirection
  wrapper that hides the gated command** (`bash -c`/`sh -c`/`eval`, `sudo`, `env`, `xargs`,
  `find -exec`) prompts — with a narrow exception where the wrapped command is "a pure reader whose
  direction is provable whatever it is fed (`xargs grep -l foo`)"; where a partial parse failure's
  own region re-parses cleanly, the commands and paths inside are recovered and gated.
- **`shellTools`** — gates *aliased shell tools* other extensions register, so a second bash-like
  tool cannot dodge the bash surface.
- **Project trust is observed, not decided**: "A policy enforcer, not a trust oracle: whether a project is trusted is Pi's decision and yours."
  Project config requires trust (breaking change 22.0.0).
  This settles our §11 trust question by fiat.
- **Unanswered prompts**: `promptTimeoutMs` denies on expiry — "the timeout never approves anything" — and the agent is told *nobody answered*, not *you refused*.
  Clock starts when the prompt is shown; each queued request gets its own window; pressing a key stops the clock.
  Subagent asks use the parent's window, and `forwardingTimeoutMs` must stay above it.
- **Subagents**: asks forward one hop up; the serving node runs *its* chain over the same evidence; the child records `authorizer_chain_delegated`.
  Our link reviews subagent asks for free.
- **Review log** on by default: bash command string for every bash decision, JSON preview for other
  tools, `0600` in a `0700` dir (tightened on next write if an older file was looser), decisions
  attributed by `decidedBy: {kind: …}` (`policy_allow`, `policy_deny`, `authorizer_allowed`,
  `authorizer_denied`, `user_approved`, `user_denied`, `unanswered`).
- **`yoloMode`**, `debugLog`, `doublePressToConfirm`, `promptMaxRows`, `toolInputPreviewMaxLength`,
  `piInfrastructureReadPaths` (Pi's own config reads are not gated).

## The seam we would build on

```ts
type AuthorizerVerdict = { kind: "allow" } | { kind: "deny"; reason?: string } | { kind: "defer" };
interface Authorizer {
  authorize(details: PromptPermissionDetails, query: PermissionQuery, log: AuthorizerLog):
    Promise<AuthorizerVerdict>;
}
```

Registration is announcement-driven and idempotent:

```ts
pi.events.on("permissions:ready", (data) => {
  const { sessionId } = data as PermissionsReadyEvent;
  if (dispose || !sessionId) return;                 // ready fires ≥ once per session, may repeat
  void (async () => {
    const { getPermissionsService } = await import("@gotgenes/pi-permission-system");
    dispose = getPermissionsService(sessionId)?.registerAuthorizer("auto-mode", authorize);
  })();
});
pi.on("session_shutdown", () => { dispose?.(); dispose = undefined; });
```

`details` carries `requestId`, `command`, `path`, `toolName`, `toolCallId`, `target`, `toolInputPreview`, a structured `payload` every renderer is a render over, `PromptEvidence[]` (label/text/`detail`, e.g. a symlink alias bound so elision cannot separate them), forwarding provenance, and the session-approval suggestion.
**The ask carries only a *preview* of the tool input** — the full arguments must be recovered from session entries (see the auto-review analysis).

`query` is an ISP projection (`checkPermission`, `getToolPermission`) so a link can consult the deterministic engine "at gate parity"; `log` writes `review`/`debug` entries into the same JSONL, keyed by `requestId`.

### Three chain invariants (their words, our consequences)

1. **Config order wins, never registration order** — `authorizerChain: ["auto-mode", …]` is the
   security-relevant order.
2. **A missing link is skipped fail-safe** — absence means *more* prompting, never less, plus a
   once-per-session warning naming the link.
3. **Registration alone grants no authority** — opt-in activation by name.

### The cap that bounds our whole design

> The chain owner caps every link with a **bounded-delegation checkpoint**: a link's `allow` on an excluded surface *family* (`external_directory` or `path`, including each family's directional members) is downgraded to `defer`, so a buggy or over-eager judge can never approve access outside your policy.
> Deny and defer are never capped.
> The excluded surface is the **gate** surface the rule fired on, not the tool name displayed in the prompt — so a `write` blocked by a `path` rule is capped.

**Consequence:** our model can never approve a path or external-directory ask.
Those are human-only.
Our semantic layer's authority is bash + other tool surfaces + MCP + skill.
A `write` refused by a `path` rule is capped even though the prompt says `write`.
Any SPEC claim that the model "approves writes" is false under this hub and must be deleted.

## Where they disagree with our current SPEC

| Their position                                                                                                                                                                                                                                                                                                                              | Our current position                                                                                         | Note                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Redaction is **name-structural, never predictive**: a value bound to a sensitive *name* (log key, shell assignment, request header field) is masked; `grep -r "sk-ant-…" .` and `deploy --token abc123` are logged unredacted, deliberately, with measured reasoning in ADR 0010 (heredoc masking: "six false positives and no true ones"). | SPEC §10 redacts **value-shaped** secrets (`sk-…`, JWTs, GitHub tokens) before the state leaves the machine. | Different channels: they mask a local `0600` log; we mask an outbound request to a LAN server whose own logs we do not control. Not a contradiction, but we must state which channel each rule covers. |
| No built-in secret denylist; "Guessing what is sensitive" is a non-goal.                                                                                                                                                                                                                                                                    | `path` denies for `.env`, `.ssh` etc. are in our L0.                                                         | They ship these as *recipes*, not defaults.                                                                                                                                                            |
| Isolation is out of scope: "a sandbox settles which paths are in scope … this package decides whether a particular action may proceed."                                                                                                                                                                                                     | Our §2 non-goals say the same.                                                                               | Aligned.                                                                                                                                                                                               |
| Policy *entry* channels are still an open question upstream (issue #799), "durable persistence of an approval among them".                                                                                                                                                                                                                  | Our §17-6 wants per-call grants and pattern-persistent allowlists.                                           | Their open question is ours; don't invent a private answer that a future upstream feature strands.                                                                                                     |

## Fit-gap for us (what the hub does *not* give us)

1. **No semantic judgment.**
   Every link in the wild uses a hosted general LLM.
   Nobody uses a local, pinned, calibrated decision endpoint, and nobody emits per-question probabilities.
2. **No aggregation model.**
   A link returns one verdict; how N signals become a verdict is the link's business.
   That is exactly SPEC §7, still ours to design.
3. **No calibration or eval loop.**
   No thresholds tuned against labelled traffic; the analyzer package (`@geohar/pi-permissions-analyzer`) probes a classifier but is not a calibration harness.
4. **No state/trust budget for a 3B model.**
   Their transcript work (in auto-review) is about a hosted model's context, not a 8192-token slot.
5. **No teaching-reason quality control.** `deny` carries an optional `reason` the invoking model
   sees; nobody measures whether that reason stops retries. `pi-auto-permission-gate`'s no-retry
   clause and `pi-jev-permit`'s three-reasons-for-three-blocks are the only prior art.

## Risks of depending on it

- **Cadence and churn**: 40 majors, breaking changes at 16.0.0 (bash fails closed), 22.0.0 (project
  trust), "the major after 36.x — requires Pi 1.0.0". auto-review pins "37.x – 40.x" — pinning to a
  major range is the local convention.
- **Single maintainer**, fork of a fork.
  MIT, so a fork of our own is always available; the seam types are published (`dist/public.d.ts`) and self-contained, which makes a fork cheap to maintain.
- **They may build it themselves**: issue #799 and ADR 0013 show active design work on policy entry.
  If a first-party semantic link appears, our value narrows to calibration + the local endpoint.

## What we adopt without re-designing

Chain registration pattern (idempotent `permissions:ready` + disposer); `AuthorizerLog` as our decision record (no private JSONL); `decidedBy` vocabulary; `promptTimeoutMs` semantics (timeout denies, and says "nobody answered"); subagent ask forwarding; `path`/`external_directory` denies as recipes; `shellTools` awareness; the read/write direction axis; migration-doc + numbered-ADR discipline as the model for our `docs/decisions.md`.
