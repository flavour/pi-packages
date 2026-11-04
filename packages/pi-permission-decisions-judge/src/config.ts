/**
 * Config: zod source of truth, defaults, and load/merge/validate.
 *
 * This file carries the **model mechanism** half of ADR 0007's config split —
 * endpoint, model, thresholds, limits. The **chain policy** half — naming the
 * link in the hub's `authorizerChain` — lives in
 * `@gotgenes/pi-permission-system` and is not read here. The hub ships no
 * model-delegation surface list (SPEC §5), so this file's `surfaces` list is
 * the only surface scope a link can express.
 *
 * No config file at all means the operator is declining the link: `loadConfig`
 * returns no config and the extension registers nothing (same posture as
 * `pi-permission-model-judge`).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** Extension id — the `extensions/<id>/config.json` path segment. */
export const EXTENSION_ID = "pi-permission-decisions-judge";

/** The operator-facing chain-link name referenced from `authorizerChain`. */
export const LINK_NAME = "decisions-judge";

/**
 * Thresholds are provisional (D-14): the corpus that would justify other values
 * does not exist yet. They are the min-rule bands of D-24 — `allow` requires
 * every scored reading at or above `allow`, and any reading at or below `deny`
 * produces a teaching denial.
 */
export const DEFAULT_ALLOW_THRESHOLD = 0.7;
export const DEFAULT_DENY_THRESHOLD = 0.3;

/**
 * State budget, in estimated tokens. Measured: the state dominates latency, and
 * at `--parallel 4` four questions ride one state read (0.485 s), so the state
 * is what to keep small, not the question count.
 */
export const DEFAULT_MAX_STATE_TOKENS = 320;

/** Endpoint round-trip budget. Measured median at 4 questions: 0.485 s. */
export const DEFAULT_TIMEOUT_MS = 1500;

/** Cap on a config array's length, enforced before the schema walks it (#1090). */
const MAX_CONFIG_ARRAY_ITEMS = 1000;

const CONFIG_FILE_NAME = "config.json";

/** The operator's global layer: `<agentDir>/extensions/<id>/config.json`. */
export function getGlobalConfigPath(agentDir: string): string {
  return join(agentDir, "extensions", EXTENSION_ID, CONFIG_FILE_NAME);
}

/**
 * The project layer: `<cwd>/.pi/extensions/<id>/config.json`.
 *
 * The same layout the hub and `pi-permission-model-judge` read, so one
 * repository's `.pi/extensions/` directory holds every permission-layer config.
 * A `.pi/<id>.json` file a draft of this package once read is not consulted.
 * The layer is only read when the project is trusted.
 */
export function getProjectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "extensions", EXTENSION_ID, CONFIG_FILE_NAME);
}

export const decisionsJudgeConfigSchema = z.object({
  endpoint: z
    .object({
      baseUrl: z.url().default("http://jetson:9931"),
      /** Anything speaking this API qualifies (D-03): llama.cpp today, a hosted service later. */
      path: z.string().startsWith("/").default("/v1/systemone"),
      model: z.string().min(1).default("LiquidAI/d1-3B-GGUF:Q8_0"),
      timeoutMs: z
        .number()
        .int()
        .min(250)
        .max(60_000)
        .default(DEFAULT_TIMEOUT_MS),
    })
    .prefault({}),
  thresholds: z
    .object({
      allow: z.number().min(0).max(1).default(DEFAULT_ALLOW_THRESHOLD),
      deny: z.number().min(0).max(1).default(DEFAULT_DENY_THRESHOLD),
    })
    .prefault({}),
  limits: z
    .object({
      maxStateTokens: z
        .number()
        .int()
        .min(32)
        .max(4096)
        .default(DEFAULT_MAX_STATE_TOKENS),
    })
    .prefault({}),
  /**
   * Which ask families this link judges, matched against the gate family the
   * hub stamps on `accessIntent.surface` (`bash`, `path`, `external_directory`,
   * …). This list is a belt, not the authority: the hub's bounded-delegation
   * checkpoint caps what any link's `allow` can reach whatever this says, and
   * the hub keeps no separate model-delegation surface list.
   */
  surfaces: z
    .array(z.string().min(1))
    .max(MAX_CONFIG_ARRAY_ITEMS)
    .default(["bash"]),
  /**
   * Evaluation mode: run the whole pipeline, log the exact prompt and readings,
   * then `defer`. Lets a corpus be collected against a live endpoint without
   * the link ever deciding.
   */
  dryRun: z.boolean().default(false),
});

