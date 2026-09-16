import type { ModelResult } from './model';

/** Detached JSON result for caches/fixtures (R61/R62). Provider raw is not portable data. */
export function copyModelResult(result: ModelResult): ModelResult {
  const portable: ModelResult = { message: result.message };
  if (result.usage !== undefined) portable.usage = result.usage;
  if (result.finishReason !== undefined) portable.finishReason = result.finishReason;
  return JSON.parse(JSON.stringify(portable)) as ModelResult;
}
