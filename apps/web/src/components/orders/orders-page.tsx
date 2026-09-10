"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, Clock3, Eye, Loader2, RefreshCcw, Search, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSession } from "@/components/auth/session-provider";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { Skeleton } from "@/components/ui/skeleton";
import { getOrderDetail, getReportOrderBalances, type OrderDetailResponse } from "@/lib/api";

const STATUS_OPTIONS = [
  { value: "pending", label: "Beklemede" },
  { value: "approved", label: "Onaylandı" },
  { value: "processing", label: "Hazırlanıyor" },
  { value: "balance", label: "Bakiye" },
  { value: "picking", label: "Toplanıyor" },
  { value: "packed", label: "Hazırlandı" },
  { value: "shipped", label: "Sevk Edildi" },
  { value: "partially_shipped", label: "Kısmi Sevk" },
  { value: "completed", label: "Tamamlandı" },
  { value: "cancelled", label: "İptal" },
] as const;

const ORDER_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "medium",
  timeStyle: "short",
});

function getStatusMeta(status: string): { label: string; className: string } {
  const normalized = status.toLowerCase();

  if (normalized === "pending") {
    return {
      label: "Beklemede",
      className: "border-amber-300/35 bg-amber-300/10 text-amber-200",
    };
  }

  if (normalized === "approved") {
    return {
      label: "Onaylandı",
      className: "border-emerald-300/35 bg-emerald-300/10 text-emerald-200",
    };
  }

  if (normalized === "processing") {
    return {
      label: "Hazırlanıyor",
      className: "border-sky-300/35 bg-sky-300/10 text-sky-200",
    };
  }

  if (normalized === "balance") {
    return {
      label: "Bakiye",
      className: "border-yellow-300/40 bg-yellow-300/10 text-yellow-100",
    };
  }

  if (normalized === "picking") {
    return {
      label: "Toplanıyor",
      className: "border-blue-300/35 bg-blue-300/10 text-blue-200",
    };
  }

  if (normalized === "packed") {
    return {
      label: "Hazırlandı",
      className: "border-indigo-300/35 bg-indigo-300/10 text-indigo-200",
    };
  }

  if (normalized === "shipped") {
    return {
      label: "Sevk Edildi",
      className: "border-cyan-300/35 bg-cyan-300/10 text-cyan-200",
    };
  }

  if (normalized === "partially_shipped") {
    return {
      label: "Kısmi Sevk",
      className: "border-violet-300/35 bg-violet-300/10 text-violet-200",
    };
  }

  if (normalized === "completed") {
    return {
      label: "Tamamlandı",
      className: "border-lime-300/35 bg-lime-300/10 text-lime-200",
    };
  }

  if (normalized === "cancelled") {
    return {
      label: "İptal",
      className: "border-rose-300/35 bg-rose-300/10 text-rose-200",
    };
  }

  return {
    label: status,
    className: "border-[var(--brand-border)] bg-[var(--surface-soft)] text-[var(--muted-foreground)]",
  };
}

function OrderStatusBadge({ status }: { status: string }) {
  const meta = getStatusMeta(status);
  return (
    <Badge variant="outline" className={`rounded-full px-3 py-1 text-[12px] font-black ${meta.className}`}>
      {meta.label}
    </Badge>
  );
}

function getCheckoutSummaryClass(code: string): string {
  if (code === "1-F") {
    return "border-emerald-300/45 bg-emerald-400/14 text-emerald-100";
  }

  if (code === "2-O" || code === "2-0") {
    return "border-sky-300/45 bg-sky-400/14 text-sky-100";
  }

  if (code === "3-B") {
    return "border-fuchsia-300/45 bg-fuchsia-400/14 text-fuchsia-100";
  }

  return "border-white/15 bg-white/[0.04] text-slate-200";
}

function isCargoMethod(value: string | null | undefined): boolean {
  const normalized = String(value ?? "").toLocaleUpperCase("tr-TR");
  return normalized.includes("KARGO") || normalized.includes("CARGO");
}

function formatOrderDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return ORDER_DATE_TIME_FORMATTER.format(parsed);
}

