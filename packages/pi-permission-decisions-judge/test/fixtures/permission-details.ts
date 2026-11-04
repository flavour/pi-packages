import type {
  PromptPayload,
  PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";

/**
 * An ask shaped the way the hub actually hands one to a chain link.
 *
 * The field set is copied from the hub's own output rather than from this
 * package's assumptions: `describeToolGate` (`@gotgenes/pi-permission-system`
 * `src/handlers/gates/tool.ts`) builds the escalation `promptDetails` from
 * `source`, `agentName`, `toolCallId`, `toolName`, `sessionLabel`,
 * `accessIntent` and the tool formatter's bash facts, and
 * `GateRunner.runDescriptor` adds `requestId` plus the spread of those facts.
 *
 * Two of those facts are why this fixture exists. A local ask carries **no
 * `surface` field** — the gate family a `surfaces` list matches lives in
 * `accessIntent.surface`, which every raising gate stamps through
 * `accessFactsFromValue`/`accessFactsFromPath`. And `source` is a review origin
 * (`"tool_call" | "skill_input" | "skill_read"`), never a family, so treating it
 * as one matches nothing an operator can configure.
 */
export function makeBashAsk(
  overrides: Partial<PromptPermissionDetails> = {},
): PromptPermissionDetails {
  const command = "command" in overrides ? overrides.command : "npm test";
  return {
    requestId: "req-1",
    source: "tool_call",
    agentName: null,
    payload: bashAskPayload(command ?? ""),
    toolCallId: "tc-1",
    toolName: "bash",
    sessionLabel: `Yes, allow bash "${command ?? ""}" for this session`,
    accessIntent: {
      surface: "bash",
      matchValues: command === undefined ? [] : [command],
      boundaryValue: null,
    },
    command,
    ...overrides,
  };
}

/**
 * The same ask raised by a subagent and served by the parent node.
 *
 * `buildForwardedAskDetails` (`src/authority/forwarded-request-server.ts`) keeps
 * two surfaces distinct on purpose: `details.surface` is the child's **display**
 * surface — the tool name its UI showed — while the gate family stays on
 * `accessIntent.surface`, the same fact the hub's bounded-delegation checkpoint
 * excludes an `allow` on. `buildForwardedAskPayload` then rewrites the payload's
 * requester to the child, which is where `payload.request.surface` (the child's
 * own gate surface) is visible. A link that reads `details.surface` first judges
 * a chain the hub reads as `bash` under whatever the child called the tool.
 */
export function makeForwardedBashAsk(
  command: string,
  displaySurface = "exec_command",
): PromptPermissionDetails {
  const ask = makeBashAsk({
    command,
    surface: displaySurface,
    value: command,
    agentName: "worker",
    forwarding: {
      requesterAgentName: "worker",
      requesterSessionId: "child-session",
    },
  });
  return {
    ...ask,
    payload: withRequester(ask.payload, {
      agentName: "worker",
      forwarded: true,
      sessionId: "child-session",
    }),
  };
}

/**
 * A forwarded ask from a child on an older hub: `buildForwardedAskDetails`
 * omits `accessIntent` entirely for a version-skew request that carried no
 * intent, and the delegation envelope reads that absence as "surface
 * undetermined" and fail-safes to excluded. Absence stays absence rather than
 * becoming `undefined`.
 */
export function makeVersionSkewForwardedAsk(
  command: string,
): PromptPermissionDetails {
  const ask = makeForwardedBashAsk(command);
  const { accessIntent: _omitted, ...withoutIntent } = ask;
  return withoutIntent;
}

/** An ask the hub raised on the `path` family — a family this link is not scoped to. */
export function makePathFamilyAsk(path: string): PromptPermissionDetails {
  return makeBashAsk({
    command: undefined,
    path,
    payload: {
      kind: "path",
      request: {
        ...bashAskPayload("").request,
        surface: "path",
        toolName: null,
        value: path,
        matchedPattern: "secrets/**",
        decidingPath: { path, effect: "read", effectSource: "syntax" },
      },
      evidence: [],
      annotations: [],
    },
    sessionLabel: `Yes, allow reading ${path} for this session`,
    accessIntent: {
      surface: "path",
      matchValues: [path],
      boundaryValue: path,
    },
  });
}

function bashAskPayload(command: string): PromptPayload {
  return {
    kind: "bash",
    request: {
      requester: { agentName: null, forwarded: false, sessionId: null },
      surface: "bash",
      toolName: "bash",
      invokedToolName: null,
      value: command,
      matchedPattern: "*",
      matchedSpelling: null,
      commandContext: null,
      executedUnit: null,
      decidingPath: null,
    },
    evidence: [],
    annotations: [],
  };
}

function withRequester(
  payload: PromptPayload,
  requester: PromptPayload["request"]["requester"],
): PromptPayload {
  return { ...payload, request: { ...payload.request, requester } };
}
