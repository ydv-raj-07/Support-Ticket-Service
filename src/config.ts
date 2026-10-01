export const SLA_HOURS = {P0: 1, P1: 4, P2: 24, P3: 72} as const;
export const PLANS = ['free','pro','enterprise'] as const;
export const AT_RISK_FRACTION = 0.2;

export const CATEGORIES = ["billing", "bug", "account_access", "feature_request", "other"] as const;
export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

export const DUPLICATE_WINDOW_MINUTES = 30;
export const AI_TIMEOUT_MS = 10_000;
export const STUCK_AFTER_MS = 5 * 60_000;

export type Category = (typeof CATEGORIES)[number];
export type Priority = (typeof PRIORITIES)[number];
