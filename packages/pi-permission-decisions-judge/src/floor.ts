/**
 * The never-allow floor (D-25) and the whole-call-visible precondition (D-16).
 *
 * Both are deterministic and run **before** the endpoint, and both produce
 * `defer`, never `deny`: the hub's policy layer owns denial, and this floor only
 * refuses to *approve*. Leaving this list in code rather than in the hub's config
 * is deliberate — an envelope claim built on an operator-editable config file is
 * not ours to make.
 *
 * The opaque-wrapper list is decomposition infidelity closed at the judge end
 * (ADR 0007 §6): `bash -c "safe; evil"` must never be approved on the safe piece
 * alone. The hub already prompts on these shapes, so they reach this link
 * precisely when the decomposition is unfaithful.
 */

export interface FloorRule {
  readonly name: string;
  readonly pattern: RegExp;
}

/** Shapes this link will never approve, whatever the model reads. */
export const NEVER_ALLOW: readonly FloorRule[] = [
  { name: "privilege escalation", pattern: /(^|[\s;&|])sudo\s/i },
  {
    name: "filesystem format or signature wipe",
    pattern: /\b(?:mkfs(?:\.[-z0-9_+-]+)?|wipefs)\b/i,
  },
  {
    name: "block device overwrite",
    pattern: /\bdd\b[^\n;&|]*\bof\s*=\s*["']?\/dev\//i,
  },
  {
    name: "recursive delete of a home or root path",
    pattern:
      /\brm\b[^\n;&|]*(?:-[a-z]*[rf][a-z]*\s+)+(?:["']?(?:\/|~|\$HOME)\/?["']?|\/(?:home|root|etc|usr|var)\b)/i,
  },
  {
    name: "remove git metadata",
    pattern: /\brm\b[^\n;&|]*\s(?:\.git|\.git\/|["']\.git["'])/i,
  },
  {
    name: "discard working tree",
    pattern: /\bgit\s+(?:reset\s+--hard|clean\s+[^\n]*-[a-z]*f)/i,
  },
  {
    name: "force push",
    pattern:
      /\bgit\s+push\b[^\n;&|]*(?:--force(?!-with-lease)\b|(?<=\s)-f(?=\s|$))/i,
  },
  {
    name: "credential file read or send",
    pattern: /(?:~|\$HOME)?\/\.ssh\/|\/\.aws\/credentials|id_rsa|id_ed25519/i,
  },
  {
    name: "secret in the command line",
    pattern:
      /(?:--token|--password|--api-key|AWS_SECRET_ACCESS_KEY|GH_TOKEN|OPENAI_API_KEY)\s*[=\s]/i,
  },
  {
    name: "cloud or infrastructure mutation",
    pattern:
      /\b(?:aws|gcloud|az|terraform|kubectl|heroku)\b[^\n;&|]*\b(?:delete|destroy|apply|deploy|terminate|remove|rm|rb|prune|drop)\b/i,
  },
  {
    name: "service or container teardown",
    pattern: /\b(?:docker|podman)\s+(?:system\s+prune|rm\s+-af?)/i,
  },
  {
    name: "package publish",
    pattern: /\b(?:npm|pnpm|yarn|cargo|twine)\s+publish\b/i,
  },
];

/**
 * Shapes whose full effect is not visible in the command text, so no reading
 * about them can be trusted (D-16).
 */
export const OPAQUE_SHAPES: readonly FloorRule[] = [
  {
    name: "shell -c wrapper",
    pattern: /\b(?:bash|sh|zsh|dash|fish)\s+-[a-z]*c\b/i,
  },
  { name: "eval", pattern: /(^|[\s;&|])eval\b/i },
  {
    name: "interpreter -c",
    pattern: /\b(?:python[23]?|node|perl|ruby|php)\s+-[ec]\b/i,
  },
  { name: "xargs", pattern: /(^|[\s;&|])xargs\b/i },
  { name: "find -exec", pattern: /\bfind\b[^\n;&|]*-exec\b/i },
  { name: "command substitution", pattern: /\$\(|`[^`\n]+`/ },
  {
    name: "piped interpreter",
    pattern: /\|\s*(?:bash|sh|zsh|python[23]?|node)\b/i,
  },
];

export interface Refusal {
  /** What the link refused to do, for the review log and the startup report. */
  readonly reason: string;
  readonly rule: string;
}

/** A never-allow shape, if the command matches one. */
export function floorRefusal(command: string): Refusal | undefined {
  const hit = NEVER_ALLOW.find((rule) => rule.pattern.test(command));
  return hit ? { reason: "never_allow", rule: hit.name } : undefined;
}

/** A shape whose whole effect is not visible, if the command has one. */
export function opaqueRefusal(command: string): Refusal | undefined {
  const hit = OPAQUE_SHAPES.find((rule) => rule.pattern.test(command));
  return hit ? { reason: "not_wholly_visible", rule: hit.name } : undefined;
}
