import { afterEach, describe, expect, it, vi } from "vitest";

import { askSystemOne, EndpointError, parseAnswers } from "#src/systemone.ts";

const QUESTIONS = { a: { type: "noul" }, b: { type: "noul" } };

describe("askSystemOne", () => {
  it("posts one request with every question and returns the readings", async () => {
    const seen: { url: string; payload: unknown; timeoutMs: number }[] = [];
    const result = await askSystemOne({
      baseUrl: "http://jetson:9931",
      path: "/v1/systemone",
      model: "LiquidAI/d1-3B-GGUF:Q8_0",
      state: { value: { command: "npm test" } },
      questions: QUESTIONS,
      timeoutMs: 1500,
      transport: async (url, payload, timeoutMs) => {
        seen.push({ url, payload, timeoutMs });
        return {
          model: "LiquidAI/d1-3B-GGUF:Q8_0",
          answers: {
            a: { type: "noul", noul: 0.9 },
            b: { type: "noul", noul: 0.4 },
          },
          usage: { input_tokens: 120, output_tokens: 0 },
        };
      },
    });
    expect(seen[0].url).toBe("http://jetson:9931/v1/systemone");
    expect(seen[0].timeoutMs).toBe(1500);
    expect(seen[0].payload).toMatchObject({
      model: "LiquidAI/d1-3B-GGUF:Q8_0",
    });
    expect(result.readings).toEqual({ a: 0.9, b: 0.4 });
    expect(result.usage).toEqual({ input_tokens: 120, output_tokens: 0 });
  });
});

describe("parseAnswers", () => {
  it("accepts a well-formed answer set", () => {
    const result = parseAnswers(
      {
        answers: {
          a: { type: "noul", noul: 0.5 },
          b: { type: "noul", noul: 0.2 },
        },
      },
      ["a", "b"],
      12,
    );
    expect(result.readings.b).toBe(0.2);
    expect(result.latencyMs).toBe(12);
  });

  it("fails as a parse error when a requested answer is missing", () => {
    expect(() =>
      parseAnswers(
        { answers: { a: { type: "noul", noul: 0.5 } } },
        ["a", "b"],
        1,
      ),
    ).toThrow(EndpointError);
    try {
      parseAnswers(
        { answers: { a: { type: "noul", noul: 0.5 } } },
        ["a", "b"],
        1,
      );
    } catch (error) {
      expect((error as EndpointError).kind).toBe("parse");
      expect((error as EndpointError).detail).toContain("`b`");
    }
  });

  it("fails when an answer is not a finite noul", () => {
    try {
      parseAnswers(
        {
          answers: {
            a: { type: "score", score: 0.5 },
            b: { type: "noul", noul: 0.2 },
          },
        },
        ["a", "b"],
        1,
      );
      expect.unreachable();
    } catch (error) {
      expect((error as EndpointError).kind).toBe("parse");
    }
  });

  it("clamps an out-of-range reading instead of rejecting it", () => {
    const result = parseAnswers(
      {
        answers: {
          a: { type: "noul", noul: 1.4 },
          b: { type: "noul", noul: -0.2 },
        },
      },
      ["a", "b"],
      1,
    );
    expect(result.readings).toEqual({ a: 1, b: 0 });
  });

  it("fails when the response has no answers object", () => {
    try {
      parseAnswers({ error: { message: "input is too large" } }, ["a"], 1);
      expect.unreachable();
    } catch (error) {
      expect((error as EndpointError).kind).toBe("parse");
    }
  });
});

describe("fetchTransport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps a non-2xx response to an http failure carrying the server message", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 500,
      text: async () =>
        '{"error":{"message":"input (3843 tokens) is too large"}}',
    }));
    try {
      await askSystemOne({
        baseUrl: "http://jetson:9931",
        path: "/v1/systemone",
        model: "m",
        state: "s",
        questions: QUESTIONS,
        timeoutMs: 1000,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as EndpointError).kind).toBe("http");
      expect((error as EndpointError).detail).toContain("too large");
    }
  });

  it("maps a connection failure to unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    try {
      await askSystemOne({
        baseUrl: "http://jetson:9931",
        path: "/v1/systemone",
        model: "m",
        state: "s",
        questions: QUESTIONS,
        timeoutMs: 1000,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as EndpointError).kind).toBe("unreachable");
    }
  });

  it("maps an aborted request to timeout", async () => {
    vi.stubGlobal("fetch", async () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    });
    try {
      await askSystemOne({
        baseUrl: "http://jetson:9931",
        path: "/v1/systemone",
        model: "m",
        state: "s",
        questions: QUESTIONS,
        timeoutMs: 1000,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as EndpointError).kind).toBe("timeout");
    }
  });
});
