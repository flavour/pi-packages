import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  PermissionsReadyEvent,
  PermissionsService,
} from "@gotgenes/pi-permission-system";
import {
  publishPermissionsService,
  unpublishPermissionsService,
} from "@gotgenes/pi-permission-system";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LINK_NAME,
  type LoadConfigOptions,
  type LoadConfigResult,
} from "#src/config.ts";
import { createDecisionsJudgeExtension } from "#src/extension.ts";

const READY_CHANNEL = "permissions:ready";

/** The session id of the node under test — the key its service publishes under. */
const SESSION_ID = "session-under-test";

const CONFIG: LoadConfigResult["config"] = {
  endpoint: {
    baseUrl: "http://jetson:9931",
    path: "/v1/systemone",
    model: "LiquidAI/d1-3B-GGUF:Q8_0",
    timeoutMs: 1500,
  },
  thresholds: { allow: 0.7, deny: 0.3 },
  limits: { maxStateTokens: 320 },
  surfaces: ["bash"],
  dryRun: false,
};

function configResult(
  overrides: Partial<LoadConfigResult> = {},
): LoadConfigResult {
  return { config: CONFIG, issues: [], ...overrides };
}

interface FakePi {
  lifecycle: Map<string, (event: unknown, ctx: unknown) => void>;
  events: Map<string, (data: unknown) => void>;
  api: ExtensionAPI;
}

function makeFakePi(): FakePi {
  const lifecycle = new Map<string, (event: unknown, ctx: unknown) => void>();
  const events = new Map<string, (data: unknown) => void>();
  return {
    lifecycle,
    events,
    api: {
      on: vi.fn(
        (name: string, handler: (event: unknown, ctx: unknown) => void) => {
          lifecycle.set(name, handler);
        },
      ),
      events: {
        on: vi.fn((channel: string, handler: (data: unknown) => void) => {
          events.set(channel, handler);
          return () => events.delete(channel);
        }),
        emit: vi.fn(),
      },
    },
  } as unknown as FakePi;
}

function makeService() {
  const disposer = vi.fn();
  return {
    checkPermission: vi.fn(),
    getToolPermission: vi.fn(),
    isToolFullyDenied: vi.fn(),
    getToolAccessExtractor: vi.fn(),
    getToolInputFormatter: vi.fn(),
    registerToolInputFormatter: vi.fn(() => () => {}),
    registerToolAccessExtractor: vi.fn(() => () => {}),
    registerAuthorizer: vi.fn(() => disposer),
    disposer,
  } as unknown as PermissionsService & {
    registerAuthorizer: Mock<() => () => void>;
  };
}

/** How a test session differs from the trusted, UI-less default. */
interface SessionOverrides {
  cwd?: string;
  trusted?: boolean;
  hasUI?: boolean;
}

/**
 * The `session_start` context: trusted and UI-less unless a test says otherwise,
 * so a test that cares about neither still exercises the console path with the
 * project layer in scope.
 */
function makeCtx(cwd = "/project", overrides: SessionOverrides = {}) {
  return {
    cwd,
    hasUI: overrides.hasUI ?? false,
    isProjectTrusted: () => overrides.trusted ?? true,
    ui: { notify: vi.fn<(message: string, type?: string) => void>() },
    sessionManager: { getSessionId: () => SESSION_ID, getBranch: () => [] },
  };
}

type FakeCtx = ReturnType<typeof makeCtx>;

/** Every UI warning the run surfaced, in order. */
function noticesOf(ctx: FakeCtx): string[] {
  return ctx.ui.notify.mock.calls.map(([message]) => message);
}

/** Wire the extension with a stub loader, then drive one session. */
function runSession(
  pi: FakePi,
  ctx: FakeCtx,
  loadConfig: (options: LoadConfigOptions) => LoadConfigResult,
  readySessionId: string | null = SESSION_ID,
): void {
  createDecisionsJudgeExtension(pi.api, { loadConfig });
  const sessionStart = pi.lifecycle.get("session_start");
  if (!sessionStart) {
    throw new Error("extension did not register a session_start handler");
  }
  sessionStart({ reason: "startup" }, ctx);
  emitReady(pi, readySessionId);
}

function emitReady(pi: FakePi, sessionId: string | null = SESSION_ID): void {
  const ready = pi.events.get(READY_CHANNEL);
  if (!ready) {
    throw new Error("extension did not subscribe to permissions:ready");
  }
  // `adjudicatesLocally: true` — the node under test runs its own chain, the
  // only case in which a registration is ever consulted.
  const event: PermissionsReadyEvent = { sessionId, adjudicatesLocally: true };
  ready(event);
}

let service: ReturnType<typeof makeService>;

beforeEach(() => {
  service = makeService();
  publishPermissionsService(SESSION_ID, service);
});

afterEach(() => {
  unpublishPermissionsService(SESSION_ID, service);
  vi.restoreAllMocks();
});

