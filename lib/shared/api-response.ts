
import { NextResponse } from "next/server";
import { logger } from "./logger";

export interface ApiErrorResponse {
  ok: false;
  error: string;
}

export interface ApiSuccessResponse<T = unknown> {
  ok: true;
  data?: T;
}

export function apiError(
  error: string,
  status = 500,
): NextResponse<ApiErrorResponse> {
  return NextResponse.json({ ok: false, error }, { status });
}

export function apiBadRequest(error: string): NextResponse<ApiErrorResponse> {
  return apiError(error, 400);
}

export function apiNotFound(error: string): NextResponse<ApiErrorResponse> {
  return apiError(error, 404);
}

export function apiServerError(
  error: unknown,
  context?: string,
): NextResponse<ApiErrorResponse> {
  const message = error instanceof Error ? error.message : "Unknown error";
  if (context) {
    logger.error(context, message, error);
  }
  return apiError(message, 500);
}

export function apiSuccess<T>(data?: T): NextResponse<ApiSuccessResponse<T>> {
  return NextResponse.json({ ok: true, data });
}
