import { checkSecrets } from "./secrets.mjs";
import { checkDangerousPatterns } from "./patterns.mjs";
import { checkLargeFiles } from "./large.mjs";

// Add new static checks here. Signature: (ctx) => findings[].
// ctx: { root, files: stagedFiles[] (see gate/staged.mjs), config: gate config }
export const checks = [checkSecrets, checkDangerousPatterns, checkLargeFiles];
