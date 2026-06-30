"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Banknote,
  BarChart3,
  Box,
  Building2,
  CheckCircle2,
  CreditCard,
  FileText,
  HandCoins,
  Loader2,
  ShieldCheck,
  ShoppingCart,
  TrendingUp,
  Truck,
  UserRound,
  Users,
} from "lucide-react";

import { getLogoDashboardStats } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type ReportPayload = Record<string, unknown> | null;

type ChartItem = {
  label: string;
  value: number;
};

type SalespersonBalanceRow = {
  id: number | null;
  name: string;
  phone: string | null;
  customerCount: number;
  activeCustomerCount: number;
  balanceTotal: number;
  orderDueTotal: number;
};

type SupplierDebtRow = {
  code: string;
  title: string;
  debt: number;
  balance: number;
  lastSyncedAt: string | null;
};

type DailyTrendPoint = {
  label: string;
  value: number;
};

type RecentTransactionRow = {
  id: string;
  date: string | null;
  type: string;
  related: string;
  amount: number;
  tone: string;
};

type SyncStateRow = {
  domain: string;
  direction: string;
  records: number;
  syncedRecords: number;
  failedRecords: number;
  pendingRecords: number;
  latestStatus: string | null;
  lastSyncedAt: string | null;
  lastActivityAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  statusCounts: Record<string, number>;
};

type SyncGapRow = {
  key: string;
  title: string;
  flow: string;
  status: string;
  expectedCount: number;
  syncedCount: number;
  missingCount: number;
  staleCount: number;
  lastSyncedAt: string | null;
  lastActivityAt: string | null;
  detail: string;
};

const ADMIN_BANNER_IMAGES = [
  {
    src: "/brand/powersa-mascot.png",
    label: "Powersa maskot",
    fit: "contain",
  },
  {
    src: "/brand/powersa-filter-showcase/optimized/branch-erzurum.jpg",
    label: "Erzurum merkez",
  },
  {
    src: "/brand/powersa-filter-showcase/optimized/branch-trabzon.jpg",
    label: "Trabzon şube",
  },
  {
    src: "/brand/powersa-filter-showcase/optimized/branch-samsun.jpg",
    label: "Samsun şube",
  },
  {
    src: "/brand/powersa-filter-showcase/optimized/featured-2.jpg",
    label: "Filtre grupları",
  },
];

function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const raw = value.trim();
    if (raw.length === 0) {
      return null;
    }

    const normalized = raw.includes(",")
      ? raw.replace(/\./g, "").replace(",", ".").replace(/[^0-9.-]/g, "")
      : raw.replace(/[^0-9.-]/g, "");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function getSummary(payload: ReportPayload): Record<string, unknown> | null {
  if (!isRecord(payload)) {
    return null;
  }

  return isRecord(payload.summary) ? payload.summary : null;
}

function getDataArray(payload: ReportPayload, key = "data"): Record<string, unknown>[] {
  if (!isRecord(payload)) {
    return [];
  }

  const target = payload[key];
  if (!Array.isArray(target)) {
    return [];
  }

  return target.filter((entry): entry is Record<string, unknown> => isRecord(entry));
}

function getSalespersonBalanceRows(payload: ReportPayload): SalespersonBalanceRow[] {
  const rows = getDataArray(payload, "salesperson_balance_summary");

  return rows
    .map((row) => {
      const salesperson = isRecord(row.salesperson) ? row.salesperson : null;
      const name = typeof salesperson?.name === "string" && salesperson.name.trim().length > 0 ? salesperson.name : "Atanmamış";
      const phone = typeof salesperson?.phone === "string" && salesperson.phone.trim().length > 0 ? salesperson.phone : null;
      const id = toNumber(salesperson?.id);
      const customerCount = Math.max(0, Math.round(toNumber(row.customer_count) ?? 0));
      const activeCustomerCount = Math.max(0, Math.round(toNumber(row.active_customer_count) ?? 0));
      const balanceTotal = toNumber(row.balance_total) ?? 0;
      const orderDueTotal = toNumber(row.order_due_total) ?? 0;

      if (customerCount <= 0 && Math.abs(balanceTotal) <= 0.004) {
        return null;
      }

      return {
        id,
        name,
        phone,
        customerCount,
        activeCustomerCount,
        balanceTotal,
        orderDueTotal,
      };
    })
    .filter((entry): entry is SalespersonBalanceRow => entry !== null)
    .sort((a, b) => Math.abs(b.balanceTotal) - Math.abs(a.balanceTotal));
}

