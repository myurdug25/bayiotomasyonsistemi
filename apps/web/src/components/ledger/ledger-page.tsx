"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Eye, ListChecks, Loader2, PackageSearch, RefreshCcw, UserRound } from "lucide-react";

import { useSession } from "@/components/auth/session-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type LedgerEntryDto,
  type CollectionMethodFilter,
  type LedgerEntryType,
  type OrderDetailResponse,
  type PaginatedResponse,
  getOrderDetail,
  listCustomerLedger,
} from "@/lib/api";

const LEDGER_DATE_FORMATTER = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "medium",
});

function formatLedgerDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return LEDGER_DATE_FORMATTER.format(parsed);
}

function getLedgerTypeMeta(type: LedgerEntryDto["type"]): { label: string; className: string } {
  if (type === "invoice") {
    return { label: "Fatura", className: "border-amber-400/40 bg-amber-500/15 text-amber-200" };
  }

  if (type === "payment") {
    return { label: "Tahsilat", className: "border-emerald-400/40 bg-emerald-500/15 text-emerald-200" };
  }

  if (type === "credit") {
    return { label: "Alacak", className: "border-blue-400/40 bg-blue-500/15 text-blue-200" };
  }

  return { label: "Borç", className: "border-rose-400/40 bg-rose-500/15 text-rose-200" };
}

function getCheckoutSummaryClass(code: string): string {
  if (code === "1-F") {
    return "border-emerald-300/45 bg-emerald-400/14 text-emerald-100";
  }

  if (code === "2-O") {
    return "border-sky-300/45 bg-sky-400/14 text-sky-100";
  }

  if (code === "3-B") {
    return "border-fuchsia-300/45 bg-fuchsia-400/14 text-fuchsia-100";
  }

  return "border-[var(--brand-border)] bg-[var(--surface-soft)] text-[var(--muted-foreground)]";
}

const COLLECTION_METHOD_FILTERS: Array<{ value: CollectionMethodFilter; label: string; className: string }> = [
  { value: "cash", label: "Nakit", className: "border-emerald-300/40 bg-emerald-400/10 text-emerald-100 hover:bg-emerald-400/16" },
  { value: "transfer", label: "Havale/EFT", className: "border-sky-300/40 bg-sky-400/10 text-sky-100 hover:bg-sky-400/16" },
  { value: "check", label: "Çek / Senet", className: "border-amber-300/40 bg-amber-400/10 text-amber-100 hover:bg-amber-400/16" },
  { value: "cc", label: "Fiziksel Pos", className: "border-rose-300/40 bg-rose-400/10 text-rose-100 hover:bg-rose-400/16" },
  { value: "factory_cc", label: "Fabrika Kart Çekimi", className: "border-orange-300/40 bg-orange-400/10 text-orange-100 hover:bg-orange-400/16" },
];

const LEDGER_TYPE_FILTERS: Array<{ value: LedgerEntryType; label: string; className: string }> = [
  { value: "invoice", label: "Fatura", className: "border-amber-300/40 bg-amber-400/10 text-amber-100 hover:bg-amber-400/16" },
  { value: "payment", label: "Tahsilat", className: "border-emerald-300/40 bg-emerald-400/10 text-emerald-100 hover:bg-emerald-400/16" },
  { value: "credit", label: "Alacak", className: "border-blue-300/40 bg-blue-400/10 text-blue-100 hover:bg-blue-400/16" },
  { value: "debit", label: "Borç", className: "border-rose-300/40 bg-rose-400/10 text-rose-100 hover:bg-rose-400/16" },
];

function toAmount(value: string | number): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatAmount(value: string | number, currency: string): string {
  const amount = toAmount(value);
  const label = currency === "TRY" ? "₺" : currency;
  return `${amount.toLocaleString("tr-TR", {
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })} ${label}`;
}

function formatSyncDateTime(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(parsed);
}

function getSourceMeta(sourceSystem: string | null | undefined): { label: string; className: string } {
  if (sourceSystem === "logo") {
    return {
      label: "Logo",
      className: "border-sky-300/45 bg-sky-400/14 text-sky-100",
    };
  }

  if (sourceSystem === "b2b") {
    return {
      label: "B2B",
      className: "border-emerald-300/45 bg-emerald-400/14 text-emerald-100",
    };
  }

  return {
    label: "Yerel",
    className: "border-[var(--brand-border)] bg-[var(--surface-soft)] text-[var(--muted-foreground)]",
  };
}

