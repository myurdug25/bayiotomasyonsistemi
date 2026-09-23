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
import { cn } from "@/lib/utils";

const LEDGER_DATE_FORMATTER = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "medium",
});
const DEFAULT_LEDGER_DATE_FROM = "2026-01-01";

function todayInputValue(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function formatLedgerDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return LEDGER_DATE_FORMATTER.format(parsed);
}

function getLedgerTypeMeta(type: LedgerEntryDto["type"] | NonNullable<LedgerEntryDto["transaction_type"]>): { label: string; className: string } {
  if (type === "order") {
    return { label: "Sipariş", className: "border-cyan-300/40 bg-cyan-400/15 text-cyan-100" };
  }

  if (type === "invoice") {
    return { label: "Fatura", className: "border-amber-400/40 bg-amber-500/15 text-amber-200" };
  }

  if (type === "payment") {
    return { label: "Tahsilat", className: "border-emerald-400/40 bg-emerald-500/15 text-emerald-200" };
  }

  if (type === "return") {
    return { label: "İade", className: "border-fuchsia-300/40 bg-fuchsia-500/15 text-fuchsia-100" };
  }

  if (type === "credit") {
    return { label: "Alacak", className: "border-blue-400/40 bg-blue-500/15 text-blue-200" };
  }

  return { label: "Borç", className: "border-rose-400/40 bg-rose-500/15 text-rose-200" };
}

function normalizeCollectionMethodLabel(value: unknown): string {
  const raw = String(value ?? "").trim();
  const withoutPrefix = raw.replace(/^Tahsilat\s+/i, "").trim();
  const normalized = withoutPrefix.toLocaleLowerCase("tr-TR");

  if (["cash", "nakit"].includes(normalized)) {
    return "Nakit";
  }

  if (["transfer", "havale", "havale/eft", "havale eft", "eft"].includes(normalized)) {
    return "Havale / EFT";
  }

  if (["check", "çek", "cek"].includes(normalized)) {
    return "Çek";
  }

  if (["note", "senet"].includes(normalized)) {
    return "Senet";
  }

  if (["cc", "fiziksel pos", "fiziksel/pos"].includes(normalized)) {
    return "Fiziksel POS";
  }

  return withoutPrefix || raw;
}

