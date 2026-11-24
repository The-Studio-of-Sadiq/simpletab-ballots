export interface RateLimitOutcome {
  success: boolean;
}

export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<RateLimitOutcome>;
}

export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  RL_LINK: RateLimiterBinding;
  RL_IP: RateLimiterBinding;
}

export type Clock = () => number;
