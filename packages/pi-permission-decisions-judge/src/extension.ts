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
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { PermissionsReadyEvent } from "@gotgenes/pi-permission-system";
import {
  getPermissionsService,
  PERMISSIONS_READY_CHANNEL,
} from "@gotgenes/pi-permission-system";

import {
  EXTENSION_ID,
  getGlobalConfigPath,
  LINK_NAME,
  type LoadConfigOptions,
  type LoadConfigResult,
  loadDecisionsJudgeConfig,
} from "./config.ts";
import { createDecisionsJudge, type SessionEntriesReader } from "./judge.ts";
import type { Transport } from "./systemone.ts";

export interface DecisionsJudgeDependencies {
  /** Seam for tests: the loader also answers whether the project may be read. */
  loadConfig?: (options: LoadConfigOptions) => LoadConfigResult;
  transport?: Transport;
}

function warn(message: string): void {
  console.warn(`[${EXTENSION_ID}] ${message}`);
}

/**
 * Surface a config problem where the operator will see it.
 *
 * These warnings fire at session start, before any prompt exists, so in a TUI
 * session a stdout write reaches nothing the operator looks at — the
 * notification is the only channel that lands. With no UI, stderr is the sink.
 * Same rule `pi-permission-model-judge` applies.
 */
function reportWarning(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, "warning");
    return;
  }
  warn(message);
}

export function createDecisionsJudgeExtension(
  pi: ExtensionAPI,
  dependencies: DecisionsJudgeDependencies = {},
): void {
  const loadConfig =
    dependencies.loadConfig ??
    ((options: LoadConfigOptions) => loadDecisionsJudgeConfig(options));

  let config: LoadConfigResult["config"];
  let sessionCtx: ExtensionContext | undefined;
  let sessionManager: SessionEntriesReader | undefined;
  let cwd = process.cwd();
  let latestUserMessage: string | undefined;
  let dispose: (() => void) | undefined;
  let warnedUnresolvedService = false;

  pi.on("session_start", (_event, ctx) => {
    sessionCtx = ctx;
    cwd = ctx.cwd;
    sessionManager = ctx.sessionManager;
    latestUserMessage = undefined;
    const result = loadConfig({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      projectTrusted: ctx.isProjectTrusted(),
    });
    config = result.config;
    for (const issue of result.issues) {
      reportWarning(
        ctx,
        `config issue at ${issue.sourcePath} — ${issue.path}: ${issue.message}`,
      );
    }
    if (result.untrustedProjectConfigPath) {
      reportWarning(
        ctx,
        `the project config at ${result.untrustedProjectConfigPath} was skipped because the project is untrusted — a project config chooses the endpoint that receives your prompt and the command under judgment. Trust this project, or move it to ${getGlobalConfigPath(getAgentDir())}.`,
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
      if (!warnedUnresolvedService && sessionCtx) {
        warnedUnresolvedService = true;
        reportWarning(
          sessionCtx,
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
    dispose = service.registerAuthorizer(LINK_NAME, authorize);
  });

  pi.on("session_shutdown", () => {
    dispose?.();
    dispose = undefined;
    config = undefined;
    sessionCtx = undefined;
    sessionManager = undefined;
    latestUserMessage = undefined;
    warnedUnresolvedService = false;
  });
}

/** The payload's session id, or `null` for any shape that cannot key the locator. */
function readySessionId(data: unknown): string | null {
  const sessionId = (data as Partial<PermissionsReadyEvent> | undefined)
    ?.sessionId;
  return typeof sessionId === "string" ? sessionId : null;
}
