/**
 * Shared API Response Utilities
 *
 * Standardized response builders for API routes.
 * Single source of truth for error response formatting.
 */

import { NextResponse } from "next/server";
import { logger } from "./logger";

/**
 * Standard API error response format
 */
export interface ApiErrorResponse {
  ok: false;
  error: string;
}

/**
 * Standard API success response format
 */
export interface ApiSuccessResponse<T = unknown> {
  ok: true;
  data?: T;
}

/**
 * Create a standardized error response
 */
export function apiError(
  error: string,
  status = 500,
): NextResponse<ApiErrorResponse> {
  return NextResponse.json({ ok: false, error }, { status });
}

/**
 * Create a bad request (400) error response
 */
export function apiBadRequest(error: string): NextResponse<ApiErrorResponse> {
  return apiError(error, 400);
}

/**
 * Create a not found (404) error response
 */
export function apiNotFound(error: string): NextResponse<ApiErrorResponse> {
  return apiError(error, 404);
}

/**
 * Create a server error (500) response from an unknown error
 */
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

/**
 * Create a success response
 */
export function apiSuccess<T>(data?: T): NextResponse<ApiSuccessResponse<T>> {
  return NextResponse.json({ ok: true, data });
}
