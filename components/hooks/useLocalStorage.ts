"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";

// Helper to safely read from localStorage
function getStorageValue<T>(key: string, initialValue: T): T {
  if (typeof window === "undefined") return initialValue;
  try {
    const item = window.localStorage.getItem(key);
    return item ? JSON.parse(item) : initialValue;
  } catch {
    return initialValue;
  }
}

// Helper to safely write to localStorage
function setStorageValue<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    // Dispatch custom event to sync other hook instances in same tab
    window.dispatchEvent(new Event(`localStorage:${key}`));
  } catch (error) {
    console.warn(`Error setting localStorage key "${key}":`, error);
  }
}

export function useLocalStorage<T>(
  key: string,
  initialValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  // Cache the snapshot value to avoid infinite loops
  // useSyncExternalStore requires getSnapshot to return the same reference
  // if the value hasn't changed
  const cachedValueRef = useRef<{ raw: string | null; parsed: T } | null>(null);

  // Debounce timer for localStorage writes
  const writeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingValueRef = useRef<T | null>(null);

  // Subscribe to storage changes (both cross-tab and same-tab)
  const subscribe = useCallback(
    (callback: () => void) => {
      // Handle cross-tab storage events
      const handleStorage = (e: StorageEvent) => {
        if (e.key === key) callback();
      };
      // Handle same-tab custom events
      const handleCustom = () => callback();

      window.addEventListener("storage", handleStorage);
      window.addEventListener(`localStorage:${key}`, handleCustom);

      return () => {
        window.removeEventListener("storage", handleStorage);
        window.removeEventListener(`localStorage:${key}`, handleCustom);
      };
    },
    [key],
  );

  // Get current value from localStorage - MUST return cached reference if unchanged
  const getSnapshot = useCallback((): T => {
    const raw =
      typeof window !== "undefined" ? window.localStorage.getItem(key) : null;

    // If raw value hasn't changed, return cached parsed value
    if (cachedValueRef.current && cachedValueRef.current.raw === raw) {
      return cachedValueRef.current.parsed;
    }

    // Parse and cache the new value
    let parsed: T;
    if (raw === null) {
      parsed = initialValue;
    } else {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = initialValue;
      }
    }

    cachedValueRef.current = { raw, parsed };
    return parsed;
  }, [key, initialValue]);

  // Server-side fallback
  const getServerSnapshot = useCallback(() => initialValue, [initialValue]);

  // Use useSyncExternalStore for proper SSR/hydration handling
  const storedValue = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  // Setter function - debounced to avoid blocking UI
  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      // Compose updates against the most recent queued value so back-to-back
      // functional writes don't clobber each other during the debounce window.
      const current =
        pendingValueRef.current ?? getStorageValue(key, initialValue);
      const valueToStore = value instanceof Function ? value(current) : value;
      pendingValueRef.current = valueToStore;

      // Clear any pending write
      if (writeTimeoutRef.current) {
        clearTimeout(writeTimeoutRef.current);
      }

      // Debounce localStorage write (100ms)
      writeTimeoutRef.current = setTimeout(() => {
        if (pendingValueRef.current !== null) {
          setStorageValue(key, pendingValueRef.current);
          pendingValueRef.current = null;
        }
      }, 100);
    },
    [key, initialValue],
  );

  return [storedValue, setValue];
}
