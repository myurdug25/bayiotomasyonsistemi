"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { resolvePostLoginRoute } from "@/lib/post-login-route";

export function GuestOnly({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isAuthenticated) {
      router.replace(resolvePostLoginRoute(user));
    }
  }, [isAuthenticated, router, user]);

  if (isAuthenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center text-[var(--muted-foreground)]">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Yönlendiriliyor...
      </div>
    );
  }

  return <>{children}</>;
}
