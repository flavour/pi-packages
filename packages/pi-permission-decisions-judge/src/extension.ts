/**
 * Extension wiring: load config at `session_start`, capture the latest user
 * prompt and the session manager, register the `decisions-judge` link from the
 * `permissions:ready` handler, dispose on shutdown.
 *
 * The ready event fires at least once per session and may repeat, and its latch
 * emission runs after every extension's `session_start` (hub ADR 0012 decision
 * 3), so the handler alone is a sufficient registration site with an idempotence
 * guard. Registration grants no authority on its own: the operator must name
 * this link in `authorizerChain` (hub ADR 0007 §4).
 */

import {
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { PermissionsReadyEvent } from "@gotgenes/pi-permission-system";
import {
  getPermissionsService,
  PERMISSIONS_READY_CHANNEL,
} from "@gotgenes/pi-permission-system";

import {
  EXTENSION_ID,
  type LoadConfigResult,
  loadDecisionsJudgeConfig,
} from "./config.ts";
import { createDecisionsJudge, type SessionEntriesReader } from "./judge.ts";
import type { Transport } from "./systemone.ts";

export interface DecisionsJudgeDependencies {
  loadConfig?: (cwd: string) => LoadConfigResult;
  transport?: Transport;
}

function warn(message: string): void {
  console.warn(`[${EXTENSION_ID}] ${message}`);
}

export function createDecisionsJudgeExtension(
  pi: ExtensionAPI,
  dependencies: DecisionsJudgeDependencies = {},
): void {
  const loadConfig =
    dependencies.loadConfig ??
    ((cwd: string) =>
      loadDecisionsJudgeConfig({ cwd, agentDir: getAgentDir() }));

  let config: LoadConfigResult["config"];
  let sessionManager: SessionEntriesReader | undefined;
  let cwd = process.cwd();
  let latestUserMessage: string | undefined;
  let dispose: (() => void) | undefined;
  let warnedUnresolvedService = false;

  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd;
    sessionManager = ctx.sessionManager;
    latestUserMessage = undefined;
    const result = loadConfig(ctx.cwd);
    config = result.config;
    for (const issue of result.issues) {
      warn(
        `config issue at ${issue.sourcePath} — ${issue.path}: ${issue.message}`,
      );
    }
  });

  // The authorization question (D-23 `authorized`) is answered against the
  // user's own words, so the link keeps the prompt that started this run.
  pi.on("before_agent_start", (event) => {
    // Read structurally: `messageType` is a 1.2 addition, and a run started by
    // an extension message carries no user prompt at all.
    const prompt = (event as { prompt?: unknown }).prompt;
    if (typeof prompt === "string") {
      latestUserMessage = prompt;
    }
  });

  pi.events.on(PERMISSIONS_READY_CHANNEL, (data) => {
    if (dispose || !config) {
      return;
    }
    const sessionId = readySessionId(data);
    const service =
      sessionId === null ? undefined : getPermissionsService(sessionId);
    if (!service) {
      if (!warnedUnresolvedService) {
        warnedUnresolvedService = true;
        warn(
          "this session's node published no permission service, so the decisions-judge link is not registered — @gotgenes/pi-permission-system must be loaded in the same session.",
        );
      }
      return;
    }
    const authorize = createDecisionsJudge({
      getConfig: () => config,
      getCwd: () => cwd,
      getLatestUserMessage: () => latestUserMessage,
      getSessionManager: () => sessionManager,
      transport: dependencies.transport,
    });
    dispose = service.registerAuthorizer(EXTENSION_LINK_NAME, authorize);
  });

  pi.on("session_shutdown", () => {
    dispose?.();
    dispose = undefined;
    config = undefined;
    sessionManager = undefined;
    latestUserMessage = undefined;
    warnedUnresolvedService = false;
  });
}

/** The operator-facing chain-link name referenced from `authorizerChain`. */
export const EXTENSION_LINK_NAME = "decisions-judge";

/** The payload's session id, or `null` for any shape that cannot key the locator. */
function readySessionId(data: unknown): string | null {
  const sessionId = (data as Partial<PermissionsReadyEvent> | undefined)
    ?.sessionId;
  return typeof sessionId === "string" ? sessionId : null;
}
