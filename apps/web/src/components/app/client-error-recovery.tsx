"use client";

import { useEffect } from "react";

const RELOAD_STORAGE_KEY = "powersa:chunk-reload";
const RELOAD_WINDOW_MS = 30_000;

function errorText(value: unknown): string {
  if (!value) {
    return "";
  }

  if (value instanceof Error) {
    return `${value.name} ${value.message} ${value.stack ?? ""}`;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isNextChunkError(value: unknown): boolean {
  const text = errorText(value).toLowerCase();

  return (
    text.includes("chunkloaderror") ||
    text.includes("loading chunk") ||
    text.includes("failed to fetch dynamically imported module") ||
    text.includes("error loading dynamically imported module") ||
    text.includes("importing a module script failed") ||
    text.includes("/_next/static/chunks/")
  );
}

function requestOneShotReload() {
  const path = `${window.location.pathname}${window.location.search}`;
  const now = Date.now();

  try {
    const previous = JSON.parse(window.sessionStorage.getItem(RELOAD_STORAGE_KEY) ?? "null") as {
      path?: string;
      time?: number;
    } | null;

    if (previous?.path === path && typeof previous.time === "number" && now - previous.time < RELOAD_WINDOW_MS) {
      return;
    }

    window.sessionStorage.setItem(RELOAD_STORAGE_KEY, JSON.stringify({ path, time: now }));
  } catch {
    // If sessionStorage is blocked, still try the reload once for this runtime.
  }

  window.location.reload();
}

export function ClientErrorRecovery() {
  useEffect(() => {
    const clearSuccessfulReloadMarker = window.setTimeout(() => {
      try {
        const currentPath = `${window.location.pathname}${window.location.search}`;
        const previous = JSON.parse(window.sessionStorage.getItem(RELOAD_STORAGE_KEY) ?? "null") as {
          path?: string;
          time?: number;
        } | null;

        if (previous?.path === currentPath) {
          window.sessionStorage.removeItem(RELOAD_STORAGE_KEY);
        }
      } catch {
        // ignore storage parse failures
      }
    }, 5_000);

    const handleWindowError = (event: ErrorEvent) => {
      const target = event.target;
      const targetSource =
        target instanceof HTMLScriptElement
          ? target.src
          : target instanceof HTMLLinkElement
          ? target.href
          : "";

      if (isNextChunkError(event.error) || isNextChunkError(event.message) || isNextChunkError(targetSource)) {
        event.preventDefault();
        requestOneShotReload();
      }
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (isNextChunkError(event.reason)) {
        event.preventDefault();
        requestOneShotReload();
      }
    };

    window.addEventListener("error", handleWindowError, true);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    return () => {
      window.clearTimeout(clearSuccessfulReloadMarker);
      window.removeEventListener("error", handleWindowError, true);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);

  return null;
}
