/**
 * Config: zod source of truth, defaults, and load/merge/validate.
 *
 * This file carries the **model mechanism** half of ADR 0007's config split —
 * endpoint, model, thresholds, limits. The **chain policy** half
 * (`authorizerChain`, `modelDelegation`) lives in `@gotgenes/pi-permission-system`
 * and is not read here.
 *
 * No config file at all means the operator is declining the link: `loadConfig`
 * returns no config and the extension registers nothing (same posture as
 * `pi-permission-model-judge`).
 */

import { readFileSync } from "node:fs";
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
   * Which ask surfaces this link judges. A belt, not the authority: the hub's
   * `modelDelegation.allowedSurfaces` is what bounds delegation, and the
   * bounded-delegation checkpoint downgrades an out-of-scope `allow` to `defer`
   * whatever this says.
   */
  surfaces: z.array(z.string().min(1)).default(["bash"]),
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

function readJson(file: string): { raw: Record<string, unknown> } | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    return { raw: parsed as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

/**
 * Load the global config (`<agentDir>/extensions/<id>/config.json`) and the
 * project config (`<cwd>/.pi/<id>.json`), project over global.
 *
 * A file that exists but does not parse is reported as an issue and skipped —
 * a silently ignored typo must not turn a configured link into an unconfigured
 * one, and an unparseable file must not take the whole extension down.
 */
export function loadDecisionsJudgeConfig(options: {
  cwd: string;
  agentDir: string;
}): LoadConfigResult {
  const globalPath = join(
    options.agentDir,
    "extensions",
    EXTENSION_ID,
    "config.json",
  );
  const projectPath = join(options.cwd, ".pi", `${EXTENSION_ID}.json`);

  const issues: ConfigIssue[] = [];
  const found: { path: string; raw: Record<string, unknown> }[] = [];
  for (const path of [globalPath, projectPath]) {
    const read = readJson(path);
    if (read === undefined) {
      continue;
    }
    found.push({ path, raw: read.raw });
  }
  if (found.length === 0) {
    return { issues };
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
    return { issues };
  }
  return { config: parsed.data, issues };
}

/** Draft 2020-12 JSON Schema for `config.json`, derived from the zod source. */
export function buildDecisionsJudgeJsonSchema(): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(decisionsJudgeConfigSchema, {
    target: "draft-2020-12",
    io: "input",
  });
  return { $schema, ...rest };
}
