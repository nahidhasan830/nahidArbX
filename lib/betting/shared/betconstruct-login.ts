import { randomBytes } from "node:crypto";

export interface BetconstructLoginOptions {
  languageTypeId: number;
  currencyTypeId: number;
  userId: string;
  password: string;
}

export interface BetconstructLoginResponse {
  data?: {
    accessToken?: string;
    refreshToken?: string;
    [key: string]: unknown;
  };
  errorCode?: string | number;
  errCode?: string | number;
  message?: string;
  msg?: string;
  success?: boolean;
  [key: string]: unknown;
}

export function buildBetconstructLoginBody(
  options: BetconstructLoginOptions,
): Record<string, unknown> {
  return {
    languageTypeId: options.languageTypeId,
    currencyTypeId: options.currencyTypeId,
    loginTypeId: 0,
    accessToken: "",
    userId: options.userId,
    password: options.password,
    isBioLogin: false,
    fingerprint2: randomBytes(16).toString("hex"),
    fingerprint4: randomBytes(16).toString("hex"),
    browserHash: randomBytes(16).toString("hex"),
    deviceHash: randomBytes(16).toString("hex"),
    fbp: "",
    fbc: "",
    ttp: "",
    ttc: "",
    ttclid: "",
  };
}

export function extractBetconstructAccessToken(json: unknown): string | null {
  return (json as BetconstructLoginResponse).data?.accessToken ?? null;
}

export function extractBetconstructRefreshToken(json: unknown): string {
  return (json as BetconstructLoginResponse).data?.refreshToken ?? "";
}

export function isBetconstructHardLoginFailure(json: unknown): boolean {
  const body = json as BetconstructLoginResponse;
  const code = String(body.errorCode ?? body.errCode ?? "").trim();
  const message = String(body.message ?? body.msg ?? "").toLowerCase();
  if (body.success === false) return true;
  if (code && code !== "0") return true;
  return (
    message.includes("invalid") ||
    message.includes("password") ||
    message.includes("credential") ||
    message.includes("suspended") ||
    message.includes("locked")
  );
}

export function decodeJwtExp(token: string): number {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64").toString(),
    ) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : 0;
  } catch {
    return 0;
  }
}
