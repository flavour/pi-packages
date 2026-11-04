import { describe, expect, it } from "vitest";

import { buildState, estimateTokens, maskSecretShapes } from "#src/state.ts";

describe("estimateTokens", () => {
  it("is a coarse character/4 estimate", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("maskSecretShapes", () => {
  it("masks api-key shapes", () => {
    expect(
      maskSecretShapes("Authorization: sk-abcdefghijklmnop12345"),
    ).toContain("[masked:api key]");
    expect(
      maskSecretShapes("Authorization: sk-abcdefghijklmnop12345"),
    ).not.toContain("sk-abcdef");
  });

  it("masks JWTs and private key blocks", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjT0kF9qLxYmZ3vQ7pR2sT4uV6wX8yZ";
    expect(maskSecretShapes(`token ${jwt}`)).toContain("[masked:jwt]");
    const key =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----";
    expect(maskSecretShapes(key)).toContain("[masked:private key]");
  });

  it("leaves an ordinary command alone", () => {
    expect(maskSecretShapes("npm test")).toBe("npm test");
  });
});

describe("buildState", () => {
  it("fits inside the budget without dropping anything", () => {
    const built = buildState({
      toolName: "bash",
      command: "rm -rf build",
      cwd: "/home/fran/code/app",
      latestUserMessage: "clean the build directory before rebuilding",
      facts: ["cwd is a git repo"],
      maxStateTokens: 320,
    });
    expect(built.dropped).toEqual([]);
    expect(built.overBudget).toBe(false);
    const context = built.state.context;
    expect(context.latest_user_message).toBe(
      "clean the build directory before rebuilding",
    );
    expect(context.facts).toEqual(["cwd is a git repo"]);
  });

  it("cuts context before the call, in order: facts, message tail, message", () => {
    const built = buildState({
      toolName: "bash",
      command: "npm test",
      cwd: "/home/fran/code/app",
      latestUserMessage: "x".repeat(300),
      facts: ["cwd is a git repo"],
      maxStateTokens: 40,
    });
    expect(built.dropped).toEqual([
      "facts",
      "user_message_tail",
      "user_message",
    ]);
    const context = built.state.context;
    expect(context.latest_user_message).toBeUndefined();
    expect(context.facts).toBeUndefined();
    expect(built.overBudget).toBe(false);
  });

  it("reports overBudget when the call itself will not fit, rather than truncating it (D-16)", () => {
    const built = buildState({
      toolName: "bash",
      command: "echo ".concat("y".repeat(2000)),
      cwd: "/home/fran/code/app",
      maxStateTokens: 320,
    });
    expect(built.overBudget).toBe(true);
    const value = built.state.value as Record<string, string>;
    expect(value.command).toContain("yyyy");
  });

  it("masks secret shapes in the command before it leaves the machine", () => {
    const built = buildState({
      toolName: "bash",
      command:
        "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'",
      cwd: "/tmp",
      maxStateTokens: 320,
    });
    const value = built.state.value as Record<string, string>;
    expect(value.command).toContain("[masked:bearer token]");
    expect(value.command).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});
