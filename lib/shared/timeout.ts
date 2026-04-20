/**
 * Shared Timeout Utilities
 *
 * Promise timeout wrappers for preventing hanging operations.
 */

/**
 * Wrap a promise with a timeout.
 * Rejects with the provided error message if the promise doesn't resolve in time.
 *
 * @example
 * await withTimeout(fetchData(), 5000, "Fetch timed out");
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  errorMsg: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(errorMsg)), ms),
    ),
  ]);
}

/**
 * Create a promise that resolves after a delay.
 * Useful for implementing retry backoff.
 *
 * @example
 * await delay(1000); // Wait 1 second
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