export function LedgerPage() {
  const { selectedCustomer } = useSession();

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [ledgerTypeFilter, setLedgerTypeFilter] = useState<LedgerEntryType | "">("");
  const [collectionMethodFilter, setCollectionMethodFilter] = useState<CollectionMethodFilter | "">("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<PaginatedResponse<LedgerEntryDto> | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailPayload, setDetailPayload] = useState<OrderDetailResponse | null>(null);
  const [detailLedgerRow, setDetailLedgerRow] = useState<LedgerEntryDto | null>(null);

  const fetchLedger = (
    page = 1,
    overrides?: {
      dateFrom?: string;
      dateTo?: string;
      ledgerType?: LedgerEntryType | "";
      collectionMethod?: CollectionMethodFilter | "";
    }
  ) => {
    if (!selectedCustomer) {
      setPayload(null);
      return;
    }

    const effectiveDateFrom = overrides?.dateFrom ?? dateFrom;
    const effectiveDateTo = overrides?.dateTo ?? dateTo;
    const effectiveLedgerType = overrides?.ledgerType ?? ledgerTypeFilter;
    const effectiveCollectionMethod = overrides?.collectionMethod ?? collectionMethodFilter;

    setLoading(true);
    setError(null);

    void listCustomerLedger(selectedCustomer.id, {
      date_from: effectiveDateFrom || undefined,
      date_to: effectiveDateTo || undefined,
      type: effectiveLedgerType || undefined,
      collection_method: effectiveCollectionMethod || undefined,
      per_page: 50,
      page,
    })
      .then((response) => setPayload(response))
      .catch((err) => setError(err instanceof Error ? err.message : "Cari hareketler alınamadı"))
      .finally(() => setLoading(false));
  };

  const openOrderDetail = (row: LedgerEntryDto) => {
    if (!row.order_id) {
      return;
    }

    setDetailOpen(true);
    setDetailLoading(true);
    setDetailError(null);
    setDetailPayload(null);
    setDetailLedgerRow(row);

    void getOrderDetail(row.order_id)
      .then((response) => setDetailPayload(response))
      .catch((err) => setDetailError(err instanceof Error ? err.message : "Sipariş detayı alınamadı"))
      .finally(() => setDetailLoading(false));
  };

  const hasActiveFilters = Boolean(dateFrom) || Boolean(dateTo) || Boolean(ledgerTypeFilter) || Boolean(collectionMethodFilter);
  const displayRows = useMemo(() => payload?.data ?? [], [payload?.data]);
  const listedRowCount = payload?.summary?.total_count ?? payload?.meta?.total ?? displayRows.length;
  const summary = useMemo(() => {
    if (payload?.summary) {
      return {
        debit: toAmount(payload.summary.total_debit),
        credit: toAmount(payload.summary.total_credit),
        balance: toAmount(payload.summary.balance),
        currency: payload.summary.currency,
      };
    }

    const rows = displayRows;
    const debit = rows.reduce((sum, row) => sum + toAmount(row.debit), 0);
    const credit = rows.reduce((sum, row) => sum + toAmount(row.credit), 0);
    const balance = rows.length > 0 ? toAmount(rows[0].balance_after) : 0;
    const currency = rows[0]?.currency ?? "TRY";

    return {
      debit,
      credit,
      balance,
      currency,
    };
  }, [displayRows, payload?.summary]);
  const detailSummary = detailPayload?.order.origin?.checkout_summary ?? detailLedgerRow?.checkout_summary ?? null;

  useEffect(() => {
    fetchLedger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomer?.id]);

  return (
    <div className="space-y-3">
      <Card className="dashboard-panel-card md:sticky md:top-24 md:z-20">
        <CardContent className="p-3">
          <div className="grid gap-3 xl:grid-cols-[minmax(150px,0.75fr)_minmax(150px,0.75fr)_minmax(300px,1.35fr)_minmax(360px,1.65fr)_auto_auto] xl:items-end">
            <div>
              <label className="mb-1 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
                <CalendarDays className="h-3.5 w-3.5" />
                Başlangıç
              </label>
              <Input
                type="date"
                value={dateFrom}
                disabled={loading || !selectedCustomer}
                onChange={(event) => setDateFrom(event.target.value)}
                className="h-12"
              />
            </div>
            <div>
              <label className="mb-1 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
                <CalendarDays className="h-3.5 w-3.5" />
                Bitiş
              </label>
              <Input
                type="date"
                value={dateTo}
                disabled={loading || !selectedCustomer}
                onChange={(event) => setDateTo(event.target.value)}
                className="h-12"
              />
            </div>
            <div>
              <label className="mb-1 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
                Hareket Tipi
              </label>
              <div className="flex min-h-12 flex-wrap items-center gap-2 rounded-[14px] border border-[var(--brand-border)] bg-[var(--surface)] px-2 py-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={
                    ledgerTypeFilter === ""
                      ? "h-8 border-white/70 bg-white/18 px-3 text-xs text-white"
                      : "h-8 border-white/15 bg-white/[0.04] px-3 text-xs text-slate-200 hover:bg-white/[0.08] hover:text-white"
                  }
                  disabled={loading || !selectedCustomer}
                  onClick={() => {
                    setLedgerTypeFilter("");
                    fetchLedger(1, { ledgerType: "" });
                  }}
                >
                  Tümü
                </Button>
                {LEDGER_TYPE_FILTERS.map((option) => {
                  const selected = ledgerTypeFilter === option.value;
                  return (
                    <Button
                      type="button"
                      key={option.value}
                      size="sm"
                      variant="outline"
                      className={selected ? "h-8 border-white/70 bg-white/18 px-3 text-xs text-white" : `h-8 px-3 text-xs ${option.className}`}
                      disabled={loading || !selectedCustomer}
                      onClick={() => {
                        const nextType = selected ? "" : option.value;
                        setLedgerTypeFilter(nextType);
                        fetchLedger(1, { ledgerType: nextType });
                      }}
                    >
                      {option.label}
                    </Button>
                  );
                })}
              </div>
            </div>
            <div>
              <label className="mb-1 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
                Tahsilat Filtresi
              </label>
              <div className="flex min-h-12 flex-wrap items-center gap-2 rounded-[14px] border border-[var(--brand-border)] bg-[var(--surface)] px-2 py-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={
                    collectionMethodFilter === ""
                      ? "h-8 border-white/70 bg-white/18 px-3 text-xs text-white"
                      : "h-8 border-white/15 bg-white/[0.04] px-3 text-xs text-slate-200 hover:bg-white/[0.08] hover:text-white"
                  }
                  disabled={loading || !selectedCustomer}
                  onClick={() => {
                    setCollectionMethodFilter("");
                    fetchLedger(1, { collectionMethod: "" });
                  }}
                >
                  Tümü
                </Button>
                {COLLECTION_METHOD_FILTERS.map((option) => {
                  const selected = collectionMethodFilter === option.value;
                  return (
                    <Button
                      type="button"
                      key={option.value}
                      size="sm"
                      variant="outline"
                      className={selected ? "h-8 border-white/70 bg-white/18 px-3 text-xs text-white" : `h-8 px-3 text-xs ${option.className}`}
                      disabled={loading || !selectedCustomer}
                      onClick={() => {
                        const nextMethod = selected ? "" : option.value;
                        setCollectionMethodFilter(nextMethod);
                        fetchLedger(1, { collectionMethod: nextMethod });
                      }}
                    >
                      {option.label}
                    </Button>
                  );
                })}
              </div>
            </div>
            <Button className="h-12 rounded-[12px]" onClick={() => fetchLedger(1)} disabled={loading || !selectedCustomer}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
              {loading ? "Yükleniyor..." : "Yenile"}
            </Button>
            {hasActiveFilters ? (
              <Button
                variant="outline"
                className="h-12 rounded-[12px]"
                disabled={loading}
                onClick={() => {
                  setDateFrom("");
                  setDateTo("");
                  setLedgerTypeFilter("");
                  setCollectionMethodFilter("");
                  fetchLedger(1, { dateFrom: "", dateTo: "", ledgerType: "", collectionMethod: "" });
                }}
              >
                Temizle
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <Card className="dashboard-panel-card">
        <CardContent className="p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="inline-flex items-center gap-1.5 text-base font-extrabold text-[var(--foreground)]">
              <ListChecks className="h-4 w-4 text-[var(--brand-primary)]" />
              Cari Hareketler
            </p>
            <Badge variant="outline" className="h-7 rounded-full px-3 text-xs">
              {listedRowCount}
            </Badge>
          </div>

          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 8 }).map((_, index) => (
                <Skeleton key={`ledger-skeleton-${index}`} className="h-10 w-full" />
              ))}
            </div>
          ) : !selectedCustomer ? (
            <div className="flex min-h-[190px] flex-col items-center justify-center gap-3 rounded-[18px] border border-dashed border-[var(--brand-border)] bg-[var(--surface-soft)] p-6 text-center">
              <UserRound className="h-9 w-9 text-[var(--brand-primary)]" />
              <p className="text-2xl font-black text-[var(--brand-primary-strong)]">Müşteri seç</p>
              <Button asChild className="rounded-[12px]">
                <Link href="/customers">Müşteriler</Link>
              </Button>
            </div>
          ) : selectedCustomer && displayRows.length === 0 ? (
            <div className="flex min-h-[160px] flex-col items-center justify-center gap-3 rounded-[18px] bg-[var(--surface-soft)] p-6 text-center">
              <p className="text-2xl font-black text-[var(--brand-primary-strong)]">Kayıt yok</p>
              {hasActiveFilters ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDateFrom("");
                    setDateTo("");
                    setLedgerTypeFilter("");
                    setCollectionMethodFilter("");
                    fetchLedger(1, { dateFrom: "", dateTo: "", ledgerType: "", collectionMethod: "" });
                  }}
                >
                  Temizle
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] table-fixed text-left text-[13px]">
                <thead>
                  <tr className="border-b border-[var(--brand-border)] text-[11px] uppercase text-[var(--muted-foreground)]">
                    <th className="w-[74px] px-2 py-2 text-center">Detay</th>
                    <th className="w-[104px] px-2 py-2">Evrak Tarihi</th>
                    <th className="w-[150px] px-2 py-2">İşlem Tipi</th>
                    <th className="w-[190px] px-2 py-2">Belge / Kaynak Evrak</th>
                    <th className="px-2 py-2">Açıklama</th>
                    <th className="w-[120px] px-2 py-2 text-right">Borç</th>
                    <th className="w-[120px] px-2 py-2 text-right">Alacak</th>
                    <th className="w-[128px] px-2 py-2 text-right">Bakiye</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((row) => (
                    <tr key={row.id} className="border-b border-[var(--brand-border)]/60 transition-colors hover:bg-[var(--surface-soft)]/70">
                      <td className="px-2 py-2.5 text-center">
                        {row.order_id ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 rounded-[10px] px-2.5 text-xs"
                            onClick={() => openOrderDetail(row)}
                          >
                            <Eye className="h-4 w-4" />
                            Detay
                          </Button>
                        ) : (
                          <span className="text-sm font-semibold text-[var(--muted-foreground)]">-</span>
                        )}
                      </td>
                      <td className="px-2 py-2.5 font-medium">{formatLedgerDate(row.document_date ?? row.date)}</td>
                      <td className="px-2 py-2.5">
                        <div className="flex flex-col items-start gap-1">
                          <Badge
                            variant="outline"
                            className={`h-6 px-2 text-xs font-semibold ${getLedgerTypeMeta(row.type).className}`}
                          >
                            {row.transaction_type_label ?? getLedgerTypeMeta(row.type).label}
                          </Badge>
                          {row.collection_method_label ? (
                            <span className="rounded-full border border-emerald-300/25 bg-emerald-400/10 px-2 py-0.5 text-[11px] font-black uppercase tracking-[0.08em] text-emerald-100">
                              {row.collection_method_label}
                            </span>
                          ) : null}
                          <Badge
                            variant="outline"
                            className={`h-5 px-1.5 text-[10px] font-black ${getSourceMeta(row.source_system).className}`}
                            title={
                              row.source_system === "logo"
                                ? `Logo ref: ${row.source_reference ?? "-"} · Sync: ${formatSyncDateTime(row.last_synced_at)}`
                                : row.source_system === "b2b"
                                  ? "B2B kaynaklı hareket"
                                  : "Yerel hareket"
                            }
                          >
                            {getSourceMeta(row.source_system).label}
                          </Badge>
                        </div>
                      </td>
                      <td className="px-2 py-2.5">
                        <p className="break-words font-bold text-[var(--foreground)]">{row.document_no || row.reference_no || "-"}</p>
                        <p className="mt-1 break-words text-[11px] font-semibold text-[var(--muted-foreground)]">
                          {row.source_document ? `Kaynak: ${row.source_document}` : "Kaynak evrak: -"}
                        </p>
                        {row.checkout_summary ? (
                          <Badge
                            variant="outline"
                            className={`mt-1 h-5 px-1.5 text-[10px] font-black ${getCheckoutSummaryClass(row.checkout_summary.code)}`}
                            title={row.checkout_summary.label}
                          >
                            {row.checkout_summary.code}
                          </Badge>
                        ) : null}
                      </td>
                      <td className="break-words px-2 py-2.5 font-medium">{row.description || "-"}</td>
                      <td className="px-2 py-2.5 text-right font-medium">{formatAmount(row.debit, row.currency)}</td>
                      <td className="px-2 py-2.5 text-right font-medium">{formatAmount(row.credit, row.currency)}</td>
                      <td className="px-2 py-2.5 text-right font-bold">
                        {formatAmount(row.balance_after, row.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {payload?.meta ? (
            <div className="mt-5 flex items-center justify-between">
              <p className="text-sm text-[var(--muted-foreground)]">
                Gösterilen {displayRows.length} hareket · Toplam {payload.meta.total} kayıt
              </p>
            </div>
          ) : null}
          {selectedCustomer ? (
            <div className="mt-5 rounded-[20px] border border-emerald-300/22 bg-[radial-gradient(circle_at_10%_18%,rgba(52,211,153,0.16)_0%,transparent_35%),linear-gradient(135deg,rgba(7,33,28,0.92)_0%,rgba(7,18,27,0.98)_100%)] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
              <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="text-lg font-black text-white">Genel Toplam</p>
                  <p className="text-sm font-semibold text-emerald-50/62">
                    Seçili cari ve aktif filtrelere göre toplam hareket özeti
                  </p>
                </div>
                <Badge variant="outline" className="w-fit border-emerald-300/35 bg-emerald-300/10 text-emerald-100">
                  {listedRowCount} hareket
                </Badge>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-[16px] border border-rose-300/18 bg-rose-400/8 p-4">
                  <p className="text-[11px] font-black uppercase tracking-[0.12em] text-rose-100/62">Toplam Borç</p>
                  <p className="mt-2 text-2xl font-black text-rose-100">{formatAmount(summary.debit, summary.currency)}</p>
                </div>
                <div className="rounded-[16px] border border-emerald-300/18 bg-emerald-400/8 p-4">
                  <p className="text-[11px] font-black uppercase tracking-[0.12em] text-emerald-100/62">Toplam Alacak</p>
                  <p className="mt-2 text-2xl font-black text-emerald-100">{formatAmount(summary.credit, summary.currency)}</p>
                </div>
                <div className="rounded-[16px] border border-amber-300/24 bg-amber-400/10 p-4">
                  <p className="text-[11px] font-black uppercase tracking-[0.12em] text-amber-100/68">Toplam Bakiye</p>
                  <p className="mt-2 text-3xl font-black text-amber-100">{formatAmount(summary.balance, summary.currency)}</p>
                </div>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-h-[calc(100vh-44px)] max-w-[min(1040px,calc(100vw-32px))] overflow-y-auto rounded-[26px] border border-emerald-300/20 bg-[linear-gradient(145deg,rgba(12,24,32,0.98)_0%,rgba(7,15,23,0.98)_58%,rgba(10,30,23,0.98)_100%)] p-0 text-slate-100 shadow-[0_34px_90px_-46px_rgba(0,0,0,0.9)]">
          <DialogHeader className="mb-0 border-b border-white/10 px-6 py-5 pr-12">
            <DialogTitle className="text-2xl font-black tracking-tight text-white">
              {detailPayload?.order.order_no ? `Cari Hareket Detayı · ${detailPayload.order.order_no}` : "Cari Hareket Detayı"}
            </DialogTitle>
            <DialogDescription className="text-base font-semibold text-slate-400">
              Sipariş kalemleri, satış tipi, tutar ve müşteri bilgileri.
            </DialogDescription>
          </DialogHeader>

          <div className="p-6">
            {detailLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, index) => (
                  <Skeleton key={`ledger-detail-skeleton-${index}`} className="h-14 w-full bg-white/8" />
                ))}
              </div>
            ) : detailError ? (
              <div className="rounded-[18px] border border-red-300/30 bg-red-500/10 p-4 text-sm font-bold text-red-100">
                {detailError}
              </div>
            ) : detailPayload ? (
              <div className="space-y-5">
                <div className="grid gap-3 md:grid-cols-4">
                  <div className="rounded-[16px] border border-white/10 bg-white/6 p-4">
                    <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-400">Müşteri</p>
                    <p className="mt-2 line-clamp-2 text-lg font-black text-white">{detailPayload.order.customer?.title ?? selectedCustomer?.title ?? "-"}</p>
                    <p className="mt-1 text-sm font-bold text-slate-400">{detailPayload.order.customer?.code ?? selectedCustomer?.code ?? "-"}</p>
                  </div>
                  <div className="rounded-[16px] border border-white/10 bg-white/6 p-4">
                    <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-400">Satış Tipi</p>
                    <div className="mt-3">
                      {detailSummary ? (
                        <Badge variant="outline" className={`h-8 px-3 text-sm font-black ${getCheckoutSummaryClass(detailSummary.code)}`}>
                          {detailSummary.label}
                        </Badge>
                      ) : (
                        <p className="text-lg font-black text-white">-</p>
                      )}
                    </div>
                  </div>
                  <div className="rounded-[16px] border border-white/10 bg-white/6 p-4">
                    <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-400">Kalem / Adet</p>
                    <p className="mt-2 text-lg font-black text-white">
                      {detailPayload.order.items.length} kalem · {detailPayload.order.items.reduce((sum, item) => sum + item.quantity, 0)} adet
                    </p>
                  </div>
                  <div className="rounded-[16px] border border-emerald-300/20 bg-emerald-400/10 p-4">
                    <p className="text-[11px] font-black uppercase tracking-[0.12em] text-emerald-100/70">Genel Toplam</p>
                    <p className="mt-2 text-2xl font-black text-emerald-200">{formatAmount(detailPayload.order.grand_total, detailPayload.order.currency)}</p>
                  </div>
                </div>

                {detailPayload.order.note ? (
                  <div className="rounded-[16px] border border-cyan-200/18 bg-cyan-400/8 p-4">
                    <p className="text-[11px] font-black uppercase tracking-[0.12em] text-cyan-100/70">Sipariş Notu</p>
                    <p className="mt-2 whitespace-pre-wrap text-sm font-semibold leading-6 text-cyan-50/86">{detailPayload.order.note}</p>
                  </div>
                ) : null}

                <div className="overflow-x-auto rounded-[18px] border border-white/10">
                  <table className="w-full min-w-[860px] text-left text-sm">
                    <thead className="bg-white/8 text-[12px] uppercase tracking-[0.06em] text-slate-400">
                      <tr>
                        <th className="px-4 py-3">Ürün</th>
                        <th className="px-4 py-3">Marka</th>
                        <th className="px-4 py-3 text-right">Adet</th>
                        <th className="px-4 py-3 text-right">Birim</th>
                        <th className="px-4 py-3 text-right">KDV</th>
                        <th className="px-4 py-3 text-right">Satır Toplam</th>
                        <th className="px-4 py-3 text-right">Logo Stok</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailPayload.order.items.map((item) => (
                        <tr key={item.id} className="border-t border-white/10">
                          <td className="px-4 py-3">
                            <div className="flex items-start gap-3">
                              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-emerald-300/12 text-emerald-100">
                                <PackageSearch className="h-4 w-4" />
                              </span>
                              <span className="min-w-0">
                                <span className="block text-sm font-black text-white">{item.sku ?? "-"}</span>
                                <span className="mt-1 line-clamp-2 block text-sm font-semibold text-slate-300">{item.name ?? "-"}</span>
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3 font-semibold text-slate-300">{item.brand ?? "-"}</td>
                          <td className="px-4 py-3 text-right font-black text-white">{item.quantity}</td>
                          <td className="px-4 py-3 text-right font-semibold text-slate-300">{formatAmount(item.unit_net_price, item.currency)}</td>
                          <td className="px-4 py-3 text-right font-semibold text-slate-300">%{toAmount(item.tax_rate).toLocaleString("tr-TR", { maximumFractionDigits: 2 })}</td>
                          <td className="px-4 py-3 text-right font-black text-white">{formatAmount(item.line_total, item.currency)}</td>
                          <td className="px-4 py-3 text-right font-semibold text-slate-300">
                            {item.logo_stock ? item.logo_stock.available_total.toLocaleString("tr-TR") : "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
