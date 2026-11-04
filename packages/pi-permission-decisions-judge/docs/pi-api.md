# Pi API surface — checked against the installed release (1.2.0)

PLAN Phase 0 item: "confirm the Pi API surface the spec assumes".
Types read from `dist/core/extensions/types.d.ts` and `docs/extensions.md` in `~/.pi/agent/install/releases/1.2.0/node_modules/@earendil-works/pi-coding-agent`.
Four assumptions in SPEC v0.1 need changing, two gaps we had written off as unimplementable are not, and two things (tool annotations, `ctx.mode`) are better than the spec assumed.

## Confirmed, as SPEC assumes

| Surface                     | Signature                                                                                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| block a tool call           | `ToolCallEventResult { block?: boolean; reason?: string; terminate?: boolean }` (`:1089-1098`)                                                                              |
| modify arguments            | **not** via the result — "To modify arguments, mutate `event.input` in place instead" (`:1090`)                                                                             |
| UI dialog                   | `ctx.ui.confirm(title, message, opts?) => Promise<boolean>` (`:76`), `ctx.ui.notify(msg, "info"\|"warning"\|"error")` (`:80`)                                               |
| status widget               | `ctx.ui.setWidget(key, string[] \| undefined, opts?)` (`:101`) — `undefined` removes it                                                                                     |
| no-UI detection             | `ctx.hasUI: boolean` (`:219`, `:547`)                                                                                                                                       |
| records outside LLM context | `pi.appendEntry` / `AppendEntryHandler` (also in `docs/json.md`)                                                                                                            |
| tool events                 | `tool_call`, `tool_execution_start/update/end`, `tool_result` (`ToolResultEventResult` can redact `content`; replacing `content` alone **drops** a declared `outputSchema`) |

## Four SPEC assumptions that are wrong for 1.2.0

1. **`ctx.isProjectTrusted()` does not exist.**
   All five prior projects call it; 1.2.0 has no such export.
   Trust is an **event**: `ProjectTrustEvent { type: "project_trust", cwd }` → `ProjectTrustEventResult { trusted: "yes"|"no"|"undecided", remember?: boolean }`, with `ProjectTrustHandler`, `ProjectTrustContext`, `ProjectTrustStore`, `hasTrustRequiringProjectResources`, `DefaultProjectTrust` exported from the package root (`types.d.ts:535-545`).
   Consequence for SPEC §11: the extension must **hold its own trust state**, set from the event, and note the ordering rule from `docs/extensions.md:50` — "Only personal and explicit command-line extensions can participate in the `project_trust` event that runs before project extensions load."
   A gate installed as a *project* extension cannot gate on its own trust decision; it must be installed personally to read project config safely.
2. **`terminate` exists and is a batch-scoped hint.**
   "Early termination only happens when every finalized tool result in the batch sets this to true" (`:1093-1097`).
   SPEC §8 should decide whether a blocked call sets it — setting it on one block in a parallel batch does nothing.
3. **Tool calls in one assistant message can run in parallel** (`docs/extensions.md:126-128`: "Do not assume a sibling call or result exists when another tool event runs").
   Every per-turn counter in the design — refusal breaker, repeat-skip ledger, question budget — must be keyed and race-safe, and a "3 refusals in a row" rule needs a defined order under parallelism.
   Not addressed by any prior project (all five assume sequential calls).
4. **`ToolCallEvent` is a discriminated union** over `bash | powershell | read | edit | write | grep | find | ls | custom` (`:984`).
   SPEC §6.4's "uncovered tools" question is narrower than assumed for the built-ins, and *wider* for `custom`: a custom tool's `input` is `Record<string, unknown>` with no schema guarantee — which is exactly where `pi-auto-permissions`' argument projection and `pi-jev-tool-guard`'s key-name redaction apply.

## Two gaps that turn out to be implementable

5. **`user_bash` is hookable** (SPEC §17-8, previously "zero coverage in all five"): `UserBashEvent { type, command, excludeFromContext, cwd }` (`:898-906`) where `excludeFromContext` is the `!!` prefix (excluded from LLM context).
   Result type is a union: `{ operations: BashOperations }` **or** `{ result: BashResult }` (`:1100-1108`).
   Behaviour from `docs/extensions.md:128`: returning `undefined` passes the command to the next handler and then to local execution; returning `operations`/`result` stops propagation; **a handler failure blocks the command rather than falling through**.
   So gating `!` commands is possible, and it fails closed for free — but note the semantics: to *block* we must return a `result` (there is no `block: true`), and an exception is a crude block that carries no reason.
6. **Nested tool calls are visible** (previously listed as uncovered): `ToolCallEventBase` carries `toolCallId` and optional `parentToolCallId` — "Set when another tool (for example a codemode script) issued this call" (`:931-941`).
   Nested ids are `<parent id>/<n>`, and such calls "never appear as tool calls or tool results in the transcript, only in the parent result's `nestedCalls` record".
   So a nested call **does** fire `tool_call` and can be blocked, but the *transcript-based* replay harness cannot see it — our corpus builder must read `nestedCalls` too, and the ledger must treat ids as hierarchical (a repeat of `a/1` is not a repeat of `a/2`).

## Confirmed, and better than SPEC assumed

7. **MCP-style tool annotations are available.**
   `pi.getAllTools(): ToolInfo[]` where `ToolInfo = Pick<ToolDefinition, "name"|"description"|"parameters"|"promptGuidelines"|"reachesTools"> & { exposure; namespace?; annotations?: ToolAnnotations; sourceInfo }` (`:1577-1582`), and `ToolAnnotations { readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint? }` — "Hints about what a tool does, with the meaning of MCP tool annotations" (`:397-409`).
   SPEC §6.4 can use them for the uncovered-tool default (`readOnlyHint → fast path candidate`, `destructiveHint/openWorldHint → always judge`), with the caveat that they are **self-declared by the tool author and optional**, so they may inform routing but must never be a sufficient allow.
8. **`ctx.mode` exists**: `ExtensionMode = "tui" | "rpc" | "json" | "print"` (`:212`, on `ExtensionContext` `:217` and `ExtensionCommandContext` `:546`).
   SPEC §8.2's headless rules should branch on `mode` plus `hasUI`, not on `hasUI` alone — `rpc` has UI-ish capability but loses custom components, `json`/`print` do not.

## Still unconfirmed / to check in Phase 2

- Whether MCP tools surface as `custom` `ToolCallEvent`s or through a separate path
  (`McpServersChangeEvent` exists; `ToolNamespace` covers MCP servers as a group, "For example
  `mcp__docs`").
- Whether a multi-choice approval exists: `ctx.ui.confirm` is boolean only, so "approve once / always
  allow / block" needs `ctx.ui.select` (not found in `types.d.ts` — check `docs/tui.md` /
  `docs/rpc-extension-ui.md`) or a `setWidget`-driven command flow like `pi-jev-permit`'s.
- `executeTool` (`ExecuteToolOptions`) as a re-entry point after a grant — needed for
  `pi-jev-permit`-style one-shot approval without asking the agent to re-issue the call.
