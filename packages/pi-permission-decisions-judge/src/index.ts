import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createDecisionsJudgeExtension } from "./extension.ts";

/**
 * Entry point: register the `decisions-judge` link with the session's
 * pi-permission-system node. Naming it in `authorizerChain` is what gives it
 * authority; installing this package does not.
 */
export default function decisionsJudgeExtension(pi: ExtensionAPI): void {
  createDecisionsJudgeExtension(pi);
}
