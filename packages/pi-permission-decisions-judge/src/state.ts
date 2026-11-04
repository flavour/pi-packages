/**
 * State building for `/v1/systemone`, with the D-16 budget rule.
 *
 * The state is what dominates latency (measured: 4 questions on a ~200-token
 * state is 0.485 s at `--parallel 4`; the state read is the cost), so the ladder
 * cuts context, never the call. If the call itself does not fit, the answer is
 * `overBudget` and the link defers — a call too big for the slot is not a
 * partial judgement (D-16: no `allow` on a call we cannot see whole).
 *
 * Secret shaping is masked on the **outbound** request: the endpoint is a LAN hop
 * whose logs we do not control. The hub masks name-bound values in its own log;
 * that is a different channel with a different rule (D-26).
 */

/** Rough token estimate; the endpoint's own tokenizer is not exposed here. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const SECRET_SHAPES: readonly { name: string; pattern: RegExp }[] = [
  {
    name: "private key",
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    name: "api key",
    pattern:
      /\b(?:sk|pk|rk|ghp|gho|github_pat|xox[baprs])-?[A-Za-z0-9_-]{12,}/g,
  },
  { name: "aws access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi },
];

/** Replace credential *shapes* with a marker. Shape-based, deliberately blunt. */
export function maskSecretShapes(text: string): string {
  let out = text;
  for (const shape of SECRET_SHAPES) {
    out = out.replace(shape.pattern, `[masked:${shape.name}]`);
  }
  return out;
}

export interface StateInput {
  toolName: string;
  command: string;
  cwd: string;
  branch?: string;
  latestUserMessage?: string;
  facts?: readonly string[];
  maxStateTokens: number;
}

export interface BuiltState {
  state: {
    value: Record<string, unknown>;
    context: Record<string, unknown>;
  };
  /** What the ladder dropped, in the order it dropped it — goes in the review log. */
  dropped: string[];
  /** True when the call itself will not fit; the caller must defer. */
  overBudget: boolean;
  tokensEstimate: number;
}

function measure(value: unknown): number {
  return estimateTokens(JSON.stringify(value));
}

/**
 * Fit the state to the budget. Order of cutting (D-26): facts, then the user
 * message shortened to its tail, then the user message entirely. The command is
 * never cut.
 */
export function buildState(input: StateInput): BuiltState {
  const dropped: string[] = [];
  const facts = [...(input.facts ?? [])];
  let userMessage = input.latestUserMessage;

  const assemble = (): BuiltState["state"] => {
    const value: Record<string, unknown> = {
      tool: input.toolName,
      command: maskSecretShapes(input.command),
      cwd: input.cwd,
    };
    if (input.branch) {
      value.git_branch = input.branch;
    }
    const context: Record<string, unknown> = {};
    if (userMessage) {
      context.latest_user_message = maskSecretShapes(userMessage);
    }
    if (facts.length > 0) {
      context.facts = facts.map((fact) => maskSecretShapes(fact));
    }
    return { value, context };
  };

  let state = assemble();
  let tokens = measure(state);

  if (tokens > input.maxStateTokens && facts.length > 0) {
    facts.length = 0;
    dropped.push("facts");
    state = assemble();
    tokens = measure(state);
  }
  if (
    tokens > input.maxStateTokens &&
    userMessage &&
    userMessage.length > 160
  ) {
    userMessage = `${userMessage.slice(0, 160)}…`;
    dropped.push("user_message_tail");
    state = assemble();
    tokens = measure(state);
  }
  if (tokens > input.maxStateTokens && userMessage) {
    userMessage = undefined;
    dropped.push("user_message");
    state = assemble();
    tokens = measure(state);
  }

  const commandOnly = estimateTokens(maskSecretShapes(input.command));
  return {
    state,
    dropped,
    overBudget: commandOnly > input.maxStateTokens,
    tokensEstimate: tokens,
  };
}
