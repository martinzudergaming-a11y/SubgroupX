export const CHECK_TIME_SCALE = process.env.CI ? 6 : 1;

export function timeBudgetMs(localBudgetMs: number): number {
  return localBudgetMs * CHECK_TIME_SCALE;
}
