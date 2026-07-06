"use client";

import { SessionProvider } from "@/components/auth/session-provider";
import { CartProvider } from "@/components/cart/cart-provider";
import { ClientErrorRecovery } from "@/components/app/client-error-recovery";
import { PwaServiceWorker } from "@/components/app/pwa-service-worker";
import { RealtimeSync } from "@/components/app/realtime-sync";

export function AppProvider({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <RealtimeSync />
      <ClientErrorRecovery />
      <PwaServiceWorker />
      <CartProvider>{children}</CartProvider>
    </SessionProvider>
  );
}
