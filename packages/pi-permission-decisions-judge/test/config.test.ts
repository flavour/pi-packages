import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EXTENSION_ID,
  getGlobalConfigPath,
  getProjectConfigPath,
  loadDecisionsJudgeConfig,
} from "#src/config.ts";

/** The smallest config that parses, differentiated per test by `baseUrl`. */
function configNamed(baseUrl: string): Record<string, unknown> {
  return { endpoint: { baseUrl } };
}

let root: string;
let cwd: string;
let agentDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "decisions-judge-config-"));
  cwd = join(root, "project");
  agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeAt(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function writeGlobal(value: unknown): void {
  writeAt(getGlobalConfigPath(agentDir), value);
}

function writeProject(value: unknown): void {
  writeAt(getProjectConfigPath(cwd), value);
}

function load(projectTrusted = true) {
  return loadDecisionsJudgeConfig({ cwd, agentDir, projectTrusted });
}

describe("decisions judge config", () => {
  it("declines the link when no config file exists", () => {
    const result = load();
    expect(result.config).toBeUndefined();
    expect(result.issues).toEqual([]);
  });

  it("loads the global config, filling defaults", () => {
    writeGlobal(configNamed("http://localhost:8080"));
    const result = load();
    expect(result.config?.endpoint.baseUrl).toBe("http://localhost:8080");
    expect(result.config?.endpoint.model).toBe("LiquidAI/d1-3B-GGUF:Q8_0");
    expect(result.config?.surfaces).toEqual(["bash"]);
  });

  it("reads the project config beside the hub's, and the project layer wins", () => {
    writeGlobal(configNamed("http://global:9931"));
    writeProject(configNamed("http://project:9931"));
    const result = load();
    expect(result.config?.endpoint.baseUrl).toBe("http://project:9931");
    expect(getProjectConfigPath(cwd)).toBe(
      join(cwd, ".pi", "extensions", EXTENSION_ID, "config.json"),
    );
  });

  it("ignores a flat project file that predates the hub's config convention", () => {
    writeAt(join(cwd, ".pi", `${EXTENSION_ID}.json`), {
      endpoint: { baseUrl: "http://stale:9931" },
    });
    expect(load().config).toBeUndefined();
  });

  describe("the project layer on an untrusted project", () => {
    it("is not read, and its endpoint cannot reach the config", () => {
      writeGlobal(configNamed("http://global:9931"));
      writeProject({ endpoint: { baseUrl: "http://attacker:9931" } });
      const result = load(false);
      expect(result.config?.endpoint.baseUrl).toBe("http://global:9931");
    });

    it("still loads the global layer when the project is untrusted", () => {
      writeGlobal(configNamed("http://global:9931"));
      expect(load(false).config?.endpoint.baseUrl).toBe("http://global:9931");
    });

    it("names the skipped file so the operator can be told where it lives", () => {
      writeGlobal(configNamed("http://global:9931"));
      writeProject(configNamed("http://project:9931"));
      expect(load(false).untrustedProjectConfigPath).toBe(
        getProjectConfigPath(cwd),
      );
    });

    it("names the skipped file when it is the only config present", () => {
      writeProject(configNamed("http://project:9931"));
      const result = load(false);
      expect(result.config).toBeUndefined();
      expect(result.untrustedProjectConfigPath).toBe(getProjectConfigPath(cwd));
    });

    it("stays absent when untrusted and no project file exists", () => {
      writeGlobal(configNamed("http://global:9931"));
      expect(load(false).untrustedProjectConfigPath).toBeUndefined();
    });

    it("stays absent when the project is trusted", () => {
      writeGlobal(configNamed("http://global:9931"));
      writeProject(configNamed("http://project:9931"));
      expect(load(true).untrustedProjectConfigPath).toBeUndefined();
    });
  });

  it("reports a malformed config file instead of failing the load", () => {
    const path = getGlobalConfigPath(agentDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not valid json ");
    const result = load();
    expect(result.config).toBeUndefined();
    expect(result.issues.length).toBeGreaterThan(0);
  });

  describe("array bounds (#1090 parity with the hub and model-judge)", () => {
    const surfacesAt = (count: number): string[] =>
      Array.from({ length: count }, (_, i) => `surface_${i}`);

    it("rejects a surfaces list longer than the cap before walking it", () => {
      writeGlobal({ surfaces: surfacesAt(1001) });
      const result = load();
      expect(result.config).toBeUndefined();
      expect(result.issues[0]?.message).toContain("1000");
    });

    it("accepts a surfaces list at the cap", () => {
      writeGlobal({ surfaces: surfacesAt(1000) });
      expect(load().config?.surfaces).toHaveLength(1000);
    });
  });
});
