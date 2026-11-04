/**
 * The chain link itself: one `ask` in, one verdict out.
 *
 * Order matters and is the whole design (D-13): the deterministic refusals run
 * before the endpoint, the endpoint never sees a call it cannot see whole
 * (D-16), and every failure path — no config, wrong surface, no command, opaque
 * shape, state over budget, endpoint down, unparseable answer — resolves to
 * `defer`, which hands the ask to the next link or to the human. This link never
 * invents a policy and never denies on a technicality.
 */

import type {
  Authorizer,
  AuthorizerLog,
  PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";

import { aggregate } from "./aggregate.ts";
import type { DecisionsJudgeConfig } from "./config.ts";
import { floorRefusal, opaqueRefusal } from "./floor.ts";
import { QUESTIONS_TEXT_VERSION, questionPayload } from "./questions.ts";
import { buildState, maskSecretShapes } from "./state.ts";
import {
  type AskResult,
  askSystemOne,
  EndpointError,
  type Transport,
} from "./systemone.ts";

/** The slice of the session manager this link needs, kept structural so it does
not couple to a particular Pi minor's exported type name. */
export interface SessionEntriesReader {
  getBranch(): unknown[];
}

export interface JudgeDeps {
  getConfig(): DecisionsJudgeConfig | undefined;
  getCwd(): string;
  getLatestUserMessage(): string | undefined;
  getSessionManager(): SessionEntriesReader | undefined;
  transport?: Transport;
  now?: () => number;
}

interface LogFields {
  requestId: string;
  /** The gate family judged, or `null` when the ask carried no family fact. */
  surface: string | null;
  /** The hub's review origin — `tool_call` / `skill_input` / `skill_read`. */
  source: string;
  tool?: string;
  command?: string;
  [key: string]: unknown;
}

/**
 * The gate family an ask belongs to — what this link's `surfaces` config lists,
 * and what the hub's bounded-delegation checkpoint excludes a link's `allow` on.
 *
 * `accessIntent.surface` is that family, stamped by the raising gate on every
 * ask. `details.surface` is a different fact and appears only on a forwarded
 * ask: the child's *display* surface, the tool name its UI showed
 * (`forwarded-request-server.ts` keeps display and fact surfaces distinct on
 * purpose). Reading it first would judge a chain the hub reads as `bash` under
 * whatever the child happened to call the tool, and so disagree with the
 * checkpoint's own cap. `details.source` is a review origin, never a family, so
 * it is no fallback either — an ask with no family fact is one this link cannot
 * scope.
 */
function askFamily(details: PromptPermissionDetails): string | undefined {
  return details.accessIntent?.surface ?? details.surface ?? undefined;
}

/** The full tool arguments for `toolCallId`, recovered from session entries. */
function recoverCommand(
  sessionManager: SessionEntriesReader | undefined,
  toolCallId: string | undefined,
): string | undefined {
  if (!sessionManager || !toolCallId) {
    return undefined;
  }
  let entries: unknown[];
  try {
    entries = sessionManager.getBranch();
  } catch {
    return undefined;
  }
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const message = (entries[i] as { message?: { content?: unknown[] } })
      .message;
    if (!message || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      const call = block as {
        type?: string;
        id?: string;
        arguments?: Record<string, unknown>;
      };
      if (call.type === "toolCall" && call.id === toolCallId) {
        const command = call.arguments?.command;
        return typeof command === "string" ? command : undefined;
      }
    }
  }
  return undefined;
}

export function createDecisionsJudge(deps: JudgeDeps): Authorizer["authorize"] {
  return async (
    details: PromptPermissionDetails,
    _query,
    log: AuthorizerLog,
  ) => {
    const config = deps.getConfig();
    const family = askFamily(details);
    const base: LogFields = {
      requestId: details.requestId,
      surface: family ?? null,
      source: details.source,
      tool: details.toolName,
    };

    const defer = (reason: string, fields: Record<string, unknown> = {}) => {
      log.debug("decisions_judge.defer", { ...base, reason, ...fields });
      return { kind: "defer" as const };
    };

    if (!config) {
      return defer("no_config");
    }
    if (family === undefined || !config.surfaces.includes(family)) {
      return defer("surface_not_configured", { surfaces: config.surfaces });
    }

    const command =
      details.command ??
      recoverCommand(deps.getSessionManager(), details.toolCallId);
    if (!command) {
      // D-16: judging a call we cannot see whole is not on the table.
      return defer("no_command");
    }

    const floor = floorRefusal(command);
    if (floor) {
      return defer(floor.reason, { rule: floor.rule });
    }
    const opaque = opaqueRefusal(command);
    if (opaque) {
      return defer(opaque.reason, { rule: opaque.rule });
    }

    const built = buildState({
      // `family` is defined here: the gate above defers without one.
      toolName: details.toolName ?? family,
      command,
      cwd: deps.getCwd(),
      latestUserMessage: deps.getLatestUserMessage(),
      maxStateTokens: config.limits.maxStateTokens,
    });
    if (built.overBudget) {
      return defer("state_over_budget", {
        tokensEstimate: built.tokensEstimate,
        maxStateTokens: config.limits.maxStateTokens,
      });
    }

    const questions = questionPayload();
    let result: AskResult;
    try {
      result = await askSystemOne({
        baseUrl: config.endpoint.baseUrl,
        path: config.endpoint.path,
        model: config.endpoint.model,
        state: built.state,
        questions,
        timeoutMs: config.endpoint.timeoutMs,
        transport: deps.transport,
        now: deps.now,
      });
    } catch (error) {
      const kind = error instanceof EndpointError ? error.kind : "unreachable";
      const detail = error instanceof Error ? error.message : String(error);
      return defer(`endpoint_${kind}`, { detail: detail.slice(0, 300) });
    }

    const verdict = aggregate(result.readings, config.thresholds);
    const fields = {
      command: maskSecretShapes(command),
      readings: result.readings,
      model: result.model,
      latencyMs: result.latencyMs,
      usage: result.usage,
      dropped: built.dropped,
      tokensEstimate: built.tokensEstimate,
      textVersion: QUESTIONS_TEXT_VERSION,
      thresholds: config.thresholds,
    };

    if (config.dryRun) {
      log.review("decisions_judge.dry_run", {
        ...base,
        ...fields,
        verdict: verdict.kind,
      });
      return { kind: "defer" as const };
    }

    if (verdict.kind === "allow") {
      log.review("decisions_judge.allow", {
        ...base,
        ...fields,
        minReading: verdict.minReading,
      });
      return { kind: "allow" as const };
    }
    if (verdict.kind === "deny") {
      const reason =
        `decisions-judge: ${verdict.label} (reading ${verdict.reading.toFixed(2)}, ` +
        `deny threshold ${config.thresholds.deny}). Do not retry this by rewording it; ` +
        `explain to the user why it is needed and ask them.`;
      log.review("decisions_judge.deny", {
        ...base,
        ...fields,
        key: verdict.key,
      });
      return { kind: "deny", reason };
    }
    log.review("decisions_judge.defer", {
      ...base,
      ...fields,
      why: verdict.reason,
    });
    return { kind: "defer" as const };
  };
}