export type DecisionsJudgeConfig = z.infer<typeof decisionsJudgeConfigSchema>;

export interface ConfigIssue {
  sourcePath: string;
  path: string;
  message: string;
}

export interface LoadConfigResult {
  config?: DecisionsJudgeConfig;
  issues: ConfigIssue[];
  /** The project config file left unread because the project is untrusted. */
  untrustedProjectConfigPath?: string;
}

/** Object keys merged one level deep rather than replaced wholesale. */
const NESTED_KEYS = ["endpoint", "thresholds", "limits"] as const;

function mergeConfig(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base, ...override };
  for (const key of NESTED_KEYS) {
    const a = base[key];
    const b = override[key];
    if (
      a !== undefined &&
      b !== undefined &&
      typeof a === "object" &&
      typeof b === "object" &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    ) {
      merged[key] = {
        ...(a as Record<string, unknown>),
        ...(b as Record<string, unknown>),
      };
    }
  }
  return merged;
}

/**
 * Read and JSON-parse one layer.
 *
 * `undefined` means the file is absent. A file that is present but unreadable —
 * bad JSON, or a JSON array/scalar where an object belongs — is recorded as an
 * issue and skipped, so a typo in a config file is a message rather than a link
 * that silently stops judging (the hub reports the same shape, #1090).
 */
function readLayer(
  path: string,
  sourcePath: string,
  issues: ConfigIssue[],
): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      issues.push({
        sourcePath,
        path: "(root)",
        message: "Config must be a JSON object.",
      });
      return undefined;
    }
    return parsed;
  } catch (error) {
    issues.push({
      sourcePath,
      path: "(root)",
      message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Where each config layer lives and whether the project one may be read. */
export interface LoadConfigOptions {
  cwd: string;
  agentDir: string;
  /** False on an untrusted project: its config layer is then not read at all. */
  projectTrusted: boolean;
}

/**
 * Load the global config and, when the project is trusted, the project config,
 * project over global, validated once against the zod source of truth.
 *
 * A file that exists but does not parse is reported as an issue and skipped —
 * a silently ignored typo must not turn a configured link into an unconfigured
 * one, and an unparseable file must not take the whole extension down.
 *
 * The project layer is read only on a trusted project: this config chooses the
 * endpoint that receives the user's prompt and the command under judgment, and
 * `thresholds.allow` decides when that endpoint's reading becomes an `allow`.
 * A checkout that can write `.pi/extensions/` can therefore pick the host and
 * lower the bar, so it gets no vote — the hub and `pi-permission-model-judge`
 * gate the same way (#1092).
 */
export function loadDecisionsJudgeConfig(
  options: LoadConfigOptions,
): LoadConfigResult {
  const globalPath = getGlobalConfigPath(options.agentDir);
  const projectPath = getProjectConfigPath(options.cwd);

  const issues: ConfigIssue[] = [];
  const found: { path: string; raw: Record<string, unknown> }[] = [];
  for (const path of [globalPath, projectPath]) {
    if (path === projectPath && !options.projectTrusted) {
      continue;
    }
    const raw = readLayer(path, path, issues);
    if (raw === undefined) {
      continue;
    }
    found.push({ path, raw });
  }

  const untrustedProjectConfigPath =
    !options.projectTrusted && existsSync(projectPath)
      ? projectPath
      : undefined;

  if (found.length === 0) {
    return { issues, untrustedProjectConfigPath };
  }

  let merged = found[0].raw;
  for (const entry of found.slice(1)) {
    merged = mergeConfig(merged, entry.raw);
  }

  const parsed = decisionsJudgeConfigSchema.safeParse(merged);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        sourcePath: found[found.length - 1].path,
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      });
    }
    return { issues, untrustedProjectConfigPath };
  }
  return { config: parsed.data, issues, untrustedProjectConfigPath };
}

/** Draft 2020-12 JSON Schema for `config.json`, derived from the zod source. */
export function buildDecisionsJudgeJsonSchema(): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(decisionsJudgeConfigSchema, {
    target: "draft-2020-12",
    io: "input",
  });
  return { $schema, ...rest };
}
