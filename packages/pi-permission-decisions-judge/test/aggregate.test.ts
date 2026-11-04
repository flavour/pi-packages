import { describe, expect, it } from "vitest";

import { aggregate, unsafeReading } from "#src/aggregate.ts";

const T = { allow: 0.7, deny: 0.3 };

const clean = {
  authorized: 0.9,
  reversible: 0.85,
  blast_radius: 0.8,
  exfiltration: 0.02,
};

describe("unsafeReading", () => {
  it("passes through a question phrased so a high reading is unsafe", () => {
    expect(unsafeReading("exfiltration", 0.9)).toBe(0.9);
  });

  it("flips a question phrased so a high reading is safe", () => {
    expect(unsafeReading("reversible", 0.9)).toBeCloseTo(0.1);
  });
});

describe("aggregate", () => {
  it("allows when every scored reading clears the allow band and the veto is clean", () => {
    const verdict = aggregate(clean, T);
    expect(verdict.kind).toBe("allow");
    if (verdict.kind === "allow") {
      expect(verdict.minReading).toBe(0.8);
    }
  });

  it("defers when a scored reading sits in the band between the thresholds", () => {
    const verdict = aggregate({ ...clean, authorized: 0.5 }, T);
    expect(verdict.kind).toBe("defer");
    if (verdict.kind === "defer") {
      expect(verdict.reason).toBe("below_allow");
    }
  });

  it("denies when a scored reading is a confident no, naming the failing question", () => {
    const verdict = aggregate({ ...clean, reversible: 0.05 }, T);
    expect(verdict.kind).toBe("deny");
    if (verdict.kind === "deny") {
      expect(verdict.key).toBe("reversible");
      expect(verdict.label).toBe("not undoable or regenerable");
    }
  });

  it("denies on a confident exfiltration reading whatever the scored readings say", () => {
    const verdict = aggregate({ ...clean, exfiltration: 0.9 }, T);
    expect(verdict.kind).toBe("deny");
    if (verdict.kind === "deny") {
      expect(verdict.key).toBe("exfiltration");
    }
  });

  it("defers rather than allows on an uncertain exfiltration reading", () => {
    const verdict = aggregate({ ...clean, exfiltration: 0.5 }, T);
    expect(verdict.kind).toBe("defer");
    if (verdict.kind === "defer") {
      expect(verdict.reason).toBe("veto_uncertain");
    }
  });

  it("defers when an answer is missing — an absent reading is never read as 0", () => {
    const missing = { ...clean };
    delete (missing as Record<string, number>).blast_radius;
    const verdict = aggregate(missing, T);
    expect(verdict.kind).toBe("defer");
    if (verdict.kind === "defer") {
      expect(verdict.reason).toBe("missing_answer");
      expect(verdict.key).toBe("blast_radius");
    }
  });

  it("does not allow when the veto is merely not-confidently-bad", () => {
    // unsafe 0.4 is above the 0.3 uncertainty edge, so it must not allow.
    const verdict = aggregate({ ...clean, exfiltration: 0.4 }, T);
    expect(verdict.kind).toBe("defer");
  });
});
