"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import {
  Activity,
  Check,
  Loader2,
  ReceiptText,
  Search,
  ShoppingBasket,
  Tags,
  Wallet,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { type CustomerListItem, listCustomers } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Toggle } from "@/components/ui/toggle";

const PAGE_LIMIT = 25;
const SEARCH_DEBOUNCE_MS = 500;
const ALL_PRICE_GROUPS = "__all_price_groups__";

function toAmount(value: string): number {
  const normalized = value.replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatBalance(value: string, currency: string) {
  const amount = toAmount(value);
  const normalizedCurrency = currency.trim().toUpperCase();
  const formattedAmount = amount.toLocaleString("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  if (normalizedCurrency === "GEL") {
    return `${formattedAmount} GEL`;
  }

  try {
    return new Intl.NumberFormat("tr-TR", {
      style: "currency",
      currency: normalizedCurrency || "TRY",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${normalizedCurrency || currency} ${formattedAmount}`;
  }
}

function isMissingLogoText(value: string | null | undefined) {
  return value === null || value === undefined || value.trim() === "" || value.trim().toUpperCase() === "NULL";
}

function formatLogoText(value: string | null | undefined, fallback = "-") {
  const trimmed = value?.trim();
  return !trimmed || trimmed.toUpperCase() === "NULL" ? fallback : trimmed;
}

function formatCustomerLocation(customer: CustomerListItem) {
  const parts = [customer.city, customer.district]
    .filter((value) => !isMissingLogoText(value))
    .map((value) => value?.trim() ?? "");

  return parts.join(" / ") || "-";
}

function getAmountTone(value: string, darkMode: boolean) {
  const amount = toAmount(value);

  if (amount > 0) {
    return darkMode
      ? "border-[#6d302d] bg-[#2c1717] text-[#ffaaa5]"
      : "border-[#f0b8b3] bg-[#fff0ef] text-[#b83232]";
  }

  if (amount < 0) {
    return darkMode
      ? "border-[#365046] bg-[#17241d] text-[#98d2b1]"
      : "border-[#c7ddd1] bg-[#eef8f1] text-[#1f6a43]";
  }

  return darkMode
    ? "border-[var(--brand-border)] bg-[var(--surface-soft)] text-[var(--muted-foreground)]"
    : "border-[#dce7de] bg-[#f8fbf8] text-[#5c7160]";
}

function getSafeCustomerSelectionNext(requestedNext: string | null): string | null {
  if (!requestedNext?.startsWith("/") || requestedNext.startsWith("//")) {
    return null;
  }

  if (requestedNext === "/customers" || requestedNext.startsWith("/customers?") || requestedNext.startsWith("/customers/")) {
    return null;
  }

  return requestedNext;
}

export function CustomerSelectionPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { selectedCustomer, selectCustomer, user } = useAuth();
  const hadCustomerOnOpenRef = useRef(Boolean(selectedCustomer));
  const roleSlugs = useMemo(() => user?.roles.map((role) => role.slug) ?? [], [user?.roles]);
  const isSalesperson = roleSlugs.includes("salesperson");
  const isSalespersonSelectionMode = isSalesperson && !selectedCustomer;
  const [isDarkMode, setIsDarkMode] = useState(false);

  const [queryInput, setQueryInput] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [hasCart, setHasCart] = useState(false);
  const [hasOrderBalance, setHasOrderBalance] = useState(false);
  const [priceGroup, setPriceGroup] = useState(ALL_PRICE_GROUPS);
  const infiniteScrollMarkerRef = useRef<HTMLDivElement | null>(null);
  const selectedPriceGroup = priceGroup === ALL_PRICE_GROUPS ? "" : priceGroup;

  useEffect(() => {
    const root = document.documentElement;
    const syncTheme = () => setIsDarkMode(root.dataset.uiTheme === "dark");

    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["data-ui-theme"] });

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const nextQuery = queryInput.trim();
    const timer = window.setTimeout(() => {
      setSubmittedQuery((currentQuery) => (currentQuery === nextQuery ? currentQuery : nextQuery));
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [queryInput]);

  const customersQuery = useInfiniteQuery({
    queryKey: [
      "customers",
      {
        userId: user?.id ?? null,
        selectionMode: isSalespersonSelectionMode,
        q: submittedQuery,
        hasCart,
        hasOrderBalance,
        priceGroup: selectedPriceGroup,
        limit: PAGE_LIMIT,
      },
    ],
    enabled: typeof user?.id === "number",
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listCustomers({
        q: submittedQuery || undefined,
        has_cart: hasCart ? true : undefined,
        has_order_balance: hasOrderBalance ? true : undefined,
        price_group: selectedPriceGroup || undefined,
        selection_mode: isSalesperson ? true : undefined,
        fast: !hasCart && !hasOrderBalance && !selectedPriceGroup ? true : undefined,
        cursor: pageParam ?? undefined,
        limit: PAGE_LIMIT,
      }),
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: 15_000,
  });

  const customerCountQuery = useQuery({
    queryKey: [
      "customers",
      "count",
      {
        userId: user?.id ?? null,
        selectionMode: isSalespersonSelectionMode,
        q: submittedQuery,
        hasCart,
        hasOrderBalance,
        priceGroup: selectedPriceGroup,
      },
    ],
    enabled: typeof user?.id === "number",
    queryFn: () =>
      listCustomers({
        q: submittedQuery || undefined,
        has_cart: hasCart ? true : undefined,
        has_order_balance: hasOrderBalance ? true : undefined,
        price_group: selectedPriceGroup || undefined,
        selection_mode: isSalesperson ? true : undefined,
        summary: "count",
        limit: 1,
      }),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: 30_000,
  });

  const customers = useMemo(() => {
    const seenCustomerIds = new Set<number>();

    return (customersQuery.data?.pages ?? [])
      .flatMap((page) => page.data)
      .filter((customer) => {
        if (seenCustomerIds.has(customer.id)) {
          return false;
        }

        seenCustomerIds.add(customer.id);

        return true;
      });
  }, [customersQuery.data?.pages]);
  const priceGroupOptions = useMemo(() => {
    const options = customersQuery.data?.pages[0]?.meta?.price_groups ?? [];
    const hasSelectedOption = selectedPriceGroup === "" || options.some((option) => option.code === selectedPriceGroup);

    return hasSelectedOption
      ? options
      : [{ code: selectedPriceGroup, label: selectedPriceGroup }, ...options];
  }, [customersQuery.data?.pages, selectedPriceGroup]);
  const hasActiveFilters = Boolean(submittedQuery) || hasCart || hasOrderBalance || Boolean(selectedPriceGroup);
  const displayCustomers = customers;
  const loadedCustomerCount = displayCustomers.length;
  const totalCustomerCount = customerCountQuery.data?.total_count ?? customersQuery.data?.pages[0]?.total_count ?? null;
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = customersQuery;
  const activeFilterCount =
    Number(Boolean(submittedQuery)) +
    Number(hasCart) +
    Number(hasOrderBalance) +
    Number(Boolean(selectedPriceGroup));
  const selectMutation = useMutation({
    mutationFn: async (customer: CustomerListItem) => {
      await selectCustomer(customer.id);
      return customer;
    },
    onSuccess: (customer) => {
      toast.success(`${customer.code} - ${customer.title} seçildi`);
      const safeNext = getSafeCustomerSelectionNext(searchParams.get("next"));

      if (hadCustomerOnOpenRef.current) {
        if (safeNext) {
          router.replace(safeNext);
          return;
        }

        router.back();
        return;
      }

      router.replace("/search");
    },
  });
  const filtersDisabled = selectMutation.isPending;
  const hasMoreCustomers = hasNextPage;
  const isLoadingMoreCustomers = isFetchingNextPage;

  useEffect(() => {
    const marker = infiniteScrollMarkerRef.current;

    if (!marker || !hasMoreCustomers || isLoadingMoreCustomers || selectMutation.isPending) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void fetchNextPage();
        }
      },
      { rootMargin: "520px 0px" }
    );

    observer.observe(marker);

    return () => observer.disconnect();
  }, [
    fetchNextPage,
    hasMoreCustomers,
    isLoadingMoreCustomers,
    selectMutation.isPending,
  ]);

  const handleSelectCustomer = (customer: CustomerListItem) => {
    selectMutation.mutate(customer);
  };

  const submitSearch = () => {
    setSubmittedQuery(queryInput.trim());
  };

  const clearSearch = () => {
    setQueryInput("");
    setSubmittedQuery("");
  };

  const clearFilters = () => {
    setQueryInput("");
    setSubmittedQuery("");
    setHasCart(false);
    setHasOrderBalance(false);
    setPriceGroup(ALL_PRICE_GROUPS);
  };

  return (
    <div
      className={cn(
        "admin-customers-page space-y-4",
        isSalespersonSelectionMode ? "mx-auto w-full max-w-[1840px] space-y-3" : ""
      )}
    >
      <Card
        className={cn(
          "dashboard-panel-card overflow-hidden",
          isDarkMode && "border-[var(--brand-border)]/70 bg-[var(--surface)] shadow-[0_22px_46px_-38px_rgba(0,0,0,0.6)]"
        )}
      >
        <CardContent className="space-y-3 pt-3">
          <div
            className={cn(
              "admin-customer-filter rounded-[18px] px-3 py-3 shadow-[0_14px_28px_-30px_rgba(10,32,20,0.34)] sm:px-4",
              isDarkMode
                ? "bg-[linear-gradient(180deg,var(--surface)_0%,var(--surface-soft)_100%)] shadow-[0_20px_34px_-30px_rgba(0,0,0,0.65)]"
                : "bg-[linear-gradient(180deg,#fbfdfb_0%,#f5f9f5_100%)]"
            )}
          >
            <div
              className={cn(
                "grid gap-2 lg:items-center",
                isSalesperson
                  ? "lg:grid-cols-[minmax(240px,1fr)_92px_88px_142px_142px_130px_112px]"
                  : "lg:grid-cols-[minmax(280px,1fr)_92px_88px_142px_142px_130px]"
              )}
            >
              <div>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4.5 w-4.5 -translate-y-1/2 text-[var(--brand-primary)]" />
                  <Input
                    value={queryInput}
                    disabled={filtersDisabled}
                    onChange={(event) => setQueryInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        submitSearch();
                      }
                    }}
                    placeholder="Cari kodu veya ünvanı ara..."
                    className="admin-dashboard-input h-12 rounded-[13px] pl-10 text-[15px] font-semibold"
                  />
                </div>
              </div>

              <Button
                type="button"
                className="h-12 min-w-0 rounded-[13px] border border-[#3f8f54] bg-[#2f7f56] px-3 text-[14px] font-black text-white shadow-[0_12px_22px_-20px_rgba(47,127,86,0.9)] hover:bg-[#276d49] hover:text-white"
                disabled={filtersDisabled}
                onClick={submitSearch}
              >
                <Search className="h-4 w-4" />
                Ara
              </Button>

              <Button
                type="button"
                variant="outline"
                className="h-12 min-w-0 rounded-[13px] border-[#ef4444] bg-[#dc2626] px-3 text-[14px] font-black text-white shadow-[0_12px_22px_-20px_rgba(220,38,38,0.95)] hover:border-[#dc2626] hover:bg-[#b91c1c] hover:text-white disabled:border-[#dc2626] disabled:bg-[#b91c1c] disabled:text-white disabled:opacity-70"
                disabled={filtersDisabled || (!queryInput && !submittedQuery)}
                onClick={clearSearch}
              >
                <X className="h-4 w-4" />
                Sil
              </Button>

              <div className="customer-filter-actions col-span-full grid grid-cols-2 items-stretch gap-2 lg:contents">
              <Toggle
                pressed={hasCart}
                onPressedChange={setHasCart}
                aria-label="Has cart filter"
                className={cn(
                  "h-12 flex-1 justify-center gap-2 rounded-[13px] border px-2 text-[12px] font-black shadow-[0_10px_20px_-18px_rgba(20,54,34,0.7)] transition-all hover:scale-[1.01] hover:shadow-[0_14px_24px_-22px_rgba(20,54,34,0.85)] sm:px-3 sm:text-[13px]",
                  hasCart
                    ? "border-[#3f8f54] bg-[#2f7f56] text-white hover:bg-[#276d49]"
                    : isDarkMode
                      ? "border-[#345b40] bg-[#14251a] text-[#8bd19f] hover:bg-[#19301f]"
                      : "border-[#b9dec4] bg-[#eef9f1] text-[#2f7f56] hover:bg-[#e1f4e7]"
                )}
                disabled={filtersDisabled}
              >
                <ShoppingBasket className="h-4 w-4" />
                Sepette Olanlar
              </Toggle>

              <Toggle
                pressed={hasOrderBalance}
                onPressedChange={setHasOrderBalance}
                aria-label="Has order balance filter"
                className={cn(
                  "h-12 flex-1 justify-center gap-2 rounded-[13px] border px-2 text-[12px] font-black shadow-[0_10px_20px_-18px_rgba(145,40,38,0.8)] transition-all hover:scale-[1.01] hover:shadow-[0_14px_24px_-22px_rgba(145,40,38,0.9)] sm:px-3 sm:text-[13px]",
                  hasOrderBalance
                    ? "border-[#c3403c] bg-[#b83232] text-white hover:bg-[#9f292b]"
                    : isDarkMode
                      ? "border-[#68403d] bg-[#2b1817] text-[#f0a6a2] hover:bg-[#351d1b]"
                      : "border-[#efc1bd] bg-[#fff0ef] text-[#b83232] hover:bg-[#ffe4e2]"
                )}
                disabled={filtersDisabled}
              >
                <Wallet className="h-4 w-4" />
                Bakiye Siparişi
              </Toggle>

              <Select
                value={priceGroup}
                onValueChange={setPriceGroup}
                disabled={filtersDisabled || priceGroupOptions.length === 0}
              >
                <SelectTrigger
                  aria-label="Cari fiyat grubu filtresi"
                  className={cn(
                    "h-12 rounded-[13px] border px-3 text-[12px] font-black shadow-[0_10px_20px_-18px_rgba(20,54,34,0.7)] sm:text-[13px]",
                    selectedPriceGroup
                      ? "border-[#3f8f54] bg-[#2f7f56] text-white"
                      : isDarkMode
                        ? "border-[#345b40] bg-[#14251a] text-[#8bd19f]"
                        : "border-[#b9dec4] bg-[#eef9f1] text-[#2f7f56]"
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Tags className="h-4 w-4 shrink-0" />
                    <SelectValue placeholder="F Grubu" />
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_PRICE_GROUPS}>Tüm F Grupları</SelectItem>
                  {priceGroupOptions.map((option) => (
                    <SelectItem key={option.code} value={option.code}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {isSalesperson ? (
                <Button
                  className="h-12 flex-1 rounded-[13px] bg-amber-500 px-2 text-[12px] font-black text-slate-950 hover:bg-amber-400 sm:px-3 sm:text-[13px]"
                  asChild
                >
                  <Link href="/pos/expenses">
                    <ReceiptText className="mr-1 h-4 w-4" />
                    Giderler
                  </Link>
                </Button>
              ) : null}
            </div>
            </div>

            {hasActiveFilters ? (
              <div
                className={cn(
                  "mt-3 flex flex-wrap items-center gap-2 rounded-xl px-3 py-2",
                  isDarkMode ? "bg-[var(--surface-soft)]" : "bg-white/80"
                )}
              >
                <p className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--muted-foreground)]">
                  <Activity className="h-3.5 w-3.5" />
                  Aktif Filtre: {activeFilterCount}
                </p>
                {submittedQuery ? (
                  <Badge variant="secondary" className="gap-1">
                    q: {submittedQuery}
                    <button type="button" onClick={clearSearch} aria-label="Clear query">
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ) : null}
                {hasCart ? (
                  <Badge variant="secondary" className="gap-1">
                    Sepette Olanlar
                    <button type="button" onClick={() => setHasCart(false)} aria-label="Clear has cart">
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ) : null}
                {hasOrderBalance ? (
                  <Badge variant="secondary" className="gap-1">
                    Bakiye Siparişi
                    <button
                      type="button"
                      onClick={() => setHasOrderBalance(false)}
                      aria-label="Clear has order balance"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ) : null}
                {selectedPriceGroup ? (
                  <Badge variant="secondary" className="gap-1">
                    F Grubu: {selectedPriceGroup}
                    <button
                      type="button"
                      onClick={() => setPriceGroup(ALL_PRICE_GROUPS)}
                      aria-label="Clear price group"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ) : null}
                <Button
                  variant="ghost"
                  size="default"
                  className="h-10 px-4 text-base"
                  disabled={filtersDisabled}
                  onClick={clearFilters}
                >
                  Temizle
                </Button>
              </div>
            ) : null}
          </div>

          <div
            className={cn(
              "admin-customer-list overflow-hidden rounded-[22px] shadow-[0_22px_46px_-38px_rgba(10,32,20,0.32)]",
              isDarkMode
                ? "bg-[var(--surface)] shadow-[0_24px_42px_-36px_rgba(0,0,0,0.7)]"
                : "bg-white"
            )}
          >
            <div className="overflow-hidden px-4 pb-1 pt-3 lg:px-5">
              <Table className="min-w-0 table-fixed text-[12px]">
                  <colgroup>
                    <col className="w-[8%]" />
                    <col className="w-[29%]" />
                    <col className="w-[10.5%]" />
                    <col className="w-[9.5%]" />
                    <col className="w-[10%]" />
                    <col className="w-[8%]" />
                    <col className="w-[10.5%]" />
                    <col className="w-[6.5%]" />
                    <col className="w-[10.5%]" />
                  </colgroup>
                  <TableHeader className="bg-[linear-gradient(135deg,rgba(22,128,55,0.96)_0%,rgba(18,90,45,0.98)_52%,rgba(11,64,35,1)_100%)]">
                    <TableRow className="border-b border-emerald-300/35 hover:bg-transparent">
                      <TableHead className="h-9 px-2 text-center text-[10px] font-bold uppercase tracking-[0.1em] text-white">
                        Kod
                      </TableHead>
                      <TableHead className="h-9 pr-3 text-[10px] font-bold uppercase tracking-[0.1em] text-white">
                        Ünvan
                      </TableHead>
                      <TableHead className="h-9 text-center text-[10px] font-bold uppercase tracking-[0.1em] text-white">
                        İl/İlçe
                      </TableHead>
                      <TableHead className="h-9 text-center text-[10px] font-bold uppercase tracking-[0.1em] text-white">
                        Telefon
                      </TableHead>
                      <TableHead className="h-9 text-center text-[10px] font-bold uppercase tracking-[0.1em] text-white">
                        Cari Borç
                      </TableHead>
                      <TableHead className="h-9 text-center text-[10px] font-bold uppercase tracking-[0.1em] text-white">
                        Sepet Sipariş
                      </TableHead>
                      <TableHead className="h-9 text-center text-[10px] font-bold uppercase tracking-[0.1em] text-white">
                        Bakiye Siparişi
                      </TableHead>
                      <TableHead className="h-9 text-center text-[10px] font-bold uppercase tracking-[0.1em] text-white">
                        F Kodu
                      </TableHead>
                      <TableHead className="h-9 px-2 text-center text-[10px] font-bold uppercase tracking-[0.1em] text-white">
                        Aksiyon
                      </TableHead>
                    </TableRow>
                  </TableHeader>

                  <TableBody>
                    {customersQuery.isLoading ? (
                      Array.from({ length: 8 }).map((_, index) => (
                        <TableRow key={`skeleton-${index}`} className={cn(isDarkMode ? "border-b border-[var(--brand-border)]" : "border-b border-[#e7eee8]")}>
                          <TableCell className="px-5 py-4"><Skeleton className="h-5 w-24" /></TableCell>
                          <TableCell className="py-4"><Skeleton className="h-5 w-56" /></TableCell>
                          <TableCell className="py-4"><Skeleton className="h-5 w-32" /></TableCell>
                          <TableCell className="py-4"><Skeleton className="h-5 w-28" /></TableCell>
                          <TableCell className="py-4 text-right"><Skeleton className="ml-auto h-12 w-28 rounded-2xl" /></TableCell>
                          <TableCell className="py-4 text-center"><Skeleton className="mx-auto h-9 w-24 rounded-full" /></TableCell>
                          <TableCell className="py-4 text-right"><Skeleton className="ml-auto h-12 w-32 rounded-2xl" /></TableCell>
                          <TableCell className="py-4 text-center"><Skeleton className="mx-auto h-9 w-14 rounded-xl" /></TableCell>
                          <TableCell className="px-5 py-4 text-right"><Skeleton className="ml-auto h-10 w-24 rounded-xl" /></TableCell>
                        </TableRow>
                      ))
                    ) : null}

                    {customersQuery.isError ? (
                      <TableRow>
                        <TableCell colSpan={9} className="py-8 text-center text-base text-red-600">
                          {(customersQuery.error as Error).message}
                        </TableCell>
                      </TableRow>
                    ) : null}

                    {!customersQuery.isLoading && !customersQuery.isError && displayCustomers.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} className="py-10 text-center text-[var(--muted-foreground)]">
                          <p>Sonuç bulunamadı.</p>
                          {hasActiveFilters ? (
                            <Button variant="outline" size="sm" className="mt-3" onClick={clearFilters}>
                              Filtreleri Temizle
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ) : null}

                    {!customersQuery.isLoading &&
                      !customersQuery.isError &&
                      displayCustomers.map((customer) => {
                        const isSelected = selectedCustomer?.id === customer.id;
                        const isSelecting =
                          selectMutation.isPending && selectMutation.variables?.id === customer.id;
                        const phoneLabel = formatLogoText(customer.phone, "Telefon tanımlı değil");
                        return (
                          <TableRow
                            key={customer.id}
                            role="button"
                            tabIndex={0}
                            aria-label={`Müşteri seç: ${customer.code}`}
                            onClick={() => {
                              handleSelectCustomer(customer);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                handleSelectCustomer(customer);
                              }
                            }}
                            className={cn(
                              "cursor-pointer border-b border-l-4 border-l-transparent transition-[background-color,border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]/30",
                              isDarkMode
                                ? "border-[var(--brand-border)] hover:border-l-[#8bd19f] hover:bg-[#1d3024] hover:shadow-[inset_0_0_0_9999px_rgba(139,209,159,0.06)]"
                                : "border-[#e7eee8] hover:border-l-[#2f7f56] hover:bg-[#e7f6eb] hover:shadow-[inset_0_0_0_9999px_rgba(47,127,86,0.055)]",
                              isSelected
                                ? isDarkMode
                                  ? "border-l-[#a8e063] bg-[#183f28] shadow-[inset_0_0_0_9999px_rgba(168,224,99,0.12),0_14px_28px_-24px_rgba(168,224,99,0.85)]"
                                  : "border-l-[#238347] bg-[#dff6e6] shadow-[inset_0_0_0_9999px_rgba(47,127,86,0.08),0_14px_28px_-24px_rgba(47,127,86,0.55)]"
                                : isDarkMode
                                  ? "bg-[var(--surface)]"
                                  : "bg-white"
                            )}
                          >
                            <TableCell className="px-2 py-1.5 text-center align-middle">
                              <div className="flex justify-center">
                                <p
                                  title={customer.code}
                                  className="max-w-full truncate whitespace-nowrap text-center text-[11px] font-bold leading-4 tracking-[0.01em] text-[var(--muted-foreground)]"
                                >
                                  {customer.code}
                                </p>
                              </div>
                            </TableCell>
                            <TableCell className="py-1.5 align-middle">
                              <div className="min-w-0 pr-3">
                                <p
                                  title={customer.title}
                                  className={cn(
                                    "block max-w-full truncate whitespace-nowrap text-[13px] font-extrabold leading-5 tracking-[0.005em]",
                                    isDarkMode ? "text-[var(--foreground)]" : "text-[#183522]"
                                  )}
                                >
                                  {customer.title}
                                </p>
                              </div>
                            </TableCell>
                            <TableCell className="py-1.5 text-center align-middle">
                              <div className="flex min-w-0 justify-center pr-1">
                                <p
                                  title={formatCustomerLocation(customer)}
                                  className={cn(
                                    "block max-w-full truncate whitespace-nowrap text-center text-[12px] font-medium leading-4",
                                    isDarkMode ? "text-[var(--foreground)]" : "text-[#24452f]"
                                  )}
                                >
                                  {formatCustomerLocation(customer)}
                                </p>
                              </div>
                            </TableCell>
                            <TableCell className="py-1.5 text-center align-middle">
                              <div className="flex justify-center pr-1">
                                <p
                                  title={phoneLabel}
                                  className={cn(
                                    "max-w-full truncate whitespace-nowrap text-center text-[12px] font-medium leading-4",
                                    isDarkMode ? "text-[var(--muted-foreground)]" : "text-[#48604f]"
                                  )}
                                >
                                  {phoneLabel}
                                </p>
                              </div>
                            </TableCell>
                            <TableCell className="py-1.5 text-center align-middle">
                              <div
                                className={cn(
                                  "mx-auto inline-flex min-w-[92px] justify-center rounded-lg border px-2 py-1.5 text-center",
                                  getAmountTone(customer.balance_summary.total_due, isDarkMode)
                                )}
                              >
                                <span className="whitespace-nowrap text-[13px] font-extrabold">
                                  {formatBalance(
                                    customer.balance_summary.total_due,
                                    customer.balance_summary.currency
                                  )}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell className="py-1.5 text-center align-middle">
                              <span
                                className={cn(
                                  "inline-flex min-w-[66px] items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-[10px] font-black uppercase tracking-[0.06em]",
                                  customer.has_cart
                                    ? isDarkMode
                                      ? "border-[#456e91] bg-[#132436] text-[#a9d8ff]"
                                      : "border-[#b9d8f3] bg-[#eef7ff] text-[#1f5f91]"
                                    : isDarkMode
                                      ? "border-[var(--brand-border)] bg-[var(--surface-soft)] text-[var(--muted-foreground)]"
                                      : "border-[#dce7de] bg-[#f8fbf8] text-[#5c7160]"
                                )}
                              >
                                {customer.has_cart ? "Var" : "Yok"}
                              </span>
                            </TableCell>
                            <TableCell className="py-1.5 text-center align-middle">
                              <div
                                className={cn(
                                  "mx-auto inline-flex min-w-[98px] justify-center rounded-lg border px-2 py-1.5 text-center",
                                  getAmountTone(customer.balance_summary.order_due, isDarkMode)
                                )}
                              >
                                <span className="whitespace-nowrap text-[13px] font-extrabold">
                                  {formatBalance(
                                    customer.balance_summary.order_due,
                                    customer.balance_summary.currency
                                  )}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell className="py-1.5 text-center align-middle">
                              <span
                                className={cn(
                                  "inline-flex min-w-[54px] items-center justify-center rounded-lg border px-2 py-1.5 text-[11px] font-black",
                                  customer.price_group
                                    ? isDarkMode
                                      ? "border-[#4d7c5d] bg-[#173523] text-[#a8e063]"
                                      : "border-[#b9dec4] bg-[#eef9f1] text-[#176b3a]"
                                    : isDarkMode
                                      ? "border-[var(--brand-border)] bg-[var(--surface-soft)] text-[var(--muted-foreground)]"
                                      : "border-[#dce7de] bg-[#f8fbf8] text-[#5c7160]"
                                )}
                              >
                                {customer.price_group ?? "-"}
                              </span>
                            </TableCell>
                            <TableCell className="px-2 py-1.5 text-center align-middle">
                              <Button
                                size="default"
                                variant={isSelected ? "secondary" : "default"}
                                className={cn(
                                  "h-8 min-w-[78px] rounded-lg px-3 text-xs font-black",
                                  isSelected
                                    ? "border border-[#2f7f56] bg-[#2f7f56] text-white shadow-[0_10px_20px_-16px_rgba(47,127,86,0.85)] hover:bg-[#276d49] hover:text-white"
                                    : "border border-red-200/45 bg-gradient-to-b from-[#ef3340] via-[#d71920] to-[#b30824] text-white shadow-[0_12px_22px_-16px_rgba(239,51,64,0.95),inset_0_1px_0_rgba(255,255,255,0.42)] hover:from-[#ff4d57] hover:via-[#e31d28] hover:to-[#b30824] hover:text-white"
                                )}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleSelectCustomer(customer);
                                }}
                                disabled={selectMutation.isPending}
                              >
                                {isSelecting ? (
                                  <>
                                    <Loader2 className="h-4 w-4 animate-spin" /> Seçiliyor
                                  </>
                                ) : isSelected ? (
                                  <>
                                    <Check className="h-4 w-4" /> Seçili
                                  </>
                                ) : (
                                  "Cari Seç"
                                )}
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}

                    {customersQuery.isFetchingNextPage ? (
                      <TableRow>
                        <TableCell colSpan={9} className="py-5 text-center text-base text-[var(--muted-foreground)]">
                          <span className="inline-flex items-center gap-2">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Devamı yükleniyor...
                          </span>
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
            </div>

            <div
              className={cn(
                "mt-3 flex flex-col gap-3 px-5 py-4 md:flex-row md:items-center md:justify-between"
              )}
            >
              <p className="text-base text-[var(--muted-foreground)]">
                {totalCustomerCount === null
                  ? `${loadedCustomerCount} kayıt yüklendi · Limit ${PAGE_LIMIT}`
                  : `${loadedCustomerCount} / ${totalCustomerCount} kayıt yüklendi · Limit ${PAGE_LIMIT}`}
              </p>
              <div className="flex items-center gap-2">
                {isLoadingMoreCustomers ? (
                  <span className="inline-flex items-center gap-2 text-base font-semibold text-[var(--muted-foreground)]">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Yükleniyor
                  </span>
                ) : hasMoreCustomers ? (
                  <span className="text-base font-semibold text-[var(--muted-foreground)]">
                    Aşağı indikçe devamı yüklenecek
                  </span>
                ) : loadedCustomerCount > 0 ? (
                  <span className="text-base font-semibold text-[var(--muted-foreground)]">
                    Tüm kayıtlar yüklendi
                  </span>
                ) : null}
              </div>
            </div>
            <div ref={infiniteScrollMarkerRef} className="h-8" aria-hidden="true" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
