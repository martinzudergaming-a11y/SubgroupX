const RETRY_LIMITS: Readonly<Record<string, number>> = {
  cyber_policy: 10,
  server: 10,
  timeout: 4,
  network: 4,
  rate_limit: 3,
  unknown: 3,
};

const MODEL_RETRY_BACKOFF_BASE_MS = 500;
const MODEL_RETRY_BACKOFF_CAP_MS = 8_000;

export function modelRetryLimit(errorKind: string): number {
  return RETRY_LIMITS[errorKind] ?? 0;
}

export function modelRetryBackoffMs(attempt: number): number {
  return Math.min(MODEL_RETRY_BACKOFF_CAP_MS, MODEL_RETRY_BACKOFF_BASE_MS * (2 ** Math.max(0, attempt - 1)));
}
