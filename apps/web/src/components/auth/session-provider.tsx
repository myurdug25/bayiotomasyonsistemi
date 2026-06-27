"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  type ApiUser,
  type CustomerSummary,
  ensureCsrfCookie,
  getContext,
  getMe,
  login as loginRequest,
  logout as logoutRequest,
  setContextCustomer,
  clearContextCustomer,
} from "@/lib/api";

type SessionStatus = "loading" | "authenticated" | "guest";
const SELECTED_CUSTOMER_STORAGE_KEY = "powersa:selected_customer";

type ApiUserPayload = ApiUser & {
  selected_customer?: (Partial<CustomerSummary> & { name?: string | null }) | null;
};

function normalizeCustomerSummary(
  customer: Partial<CustomerSummary> & {
    name?: string | null;
    meta?: { address?: string | null; iban?: string | null } | null;
  }
): CustomerSummary | null {
  if (typeof customer.id !== "number" || typeof customer.code !== "string") {
    return null;
  }

  const title =
    typeof customer.title === "string" && customer.title.length > 0
      ? customer.title
      : typeof customer.name === "string" && customer.name.length > 0
        ? customer.name
        : null;

  if (!title) {
    return null;
  }

  return {
    id: customer.id,
    code: customer.code,
    title,
    name: customer.name ?? null,
    source_system: customer.source_system ?? null,
    source_reference: customer.source_reference ?? null,
    contact_name: customer.contact_name ?? null,
    email: customer.email ?? null,
    city: customer.city ?? null,
    district: customer.district ?? null,
    phone: customer.phone ?? null,
    tax_office: customer.tax_office ?? null,
    tax_number: customer.tax_number ?? null,
    credit_limit: customer.credit_limit ?? null,
    special_discount_rate: customer.special_discount_rate ?? null,
    is_active: typeof customer.is_active === "boolean" ? customer.is_active : undefined,
    address: customer.address ?? customer.meta?.address ?? null,
    iban: customer.iban ?? customer.meta?.iban ?? null,
    last_synced_at: customer.last_synced_at ?? null,
    balance_summary: customer.balance_summary,
    balance_source: customer.balance_source,
    salesperson: customer.salesperson ?? null,
    meta: customer.meta ?? null,
  };
}

function readStoredSelectedCustomer(): CustomerSummary | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(SELECTED_CUSTOMER_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<CustomerSummary>;
    const normalized = normalizeCustomerSummary(parsed);
    if (normalized) {
      return normalized;
    }
  } catch {
    // ignore invalid cached payload
  }

  window.localStorage.removeItem(SELECTED_CUSTOMER_STORAGE_KEY);
  return null;
}

function persistSelectedCustomer(customer: CustomerSummary | null) {
  if (typeof window === "undefined") {
    return;
  }

  if (!customer) {
    window.localStorage.removeItem(SELECTED_CUSTOMER_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(SELECTED_CUSTOMER_STORAGE_KEY, JSON.stringify(customer));
}

function selectedCustomerFromUser(user: ApiUserPayload | null | undefined): CustomerSummary | null {
  if (!user) {
    return null;
  }

  return normalizeCustomerSummary(user.selectedCustomer ?? user.selected_customer ?? {}) ?? null;
}

function normalizeApiUser(user: ApiUserPayload): ApiUser {
  return {
    ...user,
    selectedCustomer: selectedCustomerFromUser(user),
  };
}

type SessionContextType = {
  status: SessionStatus;
  user: ApiUser | null;
  selectedCustomer: CustomerSummary | null;
  error: string | null;
  login: (payload: { username: string; password: string; remember?: boolean }) => Promise<ApiUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  selectCustomer: (customerId: number) => Promise<void>;
  clearCustomer: () => Promise<void>;
};

const SessionContext = createContext<SessionContextType | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [user, setUser] = useState<ApiUser | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setSelectedCustomerPersisted = useCallback((customer: CustomerSummary | null) => {
    setSelectedCustomer(customer);
    persistSelectedCustomer(customer);
  }, []);

  const refresh = useCallback(async () => {
    setStatus((prev) => (prev === "authenticated" ? prev : "loading"));
    setError(null);

    try {
      const me = await getMe();
      const normalizedUser = normalizeApiUser(me.user as ApiUserPayload);

      let nextCustomer = selectedCustomerFromUser(normalizedUser);

      if (!nextCustomer) {
        try {
          const context = await getContext();
          nextCustomer = normalizeCustomerSummary(context.context.customer ?? {}) ?? null;
        } catch {
          // Context endpoint can fail independently; fall back to the local selection below.
        }
      }

      setUser(normalizedUser);
      setSelectedCustomerPersisted(nextCustomer);
      setStatus("authenticated");
    } catch {
      setUser(null);
      setSelectedCustomerPersisted(null);
      setStatus("guest");
    }
  }, [setSelectedCustomerPersisted]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [refresh]);

  const login = useCallback(
    async (payload: { username: string; password: string; remember?: boolean }) => {
      setError(null);
      setSelectedCustomerPersisted(null);
      await ensureCsrfCookie();

      const response = await loginRequest(payload);
      const normalizedUser = normalizeApiUser(response.user as ApiUserPayload);
      setUser(normalizedUser);
      setSelectedCustomerPersisted(selectedCustomerFromUser(normalizedUser));
      setStatus("authenticated");

      try {
        const context = await getContext();
        setSelectedCustomerPersisted(normalizeCustomerSummary(context.context.customer ?? {}) ?? null);
      } catch {
        // context endpoint is optional after login
      }

      return response.user;
    },
    [setSelectedCustomerPersisted]
  );

  const logout = useCallback(async () => {
    setError(null);

    try {
      await logoutRequest();
    } catch {
      // ignore logout network errors and clear local session anyway
    }

    setUser(null);
    setSelectedCustomerPersisted(null);
    setStatus("guest");
  }, [setSelectedCustomerPersisted]);

  const selectCustomer = useCallback(async (customerId: number) => {
    setError(null);

    try {
      const response = await setContextCustomer(customerId);
      setSelectedCustomerPersisted(normalizeCustomerSummary(response.context.customer ?? {}) ?? null);
      setUser((prev) => {
        if (!prev) {
          return prev;
        }

        return {
          ...prev,
          selected_customer_id: response.context.customer?.id ?? null,
          selectedCustomer: response.context.customer,
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Müşteri seçimi güncellenemedi";
      setError(message);
      throw err;
    }
  }, [setSelectedCustomerPersisted]);

  const clearCustomer = useCallback(async () => {
    setError(null);

    try {
      await clearContextCustomer();
      setSelectedCustomerPersisted(null);
      setUser((prev) => {
        if (!prev) {
          return prev;
        }

        return {
          ...prev,
          selected_customer_id: null,
          selectedCustomer: null,
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Müşteri seçimi temizlenemedi";
      setError(message);
      throw err;
    }
  }, [setSelectedCustomerPersisted]);

  const value = useMemo<SessionContextType>(
    () => ({
      status,
      user,
      selectedCustomer,
      error,
      login,
      logout,
      refresh,
      selectCustomer,
      clearCustomer,
    }),
    [status, user, selectedCustomer, error, login, logout, refresh, selectCustomer, clearCustomer]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error("useSession must be used inside SessionProvider");
  }

  return context;
}