function toAmount(value: string): number {
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatTry(value: string, currency = "TRY"): string {
  const parsed = toAmount(value);
  const formatted = parsed.toLocaleString("tr-TR", {
    minimumFractionDigits: parsed % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return currency === "TRY" ? `${formatted} ₺` : `${formatted} ${currency}`;
}

function formatCompactTry(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} Mn ₺`;
  }

  if (Math.abs(value) >= 1_000) {
    return `${(value / 1_000).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} B ₺`;
  }

  return `${value.toLocaleString("tr-TR", { maximumFractionDigits: 0 })} ₺`;
}

function stockStatusMeta(available: number, required: number): { label: string; className: string } {
  if (available <= 0) {
    return { label: "Stok yok", className: "border-rose-300/30 bg-rose-300/10 text-rose-200" };
  }

  if (available < required) {
    return { label: "Eksik", className: "border-amber-300/30 bg-amber-300/10 text-amber-200" };
  }

  return { label: "Yeterli", className: "border-emerald-300/30 bg-emerald-300/10 text-emerald-200" };
}

type OrderRow = {
  order_id: number;
  order_no: string;
  status: string;
  customer: {
    id: number;
    code: string;
    title: string;
  };
  grand_total: string;
  remaining_quantity?: number;
  currency: string;
  ordered_at: string;
  logo_sync_status?: string | null;
  logo_sync_error?: string | null;
  logo_external_ref?: string | null;
  logo_last_synced_at?: string | null;
  checkout_summary?: {
    mode: "detailed" | "excluded" | "included";
    code: string;
    label: string;
  } | null;
  sales_price_type?: string | null;
  sales_price_type_label?: string | null;
  shipping_method?: string | null;
  origin?: {
    checkout_summary?: {
      mode: "detailed" | "excluded" | "included";
      code: string;
      label: string;
    } | null;
    sales_price_type?: string | null;
    sales_price_type_label?: string | null;
    shipping_method?: string | null;
  } | null;
};

type OrderBalanceReport = {
  summary: {
    open_order_count: number;
    open_grand_total: string;
  };
  status_breakdown: Array<{
    status: string;
    order_count: number;
    total: string;
  }>;
  data: OrderRow[];
  meta?: {
    current_page: number;
    last_page: number;
    per_page: number;
    total: number;
  };
};

export function OrdersPage() {
  const { selectedCustomer } = useSession();
  const [query, setQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [statuses, setStatuses] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<OrderBalanceReport | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailPayload, setDetailPayload] = useState<OrderDetailResponse | null>(null);
  const debouncedQuery = useDebouncedValue(query, 400);
  const hasInitializedQueryWatcher = useRef(false);

  const fetchReport = (
    targetPage = page,
    overrides?: { query?: string; dateFrom?: string; dateTo?: string; statuses?: string[] }
  ) => {
    const effectiveQuery = overrides?.query ?? query;
    const effectiveDateFrom = overrides?.dateFrom ?? dateFrom;
    const effectiveDateTo = overrides?.dateTo ?? dateTo;
    const effectiveStatuses = overrides?.statuses ?? statuses;

    setLoading(true);
    setError(null);

    void getReportOrderBalances({
      customer_id: selectedCustomer?.id,
      q: effectiveQuery || undefined,
      date_from: effectiveDateFrom || undefined,
      date_to: effectiveDateTo || undefined,
      statuses: effectiveStatuses.length ? effectiveStatuses : undefined,
      per_page: 20,
      page: targetPage,
    })
      .then((payload) => {
        setReport(payload as OrderBalanceReport);
        setPage(targetPage);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Sipariş raporu alınamadı"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    setPage(1);
    fetchReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomer?.id]);

  useEffect(() => {
    if (!hasInitializedQueryWatcher.current) {
      hasInitializedQueryWatcher.current = true;
      return;
    }

    setPage(1);
    fetchReport(1, { query: debouncedQuery });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery]);

  const hasActiveFilters = Boolean(query) || Boolean(dateFrom) || Boolean(dateTo) || statuses.length > 0;
  const displayRows = useMemo(() => report?.data ?? [], [report?.data]);
  const listedOrderCount = displayRows.length;
  const balanceOnlyMode = statuses.length === 1 && statuses[0] === "balance";
  const summaryOpenOrderCount = report?.summary.open_order_count ?? 0;
  const summaryOpenGrandTotal = report?.summary.open_grand_total ?? "0";
  const detailStockShortageCount = useMemo(
    () =>
      detailPayload?.order.items.filter((item) => (item.logo_stock?.available_total ?? 0) < item.quantity).length ?? 0,
    [detailPayload?.order.items]
  );
  const detailIsBalance = detailPayload?.order.status === "balance";
  const detailBalanceItems = useMemo(
    () => detailPayload?.order.items.filter((item) => (item.remaining_quantity ?? 0) > 0) ?? [],
    [detailPayload?.order.items]
  );
  const detailBalanceQuantity = useMemo(
    () => detailBalanceItems.reduce((sum, item) => sum + (item.remaining_quantity ?? 0), 0),
    [detailBalanceItems]
  );

  const toggleStatus = (status: string) => {
    const nextStatuses = statuses.includes(status)
      ? statuses.filter((item) => item !== status)
      : [...statuses, status];
    setStatuses(nextStatuses);
    setPage(1);
    fetchReport(1, { statuses: nextStatuses });
  };

  const clearFilters = () => {
    setQuery("");
    setDateFrom("");
    setDateTo("");
    setStatuses([]);
    setPage(1);
    fetchReport(1, { query: "", dateFrom: "", dateTo: "", statuses: [] });
  };

  const openDetail = (orderId: number) => {
    setDetailOpen(true);
    setDetailLoading(true);
    setDetailError(null);
    setDetailPayload(null);

    void getOrderDetail(orderId)
      .then((payload) => setDetailPayload(payload))
      .catch((err) => setDetailError(err instanceof Error ? err.message : "Sipariş detayı alınamadı"))
      .finally(() => setDetailLoading(false));
  };

  return (
    <div className="orders-page space-y-3 text-slate-100">
      <div className="grid gap-2 rounded-[16px] border border-white/10 bg-[linear-gradient(180deg,rgba(15,29,38,0.76)_0%,rgba(9,19,28,0.84)_100%)] p-2 shadow-[0_16px_30px_-30px_rgba(0,0,0,0.48)] sm:grid-cols-3">
        <div className="px-3 py-1.5">
          <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">Açık Sipariş</p>
          <p className="text-xl font-black text-white">{summaryOpenOrderCount}</p>
        </div>
        <div className="border-t border-white/10 px-3 py-1.5 sm:border-l sm:border-t-0">
          <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">Açık Tutar</p>
          <p className="text-xl font-black text-emerald-300">{formatCompactTry(toAmount(summaryOpenGrandTotal))}</p>
        </div>
        <div className="border-t border-white/10 px-3 py-1.5 sm:border-l sm:border-t-0">
          <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">Listelenen</p>
          <p className="text-xl font-black text-white">{listedOrderCount}</p>
        </div>
      </div>

      <Card className="overflow-hidden border-white/10 bg-[linear-gradient(180deg,rgba(15,29,38,0.76)_0%,rgba(9,19,28,0.84)_100%)] shadow-[0_18px_34px_-30px_rgba(0,0,0,0.48)]">
        <CardContent className="space-y-2 p-3">
          <div className="grid gap-2 xl:grid-cols-[1.25fr_0.9fr_0.9fr_auto] xl:items-end">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Sipariş no / müşteri ara"
                className="h-10 rounded-[12px] border-white/10 bg-white/[0.035] pl-10 text-sm font-semibold text-slate-100 placeholder:text-slate-500"
              />
            </div>
            <div>
              <label className="mb-1 inline-flex items-center gap-1 text-[11px] font-black uppercase tracking-[0.1em] text-slate-500">
                <CalendarDays className="h-3.5 w-3.5" />
                Başlangıç
              </label>
              <Input
                type="date"
                value={dateFrom}
                disabled={loading}
                onChange={(event) => setDateFrom(event.target.value)}
                className="h-10 rounded-[12px] border-white/10 bg-white/[0.035] text-sm font-semibold text-slate-100"
              />
            </div>
            <div>
              <label className="mb-1 inline-flex items-center gap-1 text-[11px] font-black uppercase tracking-[0.1em] text-slate-500">
                <CalendarDays className="h-3.5 w-3.5" />
                Bitiş
              </label>
              <Input
                type="date"
                value={dateTo}
                disabled={loading}
                onChange={(event) => setDateTo(event.target.value)}
                className="h-10 rounded-[12px] border-white/10 bg-white/[0.035] text-sm font-semibold text-slate-100"
              />
            </div>
            <Button
              className="h-10 rounded-[12px] bg-slate-200 px-4 font-black text-slate-950 hover:bg-white"
              onClick={() => {
                setPage(1);
                fetchReport(1);
              }}
              disabled={loading}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
              {loading ? "Yükleniyor..." : "Yenile"}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
              {STATUS_OPTIONS.map((option) => {
                const selected = statuses.includes(option.value);
                return (
                  <Button
                    key={option.value}
                    size="sm"
                    variant={selected ? "default" : "outline"}
                    disabled={loading}
                    onClick={() => toggleStatus(option.value)}
                    className={selected ? "h-8 rounded-full bg-emerald-400 px-3 text-xs font-black text-slate-950 hover:bg-emerald-300" : "h-8 rounded-full border-white/10 bg-white/[0.035] px-3 text-xs font-black text-slate-300 hover:bg-white/[0.07] hover:text-white"}
                  >
                    {option.label}
                  </Button>
                );
              })}
          </div>

          {hasActiveFilters ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
              {query ? (
                <Badge variant="secondary" className="gap-1">
                  q: {query}
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setPage(1);
                      fetchReport(1, { query: "" });
                    }}
                    aria-label="Clear query"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ) : null}
              {dateFrom ? (
                <Badge variant="secondary" className="gap-1">
                  Başlangıç: {dateFrom}
                  <button
                    type="button"
                    onClick={() => {
                      setDateFrom("");
                      setPage(1);
                      fetchReport(1, { dateFrom: "" });
                    }}
                    aria-label="Clear date from"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ) : null}
              {dateTo ? (
                <Badge variant="secondary" className="gap-1">
                  Bitiş: {dateTo}
                  <button
                    type="button"
                    onClick={() => {
                      setDateTo("");
                      setPage(1);
                      fetchReport(1, { dateTo: "" });
                    }}
                    aria-label="Clear date to"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ) : null}
              {statuses.map((status) => (
                <Badge key={status} variant="outline" className={`gap-1 ${getStatusMeta(status).className}`}>
                  {getStatusMeta(status).label}
                  <button
                    type="button"
                    onClick={() => {
                      const nextStatuses = statuses.filter((item) => item !== status);
                      setStatuses(nextStatuses);
                      setPage(1);
                      fetchReport(1, { statuses: nextStatuses });
                    }}
                    aria-label={`Clear ${status}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
              <Button variant="ghost" size="sm" onClick={clearFilters} disabled={loading} className="text-slate-300 hover:text-white">
                Temizle
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <div>
        <Card className="overflow-hidden border-white/10 bg-[linear-gradient(180deg,rgba(15,29,38,0.76)_0%,rgba(9,19,28,0.84)_100%)] shadow-[0_18px_34px_-30px_rgba(0,0,0,0.48)]">
          <CardHeader className="border-b border-white/10 pb-3">
            <CardTitle className="flex items-center justify-between gap-2 text-lg font-black text-white">
              <span>Sipariş Listesi</span>
              <Badge variant="outline" className="rounded-full border-white/10 bg-white/[0.04] px-3 py-1 text-slate-300">{listedOrderCount}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">
                {Array.from({ length: 6 }).map((_, index) => (
                  <Skeleton key={`orders-list-skeleton-${index}`} className="h-10 w-full" />
                ))}
              </div>
            ) : displayRows.length === 0 ? (
              <p className="rounded-md bg-[var(--surface-soft)] p-4 text-sm text-[var(--muted-foreground)]">
                Kayıt yok.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">
                      <th className="py-3">No</th>
                      <th className="py-3">Müşteri</th>
                      <th className="py-3">{balanceOnlyMode ? "Bakiye Adedi" : "Durum"}</th>
                      <th className="py-3">Tarih</th>
                      {!balanceOnlyMode ? <th className="py-3 text-right">Tutar</th> : null}
                      <th className="py-3 text-right">İşlem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.map((row) => {
                      const checkoutSummary = row.origin?.checkout_summary ?? row.checkout_summary ?? null;
                      const shippingMethod = row.origin?.shipping_method ?? row.shipping_method ?? null;
                      const salesPriceType = row.origin?.sales_price_type_label ?? row.sales_price_type_label ?? row.origin?.sales_price_type ?? row.sales_price_type ?? null;

                      return (
                      <tr
                        key={row.order_id}
                        role="button"
                        tabIndex={0}
                        aria-label={`Sipariş detayı aç: ${row.order_no}`}
                        onClick={() => {
                          if (row.order_id > 0) {
                            openDetail(row.order_id);
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            if (row.order_id > 0) {
                              openDetail(row.order_id);
                            }
                          }
                        }}
                        className="cursor-pointer border-b border-white/10 transition-colors hover:bg-white/[0.035] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/30"
                      >
                        <td className="py-3 font-black tracking-wide text-white">{row.order_no}</td>
                        <td className="py-3 text-slate-300">
                          {row.customer.code} - {row.customer.title}
                        </td>
                        <td className="py-3">
                          {balanceOnlyMode ? (
                            <strong className="text-lg font-black text-yellow-100">{row.remaining_quantity ?? 0}</strong>
                          ) : (
                            <div className="flex flex-wrap gap-1.5">
                              <OrderStatusBadge status={row.status} />
                              {checkoutSummary ? (
                                <Badge variant="outline" className={`rounded-full px-2.5 py-1 text-[11px] font-black ${getCheckoutSummaryClass(checkoutSummary.code)}`}>
                                  {checkoutSummary.label}
                                </Badge>
                              ) : null}
                              {salesPriceType ? (
                                <Badge variant="outline" className="rounded-full border-sky-300/35 bg-sky-300/10 px-2.5 py-1 text-[11px] font-black text-sky-100">
                                  {salesPriceType}
                                </Badge>
                              ) : null}
                              {isCargoMethod(shippingMethod) ? (
                                <Badge variant="outline" className="rounded-full border-rose-200/60 bg-rose-100 px-2.5 py-1 text-[11px] font-black text-rose-800">
                                  KARGO
                                </Badge>
                              ) : null}
                              {(row.remaining_quantity ?? 0) > 0 ? (
                                <Badge variant="outline" className="rounded-full border-yellow-300/40 bg-yellow-300/10 px-3 py-1 text-[12px] font-black text-yellow-100">
                                  Bakiye {row.remaining_quantity}
                                </Badge>
                              ) : null}
                            </div>
                          )}
                        </td>
                        <td className="py-3 text-slate-400">{formatOrderDateTime(row.ordered_at)}</td>
                        {!balanceOnlyMode ? (
                          <td className="py-3 text-right font-black text-white">{formatTry(row.grand_total, row.currency)}</td>
                        ) : null}
                        <td className="py-3 text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={row.order_id <= 0}
                            className="rounded-[12px] border-white/10 bg-white/[0.035] text-slate-200 hover:bg-white/[0.07] hover:text-white"
                            onClick={(event) => {
                              event.stopPropagation();
                              if (row.order_id > 0) {
                                openDetail(row.order_id);
                              }
                            }}
                          >
                            <Eye className="h-3.5 w-3.5" />
                            <span className="sr-only">Detay</span>
                          </Button>
                        </td>
                      </tr>
                    );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {report?.meta ? (
              (() => {
                const meta = report.meta;

                return (
                  <div className="mt-4 flex items-center justify-between">
                    <p className="text-xs text-[var(--muted-foreground)]">
                      {meta.current_page}/{meta.last_page} · {meta.total} kayıt
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={loading || meta.current_page <= 1}
                        className="rounded-[12px] border-white/10 bg-white/[0.035] text-slate-300 hover:bg-white/[0.07] hover:text-white"
                        onClick={() => fetchReport(meta.current_page - 1)}
                      >
                        Önceki
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={loading || meta.current_page >= meta.last_page}
                        className="rounded-[12px] border-white/10 bg-white/[0.035] text-slate-300 hover:bg-white/[0.07] hover:text-white"
                        onClick={() => fetchReport(meta.current_page + 1)}
                      >
                        Sonraki
                      </Button>
                    </div>
                  </div>
                );
              })()
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-h-[calc(100vh-32px)] max-w-[min(980px,calc(100vw-24px))] overflow-y-auto rounded-[24px] border border-emerald-300/20 bg-[linear-gradient(145deg,rgba(12,24,32,0.98)_0%,rgba(7,15,23,0.98)_58%,rgba(10,30,23,0.98)_100%)] p-0 text-slate-100 shadow-[0_34px_90px_-46px_rgba(0,0,0,0.9)]">
          <DialogHeader className="mb-0 border-b border-white/10 px-5 py-3">
            <DialogTitle className="pr-8 text-xl font-black tracking-tight text-white">
              {detailPayload?.order.order_no ? `Sipariş Detayı · ${detailPayload.order.order_no}` : "Sipariş Detayı"}
            </DialogTitle>
            <DialogDescription className="text-sm font-semibold text-slate-400">
              {detailPayload?.order.customer
                ? `${detailPayload.order.customer.code} - ${detailPayload.order.customer.title}`
                : "Kalemler ve durum geçmişi"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 px-4 py-3">
            {detailLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-20 w-full bg-white/10" />
                <Skeleton className="h-36 w-full bg-white/10" />
                <Skeleton className="h-36 w-full bg-white/10" />
              </div>
            ) : null}

            {detailError ? <p className="text-sm text-red-600">{detailError}</p> : null}

            {!detailLoading && !detailError && detailPayload ? (
              <>
                {detailIsBalance ? (
                  <div className="rounded-[16px] border border-yellow-300/25 bg-yellow-300/10 px-4 py-2.5">
                    <p className="text-[11px] font-black uppercase tracking-[0.12em] text-yellow-100/70">Bakiye Adedi</p>
                    <p className="text-2xl font-black text-yellow-100">{detailBalanceQuantity}</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded-[12px] border border-white/10 bg-white/[0.04] px-2 py-1.5 text-center">
                      <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">Kalem</p>
                      <p className="text-lg font-black leading-5 text-white">{detailPayload.order.items.length}</p>
                    </div>
                    <div className="rounded-[12px] border border-white/10 bg-white/[0.04] px-2 py-1.5 text-center">
                      <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">Toplam Adet</p>
                      <p className="text-lg font-black leading-5 text-white">
                        {detailPayload.order.items.reduce((sum, item) => sum + item.quantity, 0)}
                      </p>
                    </div>
                    <div className="rounded-[12px] border border-white/10 bg-white/[0.04] px-2 py-1.5 text-center">
                      <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">Stok Eksik</p>
                      <p className="text-lg font-black leading-5 text-white">{detailStockShortageCount}</p>
                    </div>
                  </div>
                )}

                <Card className="border-white/10 bg-white/[0.035] text-slate-100 shadow-none">
                  <CardContent className="p-2.5 text-sm">
                    <div className="grid gap-2 md:grid-cols-3">
                      <div>
                        <p className="text-xs font-black uppercase tracking-[0.1em] text-slate-500">Durum</p>
                        <div className="mt-0.5">
                          <OrderStatusBadge status={detailPayload.order.status} />
                        </div>
                      </div>
                      <div>
                        <p className="text-xs font-black uppercase tracking-[0.1em] text-slate-500">Sipariş Tarihi</p>
                        <p className="font-black text-white">{formatOrderDateTime(detailPayload.order.ordered_at)}</p>
                      </div>
                      {!detailIsBalance ? (
                          <div className="rounded-[10px] border border-emerald-300/16 bg-emerald-300/8 px-2.5 py-1.5 text-right">
                          <p className="text-[10px] font-black uppercase tracking-[0.1em] text-emerald-100/62">Genel Toplam</p>
                          <p className="text-lg font-black text-emerald-100">{formatTry(detailPayload.order.grand_total, detailPayload.order.currency)}</p>
                        </div>
                      ) : null}
                    </div>

                    {detailPayload.order.note ? (
                      <div className="mt-2 rounded-[12px] border border-white/10 bg-black/15 px-3 py-2">
                        <p className="text-xs font-black uppercase tracking-[0.1em] text-slate-500">Not</p>
                        <p className="line-clamp-2 text-sm font-semibold text-slate-200">{detailPayload.order.note}</p>
                      </div>
                    ) : null}

                    {!detailIsBalance ? (
                      <div className="mt-2 grid gap-2 rounded-[12px] border border-white/10 bg-black/15 px-3 py-2 text-xs sm:grid-cols-3">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">Ara Toplam</span>
                        <span className="font-semibold text-slate-100">{formatTry(detailPayload.order.subtotal, detailPayload.order.currency)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">İskonto</span>
                        <span className="font-semibold text-slate-100">{formatTry(detailPayload.order.discount_total, detailPayload.order.currency)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">KDV</span>
                        <span className="font-semibold text-slate-100">{formatTry(detailPayload.order.tax_total, detailPayload.order.currency)}</span>
                      </div>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>

                <Card className="border-white/10 bg-white/[0.035] text-slate-100 shadow-none">
                    <CardHeader className="border-b border-white/10 px-3 py-2">
                    <CardTitle className="text-base font-black text-white">
                      {detailIsBalance ? "Bakiye Ürünleri" : "Sipariş Kalemleri"}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-2.5">
                    <div className="overflow-x-auto">
                      <table className={`w-full text-left text-sm ${detailIsBalance ? "min-w-[460px]" : "min-w-[760px]"}`}>
                        <thead>
                          <tr className="border-b border-white/10 text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">
                            <th className="py-1.5">Ürün</th>
                            <th className="py-1.5">Marka</th>
                            <th className="py-1.5 text-right">{detailIsBalance ? "Bakiye Adedi" : "Adet"}</th>
                            {!detailIsBalance ? (
                              <>
                                <th className="py-1.5 text-right">Stok</th>
                                <th className="py-1.5 text-right">Durum</th>
                                <th className="py-1.5 text-right">Birim</th>
                                <th className="py-1.5 text-right">Tutar</th>
                              </>
                            ) : null}
                          </tr>
                        </thead>
                        <tbody>
                          {(detailIsBalance ? detailBalanceItems : detailPayload.order.items).map((item) => {
                            const available = item.logo_stock?.available_total ?? 0;
                            const stockMeta = stockStatusMeta(available, item.quantity);

                            return (
                              <tr key={item.id} className="border-b border-white/10 last:border-b-0">
                                <td className="py-1.5">
                                  <p className="text-sm font-black text-yellow-100">{item.sku ?? "-"}</p>
                                  <p className="mt-0.5 text-xs font-semibold text-slate-400">{item.name ?? "-"}</p>
                                </td>
                                <td className="py-1.5 font-semibold text-slate-300">{item.brand ?? "-"}</td>
                                <td className={`py-1.5 text-right font-black ${detailIsBalance ? "text-xl text-yellow-100" : "text-slate-100"}`}>
                                  {detailIsBalance ? item.remaining_quantity : item.quantity}
                                </td>
                                {!detailIsBalance ? (
                                  <>
                                    <td className="py-1.5 text-right font-black text-white">{available}</td>
                                    <td className="py-1.5 text-right">
                                      <Badge variant="outline" className={`font-semibold ${stockMeta.className}`}>
                                        {stockMeta.label}
                                      </Badge>
                                    </td>
                                    <td className="py-1.5 text-right font-semibold text-slate-100">
                                      {formatTry(item.unit_net_price, item.currency)}
                                    </td>
                                    <td className="py-1.5 text-right font-black text-white">
                                      {formatTry(item.line_total, item.currency)}
                                    </td>
                                  </>
                                ) : null}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>

                <details className="rounded-[16px] border border-white/10 bg-white/[0.025] text-slate-100">
                  <summary className="cursor-pointer px-4 py-3 text-sm font-black text-white">
                    Durum Geçmişi · {detailPayload.status_timeline.length} kayıt
                  </summary>
                  <div className="border-t border-white/10 p-3">
                    {detailPayload.status_timeline.length === 0 ? (
                      <p className="rounded-[14px] border border-white/10 bg-black/15 p-3 text-sm text-slate-400">
                        Durum geçmişi bulunamadı.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {detailPayload.status_timeline.map((statusRow) => (
                          <div
                            key={statusRow.id}
                            className="rounded-[14px] border border-white/10 bg-black/15 px-3 py-2"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <OrderStatusBadge status={statusRow.status} />
                              <p className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500">
                                <Clock3 className="h-3.5 w-3.5" />
                                {formatOrderDateTime(statusRow.created_at)}
                              </p>
                            </div>
                            <p className="mt-1 text-xs font-semibold text-slate-500">
                              {statusRow.changed_by.name ?? "Sistem"} {statusRow.note ? `· ${statusRow.note}` : ""}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </details>
              </>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
