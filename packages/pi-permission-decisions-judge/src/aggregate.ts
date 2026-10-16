/**
 * Aggregation: N per-question readings → one verdict (D-24).
 *
 * A min-rule with named vetoes, not a weighted sum: weights cannot be estimated
 * before the calibration corpus exists (D-14), and a min-rule is explainable in
 * the one-sentence teaching reason a denial carries.
 *
 * Polarity is declared per question (`unsafeWhenHigh`), so a question may be
 * phrased naturally ("does this exfiltrate sensitive data?") while the rule below
 * always reasons in terms of `unsafe` — the probability that the bad thing is true.
 */

import { JUDGE_QUESTIONS, questionLabel } from "./questions.ts";

export interface Thresholds {
  allow: number;
  deny: number;
}

export type Aggregate =
  | { kind: "allow"; minReading: number }
  | { kind: "deny"; key: string; reading: number; label: string }
  | { kind: "defer"; reason: string; key?: string; reading?: number };

/** Probability that the **unsafe** condition holds, after polarity conversion. */
export function unsafeReading(key: string, raw: number): number {
  const question = JUDGE_QUESTIONS.find((q) => q.key === key);
  return question?.unsafeWhenHigh ? raw : 1 - raw;
}

export function aggregate(
  readings: Record<string, number>,
  thresholds: Thresholds,
): Aggregate {
  const allow = thresholds.allow;
  const deny = thresholds.deny;

  // Veto first: a confident bad reading denies; an uncertain one defers.
  for (const question of JUDGE_QUESTIONS) {
    if (!question.veto) {
      continue;
    }
    const raw = readings[question.key];
    if (typeof raw !== "number") {
      return { kind: "defer", reason: "missing_answer", key: question.key };
    }
    const unsafe = unsafeReading(question.key, raw);
    if (unsafe >= allow) {
      return {
        kind: "deny",
        key: question.key,
        reading: raw,
        label: questionLabel(question.key),
      };
    }
    if (unsafe > 1 - allow) {
      return {
        kind: "defer",
        reason: "veto_uncertain",
        key: question.key,
        reading: raw,
      };
    }
  }

  const scored: { key: string; reading: number }[] = [];
  for (const question of JUDGE_QUESTIONS) {
    if (question.veto) {
      continue;
    }
    const raw = readings[question.key];
    if (typeof raw !== "number") {
      return { kind: "defer", reason: "missing_answer", key: question.key };
    }
    scored.push({ key: question.key, reading: raw });
  }

  // A confident "no" on any scored question is a teaching denial.
  const failing = scored.find((entry) => entry.reading <= deny);
  if (failing) {
    return {
      kind: "deny",
      key: failing.key,
      reading: failing.reading,
      label: questionLabel(failing.key),
    };
  }

  const minReading = Math.min(...scored.map((entry) => entry.reading));
  if (minReading >= allow) {
    return { kind: "allow", minReading };
  }
  return { kind: "defer", reason: "below_allow", reading: minReading };
}