describe("decisions judge extension", () => {
  it("registers the link under the name the operator writes in authorizerChain", () => {
    const pi = makeFakePi();
    runSession(pi, makeCtx(), () => configResult());
    expect(service.registerAuthorizer).toHaveBeenCalledWith(
      LINK_NAME,
      expect.any(Function),
    );
    expect(LINK_NAME).toBe("decisions-judge");
  });

  it("registers nothing when the operator has no config", () => {
    const pi = makeFakePi();
    runSession(pi, makeCtx(), () => ({ issues: [] }));
    expect(service.registerAuthorizer).not.toHaveBeenCalled();
  });

  it("registers nothing when the session publishes no permission service", () => {
    const pi = makeFakePi();
    runSession(pi, makeCtx(), () => configResult(), null);
    expect(service.registerAuthorizer).not.toHaveBeenCalled();
  });

  it("shows an invalid config to the operator as a UI warning, not stdout", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pi = makeFakePi();
    const ctx = makeCtx("/repo", { hasUI: true });
    runSession(pi, ctx, () =>
      configResult({
        config: undefined,
        issues: [
          {
            sourcePath:
              "/home/fran/.pi/agent/extensions/pi-permission-decisions-judge/config.json",
            path: "endpoint.baseUrl",
            message: "Invalid URL",
          },
        ],
      }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid URL"),
      "warning",
    );
    expect(service.registerAuthorizer).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to console.warn when the session has no UI", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pi = makeFakePi();
    runSession(pi, makeCtx("/repo"), () =>
      configResult({
        config: undefined,
        issues: [
          {
            sourcePath:
              "/repo/.pi/extensions/pi-permission-decisions-judge/config.json",
            path: "surfaces",
            message: "Array must contain at most 1000 element(s)",
          },
        ],
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "surfaces: Array must contain at most 1000 element(s)",
      ),
    );
  });

  it("names the config file whose JSON did not parse", () => {
    const pi = makeFakePi();
    const ctx = makeCtx("/repo", { hasUI: true });
    runSession(pi, ctx, () =>
      configResult({
        config: undefined,
        issues: [
          {
            sourcePath:
              "/home/fran/.pi/agent/extensions/pi-permission-decisions-judge/config.json",
            path: "(root)",
            message: "Invalid JSON: Unexpected token",
          },
        ],
      }),
    );
    expect(noticesOf(ctx).join("\n")).toContain("Invalid JSON");
  });

  it("asks the loader to skip the project layer on an untrusted project", () => {
    let trustedSeen: boolean | undefined;
    const pi = makeFakePi();
    runSession(pi, makeCtx("/repo", { trusted: false }), (options) => {
      trustedSeen = options.projectTrusted;
      return configResult();
    });
    expect(trustedSeen).toBe(false);
    expect(service.registerAuthorizer).toHaveBeenCalledWith(
      LINK_NAME,
      expect.any(Function),
    );
  });

  it("passes a trusted project's trust through to the loader", () => {
    let trustedSeen: boolean | undefined;
    const pi = makeFakePi();
    runSession(pi, makeCtx("/repo", { trusted: true }), (options) => {
      trustedSeen = options.projectTrusted;
      return configResult();
    });
    expect(trustedSeen).toBe(true);
  });

  it("names the project config left unread on an untrusted project", () => {
    const pi = makeFakePi();
    const ctx = makeCtx("/repo", { trusted: false, hasUI: true });
    runSession(pi, ctx, () =>
      configResult({
        untrustedProjectConfigPath:
          "/repo/.pi/extensions/pi-permission-decisions-judge/config.json",
      }),
    );
    expect(noticesOf(ctx).join("\n")).toContain(
      ".pi/extensions/pi-permission-decisions-judge/config.json",
    );
  });

  it("reports an untrusted project's skipped config once per session", () => {
    const pi = makeFakePi();
    const ctx = makeCtx("/repo", { trusted: false, hasUI: true });
    runSession(pi, ctx, () =>
      configResult({
        untrustedProjectConfigPath:
          "/repo/.pi/extensions/pi-permission-decisions-judge/config.json",
      }),
    );
    emitReady(pi);
    emitReady(pi);
    expect(
      noticesOf(ctx).filter((text) => text.includes("untrusted")),
    ).toHaveLength(1);
  });

  it("warns over the UI that the link is inert when no service is published", () => {
    const pi = makeFakePi();
    const ctx = makeCtx("/repo", { hasUI: true });
    runSession(pi, ctx, () => configResult(), null);
    expect(noticesOf(ctx).join("\n")).toContain("pi-permission-system");
  });

  it("warns only once that no permission service was published", () => {
    const pi = makeFakePi();
    const ctx = makeCtx("/repo", { hasUI: true });
    runSession(pi, ctx, () => configResult(), null);
    emitReady(pi, null);
    emitReady(pi, null);
    expect(
      noticesOf(ctx).filter((text) =>
        text.includes("published no permission service"),
      ),
    ).toHaveLength(1);
  });
});
