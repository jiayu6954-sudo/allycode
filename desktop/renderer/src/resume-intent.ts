/** Exact short phrases that novice users commonly type instead of clicking Continue. */
export function isResumeIntent(value: string): boolean {
  return /^(?:请)?(?:继续|接续|继续执行|接着执行)[。！!…\s]*$/.test(value.trim());
}
