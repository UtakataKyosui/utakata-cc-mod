import type { PreToolUseResult } from "claude-code";

export const withContext = (
  result: PreToolUseResult,
  note: string,
): PreToolUseResult =>
  result.deny !== undefined
    ? result
    : {
        ...result,
        additionalContext: [...(result.additionalContext ?? []), note],
      };
