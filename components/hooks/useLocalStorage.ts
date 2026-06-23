"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";

function getStorageValue<T>(key: string, initialValue: T): T {
  if (typeof window === "undefined") return initialValue;
  try {
    const item = window.localStorage.getItem(key);
    return item ? JSON.parse(item) : initialValue;
  } catch {
    return initialValue;
  }
}

function setStorageValue<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(new Event(`localStorage:${key}`));
  } catch (error) {
    console.warn(`Error setting localStorage key "${key}":`, error);
  }
}

export function useLocalStorage<T>(
  key: string,
  initialValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const cachedValueRef = useRef<{ raw: string | null; parsed: T } | null>(null);

  const writeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingValueRef = useRef<T | null>(null);

  const subscribe = useCallback(
    (callback: () => void) => {
      const handleStorage = (e: StorageEvent) => {
        if (e.key === key) callback();
      };
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

  const getSnapshot = useCallback((): T => {
    const raw =
      typeof window !== "undefined" ? window.localStorage.getItem(key) : null;

    if (cachedValueRef.current && cachedValueRef.current.raw === raw) {
      return cachedValueRef.current.parsed;
    }

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

  const getServerSnapshot = useCallback(() => initialValue, [initialValue]);

  const storedValue = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      const current =
        pendingValueRef.current ?? getStorageValue(key, initialValue);
      const valueToStore = value instanceof Function ? value(current) : value;
      pendingValueRef.current = valueToStore;

      if (writeTimeoutRef.current) {
        clearTimeout(writeTimeoutRef.current);
      }

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
