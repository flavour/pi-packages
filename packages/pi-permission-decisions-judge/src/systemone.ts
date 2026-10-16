/**
 * The single place that talks to the decision endpoint.
 *
 * Contract (`docs/endpoint.md`, probed live): `POST /v1/systemone` with
 * `{ model, state, questions }`; `answers` echoes the question keys, and an
 * `noul` answer is `{ type: "noul", noul: p }`. `usage.input_tokens` is
 * accounting only — it is **not** a compute budget and not a sharing signal
 * (measured: inherited prefix does not show up there).
 *
 * Every failure mode is a typed `EndpointError` so the caller can turn it into a
 * `defer` without string matching.
 */

export type EndpointFailureKind = "unreachable" | "timeout" | "http" | "parse";

export class EndpointError extends Error {
  readonly kind: EndpointFailureKind;
  readonly detail: string;

  constructor(kind: EndpointFailureKind, detail: string) {
    super(`${kind}: ${detail}`);
    this.name = "EndpointError";
    this.kind = kind;
    this.detail = detail;
  }
}

export interface SystemOneAnswer {
  type: string;
  noul?: number;
}

export interface AskResult {
  /** Question key → raw reading, before polarity inversion. */
  readings: Record<string, number>;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
  latencyMs: number;
}

/** Injectable seam so unit tests never touch the network. */
export type Transport = (
  url: string,
  payload: unknown,
  timeoutMs: number,
) => Promise<unknown>;

async function fetchTransport(
  url: string,
  payload: unknown,
  timeoutMs: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new EndpointError("timeout", message);
    }
    throw new EndpointError("unreachable", message);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new EndpointError("http", `${response.status} ${body.slice(0, 200)}`);
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new EndpointError("parse", "response body is not JSON");
  }
}

export interface AskOptions {
  baseUrl: string;
  path: string;
  model: string;
  state: unknown;
  questions: Record<string, unknown>;
  timeoutMs: number;
  transport?: Transport;
  now?: () => number;
}

/** One request, all questions — batching, not per-question fan-out (measured). */
export async function askSystemOne(options: AskOptions): Promise<AskResult> {
  const transport = options.transport ?? fetchTransport;
  const url = new URL(options.path, options.baseUrl).toString();
  const payload = {
    model: options.model,
    state: options.state,
    questions: options.questions,
  };

  const started = (options.now ?? Date.now)();
  const raw = await transport(url, payload, options.timeoutMs);
  const latencyMs = (options.now ?? Date.now)() - started;

  return parseAnswers(raw, Object.keys(options.questions), latencyMs);
}

/** Validate the answer shape; anything unexpected is a `parse` failure, not a 0. */
export function parseAnswers(
  raw: unknown,
  expectedKeys: readonly string[],
  latencyMs: number,
): AskResult {
  if (typeof raw !== "object" || raw === null) {
    throw new EndpointError("parse", "response is not an object");
  }
  const record = raw as Record<string, unknown>;
  const answers = record.answers;
  if (typeof answers !== "object" || answers === null) {
    throw new EndpointError("parse", "response has no `answers` object");
  }
  const answerRecord = answers as Record<string, unknown>;

  const readings: Record<string, number> = {};
  for (const key of expectedKeys) {
    const answer = answerRecord[key];
    if (typeof answer !== "object" || answer === null) {
      throw new EndpointError("parse", `answer \`${key}\` is missing`);
    }
    const typed = answer as SystemOneAnswer;
    if (
      typed.type !== "noul" ||
      typeof typed.noul !== "number" ||
      !Number.isFinite(typed.noul)
    ) {
      throw new EndpointError(
        "parse",
        `answer \`${key}\` is not a finite noul`,
      );
    }
    readings[key] = Math.min(1, Math.max(0, typed.noul));
  }

  const usage = record.usage;
  const result: AskResult = { readings, latencyMs };
  if (typeof record.model === "string") {
    result.model = record.model;
  }
  if (
    typeof usage === "object" &&
    usage !== null &&
    typeof (usage as Record<string, unknown>).input_tokens === "number" &&
    typeof (usage as Record<string, unknown>).output_tokens === "number"
  ) {
    result.usage = {
      input_tokens: (usage as Record<string, number>).input_tokens,
      output_tokens: (usage as Record<string, number>).output_tokens,
    };
  }
  return result;
}
