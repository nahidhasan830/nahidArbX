import { queryPlayerInfo } from "./client";
import {
  getSession,
  invalidateSession,
  VelkiSessionExpiredError,
} from "./session";
import {
  isVelkiAutoLoginEnabled,
  VelkiAutoLoginDisabledError,
} from "./auto-login-config";
import type { VelkiPlayerInfoResponse } from "./types";

export interface VelkiBalanceReadResult {
  info: VelkiPlayerInfoResponse;
  recaptured: boolean;
}

export async function readPlayerInfoWithRecapture(): Promise<VelkiBalanceReadResult> {
  const first = await queryPlayerInfo();
  if (first.betCredit > 0) {
    return { info: first, recaptured: false };
  }

  if (!isVelkiAutoLoginEnabled()) {
    return { info: first, recaptured: false };
  }

  invalidateSession();
  try {
    await getSession(true);
  } catch (err) {
    if (err instanceof VelkiAutoLoginDisabledError) {
      return { info: first, recaptured: false };
    }
    if (err instanceof VelkiSessionExpiredError) {
      throw err;
    }
    throw err;
  }

  const second = await queryPlayerInfo();
  return { info: second, recaptured: true };
}
