import { z } from "zod";

import { ReconnectPolicySchema } from "./config";

export type ReconnectPolicy = z.infer<typeof ReconnectPolicySchema>;

export function getReconnectDelayMs(attempt: number, policy: ReconnectPolicy): number {
  const normalizedAttempt = Math.max(1, attempt);
  return Math.min(policy.baseDelayMs * 2 ** (normalizedAttempt - 1), policy.maxDelayMs);
}

export function canReconnect(attempt: number, policy: ReconnectPolicy): boolean {
  return attempt <= policy.maxAttempts;
}

