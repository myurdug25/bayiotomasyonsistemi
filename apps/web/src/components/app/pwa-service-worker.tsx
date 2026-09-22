"use client";

import { useEffect } from "react";

export function PwaServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    const userAgent = window.navigator.userAgent || "";
    const isAppleWebKit = /AppleWebKit/i.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(userAgent);
    const isAppleDevice = /Macintosh|Mac OS X|iPhone|iPad|iPod/i.test(userAgent);

    if (isAppleWebKit && isAppleDevice) {
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
        .catch(() => undefined);
      return;
    }

    const isSupportedOrigin =
      window.location.protocol === "https:" ||
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";

    if (!isSupportedOrigin) {
      return;
    }

    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // PWA registration should never block login or panel usage.
    });
  }, []);

  return null;
}