function ledgerTypeDisplayLabel(row: LedgerEntryDto): string {
  if (row.type === "payment") {
    return normalizeCollectionMethodLabel(row.collection_method_label ?? row.transaction_type_label ?? getLedgerTypeMeta(row.type).label);
  }

  return row.transaction_type_label ?? getLedgerTypeMeta(row.type).label;
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
  { value: "order", label: "Sipariş", className: "border-cyan-300/40 bg-cyan-400/10 text-cyan-100 hover:bg-cyan-400/16" },
  { value: "invoice", label: "Fatura", className: "border-amber-300/40 bg-amber-400/10 text-amber-100 hover:bg-amber-400/16" },
  { value: "payment", label: "Tahsilat", className: "border-emerald-300/40 bg-emerald-400/10 text-emerald-100 hover:bg-emerald-400/16" },
  { value: "return", label: "İade", className: "border-fuchsia-300/40 bg-fuchsia-400/10 text-fuchsia-100 hover:bg-fuchsia-400/16" },
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

function salesPriceTypeLabel(row: LedgerEntryDto | OrderDetailResponse["order"] | null | undefined): string | null {
  const origin = row && "origin" in row ? row.origin : null;
  const rawLabel = row && "sales_price_type_label" in row ? row.sales_price_type_label : origin?.sales_price_type;
  const rawValue = row && "sales_price_type" in row ? row.sales_price_type : origin?.sales_price_type;
  const value = String(rawLabel ?? rawValue ?? "").trim();
  const normalized = value.toLocaleLowerCase("tr-TR");

  if (!normalized) {
    return null;
  }

  if (["bank_transfer", "transfer", "havale", "havale/eft", "havale / eft"].includes(normalized)) {
    return "Havale / EFT";
  }

  if (["cash", "nakit"].includes(normalized)) {
    return "Nakit";
  }

  if (["single_payment", "tek çekim", "tek cekim"].includes(normalized)) {
    return "Tek Çekim";
  }

  return value;
}

function shippingMethodLabel(row: LedgerEntryDto | OrderDetailResponse["order"] | null | undefined): string | null {
  const rawValue =
    row && "shipping_method_label" in row
      ? row.shipping_method_label ?? row.shipping_method
      : row && "origin" in row
        ? row.origin?.shipping_method
        : null;
  const value = String(rawValue ?? "").trim();
  const normalized = value.toLocaleUpperCase("tr-TR");

  if (!normalized) {
    return null;
  }

  if (normalized.includes("KARGO") || normalized.includes("CARGO")) {
    return "KARGO";
  }

  if (normalized.includes("OTOB")) {
    return "OTOBÜS";
  }

  if (normalized.includes("DEPO")) {
    return "DEPOYA SEVK";
  }

  return value;
}

function isInternalOrderReference(value: string | null | undefined): boolean {
  const normalized = String(value ?? "").trim().toLocaleUpperCase("tr-TR");

  return normalized === "" || normalized.startsWith("ORD-");
}

function cleanLedgerLabel(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();

  if (!normalized || normalized === "-") {
    return null;
  }

  return normalized;
}

function ledgerDocumentLabel(row: LedgerEntryDto): string | null {
  const documentNo = cleanLedgerLabel(row.document_no);
  const referenceNo = cleanLedgerLabel(row.reference_no);

  if (documentNo && !isInternalOrderReference(documentNo)) {
    return documentNo;
  }

  if (referenceNo && !isInternalOrderReference(referenceNo)) {
    return referenceNo;
  }

  return null;
}

function ledgerSourceLabel(row: LedgerEntryDto): string | null {
  const source = cleanLedgerLabel(row.source_document);
  const document = ledgerDocumentLabel(row);

  if (!source || isInternalOrderReference(source) || source === document) {
    return null;
  }

  return source;
}

function ledgerMeaningfulBadges(row: LedgerEntryDto): string[] {
  const labels = [
    row.checkout_summary?.label ?? null,
    salesPriceTypeLabel(row),
    shippingMethodLabel(row),
  ]
    .map((label) => String(label ?? "").trim())
    .filter(Boolean);

  return Array.from(new Set(labels));
}

function ledgerHasDetail(row: LedgerEntryDto): boolean {
  const transactionType = row.transaction_type ?? row.type;
  const hasLogoInvoiceLines = Boolean(row.logo_invoice_detail?.lines?.length);

  return Boolean(
    hasLogoInvoiceLines ||
      row.order_id ||
      row.collection_id ||
      ledgerDocumentLabel(row) ||
      ledgerSourceLabel(row) ||
      String(row.description ?? "").trim() ||
      String(row.source_reference ?? "").trim() ||
      row.checkout_summary ||
      row.sales_price_type_label ||
      row.shipping_method_label ||
      row.collection_method_label ||
      row.return_quantity ||
      row.return_total ||
      transactionType === "payment" ||
      transactionType === "transfer" ||
      transactionType === "offset" ||
      transactionType === "opening" ||
      transactionType === "invoice" ||
      transactionType === "return" ||
      row.type === "debit" ||
      row.type === "credit"
  );
}

export function LedgerPage() {
  const { selectedCustomer } = useSession();

  const [dateFrom, setDateFrom] = useState(DEFAULT_LEDGER_DATE_FROM);
  const [dateTo, setDateTo] = useState(todayInputValue);
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
    setDetailOpen(true);
    setDetailError(null);
    setDetailPayload(null);
    setDetailLedgerRow(row);

    if (!row.order_id) {
      setDetailLoading(false);
      return;
    }

    setDetailLoading(true);
    void getOrderDetail(row.order_id)
      .then((response) => setDetailPayload(response))
      .catch((err) => setDetailError(err instanceof Error ? err.message : "Sipariş detayı alınamadı"))
      .finally(() => setDetailLoading(false));
  };

  const hasActiveFilters =
    dateFrom !== DEFAULT_LEDGER_DATE_FROM ||
    dateTo !== todayInputValue() ||
    Boolean(ledgerTypeFilter) ||
    Boolean(collectionMethodFilter);
  const displayRows = useMemo(() => payload?.data ?? [], [payload?.data]);
  const listedRowCount = payload?.summary?.total_count ?? payload?.meta?.total ?? displayRows.length;
  const summary = useMemo(() => {
    if (payload?.summary) {
      return {
        debit: toAmount(payload.summary.total_debit),
        credit: toAmount(payload.summary.total_credit),
        balance: toAmount(payload.summary.balance),
        currency: payload.summary.currency,
        returnAmount: toAmount(payload.summary.total_return_amount ?? "0"),
        returnQuantity: Number(payload.summary.total_return_quantity ?? 0),
      };
    }

    const rows = displayRows;
    const debit = rows.reduce((sum, row) => sum + toAmount(row.debit), 0);
    const credit = rows.reduce((sum, row) => sum + toAmount(row.credit), 0);
    const returnRows = rows.filter((row) => row.transaction_type === "return" || row.type === "return");
    const returnAmount = returnRows.reduce((sum, row) => sum + toAmount(row.return_total ?? row.credit), 0);
    const returnQuantity = returnRows.reduce((sum, row) => sum + Number(row.return_quantity ?? 0), 0);
    const balance = rows.length > 0 ? toAmount(rows[0].balance_after) : 0;
    const currency = rows[0]?.currency ?? "TRY";

    return {
      debit,
      credit,
      balance,
      currency,
      returnAmount,
      returnQuantity,
    };
  }, [displayRows, payload?.summary]);
  const detailSummary = detailPayload?.order.origin?.checkout_summary ?? detailLedgerRow?.checkout_summary ?? null;

  useEffect(() => {
    fetchLedger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomer?.id]);

  return (
    <div className="ledger-page space-y-3">
      <Card className="dashboard-panel-card ledger-filter-card md:sticky md:top-24 md:z-20">
        <CardContent className="ledger-filter-content p-3">
          <div className="ledger-filter-grid grid min-w-0 gap-2 xl:grid-cols-[130px_130px_minmax(340px,0.9fr)_minmax(430px,1.1fr)_minmax(108px,auto)] xl:items-end">
            <div className="ledger-date-filter">
              <label className="mb-1 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
                <CalendarDays className="h-3.5 w-3.5" />
                Başlangıç
              </label>
              <Input
                type="date"
                value={dateFrom}
                disabled={loading || !selectedCustomer}
                onChange={(event) => setDateFrom(event.target.value)}
                className="h-10"
              />
            </div>
            <div className="ledger-date-filter">
              <label className="mb-1 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
                <CalendarDays className="h-3.5 w-3.5" />
                Bitiş
              </label>
              <Input
                type="date"
                value={dateTo}
                disabled={loading || !selectedCustomer}
                onChange={(event) => setDateTo(event.target.value)}
                className="h-10"
              />
            </div>
            <div className="min-w-0">
              <label className="mb-1 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
                Hareket Tipi
              </label>
              <div className="ledger-filter-strip flex min-h-10 w-full max-w-full flex-nowrap items-center gap-1 overflow-x-auto rounded-[14px] border border-[var(--brand-border)] bg-[var(--surface)] px-1.5 py-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={
                    ledgerTypeFilter === ""
                      ? "h-7 shrink-0 whitespace-nowrap border-white/70 bg-white/18 px-2 text-[10px] text-white"
                      : "h-7 shrink-0 whitespace-nowrap border-white/15 bg-white/[0.04] px-2 text-[10px] text-slate-200 hover:bg-white/[0.08] hover:text-white"
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
                      className={selected ? "h-7 shrink-0 whitespace-nowrap border-white/70 bg-white/18 px-2 text-[10px] text-white" : `h-7 shrink-0 whitespace-nowrap px-2 text-[10px] ${option.className}`}
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
            <div className="min-w-0">
              <label className="mb-1 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
                Tahsilat Filtresi
              </label>
              <div className="ledger-filter-strip flex min-h-10 w-full max-w-full flex-nowrap items-center gap-1 overflow-x-auto rounded-[14px] border border-[var(--brand-border)] bg-[var(--surface)] px-1.5 py-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={
                    collectionMethodFilter === ""
                      ? "h-7 shrink-0 whitespace-nowrap border-white/70 bg-white/18 px-2 text-[10px] text-white"
                      : "h-7 shrink-0 whitespace-nowrap border-white/15 bg-white/[0.04] px-2 text-[10px] text-slate-200 hover:bg-white/[0.08] hover:text-white"
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
                      className={selected ? "h-7 shrink-0 whitespace-nowrap border-white/70 bg-white/18 px-2 text-[10px] text-white" : `h-7 shrink-0 whitespace-nowrap px-2 text-[10px] ${option.className}`}
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
            <div className="ledger-filter-actions flex min-w-0 flex-nowrap items-end gap-2 xl:justify-end">
              <Button className="ledger-refresh-button h-10 min-w-[96px] shrink-0 rounded-[12px] px-3 text-xs" onClick={() => fetchLedger(1)} disabled={loading || !selectedCustomer}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                {loading ? "Yükleniyor..." : "Yenile"}
              </Button>
              {hasActiveFilters ? (
                <Button
                  variant="outline"
                  className="h-10 shrink-0 rounded-[12px] px-2 text-xs"
                  disabled={loading}
                  onClick={() => {
                    const defaultDateTo = todayInputValue();
                    setDateFrom(DEFAULT_LEDGER_DATE_FROM);
                    setDateTo(defaultDateTo);
                    setLedgerTypeFilter("");
                    setCollectionMethodFilter("");
                    fetchLedger(1, {
                      dateFrom: DEFAULT_LEDGER_DATE_FROM,
                      dateTo: defaultDateTo,
                      ledgerType: "",
                      collectionMethod: "",
                    });
                  }}
                >
                  Temizle
                </Button>
              ) : null}
            </div>
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
                    const defaultDateTo = todayInputValue();
                    setDateFrom(DEFAULT_LEDGER_DATE_FROM);
                    setDateTo(defaultDateTo);
                    setLedgerTypeFilter("");
                    setCollectionMethodFilter("");
                    fetchLedger(1, {
                      dateFrom: DEFAULT_LEDGER_DATE_FROM,
                      dateTo: defaultDateTo,
                      ledgerType: "",
                      collectionMethod: "",
                    });
                  }}
                >
                  Temizle
                </Button>
              ) : null}
            </div>
          ) : (
            <>
            <div className="ledger-mobile-cards md:hidden">
              {displayRows.map((row) => {
                const documentLabel = ledgerDocumentLabel(row);
                const sourceLabel = ledgerSourceLabel(row);
                const meaningfulBadges = ledgerMeaningfulBadges(row);

                return (
                  <article key={`mobile-${row.id}`} className="ledger-mobile-card">
                    <div className="ledger-mobile-card-head">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge
                            variant="outline"
                            className={`h-6 px-2 text-xs font-semibold ${getLedgerTypeMeta(row.type).className}`}
                          >
                            {ledgerTypeDisplayLabel(row)}
                          </Badge>
                          {row.type !== "payment" && row.collection_method_label ? (
                            <span className="rounded-full border border-emerald-300/25 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-black uppercase text-emerald-100">
                              {normalizeCollectionMethodLabel(row.collection_method_label)}
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1.5 text-xs font-bold text-[var(--muted-foreground)]">
                          {formatLedgerDate(row.document_date ?? row.date)}
                        </p>
                      </div>
                      <p className="shrink-0 text-right text-base font-black text-[var(--foreground)]">
                        {formatAmount(row.balance_after, row.currency)}
                      </p>
                    </div>

                    <div className="ledger-mobile-card-body">
                      <div className="min-w-0">
                        <p className="ledger-mobile-label">Belge / Kaynak</p>
                        <p className="break-words text-sm font-black text-[var(--foreground)]">{documentLabel ?? ""}</p>
                        {sourceLabel ? <p className="mt-0.5 break-words text-xs font-semibold text-[var(--muted-foreground)]">Kaynak: {sourceLabel}</p> : null}
                      </div>
                      <div className="min-w-0">
                        <p className="ledger-mobile-label">Açıklama</p>
                        <p className="line-clamp-2 text-sm font-semibold leading-snug text-[var(--foreground)]">{cleanLedgerLabel(row.description) ?? ""}</p>
                      </div>
                    </div>

                    {meaningfulBadges.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {meaningfulBadges.map((label) => (
                          <Badge
                            key={`mobile-${row.id}-${label}`}
                            variant="outline"
                            className="h-5 max-w-full px-1.5 text-[10px] font-black"
                            title={label}
                          >
                            <span className="truncate">{label}</span>
                          </Badge>
                        ))}
                      </div>
                    ) : null}

                    <div className="ledger-mobile-amounts">
                      <div><span>Borç</span><strong>{formatAmount(row.debit, row.currency)}</strong></div>
                      <div><span>Alacak</span><strong>{formatAmount(row.credit, row.currency)}</strong></div>
                    </div>

                    {ledgerHasDetail(row) ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-9 w-full rounded-xl text-xs font-black"
                        onClick={() => openOrderDetail(row)}
                      >
                        <Eye className="h-4 w-4" />
                        Detay
                      </Button>
                    ) : null}
                  </article>
                );
              })}
            </div>

            <div className="ledger-table-scroll hidden overflow-x-auto md:block">
              <table className="ledger-table w-full min-w-[1120px] table-fixed text-left text-[13px]">
                <thead>
                  <tr className="border-b border-[var(--brand-border)] text-[11px] uppercase text-[var(--muted-foreground)]">
                    <th className="w-[74px] px-2 py-2 text-center">Detay</th>
                    <th className="w-[104px] px-2 py-2">Evrak Tarihi</th>
                    <th className="w-[142px] px-2 py-2">İşlem Tipi</th>
                    <th className="w-[300px] px-2 py-2">Belge / Kaynak Evrak</th>
                    <th className="px-2 py-2">Açıklama</th>
                    <th className="w-[120px] px-2 py-2 text-right">Borç</th>
                    <th className="w-[120px] px-2 py-2 text-right">Alacak</th>
                    <th className="w-[128px] px-2 py-2 text-right">Bakiye</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((row) => {
                    const documentLabel = ledgerDocumentLabel(row);
                    const sourceLabel = ledgerSourceLabel(row);
                    const meaningfulBadges = ledgerMeaningfulBadges(row);

                    return (
                    <tr key={row.id} className="border-b border-[var(--brand-border)]/60 transition-colors hover:bg-[var(--surface-soft)]/70">
                      <td className="px-2 py-2.5 text-center">
                        {ledgerHasDetail(row) ? (
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
                        ) : null}
                      </td>
                      <td className="px-2 py-2.5 font-medium">{formatLedgerDate(row.document_date ?? row.date)}</td>
                      <td className="px-2 py-2.5">
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge
                            variant="outline"
                            className={`h-6 px-2 text-xs font-semibold ${getLedgerTypeMeta(row.type).className}`}
                          >
                            {ledgerTypeDisplayLabel(row)}
                          </Badge>
                          {row.type !== "payment" && row.collection_method_label ? (
                            <span className="rounded-full border border-emerald-300/25 bg-emerald-400/10 px-2 py-0.5 text-[11px] font-black uppercase tracking-[0.08em] text-emerald-100">
                              {normalizeCollectionMethodLabel(row.collection_method_label)}
                            </span>
                          ) : null}
                          {row.return_quantity ? (
                            <span className="rounded-full border border-fuchsia-300/25 bg-fuchsia-400/10 px-2 py-0.5 text-[11px] font-black uppercase tracking-[0.08em] text-fuchsia-100">
                              {row.return_quantity} adet
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-2 py-2.5">
                        {documentLabel ? (
                          <p className="break-words font-bold leading-snug text-[var(--foreground)]" title={documentLabel}>{documentLabel}</p>
                        ) : null}
                        {sourceLabel ? (
                          <p className="mt-1 break-words text-[11px] font-semibold leading-snug text-[var(--muted-foreground)]" title={sourceLabel}>
                            Kaynak: {sourceLabel}
                          </p>
                        ) : null}
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          {meaningfulBadges.length > 0 ? meaningfulBadges.map((label) => (
                            <Badge
                              key={`${row.id}-${label}`}
                              variant="outline"
                              className={cn(
                                "h-5 shrink-0 px-1.5 text-[10px] font-black",
                                label === row.checkout_summary?.label
                                  ? getCheckoutSummaryClass(row.checkout_summary.code)
                                  : label === shippingMethodLabel(row)
                                    ? "border-rose-200/60 bg-rose-100 text-rose-800"
                                    : "border-sky-300/45 bg-sky-400/14 text-sky-100"
                              )}
                              title={label}
                            >
                              {label}
                            </Badge>
                          )) : null}
                        </div>
                      </td>
                      <td className="break-words px-2 py-2.5 font-medium">{cleanLedgerLabel(row.description) ?? ""}</td>
                      <td className="px-2 py-2.5 text-right font-medium">{formatAmount(row.debit, row.currency)}</td>
                      <td className="px-2 py-2.5 text-right font-medium">{formatAmount(row.credit, row.currency)}</td>
                      <td className="px-2 py-2.5 text-right font-bold">
                        {formatAmount(row.balance_after, row.currency)}
                      </td>
                    </tr>
                  );
                  })}
                </tbody>
              </table>
            </div>
            </>
          )}
          {payload?.meta ? (
            <div className="mt-5 flex items-center justify-between">
              <p className="text-sm text-[var(--muted-foreground)]">
                Gösterilen {displayRows.length} hareket · Toplam {payload.meta.total} kayıt
              </p>
            </div>
          ) : null}
          {selectedCustomer ? (
            <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(300px,0.42fr)] md:items-stretch xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.4fr)]">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-[16px] border border-rose-300/16 bg-rose-400/7 p-3 text-center">
                  <p className="text-[10px] font-black uppercase tracking-[0.12em] text-rose-100/58">Toplam Borç</p>
                  <p className="mt-1 text-xl font-black text-rose-100">{formatAmount(summary.debit, summary.currency)}</p>
                </div>
                <div className="rounded-[16px] border border-emerald-300/16 bg-emerald-400/7 p-3 text-center">
                  <p className="text-[10px] font-black uppercase tracking-[0.12em] text-emerald-100/58">Toplam Alacak</p>
                  <p className="mt-1 text-xl font-black text-emerald-100">{formatAmount(summary.credit, summary.currency)}</p>
                </div>
                <div className="rounded-[16px] border border-fuchsia-300/16 bg-fuchsia-400/7 p-3 text-center">
                  <p className="text-[10px] font-black uppercase tracking-[0.12em] text-fuchsia-100/58">Toplam İade</p>
                  <p className="mt-1 text-xl font-black text-fuchsia-100">{formatAmount(summary.returnAmount, summary.currency)}</p>
                  <p className="mt-1 text-[11px] font-bold text-fuchsia-100/68">{summary.returnQuantity.toLocaleString("tr-TR")} adet</p>
                </div>
              </div>
              <div className="flex min-h-[88px] flex-col items-center justify-center rounded-[18px] border border-red-200/24 bg-[radial-gradient(circle_at_20%_15%,rgba(255,255,255,0.16)_0%,transparent_34%),linear-gradient(135deg,#ff4d4f_0%,#b71c1c_100%)] p-3 text-center shadow-[0_22px_48px_-30px_rgba(255,77,79,0.9)]">
                <p className="text-[11px] font-black uppercase tracking-[0.13em] text-white/78">Toplam Bakiye</p>
                <p className="mt-1 text-2xl font-black text-white">{formatAmount(summary.balance, summary.currency)}</p>
                <p className="mt-1 text-[11px] font-bold text-white/62">{listedRowCount} hareket</p>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-h-[calc(100vh-44px)] max-w-[min(1040px,calc(100vw-32px))] overflow-y-auto rounded-[22px] border border-emerald-300/20 bg-[linear-gradient(145deg,rgba(12,24,32,0.98)_0%,rgba(7,15,23,0.98)_58%,rgba(10,30,23,0.98)_100%)] p-0 text-slate-100 shadow-[0_34px_90px_-46px_rgba(0,0,0,0.9)]">
          <DialogHeader className="mb-0 border-b border-white/10 px-5 py-3 pr-12">
            <DialogTitle className="text-xl font-black tracking-tight text-white">
              {detailPayload?.order.order_no
                ? `Cari Hareket Detayı · ${detailPayload.order.order_no}`
                : detailLedgerRow?.document_no || detailLedgerRow?.reference_no
                  ? `Cari Hareket Detayı · ${detailLedgerRow.document_no || detailLedgerRow.reference_no}`
                  : "Cari Hareket Detayı"}
            </DialogTitle>
            <DialogDescription className="text-sm font-semibold text-slate-400">
              Sipariş kalemleri, satış tipi, tutar ve müşteri bilgileri.
            </DialogDescription>
          </DialogHeader>

          <div className="p-3">
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
              <div className="space-y-2">
                <div className="grid gap-2 md:grid-cols-[1.15fr_.85fr_.85fr_1fr]">
                  <div className="rounded-[12px] border border-white/10 bg-white/6 p-2">
                    <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-400">Müşteri</p>
                    <p className="mt-1 line-clamp-1 text-sm font-black text-white">{detailPayload.order.customer?.title ?? selectedCustomer?.title ?? "-"}</p>
                    <p className="mt-0.5 text-xs font-bold text-slate-400">{detailPayload.order.customer?.code ?? selectedCustomer?.code ?? "-"}</p>
                  </div>
                  <div className="rounded-[12px] border border-white/10 bg-white/6 p-2">
                    <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-400">Satış Tipi</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {salesPriceTypeLabel(detailPayload.order) ? (
                        <Badge variant="outline" className="h-7 border-sky-300/45 bg-sky-400/14 px-2 text-xs font-black text-sky-100">
                          {salesPriceTypeLabel(detailPayload.order)}
                        </Badge>
                      ) : null}
                      {detailSummary ? (
                        <Badge variant="outline" className={`h-7 px-2 text-xs font-black ${getCheckoutSummaryClass(detailSummary.code)}`}>
                          {detailSummary.label}
                        </Badge>
                      ) : null}
                      {shippingMethodLabel(detailPayload.order) ? (
                        <Badge variant="outline" className="h-7 border-rose-200/60 bg-rose-100 px-2 text-xs font-black text-rose-800">
                          {shippingMethodLabel(detailPayload.order)}
                        </Badge>
                      ) : null}
                      {!salesPriceTypeLabel(detailPayload.order) && !detailSummary && !shippingMethodLabel(detailPayload.order) ? <p className="text-base font-black text-white">-</p> : null}
                    </div>
                  </div>
                  <div className="rounded-[12px] border border-white/10 bg-white/6 p-2">
                    <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-400">Kalem / Adet</p>
                    <p className="mt-1 text-base font-black text-white">
                      {detailPayload.order.items.length} kalem · {detailPayload.order.items.reduce((sum, item) => sum + item.quantity, 0)} adet
                    </p>
                  </div>
                  <div className="rounded-[12px] border border-emerald-300/20 bg-emerald-400/10 p-2">
                    <p className="text-[11px] font-black uppercase tracking-[0.12em] text-emerald-100/70">Genel Toplam</p>
                    <p className="mt-0.5 text-lg font-black text-emerald-200">{formatAmount(detailPayload.order.grand_total, detailPayload.order.currency)}</p>
                  </div>
                </div>

                <div className="overflow-x-auto rounded-[18px] border border-emerald-300/18 shadow-[0_18px_45px_rgba(0,0,0,0.2)]">
                  <table className="w-full min-w-[860px] text-left text-sm">
                    <thead className="bg-white/8 text-[12px] uppercase tracking-[0.06em] text-slate-400">
                      <tr>
                        <th className="px-3 py-2">Ürün</th>
                        <th className="px-3 py-2">Marka</th>
                        <th className="px-3 py-2 text-right">Adet</th>
                        <th className="px-3 py-2 text-right">Birim</th>
                        <th className="px-3 py-2 text-right">KDV</th>
                        <th className="px-3 py-2 text-right">Satır Toplam</th>
                        <th className="px-3 py-2 text-right">Logo Stok</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailPayload.order.items.map((item) => (
                        <tr key={item.id} className="border-t border-white/10">
                          <td className="px-3 py-2">
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
                          <td className="px-3 py-2 font-semibold text-slate-300">{item.brand ?? "-"}</td>
                          <td className="px-3 py-2 text-right font-black text-white">{item.quantity}</td>
                          <td className="px-3 py-2 text-right font-semibold text-slate-300">{formatAmount(item.unit_net_price, item.currency)}</td>
                          <td className="px-3 py-2 text-right font-semibold text-slate-300">%{toAmount(item.tax_rate).toLocaleString("tr-TR", { maximumFractionDigits: 2 })}</td>
                          <td className="px-3 py-2 text-right font-black text-white">{formatAmount(item.line_total, item.currency)}</td>
                          <td className="px-3 py-2 text-right font-semibold text-slate-300">
                            {item.logo_stock ? item.logo_stock.available_total.toLocaleString("tr-TR") : "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {detailPayload.order.note ? (
                  <div className="rounded-[12px] border border-cyan-200/18 bg-cyan-400/8 p-2">
                    <p className="text-[10px] font-black uppercase tracking-[0.12em] text-cyan-100/70">Sipariş Notu</p>
                    <p className="mt-1 max-h-10 overflow-y-auto whitespace-pre-wrap text-[11px] font-semibold leading-4 text-cyan-50/86">{detailPayload.order.note}</p>
                  </div>
                ) : null}
              </div>
            ) : detailLedgerRow ? (
              <div className="space-y-3">
                <div className="grid gap-2 md:grid-cols-4">
                  <div className="rounded-[12px] border border-white/10 bg-white/6 p-2.5">
                    <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-400">Müşteri</p>
                    <p className="mt-1 line-clamp-1 text-sm font-black text-white">{selectedCustomer?.title ?? ""}</p>
                    <p className="mt-1 text-sm font-bold text-slate-400">{selectedCustomer?.code ?? ""}</p>
                  </div>
                  <div className="rounded-[12px] border border-white/10 bg-white/6 p-2.5">
                    <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-400">İşlem Tipi</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Badge variant="outline" className={`h-7 px-2 text-xs font-black ${getLedgerTypeMeta(detailLedgerRow.transaction_type ?? detailLedgerRow.type).className}`}>
                        {ledgerTypeDisplayLabel(detailLedgerRow)}
                      </Badge>
                      {salesPriceTypeLabel(detailLedgerRow) ? (
                        <Badge variant="outline" className="h-7 border-sky-300/45 bg-sky-400/14 px-2 text-xs font-black text-sky-100">
                          {salesPriceTypeLabel(detailLedgerRow)}
                        </Badge>
                      ) : null}
                      {shippingMethodLabel(detailLedgerRow) ? (
                        <Badge variant="outline" className="h-7 border-rose-200/60 bg-rose-100 px-2 text-xs font-black text-rose-800">
                          {shippingMethodLabel(detailLedgerRow)}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <div className="rounded-[12px] border border-white/10 bg-white/6 p-2.5">
                    <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-400">Belge / Tarih</p>
                    <p className="mt-1 text-sm font-black text-white">{ledgerDocumentLabel(detailLedgerRow) ?? ""}</p>
                    <p className="mt-1 text-sm font-bold text-slate-400">{formatLedgerDate(detailLedgerRow.document_date ?? detailLedgerRow.date)}</p>
                  </div>
                  <div className="rounded-[12px] border border-emerald-300/20 bg-emerald-400/10 p-2.5">
                    <p className="text-[11px] font-black uppercase tracking-[0.12em] text-emerald-100/70">Tutar</p>
                    <p className="mt-1 text-xl font-black text-emerald-200">
                      {formatAmount(toAmount(detailLedgerRow.debit) > 0 ? detailLedgerRow.debit : detailLedgerRow.credit, detailLedgerRow.currency)}
                    </p>
                  </div>
                </div>
                {detailLedgerRow.collection_images?.length ? (
                  <div className="rounded-[14px] border border-emerald-300/18 bg-emerald-400/8 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-[11px] font-black uppercase tracking-[0.12em] text-emerald-100/75">Çek / Senet Görselleri</p>
                        <p className="mt-0.5 text-xs font-semibold text-emerald-50/72">
                          {detailLedgerRow.collection_images.length} resim
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      {detailLedgerRow.collection_images.map((image, index) => (
                        <a
                          key={image.id || `${detailLedgerRow.id}-collection-image-${index}`}
                          href={image.data}
                          target="_blank"
                          rel="noreferrer"
                          className="group overflow-hidden rounded-[14px] border border-white/10 bg-black/18 transition hover:border-emerald-200/45 hover:bg-emerald-400/10"
                        >
                          <div className="flex aspect-[4/3] items-center justify-center bg-black/20">
                            <img
                              src={image.data}
                              alt={image.name || `Çek / senet resmi ${index + 1}`}
                              className="h-full w-full object-contain"
                              loading="lazy"
                            />
                          </div>
                          <div className="border-t border-white/10 px-3 py-2">
                            <p className="truncate text-xs font-black text-white">{image.name || `Resim ${index + 1}`}</p>
                            {image.check_no || image.note_no ? (
                              <p className="mt-0.5 text-[11px] font-semibold text-emerald-100/72">No: {image.check_no ?? image.note_no}</p>
                            ) : null}
                          </div>
                        </a>
                      ))}
                    </div>
                  </div>
                ) : null}
                {detailLedgerRow.logo_invoice_detail?.lines?.length ? (
                  <div className="overflow-hidden rounded-[12px] border border-amber-200/20 bg-amber-400/8">
                    <div className="flex items-center justify-between gap-3 border-b border-amber-200/15 px-3 py-2">
                      <div>
                        <p className="text-[11px] font-black uppercase tracking-[0.12em] text-amber-100/75">Logo Fatura Kalemleri</p>
                        <p className="mt-0.5 text-xs font-semibold text-amber-50/75">
                          {detailLedgerRow.logo_invoice_detail.lines.length} satır
                        </p>
                      </div>
                      <p className="text-sm font-black text-amber-100">
                        {formatAmount(detailLedgerRow.logo_invoice_detail.total, detailLedgerRow.currency)}
                      </p>
                    </div>
                    <div className="max-h-[300px] overflow-auto">
                      <table className="min-w-full text-left text-xs">
                        <thead className="sticky top-0 bg-[#132018] text-[10px] uppercase tracking-[0.08em] text-amber-100/75">
                          <tr>
                            <th className="px-3 py-2">Stok Kodu</th>
                            <th className="min-w-[260px] px-3 py-2">Ürün</th>
                            <th className="px-3 py-2 text-right">Miktar</th>
                            <th className="px-3 py-2">Birim</th>
                            <th className="px-3 py-2 text-right">Birim Fiyat</th>
                            <th className="px-3 py-2 text-right">KDV</th>
                            <th className="px-3 py-2 text-right">Tutar</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/10">
                          {detailLedgerRow.logo_invoice_detail.lines.map((line, index) => (
                            <tr key={line.logo_line_ref ?? `${line.product_code ?? "line"}-${index}`}>
                              <td className="px-3 py-2 font-black text-white">{line.product_code ?? ""}</td>
                              <td className="px-3 py-2">
                                <p className="font-semibold text-slate-100">{line.product_name ?? ""}</p>
                                {line.description ? (
                                  <p className="mt-0.5 text-[11px] font-semibold text-slate-400">{line.description}</p>
                                ) : null}
                              </td>
                              <td className="px-3 py-2 text-right font-black text-white">{Number(line.quantity).toLocaleString("tr-TR")}</td>
                              <td className="px-3 py-2 font-semibold text-slate-300">{line.unit ?? ""}</td>
                              <td className="px-3 py-2 text-right font-semibold text-slate-300">{formatAmount(line.unit_price, detailLedgerRow.currency)}</td>
                              <td className="px-3 py-2 text-right font-semibold text-slate-300">%{Number(line.vat_rate).toLocaleString("tr-TR")}</td>
                              <td className="px-3 py-2 text-right font-black text-white">{formatAmount(line.line_total, detailLedgerRow.currency)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
                <div className="rounded-[12px] border border-white/10 bg-white/6 p-3">
                  <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-400">Açıklama / Kaynak</p>
                  <p className="mt-2 text-sm font-semibold text-slate-200">{cleanLedgerLabel(detailLedgerRow.description) ?? ""}</p>
                  {ledgerSourceLabel(detailLedgerRow) ? (
                    <p className="mt-1 text-xs font-semibold text-slate-400">Kaynak evrak: {ledgerSourceLabel(detailLedgerRow)}</p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