function getSupplierDebtRows(payload: ReportPayload): SupplierDebtRow[] {
  const rows = getDataArray(payload, "supplier_debt_summary");

  return rows
    .map((row) => {
      const title = typeof row.title === "string" && row.title.trim().length > 0 ? row.title : null;
      const code = typeof row.code === "string" ? row.code : "";
      const debt = Math.max(0, toNumber(row.debt) ?? Math.abs(toNumber(row.balance) ?? 0));
      const balance = toNumber(row.balance) ?? 0;
      const lastSyncedAt = typeof row.last_synced_at === "string" ? row.last_synced_at : null;

      if (!title || debt <= 0) {
        return null;
      }

      return {
        code,
        title,
        debt,
        balance,
        lastSyncedAt,
      };
    })
    .filter((entry): entry is SupplierDebtRow => entry !== null)
    .sort((a, b) => b.debt - a.debt);
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function formatMethodLabel(method: string): string {
  const map: Record<string, string> = {
    cash: "Nakit",
    transfer: "Havale",
    check: "Çek",
    note: "Senet",
    cc: "Kart",
  };

  return map[method] ?? titleCase(method);
}

function extractSalesLabel(row: Record<string, unknown>): string | null {
  const brand = isRecord(row.brand) ? row.brand : null;
  if (brand && typeof brand.name === "string" && brand.name.trim().length > 0) {
    return brand.name;
  }

  const customer = isRecord(row.customer) ? row.customer : null;
  if (customer && typeof customer.title === "string" && customer.title.trim().length > 0) {
    return customer.title;
  }

  const product = isRecord(row.product) ? row.product : null;
  if (product && typeof product.name === "string" && product.name.trim().length > 0) {
    return product.name;
  }

  return null;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("tr-TR", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatMoneyCompact(value: number): string {
  const absolute = Math.abs(value);

  if (absolute >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} Mr ₺`;
  }

  if (absolute >= 1_000_000) {
    return `${(value / 1_000_000).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} Mn ₺`;
  }

  if (absolute >= 1_000) {
    return `${(value / 1_000).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} B ₺`;
  }

  return `${value.toLocaleString("tr-TR", { maximumFractionDigits: 0 })} ₺`;
}

function formatShortDate(value: string | null): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "short",
  }).format(date);
}

function formatDateTimeShort(value: string | null): string {
  if (!value) {
    return "Logo sync bekleniyor";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Logo sync tarihi okunamadı";
  }

  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function getDailyTrendRows(payload: ReportPayload, key: string, countKey: string): DailyTrendPoint[] {
  return getDataArray(payload, key)
    .map((row) => {
      const date = typeof row.date === "string" ? row.date : null;
      const value = toNumber(row.total) ?? 0;
      const count = Math.max(0, Math.round(toNumber(row[countKey]) ?? 0));

      if (!date || value <= 0) {
        return null;
      }

      return {
        label: `${formatShortDate(date)} · ${formatCount(count)} kayıt`,
        value,
      };
    })
    .filter((entry): entry is DailyTrendPoint => entry !== null)
    .slice(-5);
}

function formatMovementType(type: string | null, direction: string | null): string {
  if (direction === "credit") {
    return "Tahsilat";
  }

  if (direction === "debit") {
    return "Satış";
  }

  const map: Record<string, string> = {
    payment: "Tahsilat",
    credit: "Tahsilat",
    invoice: "Satış",
    debit: "Borç",
    refund: "İade",
  };

  return type ? (map[type] ?? titleCase(type)) : "Hareket";
}

function getRecentTransactionRows(payload: ReportPayload): RecentTransactionRow[] {
  return getDataArray(payload, "recent_movements")
    .map((row, index) => {
      const customer = isRecord(row.customer) ? row.customer : null;
      const related =
        (typeof customer?.title === "string" && customer.title.trim().length > 0 ? customer.title : null) ??
        (typeof row.description === "string" && row.description.trim().length > 0 ? row.description : null) ??
        (typeof row.reference_no === "string" && row.reference_no.trim().length > 0 ? row.reference_no : null) ??
        "Logo hareketi";
      const direction = typeof row.direction === "string" ? row.direction : null;
      const type = formatMovementType(typeof row.type === "string" ? row.type : null, direction);
      const amount = Math.abs(toNumber(row.amount) ?? 0);

      if (amount <= 0) {
        return null;
      }

      return {
        id: `${row.id ?? index}-${type}-${related}`,
        date: typeof row.date === "string" ? row.date : null,
        type,
        related,
        amount,
        tone: direction === "credit" ? "bg-emerald-400" : direction === "debit" ? "bg-sky-400" : "bg-violet-400",
      };
    })
    .filter((entry): entry is RecentTransactionRow => entry !== null)
    .slice(0, 6);
}

function getSyncRows(payload: ReportPayload): SyncStateRow[] {
  return getDataArray(payload, "sync")
    .map((row) => {
      const domain = typeof row.domain === "string" ? row.domain : null;
      const direction = typeof row.direction === "string" ? row.direction : null;

      if (!domain || !direction) {
        return null;
      }

      return {
        domain,
        direction,
        records: Math.max(0, Math.round(toNumber(row.records) ?? 0)),
        syncedRecords: Math.max(0, Math.round(toNumber(row.synced_records) ?? 0)),
        failedRecords: Math.max(0, Math.round(toNumber(row.failed_records) ?? 0)),
        pendingRecords: Math.max(0, Math.round(toNumber(row.pending_records) ?? 0)),
        latestStatus: typeof row.latest_status === "string" ? row.latest_status : null,
        lastSyncedAt: typeof row.last_synced_at === "string" ? row.last_synced_at : null,
        lastActivityAt: typeof row.last_activity_at === "string" ? row.last_activity_at : null,
        lastError: typeof row.last_error === "string" && row.last_error.trim().length > 0 ? row.last_error : null,
        lastErrorAt: typeof row.last_error_at === "string" ? row.last_error_at : null,
        statusCounts: isRecord(row.status_counts)
          ? Object.fromEntries(
              Object.entries(row.status_counts)
                .map<[string, number]>(([key, value]) => [key, Math.max(0, Math.round(toNumber(value) ?? 0))])
                .filter(([, value]) => value > 0)
            )
          : {},
      };
    })
    .filter((entry): entry is SyncStateRow => entry !== null)
    .sort((a, b) => {
      const aTime = new Date(a.lastActivityAt ?? a.lastSyncedAt ?? 0).getTime();
      const bTime = new Date(b.lastActivityAt ?? b.lastSyncedAt ?? 0).getTime();

      return bTime - aTime;
    });
}

function getSyncGapRows(payload: ReportPayload): SyncGapRow[] {
  return getDataArray(payload, "sync_gaps")
    .map((row) => {
      const key = typeof row.key === "string" ? row.key : null;
      const title = typeof row.title === "string" ? row.title : null;
      const flow = typeof row.flow === "string" ? row.flow : null;

      if (!key || !title || !flow) {
        return null;
      }

      return {
        key,
        title,
        flow,
        status: typeof row.status === "string" ? row.status : "unknown",
        expectedCount: Math.max(0, Math.round(toNumber(row.expected_count) ?? 0)),
        syncedCount: Math.max(0, Math.round(toNumber(row.synced_count) ?? 0)),
        missingCount: Math.max(0, Math.round(toNumber(row.missing_count) ?? 0)),
        staleCount: Math.max(0, Math.round(toNumber(row.stale_count) ?? 0)),
        lastSyncedAt: typeof row.last_synced_at === "string" ? row.last_synced_at : null,
        lastActivityAt: typeof row.last_activity_at === "string" ? row.last_activity_at : null,
        detail: typeof row.detail === "string" && row.detail.trim().length > 0 ? row.detail : "Detay bekleniyor.",
      };
    })
    .filter((entry): entry is SyncGapRow => entry !== null)
    .sort((a, b) => {
      const severityDiff = syncGapSeverityRank(a.status) - syncGapSeverityRank(b.status);

      if (severityDiff !== 0) {
        return severityDiff;
      }

      return (b.missingCount + b.staleCount) - (a.missingCount + a.staleCount);
    });
}

function formatSyncDomainLabel(row: SyncStateRow): string {
  const domains: Record<string, string> = {
    customers: "Cari",
    ledger: "Cari Hareket",
    collections: "Tahsilat",
    "pos-sales": "POS Satış",
    "pos-expenses": "POS Masraf",
    orders: "Sipariş",
    products: "Ürün",
    "product-stocks": "Stok",
    documents: "Belge",
  };

  const direction = row.direction === "outbound" ? "yazma" : "okuma";

  return `${domains[row.domain] ?? titleCase(row.domain)} ${direction}`;
}

function formatSyncDirectionLabel(direction: string): string {
  if (direction === "outbound") {
    return "B2B -> Logo";
  }

  if (direction === "inbound") {
    return "Logo -> B2B";
  }

  return titleCase(direction);
}

function formatSyncStatusLabel(status: string | null): string {
  const map: Record<string, string> = {
    synced: "Başarılı",
    failed: "Hatalı",
    error: "Hatalı",
    pending: "Bekliyor",
    queued: "Kuyrukta",
    processing: "İşleniyor",
    unknown: "Bilinmiyor",
  };

  return status ? map[status] ?? titleCase(status) : "Bilinmiyor";
}

function syncStatusClassName(status: string | null): string {
  if (status === "failed" || status === "error") {
    return "border-red-400/40 bg-red-400/12 text-red-100";
  }

  if (status === "pending" || status === "queued" || status === "processing") {
    return "border-amber-300/40 bg-amber-300/12 text-amber-100";
  }

  if (status === "synced") {
    return "border-emerald-300/40 bg-emerald-300/12 text-emerald-100";
  }

  return "border-slate-500/40 bg-slate-500/12 text-slate-200";
}

function formatSyncStatusCounts(row: SyncStateRow): string {
  const parts = [
    row.syncedRecords > 0 ? `${formatCount(row.syncedRecords)} başarılı` : null,
    row.pendingRecords > 0 ? `${formatCount(row.pendingRecords)} bekliyor` : null,
    row.failedRecords > 0 ? `${formatCount(row.failedRecords)} hatalı` : null,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" · ") : `${formatCount(row.records)} kayıt`;
}

function syncGapSeverityRank(status: string): number {
  if (status === "critical") {
    return 0;
  }

  if (status === "warning") {
    return 1;
  }

  if (status === "ok") {
    return 2;
  }

  return 3;
}

function formatSyncGapStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    critical: "Acil",
    warning: "Eksik var",
    ok: "Tamam",
    unknown: "Bilinmiyor",
  };

  return labels[status] ?? titleCase(status);
}

function syncGapStatusClassName(status: string): string {
  if (status === "critical") {
    return "border-red-400/45 bg-red-400/14 text-red-100";
  }

  if (status === "warning") {
    return "border-amber-300/45 bg-amber-300/14 text-amber-100";
  }

  if (status === "ok") {
    return "border-emerald-300/40 bg-emerald-300/12 text-emerald-100";
  }

  return "border-slate-500/40 bg-slate-500/12 text-slate-200";
}

function formatSyncGapIssue(row: SyncGapRow): string {
  const parts = [
    row.missingCount > 0 ? `${formatCount(row.missingCount)} eksik` : null,
    row.staleCount > 0 ? `${formatCount(row.staleCount)} eski` : null,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" · ") : "Eksik yok";
}

function AdminBrandBanner() {
  return (
    <section className="admin-brand-banner">
      <div className="admin-brand-banner-copy">
        <span className="admin-brand-banner-kicker">Powersa Filter</span>
        <h2>Operasyon görünümü</h2>
        <p>Şube, stok ve sipariş tek merkezde.</p>
      </div>
      <div className="admin-brand-banner-collage" aria-label="Powersa operasyon görselleri">
        {ADMIN_BANNER_IMAGES.map((image, index) => (
          <figure
            className="admin-brand-banner-tile"
            data-fit={image.fit}
            key={image.src}
            style={{ "--tile-index": index } as CSSProperties}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image.src} alt={image.label} loading={index === 0 ? "eager" : "lazy"} />
            <figcaption>{image.label}</figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

function LogoBridgeDetails({ rows, gaps, loading }: { rows: SyncStateRow[]; gaps: SyncGapRow[]; loading: boolean }) {
  const latestActivity = rows[0]?.lastActivityAt ?? rows[0]?.lastSyncedAt ?? null;
  const gapIssueCount = gaps.filter((row) => row.status !== "ok").length;

  return (
    <Card className="admin-report-card border-emerald-400/25 bg-[linear-gradient(180deg,rgba(9,30,33,0.98)_0%,rgba(7,17,27,0.98)_100%)] text-slate-100">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>
            <CardTitle className="flex items-center gap-2 text-xl font-black">
              <ShieldCheck className="h-5 w-5 text-emerald-300" />
              Logo Köprü Detayı
            </CardTitle>
            <p className="mt-1 text-sm font-semibold text-slate-400">
              Logo okuma ve yazma hareketlerinin son durumu
            </p>
          </span>
          <span className="rounded-full border border-emerald-300/30 bg-emerald-300/10 px-3 py-1.5 text-xs font-black text-emerald-100">
            Son hareket: {formatDateTimeShort(latestActivity)}
          </span>
          <span className={`rounded-full border px-3 py-1.5 text-xs font-black ${gapIssueCount > 0 ? "border-amber-300/40 bg-amber-300/12 text-amber-100" : "border-emerald-300/30 bg-emerald-300/10 text-emerald-100"}`}>
            Eksik takip: {formatCount(gapIssueCount)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        {loading && rows.length === 0 ? (
          <div className="flex min-h-[120px] items-center justify-center gap-2 rounded-[14px] border border-slate-700/75 bg-slate-950/30 text-sm font-black text-slate-300">
            <Loader2 className="h-4 w-4 animate-spin" />
            Logo köprü durumu yükleniyor
          </div>
        ) : rows.length > 0 ? (
          <div className="overflow-x-auto rounded-[14px] border border-slate-700/80">
            <table className="min-w-[940px] w-full border-collapse text-left">
              <thead className="bg-white/[0.055] text-[0.68rem] font-black uppercase tracking-[0.1em] text-slate-400">
                <tr>
                  <th className="px-4 py-3">İşlem</th>
                  <th className="px-4 py-3">Akış</th>
                  <th className="px-4 py-3">Durum</th>
                  <th className="px-4 py-3 text-right">Kayıt</th>
                  <th className="px-4 py-3">Son İşlem</th>
                  <th className="px-4 py-3">Son Başarılı Sync</th>
                  <th className="px-4 py-3">Hata</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/70">
                {rows.map((row) => (
                  <tr key={`${row.domain}-${row.direction}`} className="bg-slate-950/18 text-sm font-semibold text-slate-200">
                    <td className="px-4 py-3">
                      <span className="block font-black text-white">{formatSyncDomainLabel(row)}</span>
                      <span className="mt-1 block text-xs text-slate-500">{row.domain}</span>
                    </td>
                    <td className="px-4 py-3 text-slate-300">{formatSyncDirectionLabel(row.direction)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-black ${syncStatusClassName(row.latestStatus)}`}>
                        {row.latestStatus === "synced" ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
                        {formatSyncStatusLabel(row.latestStatus)}
                      </span>
                      <span className="mt-1 block text-xs text-slate-500">{formatSyncStatusCounts(row)}</span>
                    </td>
                    <td className="px-4 py-3 text-right font-black text-slate-100">{formatCount(row.records)}</td>
                    <td className="px-4 py-3 text-slate-300">{formatDateTimeShort(row.lastActivityAt)}</td>
                    <td className="px-4 py-3 text-slate-300">{formatDateTimeShort(row.lastSyncedAt)}</td>
                    <td className="max-w-[260px] px-4 py-3">
                      {row.lastError ? (
                        <span className="block text-red-100">
                          <span className="block truncate font-black">{row.lastError}</span>
                          <span className="mt-1 block text-xs text-red-200/70">{formatDateTimeShort(row.lastErrorAt)}</span>
                        </span>
                      ) : (
                        <span className="text-slate-500">Hata yok</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-[14px] border border-slate-700/75 bg-slate-950/30 px-4 py-8 text-center text-sm font-semibold text-slate-400">
            Logo okuma/yazma durumu bekleniyor.
          </div>
        )}
        <div className="overflow-hidden rounded-[14px] border border-slate-700/80 bg-slate-950/20">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-700/75 px-4 py-3">
            <span>
              <span className="block text-sm font-black text-white">Eksik / Takip Gerekenler</span>
              <span className="mt-1 block text-xs font-semibold text-slate-500">Logo entegrasyonunda eşleşmeyen, rafı boş kalan veya zamanı eskiyen kayıtlar</span>
            </span>
            <span className="rounded-full border border-slate-600/70 bg-white/5 px-2.5 py-1 text-xs font-black text-slate-300">
              {formatCount(gaps.length)} kontrol
            </span>
          </div>
          {loading && gaps.length === 0 ? (
            <div className="flex min-h-[86px] items-center justify-center gap-2 text-sm font-black text-slate-300">
              <Loader2 className="h-4 w-4 animate-spin" />
              Eksik analizi yükleniyor
            </div>
          ) : gaps.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="min-w-[980px] w-full border-collapse text-left">
                <thead className="bg-white/[0.04] text-[0.68rem] font-black uppercase tracking-[0.1em] text-slate-400">
                  <tr>
                    <th className="px-4 py-3">Konu</th>
                    <th className="px-4 py-3">Akış</th>
                    <th className="px-4 py-3">Durum</th>
                    <th className="px-4 py-3 text-right">Eksik</th>
                    <th className="px-4 py-3 text-right">Kapsam</th>
                    <th className="px-4 py-3">Son Sync</th>
                    <th className="px-4 py-3">Detay</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/70">
                  {gaps.map((row) => (
                    <tr key={row.key} className="text-sm font-semibold text-slate-200">
                      <td className="px-4 py-3">
                        <span className="block font-black text-white">{row.title}</span>
                        <span className="mt-1 block text-xs text-slate-500">{row.key}</span>
                      </td>
                      <td className="px-4 py-3 text-slate-300">{row.flow}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-black ${syncGapStatusClassName(row.status)}`}>
                          {row.status === "ok" ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
                          {formatSyncGapStatusLabel(row.status)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-black text-slate-100">{formatSyncGapIssue(row)}</td>
                      <td className="px-4 py-3 text-right text-slate-300">
                        {formatCount(row.syncedCount)} / {formatCount(row.expectedCount)}
                      </td>
                      <td className="px-4 py-3 text-slate-300">{formatDateTimeShort(row.lastSyncedAt ?? row.lastActivityAt)}</td>
                      <td className="max-w-[360px] px-4 py-3 text-slate-300">
                        <span className="block truncate">{row.detail}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-4 py-8 text-center text-sm font-semibold text-slate-400">
              Eksik analiz kaydı bekleniyor.
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SalespersonBalanceOverview({ rows, loading }: { rows: SalespersonBalanceRow[]; loading: boolean }) {
  const visibleRows = rows.slice(0, 6);
  const totalBalance = rows.reduce((sum, row) => sum + row.balanceTotal, 0);
  const totalCustomers = rows.reduce((sum, row) => sum + row.customerCount, 0);

  return (
    <Card className="dashboard-panel-card overflow-hidden rounded-[18px]">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg font-extrabold text-[var(--foreground)] md:text-xl">
              <UserRound className="h-5 w-5 text-[var(--brand-primary)]" /> Plasiyer Cari Bakiyeleri
            </CardTitle>
            <p className="mt-1 text-sm font-semibold text-[var(--muted-foreground)]">
              {formatCount(totalCustomers)} cari · toplam bakiye {formatMoneyCompact(totalBalance)}
            </p>
          </div>
          <span className="dashboard-panel-soft inline-flex items-center gap-2 rounded-[12px] px-3 py-2 text-[12px] font-black uppercase tracking-[0.1em] text-[var(--brand-primary)]">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            Plasiyer Bazlı
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {visibleRows.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visibleRows.map((row) => {
              const initials = row.name
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2)
                .map((part) => part[0]?.toLocaleUpperCase("tr-TR") ?? "")
                .join("");
              const balanceTone = row.balanceTotal > 0 ? "Borç Bakiyesi" : row.balanceTotal < 0 ? "Alacak Bakiyesi" : "Dengede";

              return (
                <div
                  key={`${row.id ?? "unassigned"}-${row.name}`}
                  className="min-h-[172px] rounded-[18px] border border-[color-mix(in_oklab,var(--brand-primary)_28%,var(--brand-border))] bg-[linear-gradient(135deg,var(--surface)_0%,var(--surface-soft)_100%)] p-5 shadow-[0_22px_38px_-34px_color-mix(in_oklab,var(--brand-primary)_50%,transparent),inset_0_1px_0_rgba(255,255,255,0.7)]"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-[16px] bg-[var(--brand-primary)] text-[15px] font-black text-white shadow-[0_14px_24px_-18px_color-mix(in_oklab,var(--brand-primary)_90%,transparent)]">
                        {initials || "P"}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[17px] font-black text-[var(--brand-primary-strong)]">{row.name}</span>
                        <span className="mt-0.5 block truncate text-[12px] font-bold text-[var(--muted-foreground)]">
                          {row.phone ?? "Telefon yok"}
                        </span>
                      </span>
                    </div>
                    <span className="rounded-full border border-[var(--brand-border)] bg-[var(--surface)] px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-[var(--brand-primary)]">
                      {balanceTone}
                    </span>
                  </div>

                  <div className="mt-5">
                    <p className="text-[2rem] font-black leading-none tracking-tight text-[var(--brand-primary-strong)]">
                      {formatMoneyCompact(row.balanceTotal)}
                    </p>
                    <div className="mt-4 grid grid-cols-3 gap-2">
                      <span className="rounded-[12px] bg-[var(--surface)] px-3 py-2">
                        <span className="block text-[10px] font-black uppercase tracking-[0.1em] text-[var(--muted-foreground)]">Cari</span>
                        <span className="mt-1 block text-[16px] font-black text-[var(--brand-primary-strong)]">{formatCount(row.customerCount)}</span>
                      </span>
                      <span className="rounded-[12px] bg-[var(--surface)] px-3 py-2">
                        <span className="block text-[10px] font-black uppercase tracking-[0.1em] text-[var(--muted-foreground)]">Aktif</span>
                        <span className="mt-1 block text-[16px] font-black text-[var(--brand-primary-strong)]">{formatCount(row.activeCustomerCount)}</span>
                      </span>
                      <span className="rounded-[12px] bg-[var(--surface)] px-3 py-2">
                        <span className="block text-[10px] font-black uppercase tracking-[0.1em] text-[var(--muted-foreground)]">Sipariş</span>
                        <span className="mt-1 block text-[16px] font-black text-[var(--brand-primary-strong)]">{formatMoneyCompact(row.orderDueTotal)}</span>
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-[16px] border border-[var(--brand-border)] bg-[var(--surface)] p-5 text-sm font-semibold text-[var(--muted-foreground)]">
            Plasiyer bazlı cari bakiyesi için Logo cari verisi bekleniyor.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ReportFocusCards({
  collectionTotal,
  salesTotal,
  supplierDebtTotal,
}: {
  collectionTotal: number;
  collectionCount: number;
  salesTotal: number;
  salesCount: number;
  openOrderTotal: number;
  supplierDebtTotal: number;
  supplierCount: number;
  topCollectionMethod?: ChartItem;
  topSalesCustomer?: { name: string; netTotal: number };
  topSupplierDebt?: SupplierDebtRow;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card className="aspect-square overflow-hidden rounded-[18px] border border-cyan-300/35 bg-[radial-gradient(circle_at_82%_18%,rgba(125,211,252,0.4)_0%,transparent_34%),linear-gradient(145deg,#082f49_0%,#0e7490_56%,#164e63_100%)] text-white shadow-[0_28px_54px_-34px_rgba(14,116,144,0.78)]">
        <CardContent className="relative flex h-full p-6">
          <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.12)_0%,transparent_44%),radial-gradient(circle_at_18%_82%,rgba(34,211,238,0.28)_0%,transparent_38%)]" />
          <div className="relative flex h-full flex-col justify-between gap-5">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-[58px] w-[58px] shrink-0 items-center justify-center rounded-[18px] border border-white/22 bg-white/14 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]">
                <HandCoins className="h-7 w-7" />
              </span>
              <p className="text-[15px] font-black uppercase tracking-[0.14em] text-cyan-100">Tahsilat Raporu</p>
            </div>
            <p className="text-[clamp(2.25rem,4vw,3.35rem)] font-black leading-none tracking-tight text-white">{formatMoneyCompact(collectionTotal)}</p>
          </div>
        </CardContent>
      </Card>

      <Card className="aspect-square overflow-hidden rounded-[18px] border border-fuchsia-300/35 bg-[radial-gradient(circle_at_82%_18%,rgba(240,171,252,0.38)_0%,transparent_34%),linear-gradient(145deg,#3b0764_0%,#7e22ce_54%,#4c1d95_100%)] text-white shadow-[0_28px_54px_-34px_rgba(126,34,206,0.78)]">
        <CardContent className="relative flex h-full p-6">
          <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.12)_0%,transparent_44%),radial-gradient(circle_at_18%_82%,rgba(217,70,239,0.28)_0%,transparent_38%)]" />
          <div className="relative flex h-full flex-col justify-between gap-5">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-[58px] w-[58px] shrink-0 items-center justify-center rounded-[18px] border border-white/22 bg-white/14 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]">
                <TrendingUp className="h-7 w-7" />
              </span>
              <p className="text-[15px] font-black uppercase tracking-[0.14em] text-fuchsia-100">Satış Raporu</p>
            </div>
            <p className="text-[clamp(2.25rem,4vw,3.35rem)] font-black leading-none tracking-tight text-white">{formatMoneyCompact(salesTotal)}</p>
          </div>
        </CardContent>
      </Card>

      <Card className="aspect-square overflow-hidden rounded-[18px] border border-orange-300/40 bg-[linear-gradient(145deg,#451707_0%,#9a3412_52%,#f59e0b_100%)] text-white shadow-[0_28px_54px_-34px_rgba(160,72,15,0.82)]">
        <CardContent className="relative flex h-full p-6">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_10%,rgba(255,239,184,0.38)_0%,transparent_38%),linear-gradient(135deg,rgba(255,255,255,0.11)_0%,transparent_45%)]" />
          <div className="relative flex h-full flex-col justify-between gap-5">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-[58px] w-[58px] shrink-0 items-center justify-center rounded-[18px] border border-white/20 bg-white/12 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]">
                <Truck className="h-7 w-7" />
              </span>
              <p className="text-[15px] font-black uppercase tracking-[0.14em] text-[#ffe1a6]">Tedarikçilere Borç</p>
            </div>
            <p className="text-[clamp(2.25rem,4vw,3.35rem)] font-black leading-none tracking-tight text-white">{formatMoneyCompact(supplierDebtTotal)}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AdminReportSquares({
  customerCount,
  totalReceivable,
  openOrderTotal,
  collectedTotal,
  collectedCount,
  salesTotal,
  salesCount,
  topCollectionMethod,
  topSalesCustomer,
}: {
  customerCount: number;
  totalReceivable: number;
  openOrderTotal: number;
  collectedTotal: number;
  collectedCount: number;
  salesTotal: number;
  salesCount: number;
  topCollectionMethod?: ChartItem;
  topSalesCustomer?: { name: string; netTotal: number };
}) {
  const cards = [
    {
      title: "Cari Bakiye Durumları",
      icon: Banknote,
      value: formatMoneyCompact(totalReceivable),
      className:
        "border-emerald-300/40 bg-[radial-gradient(circle_at_18%_16%,rgba(166,230,178,0.34),transparent_38%),linear-gradient(145deg,rgba(8,38,25,0.96),rgba(28,91,60,0.9))]",
      iconClassName: "bg-emerald-300/20 text-emerald-200",
    },
    {
      title: "Sipariş Bakiye Durumları",
      icon: ShoppingCart,
      value: formatMoneyCompact(openOrderTotal),
      className:
        "border-sky-300/40 bg-[radial-gradient(circle_at_18%_16%,rgba(125,211,252,0.34),transparent_38%),linear-gradient(145deg,rgba(9,31,55,0.96),rgba(20,83,128,0.88))]",
      iconClassName: "bg-sky-300/20 text-sky-100",
    },
    {
      title: "Tahsilat Raporu",
      icon: FileText,
      value: formatMoneyCompact(collectedTotal),
      className:
        "border-amber-300/45 bg-[radial-gradient(circle_at_18%_16%,rgba(252,211,77,0.34),transparent_38%),linear-gradient(145deg,rgba(64,38,8,0.96),rgba(133,77,14,0.88))]",
      iconClassName: "bg-amber-200/20 text-amber-100",
    },
    {
      title: "Satış Raporu",
      icon: BarChart3,
      value: formatMoneyCompact(salesTotal),
      className:
        "border-violet-300/45 bg-[radial-gradient(circle_at_18%_16%,rgba(196,181,253,0.34),transparent_38%),linear-gradient(145deg,rgba(35,20,61,0.96),rgba(91,33,182,0.82))]",
      iconClassName: "bg-violet-200/20 text-violet-100",
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
      {cards.map((card) => {
        const Icon = card.icon;

        return (
          <Card
            key={card.title}
            className={`aspect-square min-h-[300px] overflow-hidden rounded-[18px] text-white shadow-[0_28px_54px_-34px_rgba(0,0,0,0.58)] ${card.className}`}
          >
            <CardContent className="flex h-full flex-col p-5">
              <div className="flex items-center gap-3">
                <span className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-white/20 backdrop-blur ${card.iconClassName}`}>
                  <Icon className="h-7 w-7" />
                </span>
                <h2 className="text-[1.35rem] font-extrabold leading-tight tracking-tight">{card.title}</h2>
              </div>

              <p className="mt-auto text-[3rem] font-black leading-none tracking-tight">{card.value}</p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function MetricBlock({
  title,
  icon: Icon,
  value,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <Card className="dashboard-panel-card admin-dashboard-metric overflow-hidden rounded-[18px] text-[var(--foreground)]">
      <CardContent className="flex h-full items-center justify-between gap-4 p-5">
        <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-[15px] border border-[var(--brand-border)] bg-[var(--brand-primary-soft)] text-[var(--brand-primary)] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
          <Icon className="h-6 w-6" />
        </span>
        <div className="min-w-0 text-right">
          <p className="text-[12px] font-black uppercase tracking-[0.1em] text-[var(--muted-foreground)]">{title}</p>
          <p className="mt-1 text-[1.7rem] font-black leading-none tracking-tight text-[var(--brand-primary-strong)]">{value}</p>
          {children}
        </div>
      </CardContent>
    </Card>
  );
}

export function ControlPanelPage() {
  const now = new Date();
  const lastMonth = new Date();
  lastMonth.setDate(now.getDate() - 30);

  const [dateFrom, setDateFrom] = useState(toDateInputValue(lastMonth));
  const [dateTo, setDateTo] = useState(toDateInputValue(now));

  const reportsQuery = useQuery({
    queryKey: ["control-panel", { dateFrom, dateTo }],
    queryFn: async () => {
      const logoDashboard = await getLogoDashboardStats({ date_from: dateFrom, date_to: dateTo });

      return {
        logoDashboard: logoDashboard as ReportPayload,
      };
    },
    staleTime: 300_000,
    gcTime: 1_800_000,
    refetchOnWindowFocus: false,
    placeholderData: (previous) => previous,
    refetchInterval: 15_000,
  });

  const metrics = useMemo(() => {
    const logoSummary = getSummary(reportsQuery.data?.logoDashboard ?? null);

    return {
      totalReceivable: toNumber(logoSummary?.logo_balance_total) ?? 0,
      openOrderTotal: toNumber(logoSummary?.logo_order_due_total) ?? 0,
      collectedTotal: toNumber(logoSummary?.logo_collections_total) ?? 0,
      collectedCount: Math.max(0, Math.round(toNumber(logoSummary?.logo_collections_count) ?? 0)),
      salesTotal: toNumber(logoSummary?.logo_sales_total) ?? 0,
      salesCount: Math.max(0, Math.round(toNumber(logoSummary?.logo_sales_count) ?? 0)),
      supplierDebtTotal: Math.max(0, toNumber(logoSummary?.logo_supplier_debt_total) ?? 0),
      supplierCount: Math.max(0, Math.round(toNumber(logoSummary?.logo_suppliers_total) ?? 0)),
      customerCount: Math.max(0, toNumber(logoSummary?.logo_customers_total) ?? 0),
      activeCustomerCount: Math.max(0, toNumber(logoSummary?.logo_active_customers_total) ?? 0),
      productCount: Math.max(0, toNumber(logoSummary?.logo_products_total) ?? 0),
      stockedProductCount: Math.max(0, toNumber(logoSummary?.logo_stocked_products_total) ?? 0),
      logoLastSyncedAt: typeof logoSummary?.logo_last_synced_at === "string" ? logoSummary.logo_last_synced_at : null,
    };
  }, [reportsQuery.data]);

  const collectionsByMethod = useMemo<ChartItem[]>(() => {
    const rows = getDataArray(reportsQuery.data?.logoDashboard ?? null, "method_breakdown");

    return rows
      .map((row) => {
        const method = typeof row.method === "string" ? formatMethodLabel(row.method) : null;
        const total = Math.max(0, toNumber(row.total) ?? 0);
        if (!method || total <= 0) {
          return null;
        }
        return { label: method, value: total };
      })
      .filter((entry): entry is ChartItem => entry !== null)
      .sort((a, b) => b.value - a.value)
      .slice(0, 4);
  }, [reportsQuery.data?.logoDashboard]);

  const salesRows = useMemo(() => {
    const rows = getDataArray(reportsQuery.data?.logoDashboard ?? null, "sales_breakdown");
    const parsed = rows
      .map((row) => {
        const name = extractSalesLabel(row);
        const orderCount = Math.max(0, Math.round(toNumber(row.order_count) ?? 0));
        const quantityTotal = Math.max(0, Math.round(toNumber(row.quantity_total) ?? 0));
        const netTotal = Math.max(0, toNumber(row.net_total) ?? 0);
        const taxTotal = Math.max(0, toNumber(row.tax_total) ?? 0);

        if (!name || netTotal <= 0) {
          return null;
        }

        return { name, orderCount, quantityTotal, netTotal, taxTotal };
      })
      .filter(
        (
          entry
        ): entry is {
          name: string;
          orderCount: number;
          quantityTotal: number;
          netTotal: number;
          taxTotal: number;
        } => entry !== null
      )
      .sort((a, b) => b.netTotal - a.netTotal);

    const totalNet = parsed.reduce((sum, row) => sum + row.netTotal, 0);

    return parsed.map((row) => ({
      ...row,
      share: totalNet > 0 ? (row.netTotal / totalNet) * 100 : 0,
    }));
  }, [reportsQuery.data?.logoDashboard]);

  const topCollectionMethod = collectionsByMethod[0];
  const topSalesCustomer = salesRows[0];
  const supplierDebtRows = useMemo(
    () => getSupplierDebtRows(reportsQuery.data?.logoDashboard ?? null),
    [reportsQuery.data?.logoDashboard]
  );
  const topSupplierDebt = supplierDebtRows[0];

  const salespersonBalanceRows = useMemo(
    () => getSalespersonBalanceRows(reportsQuery.data?.logoDashboard ?? null),
    [reportsQuery.data?.logoDashboard]
  );

  const collectionTrend = useMemo(
    () => getDailyTrendRows(reportsQuery.data?.logoDashboard ?? null, "daily_breakdown", "collection_count"),
    [reportsQuery.data?.logoDashboard]
  );
  const salesTrend = useMemo(
    () => getDailyTrendRows(reportsQuery.data?.logoDashboard ?? null, "daily_sales_breakdown", "sales_count"),
    [reportsQuery.data?.logoDashboard]
  );
  const maxCollectionTrend = Math.max(...collectionTrend.map((row) => row.value), 1);
  const maxSalesTrend = Math.max(...salesTrend.map((row) => row.value), 1);
  const recentTransactions = useMemo(
    () => getRecentTransactionRows(reportsQuery.data?.logoDashboard ?? null),
    [reportsQuery.data?.logoDashboard]
  );
  const syncRows = useMemo(
    () => getSyncRows(reportsQuery.data?.logoDashboard ?? null),
    [reportsQuery.data?.logoDashboard]
  );
  const syncGapRows = useMemo(
    () => getSyncGapRows(reportsQuery.data?.logoDashboard ?? null),
    [reportsQuery.data?.logoDashboard]
  );
  const financeScale = Math.max(metrics.totalReceivable, metrics.collectedTotal, metrics.openOrderTotal, metrics.salesTotal, 1);
  const logoSyncedLabel = formatDateTimeShort(metrics.logoLastSyncedAt);

  return (
    <div className="admin-control-panel mx-auto w-full max-w-[1620px] space-y-4 text-slate-100">
      <section className="admin-overview-grid grid gap-3 rounded-[18px] border border-slate-700/60 bg-[linear-gradient(135deg,#081a21_0%,#0b1621_100%)] p-3 shadow-[0_20px_58px_-50px_rgba(0,0,0,0.84)] xl:grid-cols-[minmax(0,0.86fr)_minmax(360px,0.5fr)]">
        <div className="admin-control-hero relative min-h-[168px] overflow-hidden rounded-[15px] border border-emerald-400/24 bg-[radial-gradient(circle_at_72%_42%,rgba(132,204,22,0.16),transparent_29%),linear-gradient(120deg,#0b2d1b_0%,#0c291a_48%,#0b1f28_100%)] p-6">
          <div className="relative z-10 max-w-[390px]">
            <p className="text-[0.68rem] font-black uppercase tracking-[0.14em] text-lime-200">Powersa Filter</p>
            <h2 className="mt-3 max-w-[370px] text-[clamp(1.55rem,2vw,2.25rem)] font-black leading-[1.03] tracking-tight text-white">
              Bayi Otomasyon Satış Sistemi
              <span className="mt-2 block text-[clamp(2.25rem,3.2vw,3.55rem)] leading-none tracking-[0.08em] text-lime-200">
                BOSS
              </span>
            </h2>
            <Button
              asChild
              variant="outline"
              className="mt-3 h-10 rounded-[10px] border-emerald-300/35 bg-white/8 px-3.5 text-sm font-black text-white hover:bg-emerald-300/14 hover:text-white"
            >
              <a href="https://powersafilter.com" target="_blank" rel="noreferrer">
                PowersaFilter.com
                <ArrowRight className="h-4 w-4" />
              </a>
            </Button>
          </div>
          <Image
            src="/brand/powersa-mascot.png"
            alt="Powersa maskot"
            width={520}
            height={520}
            priority
            quality={80}
            sizes="(max-width: 768px) 220px, (max-width: 1200px) 320px, 520px"
            className="absolute bottom-[-66px] right-[1%] z-0 hidden h-[335px] w-[335px] object-contain drop-shadow-[0_18px_26px_rgba(0,0,0,0.38)] md:block xl:right-[3%]"
          />
        </div>

        <div className="admin-shortcut-group rounded-[15px] border border-slate-700/70 bg-[linear-gradient(180deg,rgba(20,32,44,0.78)_0%,rgba(10,20,31,0.9)_100%)] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
          <div className="mb-2 flex items-center justify-between gap-3 px-1">
            <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-300">Hızlı Yönetim</p>
            <span className="rounded-full border border-slate-600/70 bg-white/5 px-2 py-1 text-[0.68rem] font-black text-slate-400">
              Logo: {logoSyncedLabel}
            </span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            {[
              { href: "/warehouse", title: "Şubeler", value: "Ambar ve sevkiyat", icon: Building2, tone: "text-emerald-200 bg-emerald-300/12 border-emerald-300/20" },
              { href: "/search", title: "Stoklu Ürün", value: `${formatCount(Math.round(metrics.stockedProductCount))} kayıt`, icon: Box, tone: "text-yellow-200 bg-yellow-300/12 border-yellow-300/20" },
              { href: "/customers", title: "Müşteriler", value: `${formatCount(Math.round(metrics.customerCount))} kayıt`, icon: Users, tone: "text-violet-200 bg-violet-300/12 border-violet-300/20" },
              { href: "/orders", title: "Sipariş", value: formatMoneyCompact(metrics.openOrderTotal), icon: ShoppingCart, tone: "text-orange-200 bg-orange-300/12 border-orange-300/20" },
            ].map((item) => {
              const Icon = item.icon;

              return (
                <Link
                  href={item.href}
                  key={item.title}
                  className="admin-shortcut-card group flex min-h-[72px] items-center gap-3 rounded-[13px] border border-slate-700/65 bg-[linear-gradient(135deg,rgba(26,39,51,0.78)_0%,rgba(12,23,35,0.88)_100%)] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] transition hover:-translate-y-0.5 hover:border-slate-500/90 hover:bg-slate-800/80"
                >
                  <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border ${item.tone}`}>
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-sm font-black text-white">{item.title}</strong>
                    <span className="mt-1 block truncate text-xs font-semibold text-slate-300">
                      {item.value}
                    </span>
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-slate-400 transition group-hover:translate-x-1 group-hover:text-slate-200" />
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
        {[
          {
            title: "Cari Bakiye Durumu",
            subtitle: "Toplam cari bakiye",
            value: formatMoneyCompact(metrics.totalReceivable),
            note: `${formatCount(Math.round(metrics.customerCount))} Logo carisi · sync ${logoSyncedLabel}`,
            icon: CreditCard,
            accent: "emerald",
            className: "border-emerald-300/30 bg-[linear-gradient(135deg,rgba(8,70,52,0.54)_0%,rgba(9,22,29,0.96)_100%)] text-emerald-200",
            bar: "from-emerald-400 via-emerald-400 to-red-400",
            progress: Math.max(4, Math.round((metrics.totalReceivable / financeScale) * 100)),
          },
          {
            title: "Tahsilat Toplamı",
            subtitle: "Bu ay tahsilat",
            value: formatMoneyCompact(metrics.collectedTotal),
            note: `${formatCount(metrics.collectedCount)} tahsilat hareketi${topCollectionMethod ? ` · ${topCollectionMethod.label}` : ""}`,
            icon: HandCoins,
            accent: "amber",
            className: "border-yellow-300/30 bg-[linear-gradient(135deg,rgba(82,58,18,0.52)_0%,rgba(13,20,26,0.96)_100%)] text-yellow-200",
            bar: "from-amber-300 to-amber-400",
            progress: Math.max(4, Math.round((metrics.collectedTotal / financeScale) * 100)),
          },
          {
            title: "Sipariş Durumu",
            subtitle: "Logo sipariş bakiyesi",
            value: formatMoneyCompact(metrics.openOrderTotal),
            note: "Logo carilerindeki açık sipariş bakiyesi",
            icon: ShoppingCart,
            accent: "sky",
            className: "border-sky-300/30 bg-[linear-gradient(135deg,rgba(11,76,117,0.5)_0%,rgba(9,21,32,0.96)_100%)] text-sky-200",
            bar: "from-sky-400 to-cyan-300",
            progress: Math.max(4, Math.round((metrics.openOrderTotal / financeScale) * 100)),
          },
          {
            title: "Satış Toplamı",
            subtitle: "Bu ay toplam satış",
            value: formatMoneyCompact(metrics.salesTotal),
            note: `${formatCount(metrics.salesCount)} Logo satış hareketi${topSalesCustomer ? ` · ${topSalesCustomer.name}` : ""}`,
            icon: BarChart3,
            accent: "violet",
            className: "border-violet-300/30 bg-[linear-gradient(135deg,rgba(71,52,130,0.5)_0%,rgba(16,20,34,0.96)_100%)] text-fuchsia-200",
            bar: "from-violet-400 to-fuchsia-300",
            progress: Math.max(4, Math.round((metrics.salesTotal / financeScale) * 100)),
          },
        ].map((card) => {
          const Icon = card.icon;

          return (
            <article key={card.title} className={`admin-finance-card min-h-[165px] rounded-[18px] border p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] ${card.className}`}>
              <div className="flex items-start gap-4">
                <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/10">
                  <Icon className="h-8 w-8" />
                </span>
                <div className="min-w-0">
                  <h3 className="truncate text-lg font-black text-white">{card.title}</h3>
                  <p className="mt-1 text-sm font-semibold text-slate-300">{card.subtitle}</p>
                </div>
              </div>
              <p className="mt-5 text-[2.65rem] font-black leading-none tracking-tight">{card.value}</p>
              <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-slate-700/70">
                <div className={`h-full rounded-full bg-gradient-to-r ${card.bar}`} style={{ width: `${Math.min(100, card.progress)}%` }} />
              </div>
              <p className="mt-3 text-sm font-semibold text-slate-300">{card.note}</p>
            </article>
          );
        })}
      </section>

      <section className="grid gap-4 xl:grid-cols-[1fr_1.08fr_1.12fr]">
        <Card className="admin-report-card border-slate-700/80 bg-[linear-gradient(180deg,rgba(13,27,39,0.98)_0%,rgba(7,17,27,0.98)_100%)] text-slate-100">
          <CardContent className="p-5">
            <div className="mb-5 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-xl font-black">Tahsilat Raporu</h3>
                <p className="text-sm font-semibold text-slate-400">Logo günlük tahsilat hareketleri</p>
              </div>
              <span className="rounded-[10px] border border-slate-700 px-3 py-2 text-xs font-black">{formatCount(metrics.collectedCount)} kayıt</span>
            </div>
            {collectionTrend.length > 0 ? (
              <>
                <div className="flex h-[154px] items-end gap-5 border-b border-slate-700/80 px-4">
                  {collectionTrend.map((row) => (
                    <div className="flex flex-1 flex-col items-center gap-2" key={row.label}>
                      <span
                        className="w-full rounded-t-[4px] bg-[linear-gradient(180deg,#4ade80_0%,rgba(34,197,94,0.35)_100%)] shadow-[0_0_22px_rgba(74,222,128,0.16)]"
                        style={{ height: `${Math.max(18, (row.value / maxCollectionTrend) * 126)}px` }}
                      />
                    </div>
                  ))}
                </div>
                <div className="mt-3 grid text-center text-xs font-semibold text-slate-300" style={{ gridTemplateColumns: `repeat(${collectionTrend.length}, minmax(0, 1fr))` }}>
                  {collectionTrend.map((row) => <span key={row.label}>{row.label.split(" · ")[0]}</span>)}
                </div>
              </>
            ) : (
              <div className="flex h-[190px] items-center justify-center rounded-[14px] border border-slate-700/70 bg-slate-950/30 text-sm font-semibold text-slate-400">
                Seçili tarih aralığında Logo tahsilat hareketi yok.
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="admin-report-card border-slate-700/80 bg-[linear-gradient(180deg,rgba(13,27,39,0.98)_0%,rgba(7,17,27,0.98)_100%)] text-slate-100">
          <CardContent className="p-5">
            <div className="mb-5 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-xl font-black">Satış Performansı</h3>
                <p className="text-sm font-semibold text-slate-400">Logo günlük satış hareketleri</p>
              </div>
              <span className="rounded-[10px] border border-slate-700 px-3 py-2 text-xs font-black">{formatCount(metrics.salesCount)} kayıt</span>
            </div>
            {salesTrend.length > 0 ? (
              <>
                <svg viewBox="0 0 520 160" className="h-[170px] w-full overflow-visible">
                  <defs>
                    <linearGradient id="adminSalesFill" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.38" />
                      <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  {[36, 68, 52, 84, 28].map((y) => (
                    <line key={y} x1="0" x2="520" y1={y} y2={y} stroke="rgba(148,163,184,0.13)" strokeDasharray="4 4" />
                  ))}
                  <polyline
                    points={salesTrend.map((row, index) => {
                      const x = salesTrend.length === 1 ? 260 : index * (520 / (salesTrend.length - 1));
                      return `${x},${148 - (row.value / maxSalesTrend) * 118}`;
                    }).join(" ")}
                    fill="none"
                    stroke="#38bdf8"
                    strokeWidth="4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <polygon
                    points={`0,160 ${salesTrend.map((row, index) => {
                      const x = salesTrend.length === 1 ? 260 : index * (520 / (salesTrend.length - 1));
                      return `${x},${148 - (row.value / maxSalesTrend) * 118}`;
                    }).join(" ")} 520,160`}
                    fill="url(#adminSalesFill)"
                  />
                  {salesTrend.map((row, index) => {
                    const x = salesTrend.length === 1 ? 260 : index * (520 / (salesTrend.length - 1));
                    return <circle key={row.label} cx={x} cy={148 - (row.value / maxSalesTrend) * 118} r="6" fill="#38bdf8" />;
                  })}
                </svg>
                <div className="grid text-center text-xs font-semibold text-slate-300" style={{ gridTemplateColumns: `repeat(${salesTrend.length}, minmax(0, 1fr))` }}>
                  {salesTrend.map((row) => <span key={row.label}>{row.label.split(" · ")[0]}</span>)}
                </div>
              </>
            ) : (
              <div className="flex h-[190px] items-center justify-center rounded-[14px] border border-slate-700/70 bg-slate-950/30 text-sm font-semibold text-slate-400">
                Seçili tarih aralığında Logo satış hareketi yok.
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="admin-report-card border-slate-700/80 bg-[linear-gradient(180deg,rgba(13,27,39,0.98)_0%,rgba(7,17,27,0.98)_100%)] text-slate-100">
          <CardContent className="p-5">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-xl font-black">Tedarikçilere Borç</h3>
                <p className="text-sm font-semibold text-slate-400">Toplam borç durumu</p>
              </div>
              <Button asChild variant="outline" className="h-10 rounded-[10px] border-slate-700 bg-transparent text-slate-100 hover:bg-white/5 hover:text-white">
                <Link href="/reports">Detaylar <ArrowRight className="h-4 w-4" /></Link>
              </Button>
            </div>
            <div className="grid gap-5 sm:grid-cols-[150px_minmax(0,1fr)] sm:items-center">
              <div className="mx-auto h-[138px] w-[138px] rounded-full p-[16px]" style={{ background: "conic-gradient(#f97316 0 68%, #1f2937 68% 100%)" }}>
                <div className="flex h-full w-full items-center justify-center rounded-full bg-[#07111b] text-sky-300">
                  <Truck className="h-10 w-10" />
                </div>
              </div>
              <div>
                <p className="text-[2.35rem] font-black leading-none text-amber-300">{formatMoneyCompact(metrics.supplierDebtTotal)}</p>
                <p className="mt-2 text-sm font-semibold text-slate-300">Toplam Borç</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <span className="rounded-[12px] border border-slate-700 bg-slate-900/55 p-3">
                    <span className="block text-xs font-semibold text-slate-400">Tedarikçi</span>
                    <strong className="mt-1 block text-lg font-black text-white">{formatCount(metrics.supplierCount)}</strong>
                  </span>
                  <span className="rounded-[12px] border border-slate-700 bg-slate-900/55 p-3">
                    <span className="block text-xs font-semibold text-slate-400">En yüksek</span>
                    <strong className="mt-1 block truncate text-lg font-black text-white">{topSupplierDebt?.title ?? "Kayıt yok"}</strong>
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-[270px_270px_minmax(0,1fr)]">
        <Card className="admin-small-stat border-cyan-500/30 bg-[linear-gradient(135deg,rgba(7,89,133,0.36)_0%,rgba(7,17,27,0.98)_100%)] text-slate-100">
          <CardContent className="flex min-h-[164px] flex-col justify-between p-5">
            <span>
              <h3 className="text-lg font-black">Toplam Cari</h3>
              <p className="text-sm font-semibold text-slate-400">Aktif cari sayısı</p>
            </span>
            <strong className="text-[2.6rem] font-black leading-none text-cyan-300">{formatCount(Math.round(metrics.customerCount))}</strong>
            <p className="text-sm font-semibold text-cyan-200">{formatCount(Math.round(metrics.activeCustomerCount))} aktif cari</p>
          </CardContent>
        </Card>

        <Card className="admin-small-stat border-violet-500/30 bg-[linear-gradient(135deg,rgba(88,28,135,0.42)_0%,rgba(7,17,27,0.98)_100%)] text-slate-100">
          <CardContent className="flex min-h-[164px] flex-col justify-between p-5">
            <span>
              <h3 className="text-lg font-black">Toplam Ürün</h3>
              <p className="text-sm font-semibold text-slate-400">Ürün çeşidi</p>
            </span>
            <strong className="text-[2.6rem] font-black leading-none text-fuchsia-300">{formatCount(Math.round(metrics.productCount))}</strong>
            <p className="text-sm font-semibold text-violet-200">{formatCount(Math.round(metrics.stockedProductCount))} stoklu ürün</p>
          </CardContent>
        </Card>

        <Card className="admin-report-card border-slate-700/80 bg-[linear-gradient(180deg,rgba(13,27,39,0.98)_0%,rgba(7,17,27,0.98)_100%)] text-slate-100">
          <CardContent className="p-5">
            <div className="mb-4">
              <h3 className="text-xl font-black">Son İşlemler</h3>
              <p className="text-sm font-semibold text-slate-400">En son gerçekleşen işlemler</p>
            </div>
            <div className="overflow-hidden rounded-[12px] border border-slate-700/80">
              <div className="grid grid-cols-[1fr_1fr_1.2fr_120px] bg-white/5 px-4 py-2 text-xs font-black uppercase tracking-[0.1em] text-slate-400">
                <span>Tarih</span>
                <span>Tip</span>
                <span>İlgili</span>
                <span className="text-right">Tutar</span>
              </div>
              {recentTransactions.length > 0 ? (
                recentTransactions.map((row) => (
                  <div key={row.id} className="grid grid-cols-[1fr_1fr_1.2fr_120px] border-t border-slate-700/70 px-4 py-2 text-sm font-semibold">
                    <span className="flex items-center gap-2"><i className={`h-2 w-2 rounded-full ${row.tone}`} /> {formatShortDate(row.date)}</span>
                    <span>{row.type}</span>
                    <span className="truncate">{row.related}</span>
                    <span className="text-right">{formatMoneyCompact(row.amount)}</span>
                  </div>
                ))
              ) : (
                <div className="border-t border-slate-700/70 px-4 py-8 text-center text-sm font-semibold text-slate-400">
                  Seçili tarih aralığında Logo cari hareketi yok.
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </section>

      <LogoBridgeDetails rows={syncRows} gaps={syncGapRows} loading={reportsQuery.isFetching} />
    </div>
  );
}
