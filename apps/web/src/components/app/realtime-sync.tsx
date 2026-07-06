"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useSession } from "@/components/auth/session-provider";
import { resolveApiBaseUrl } from "@/lib/api";

type RealtimeDomainEvent = {
  id: string;
  event: string;
  occurred_at: string;
  payload?: Record<string, unknown>;
};

type RealtimePollResponse = {
  data: RealtimeDomainEvent[];
};

const POLL_INTERVAL_MS = 5_000;
const MAX_SEEN_EVENT_IDS = 500;

const QUERY_PREFIXES_BY_EVENT: Record<string, string[]> = {
  stock_updated: ["products", "product", "catalog", "pos", "warehouse", "cart"],
  stock_transfer_created: ["warehouse", "orders", "dashboard", "reports"],
  stock_transfer_updated: ["warehouse", "orders", "dashboard", "reports"],
  stock_transfer_received: ["warehouse", "orders", "products", "dashboard", "reports"],
  collection_added: ["collections", "ledger", "customers", "dashboard", "reports"],
  collection_updated: ["collections", "ledger", "customers", "dashboard", "reports"],
  cash_transaction_added: ["collections", "ledger", "dashboard", "reports", "pos"],
  customer_balance_changed: ["ledger", "customers", "dashboard", "reports"],
  customer_created: ["customers", "customer", "dashboard", "reports"],
  customer_updated: ["customers", "customer", "ledger", "dashboard", "reports"],
  return_created: ["returns", "orders", "warehouse", "dashboard", "reports"],
  return_updated: ["returns", "orders", "warehouse", "products", "dashboard", "reports"],
};

export function RealtimeSync() {
  const queryClient = useQueryClient();
  const { status } = useSession();

  useEffect(() => {
    if (status !== "authenticated" || typeof window === "undefined") {
      return;
    }

    let stopped = false;
    let polling = false;
    let initialized = false;
    const seenEventIds = new Set<string>();
    const abortController = new AbortController();

    const dispatchEvent = (event: RealtimeDomainEvent) => {
      window.dispatchEvent(new CustomEvent("powersa:realtime", { detail: event }));
    };

    const poll = async () => {
      if (stopped || polling || document.visibilityState === "hidden") {
        return;
      }

      polling = true;

      try {
        const response = await fetch(`${resolveApiBaseUrl()}/api/realtime/events?limit=100`, {
          credentials: "include",
          headers: {
            Accept: "application/json",
            "X-Requested-With": "XMLHttpRequest",
          },
          cache: "no-store",
          signal: abortController.signal,
        });

        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as RealtimePollResponse;
        const events = [...(payload.data ?? [])].reverse();

        if (!initialized) {
          for (const event of events) {
            if (event?.id) {
              seenEventIds.add(event.id);
            }
          }
          initialized = true;
          return;
        }

        const prefixesToInvalidate = new Set<string>();
        for (const event of events) {
          if (!event?.id || seenEventIds.has(event.id)) {
            continue;
          }

          seenEventIds.add(event.id);
          for (const prefix of QUERY_PREFIXES_BY_EVENT[event.event] ?? []) {
            prefixesToInvalidate.add(prefix);
          }
          dispatchEvent(event);
        }

        if (prefixesToInvalidate.size > 0) {
          void queryClient.invalidateQueries({
            predicate: (query) => {
              const root = String(query.queryKey[0] ?? "");
              return [...prefixesToInvalidate].some((prefix) => root.startsWith(prefix));
            },
          });
        }

        while (seenEventIds.size > MAX_SEEN_EVENT_IDS) {
          const oldestId = seenEventIds.values().next().value;
          if (typeof oldestId !== "string") {
            break;
          }
          seenEventIds.delete(oldestId);
        }
      } catch {
        // Temporary network/deploy interruptions are retried by the next poll.
      } finally {
        polling = false;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      abortController.abort();
    };
  }, [queryClient, status]);

  return null;
}
