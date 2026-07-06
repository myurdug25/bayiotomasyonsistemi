"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowRight,
  BarChart3,
  FileDown,
  FileSpreadsheet,
  Loader2,
  RefreshCcw,
  RotateCcw,
  ShoppingCart,
  TrendingUp,
  Wallet,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  getReportCollections,
  getReportCustomerBalances,
  getReportOrderBalances,
  getReportSales,
  type ReportQueueResponse,
} from "@/lib/api";
import { useSession } from "@/components/auth/session-provider";

type ReportKey = "customer" | "order" | "collection" | "sales";
type ReportPayload = Record<string, unknown> | null;
type CustomerFilterOption = { id: number; label: string };
type DetailView = "balances" | "orders" | "collections" | "customers";
type DatePreset = "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month" | "three_months" | "six_months" | "one_year";

const REPORT_KEYS: ReportKey[] = ["customer", "order", "collection", "sales"];
const DATE_PRESETS: Array<{ key: DatePreset; label: string }> = [
  { key: "today", label: "Bugün" },
  { key: "yesterday", label: "Dün" },
  { key: "this_week", label: "Bu Hafta" },
  { key: "last_week", label: "Geçen Hafta" },
  { key: "this_month", label: "Bu Ay" },
  { key: "last_month", label: "Geçen Ay" },
  { key: "three_months", label: "Son 3 Ay" },
  { key: "six_months", label: "Son 6 Ay" },
  { key: "one_year", label: "Son 1 Yıl" },
];

function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function currentMonthRange() {
  const today = new Date();
  return {
    from: toDateInputValue(new Date(today.getFullYear(), today.getMonth(), 1)),
    to: toDateInputValue(today),
  };
}

function dateRangeForPreset(preset: DatePreset): { from: string; to: string } {
  const today = new Date();
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const ranges: Record<DatePreset, { from: Date; to: Date }> = {
    today: { from: today, to: today },
    yesterday: { from: yesterday, to: yesterday },
    this_week: { from: startOfWeek, to: today },
    last_week: {
      from: new Date(startOfWeek.getFullYear(), startOfWeek.getMonth(), startOfWeek.getDate() - 7),
      to: new Date(startOfWeek.getFullYear(), startOfWeek.getMonth(), startOfWeek.getDate() - 1),
    },
    this_month: { from: new Date(today.getFullYear(), today.getMonth(), 1), to: today },
    last_month: {
      from: new Date(today.getFullYear(), today.getMonth() - 1, 1),
      to: new Date(today.getFullYear(), today.getMonth(), 0),
    },
    three_months: { from: new Date(today.getFullYear(), today.getMonth() - 3, today.getDate()), to: today },
    six_months: { from: new Date(today.getFullYear(), today.getMonth() - 6, today.getDate()), to: today },
    one_year: { from: new Date(today.getFullYear() - 1, today.getMonth(), today.getDate()), to: today },
  };

  return {
    from: toDateInputValue(ranges[preset].from),
    to: toDateInputValue(ranges[preset].to),
  };
}

function hasRun(payload: unknown): payload is ReportQueueResponse {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      "run" in payload &&
      typeof (payload as { run?: { id?: unknown } }).run?.id === "number"
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function parseNumericLike(value: string | number | boolean): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const source = String(value).trim();
  if (!source) {
    return null;
  }

  const cleaned = source.replace(/\s/g, "");
  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");
  let normalized = cleaned;

  if (hasComma && hasDot) {
    normalized =
      cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")
        ? cleaned.replace(/\./g, "").replace(",", ".")
        : cleaned.replace(/,/g, "");
  } else if (hasComma && !hasDot) {
    normalized = cleaned.replace(",", ".");
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function isMoneyKey(key: string): boolean {
  return /(total|due|amount|balance|subtotal|tax|vat)/i.test(key) && !/count|quantity/i.test(key);
}

function formatMetricValue(
  key: string,
  value: string | number | boolean,
  currency: string
): string {
  if (typeof value === "boolean") {
    return value ? "Evet" : "Hayır";
  }

  const parsed = parseNumericLike(value);
  if (parsed === null) {
    const text = String(value).trim();
    return text.length > 58 ? `${text.slice(0, 55)}...` : text;
  }

  if (isMoneyKey(key)) {
    const suffix = currency.toUpperCase() === "TRY" ? "₺" : currency;
    return `${parsed.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${suffix}`;
  }

  return parsed.toLocaleString("tr-TR", { maximumFractionDigits: 2 });
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) {
    return "-";
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleString("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function extractPreviewRows(key: ReportKey, payload: ReportPayload, limit = 6): Array<Record<string, string>> {
  const root = asRecord(payload);
  const rows = root && Array.isArray(root.data) ? root.data : [];

  return rows
    .slice(0, limit)
    .map((row) => {
      const record = asRecord(row);
      if (!record) {
        return null;
      }

      if (key === "customer") {
        return {
          Cari: [record.code, record.title].filter(Boolean).join(" - ") || "-",
          Bakiye: isPrimitive(record.balance) ? formatMetricValue("balance", record.balance, "TRY") : "-",
          "Vade Geçen": isPrimitive(record.overdue_total) ? formatMetricValue("overdue_total", record.overdue_total, "TRY") : "-",
        };
      }

      if (key === "order") {
        const customer = asRecord(record.customer);
        const salesperson = asRecord(record.salesperson);
        return {
          Sipariş: typeof record.order_no === "string" ? record.order_no : "-",
          Cari: typeof customer?.title === "string" ? customer.title : "-",
          Pazarlamacı: typeof salesperson?.name === "string" ? salesperson.name : "Atanmamış",
          Durum: typeof record.status === "string" ? record.status : "-",
          Tutar: isPrimitive(record.grand_total) ? formatMetricValue("grand_total", record.grand_total, "TRY") : "-",
          Tarih: typeof record.ordered_at === "string" ? record.ordered_at.slice(0, 10) : "-",
          Logo: typeof record.logo_sync_status === "string" ? record.logo_sync_status : "kayıt yok",
        };
      }

      if (key === "collection") {
        const customer = asRecord(record.customer);
        return {
          Cari: typeof customer?.title === "string" ? customer.title : "-",
          Yöntem: typeof record.method === "string" ? record.method : "-",
          Tutar: isPrimitive(record.amount) ? formatMetricValue("amount", record.amount, "TRY") : "-",
          Tarih: typeof record.date === "string" ? record.date : "-",
        };
      }

      const product = asRecord(record.product);
      const customer = asRecord(record.customer);
      const brand = asRecord(record.brand);
      const label =
        (typeof product?.name === "string" && product.name) ||
        (typeof brand?.name === "string" && brand.name) ||
        (typeof customer?.title === "string" && customer.title) ||
        "-";

      return {
        Kırılım: label,
        Sipariş: isPrimitive(record.order_count) ? formatMetricValue("order_count", record.order_count, "TRY") : "-",
        Adet: isPrimitive(record.quantity_total) ? formatMetricValue("quantity_total", record.quantity_total, "TRY") : "-",
        Tutar: isPrimitive(record.net_total) ? formatMetricValue("net_total", record.net_total, "TRY") : "-",
      };
    })
    .filter((row) => row !== null) as Array<Record<string, string>>;
}

function extractCustomerFilterOptions(...payloads: ReportPayload[]): CustomerFilterOption[] {
  const options = new Map<number, string>();

  payloads.forEach((payload) => {
    const root = asRecord(payload);
    const rows = root && Array.isArray(root.data) ? root.data : [];

    rows.forEach((row) => {
      const record = asRecord(row);
      if (!record) {
        return;
      }

      const nestedCustomer = asRecord(record.customer);
      const rawId = record.customer_id ?? nestedCustomer?.id;
      const id = typeof rawId === "number" ? rawId : typeof rawId === "string" ? Number(rawId) : null;

      if (!id || !Number.isFinite(id)) {
        return;
      }

      const code = typeof record.code === "string" ? record.code : typeof nestedCustomer?.code === "string" ? nestedCustomer.code : "";
      const title =
        typeof record.title === "string"
          ? record.title
          : typeof nestedCustomer?.title === "string"
            ? nestedCustomer.title
            : "Cari";
      const label = [code, title].filter(Boolean).join(" - ");

      if (!options.has(id)) {
        options.set(id, label);
      }
    });
  });

  return Array.from(options, ([id, label]) => ({ id, label })).sort((left, right) =>
    left.label.localeCompare(right.label, "tr")
  );
}

function getNestedRecord(payload: ReportPayload, path: string[]): Record<string, unknown> | null {
  let current: unknown = payload;

  for (const key of path) {
    const record = asRecord(current);
    if (!record) {
      return null;
    }
    current = record[key];
  }

  return asRecord(current);
}

function getPayloadRows(payload: ReportPayload, key: string): Record<string, unknown>[] {
  const root = asRecord(payload);
  const rows = root && Array.isArray(root[key]) ? root[key] : [];

  return rows.map(asRecord).filter((row): row is Record<string, unknown> => row !== null);
}

function percentOf(value: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, (value / total) * 100));
}

function methodLabel(method: string): string {
  const labels: Record<string, string> = {
    cash: "Nakit",
    transfer: "Havale/EFT",
    check: "Çek",
    note: "Senet",
    cc: "POS",
    factory_cc: "Fabrika Kart",
  };

  return labels[method] ?? method.toUpperCase();
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "Bekliyor",
    approved: "Onaylandı",
    preparing: "Hazırlanıyor",
    shipped: "Sevk Edildi",
    delivered: "Teslim Edildi",
    completed: "Tamamlandı",
    cancelled: "İptal",
  };

  return labels[status] ?? status;
}

function extractSalesBars(payload: ReportPayload): Array<{ label: string; value: number; formatted: string }> {
  return extractPreviewRows("sales", payload)
    .map((row) => {
      const value = parseNumericLike(row.Tutar ?? "0") ?? 0;
      return {
        label: row.Kırılım ?? row.Cari ?? "Kırılım",
        value,
        formatted: row.Tutar ?? "0,00 ₺",
      };
    })
    .filter((row) => row.value > 0)
    .slice(0, 6);
}

function extractCollectionDailyBars(payload: ReportPayload): Array<{ label: string; value: number; formatted: string }> {
  return getPayloadRows(payload, "daily_breakdown")
    .map((row) => {
      const date = typeof row.date === "string" ? row.date.slice(5) : "-";
      const value = isPrimitive(row.total) ? parseNumericLike(row.total) ?? 0 : 0;

      return {
        label: date,
        value,
        formatted: formatMetricValue("total", value, "TRY"),
      };
    })
    .filter((row) => row.value > 0)
    .slice(-12);
}

function extractCollectionMethodRows(payload: ReportPayload): Array<{ label: string; value: number; formatted: string; percent: number; color: string }> {
  const colors = ["#4ade80", "#60a5fa", "#f97316", "#fbbf24", "#a855f7", "#ef4444"];
  const rows = getPayloadRows(payload, "method_breakdown")
    .map((row, index) => {
      const value = isPrimitive(row.total) ? parseNumericLike(row.total) ?? 0 : 0;
      const method = typeof row.method === "string" ? row.method : "-";

      return {
        label: methodLabel(method),
        value,
        formatted: formatMetricValue("total", value, "TRY"),
        percent: 0,
        color: colors[index % colors.length],
      };
    })
    .filter((row) => row.value > 0);

  const total = rows.reduce((sum, row) => sum + row.value, 0);

  return rows.map((row) => ({ ...row, percent: percentOf(row.value, total) }));
}

type CollectorPerformanceRow = {
  id: number;
  name: string;
  total: string;
  cash: string;
  card: string;
  pos: string;
  factoryCard: string;
  transfer: string;
  check: string;
  note: string;
  customerCount: number;
  transactionCount: number;
  average: string;
  lastDate: string;
};

function extractCollectorRows(payload: ReportPayload): CollectorPerformanceRow[] {
  return getPayloadRows(payload, "collector_breakdown").map((row) => ({
    id: typeof row.user_id === "number" ? row.user_id : Number(row.user_id),
    name: typeof row.user_name === "string" ? row.user_name : "Atanmamış",
    total: isPrimitive(row.total) ? formatMetricValue("total", row.total, "TRY") : "0,00 ₺",
    cash: isPrimitive(row.cash_total) ? formatMetricValue("total", row.cash_total, "TRY") : "0,00 ₺",
    card: isPrimitive(row.card_total) ? formatMetricValue("total", row.card_total, "TRY") : "0,00 ₺",
    pos: isPrimitive(row.pos_total) ? formatMetricValue("total", row.pos_total, "TRY") : "0,00 ₺",
    factoryCard: isPrimitive(row.factory_card_total) ? formatMetricValue("total", row.factory_card_total, "TRY") : "0,00 ₺",
    transfer: isPrimitive(row.transfer_total) ? formatMetricValue("total", row.transfer_total, "TRY") : "0,00 ₺",
    check: isPrimitive(row.check_total) ? formatMetricValue("total", row.check_total, "TRY") : "0,00 ₺",
    note: isPrimitive(row.note_total) ? formatMetricValue("total", row.note_total, "TRY") : "0,00 ₺",
    customerCount: isPrimitive(row.customer_count) ? parseNumericLike(row.customer_count) ?? 0 : 0,
    transactionCount: isPrimitive(row.collection_count) ? parseNumericLike(row.collection_count) ?? 0 : 0,
    average: isPrimitive(row.average) ? formatMetricValue("total", row.average, "TRY") : "0,00 ₺",
    lastDate: typeof row.last_collection_date === "string" ? row.last_collection_date.slice(0, 10) : "-",
  }));
}

function extractCollectionCustomerRows(payload: ReportPayload): Array<Record<string, string>> {
  return getPayloadRows(payload, "customer_breakdown").map((row) => ({
    Cari: [row.customer_code, row.customer_title].filter((value) => typeof value === "string" && value).join(" - ") || "-",
    Toplam: isPrimitive(row.total) ? formatMetricValue("total", row.total, "TRY") : "0,00 ₺",
    Nakit: isPrimitive(row.cash_total) ? formatMetricValue("total", row.cash_total, "TRY") : "0,00 ₺",
    Kart: isPrimitive(row.card_total) ? formatMetricValue("total", row.card_total, "TRY") : "0,00 ₺",
    POS: isPrimitive(row.pos_total) ? formatMetricValue("total", row.pos_total, "TRY") : "0,00 ₺",
    "Fabrika Kart": isPrimitive(row.factory_card_total) ? formatMetricValue("total", row.factory_card_total, "TRY") : "0,00 ₺",
    Havale: isPrimitive(row.transfer_total) ? formatMetricValue("total", row.transfer_total, "TRY") : "0,00 ₺",
    Çek: isPrimitive(row.check_total) ? formatMetricValue("total", row.check_total, "TRY") : "0,00 ₺",
    Senet: isPrimitive(row.note_total) ? formatMetricValue("total", row.note_total, "TRY") : "0,00 ₺",
    İşlem: isPrimitive(row.collection_count) ? String(parseNumericLike(row.collection_count) ?? 0) : "0",
    "Son İşlem": typeof row.last_collection_date === "string" ? row.last_collection_date.slice(0, 10) : "-",
  }));
}

function extractMonthlyCollectionRows(payload: ReportPayload): Array<{ label: string; value: number; count: number; average: string }> {
  return getPayloadRows(payload, "monthly_breakdown").map((row) => ({
    label: typeof row.month === "string" ? row.month : "-",
    value: isPrimitive(row.total) ? parseNumericLike(row.total) ?? 0 : 0,
    count: isPrimitive(row.collection_count) ? parseNumericLike(row.collection_count) ?? 0 : 0,
    average: isPrimitive(row.average) ? formatMetricValue("total", row.average, "TRY") : "0,00 ₺",
  }));
}

function extractCollectionTransactions(payload: ReportPayload): Array<{
  id: number;
  collectorId: number | null;
  date: string;
  collector: string;
  customer: string;
  method: string;
  amount: string;
  reference: string;
  note: string;
}> {
  return getPayloadRows(payload, "data").map((row) => {
    const collector = asRecord(row.collector);
    const customer = asRecord(row.customer);

    return {
      id: typeof row.collection_id === "number" ? row.collection_id : 0,
      collectorId: typeof collector?.id === "number" ? collector.id : null,
      date: typeof row.date === "string" ? row.date : "-",
      collector: typeof collector?.name === "string" ? collector.name : "Atanmamış",
      customer: [customer?.code, customer?.title].filter((value) => typeof value === "string" && value).join(" - ") || "-",
      method: methodLabel(typeof row.method === "string" ? row.method : "-"),
      amount: isPrimitive(row.amount) ? formatMetricValue("amount", row.amount, typeof row.currency === "string" ? row.currency : "TRY") : "0,00 ₺",
      reference: typeof row.reference_no === "string" && row.reference_no ? row.reference_no : "-",
      note: typeof row.note === "string" && row.note ? row.note : "-",
    };
  });
}

function extractOrderStatusRows(payload: ReportPayload): Array<{ label: string; count: number; total: string; color: string }> {
  const colors = ["bg-emerald-400", "bg-blue-400", "bg-violet-400", "bg-amber-400", "bg-red-400"];

  return getPayloadRows(payload, "status_breakdown")
    .map((row, index) => {
      const status = typeof row.status === "string" ? row.status : "-";
      const count = isPrimitive(row.order_count) ? parseNumericLike(row.order_count) ?? 0 : 0;
      const total = isPrimitive(row.total) ? formatMetricValue("total", row.total, "TRY") : "0,00 ₺";

      return {
        label: statusLabel(status),
        count,
        total,
        color: colors[index % colors.length],
      };
    })
    .filter((row) => row.count > 0);
}

function extractAgingRows(payload: ReportPayload): Array<{ label: string; value: number; formatted: string; percent: number }> {
  const aging = getNestedRecord(payload, ["summary", "aging_totals"]);
  const rows = [
    { key: "0_30", label: "0-30" },
    { key: "31_60", label: "31-60" },
    { key: "60_plus", label: "61+" },
  ].map((bucket) => {
    const value = aging && isPrimitive(aging[bucket.key]) ? parseNumericLike(aging[bucket.key]) ?? 0 : 0;

    return {
      label: bucket.label,
      value,
      formatted: formatMetricValue("balance", value, "TRY"),
      percent: 0,
    };
  });
  const total = rows.reduce((sum, row) => sum + row.value, 0);

  return rows.map((row) => ({ ...row, percent: percentOf(row.value, total) }));
}

function getMetricValue(
  payload: ReportPayload,
  keys: string[],
  fallback = "0,00 ₺"
): string {
  const root = asRecord(payload);
  if (!root) {
    return fallback;
  }

  const summary = asRecord(root.summary);
  const totals = summary ? asRecord(summary.totals) : null;
  const sources = [totals, summary, asRecord(root.totals), root].filter(Boolean) as Array<Record<string, unknown>>;
  const currency = sources.find((source) => typeof source.currency === "string")?.currency;

  for (const key of keys) {
    for (const source of sources) {
      const value = source[key];
      if (isPrimitive(value)) {
        return formatMetricValue(key, value, typeof currency === "string" ? currency : "TRY");
      }
    }
  }

  return fallback;
}

function getMetricNumber(payload: ReportPayload, keys: string[], fallback = 0): number {
  const root = asRecord(payload);
  if (!root) {
    return fallback;
  }

  const summary = asRecord(root.summary);
  const totals = summary ? asRecord(summary.totals) : null;
  const sources = [totals, summary, asRecord(root.totals), root].filter(Boolean) as Array<Record<string, unknown>>;

  for (const key of keys) {
    for (const source of sources) {
      const value = source[key];
      if (typeof value === "number") {
        return Number.isFinite(value) ? value : fallback;
      }
      if (typeof value === "string") {
        const parsed = parseNumericLike(value);
        if (parsed !== null) {
          return parsed;
        }
      }
    }
  }

  return fallback;
}

function MiniLineChart({ color = "#4ade80" }: { color?: string }) {
  return (
    <svg viewBox="0 0 120 54" className="h-16 w-32 opacity-95" aria-hidden="true">
      <defs>
        <linearGradient id={`lineFill-${color.replace("#", "")}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.32" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M3 47 C18 42 20 25 34 28 C43 30 45 9 56 13 C66 17 60 39 75 34 C88 29 90 31 101 21 C109 14 113 12 117 8 L117 54 L3 54 Z" fill={`url(#lineFill-${color.replace("#", "")})`} />
      <path d="M3 47 C18 42 20 25 34 28 C43 30 45 9 56 13 C66 17 60 39 75 34 C88 29 90 31 101 21 C109 14 113 12 117 8" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" />
      <circle cx="101" cy="21" r="4" fill={color} />
    </svg>
  );
}

function MiniBars({ color = "#60a5fa" }: { color?: string }) {
  const heights = [18, 28, 40, 32, 48, 54];
  return (
    <div className="flex h-16 items-end gap-2">
      {heights.map((height, index) => (
        <span
          key={`mini-bar-${index}`}
          className="w-3 rounded-t-md"
          style={{
            height,
            background: `linear-gradient(180deg, ${color}, rgba(255,255,255,0.08))`,
          }}
        />
      ))}
    </div>
  );
}

function RingChart({ value, color, label = "Toplam" }: { value: number; color: string; label?: string }) {
  const normalized = Math.max(0, Math.min(100, value));
  return (
    <div
      className="relative grid h-32 w-32 place-items-center rounded-full"
      style={{
        background: `conic-gradient(${color} ${normalized}%, #23334a ${normalized}% 100%)`,
      }}
    >
      <div className="grid h-20 w-20 place-items-center rounded-full bg-[#071421] text-center shadow-[inset_0_0_22px_rgba(0,0,0,0.45)]">
        <span className="text-xl font-black text-white">{Math.round(value)}</span>
        <span className="-mt-4 text-[11px] font-bold text-[#8aa0b8]">{label}</span>
      </div>
    </div>
  );
}

function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section className={cn("rounded-[18px] border border-[#1d3449] bg-[#071827]/84 p-4 shadow-[0_22px_60px_-48px_rgba(0,0,0,0.8)]", className)}>
      {children}
    </section>
  );
}

function CompactTable({
  rows,
  footerLabel,
  onFooterClick,
}: {
  rows: Array<Record<string, string>>;
  footerLabel: string;
  onFooterClick: () => void;
}) {
  const columns = Object.keys(rows[0] ?? {});

  return (
    <div className="overflow-hidden rounded-xl border border-[#1a3348] bg-[#071522]/80">
      {rows.length === 0 ? (
        <div className="grid min-h-[124px] place-items-center text-sm font-semibold text-[#7890a8]">
          Seçili filtrelerde kayıt bulunamadı.
        </div>
      ) : (
        <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] table-fixed text-left text-[12px]">
          <thead>
            <tr className="border-b border-[#1a3348] bg-[#0b2032] text-[11px] font-black uppercase tracking-[0.1em] text-[#8fa3b8]">
              {columns.map((column) => (
                <th key={column} className="px-3 py-2.5">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 5).map((row, rowIndex) => (
              <tr key={`compact-${rowIndex}`} className="border-b border-[#132c3f] last:border-0">
                {columns.map((column) => (
                  <td key={`${rowIndex}-${column}`} className="truncate px-3 py-2.5 font-bold text-[#d6e3ef]">
                    {row[column]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <button
        type="button"
        onClick={onFooterClick}
        className="block w-full border-t border-[#132c3f] px-3 py-2 text-center text-[12px] font-bold text-[#5aa7e8] transition hover:bg-sky-400/10 hover:text-sky-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400"
      >
        {footerLabel} <ArrowRight className="ml-1 inline h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function ReportsPage() {
  const { user, selectedCustomer } = useSession();
  const [dateFrom, setDateFrom] = useState(() => currentMonthRange().from);
  const [dateTo, setDateTo] = useState(() => currentMonthRange().to);
  const [salesBreakdown, setSalesBreakdown] = useState<"product" | "brand" | "customer">("product");
  const [customerFilter, setCustomerFilter] = useState("all");
  const [collectionSearch, setCollectionSearch] = useState("");
  const [topCustomerLimit, setTopCustomerLimit] = useState<10 | 20 | 50>(20);
  const [collectorFilter, setCollectorFilter] = useState("all");
  const [collectionMethodFilter, setCollectionMethodFilter] = useState("all");
  const [collectionPage, setCollectionPage] = useState(1);
  const [selectedCollectorId, setSelectedCollectorId] = useState<number | null>(null);
  const [detailView, setDetailView] = useState<DetailView | null>(null);
  const [detailSearch, setDetailSearch] = useState("");
  const [detailStatus, setDetailStatus] = useState("all");

  const [loadingKey, setLoadingKey] = useState<ReportKey | "all" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [reportsByKey, setReportsByKey] = useState<Record<ReportKey, ReportPayload>>({
    customer: null,
    order: null,
    collection: null,
    sales: null,
  });
  const [updatedAtByKey, setUpdatedAtByKey] = useState<Partial<Record<ReportKey, string>>>({});

  const isAnyLoading = loadingKey !== null;
  const hasDateFilters = Boolean(dateFrom) || Boolean(dateTo);
  const hasActiveFilters =
    hasDateFilters
    || salesBreakdown !== "product"
    || customerFilter !== "all"
    || collectionSearch !== ""
    || topCustomerLimit !== 20
    || collectorFilter !== "all"
    || collectionMethodFilter !== "all";
  const activeFilterCount =
    Number(Boolean(dateFrom)) +
    Number(Boolean(dateTo)) +
    Number(salesBreakdown !== "product") +
    Number(customerFilter !== "all") +
    Number(collectionSearch !== "") +
    Number(topCustomerLimit !== 20) +
    Number(collectorFilter !== "all") +
    Number(collectionMethodFilter !== "all");
  const effectiveDealerId = user?.dealer_id ?? undefined;
  const effectiveCustomerId =
    customerFilter !== "all" && Number.isFinite(Number(customerFilter))
      ? Number(customerFilter)
      : selectedCustomer?.id;
  const scopeLabel =
    selectedCustomer
      ? `${selectedCustomer.code} - ${selectedCustomer.title}`
      : user?.dealer?.name ?? "Yetkili kapsam";

  const setReportPayload = useCallback((key: ReportKey, payload: Record<string, unknown>) => {
    setReportsByKey((previous) => ({ ...previous, [key]: payload }));

    const generatedAt = typeof payload.generated_at === "string" ? payload.generated_at : null;
    setUpdatedAtByKey((previous) => ({
      ...previous,
      [key]: generatedAt ?? new Date().toISOString(),
    }));
  }, []);

  const reportActions = useMemo(
    () =>
      ({
        customer: () =>
          getReportCustomerBalances({
            dealer_id: effectiveDealerId,
            customer_id: effectiveCustomerId,
            date_to: dateTo || undefined,
            per_page: 100,
            async: false,
          }),
        order: () =>
          getReportOrderBalances({
            dealer_id: effectiveDealerId,
            customer_id: effectiveCustomerId,
            date_from: dateFrom || undefined,
            date_to: dateTo || undefined,
            per_page: 100,
            async: false,
          }),
        collection: () =>
          getReportCollections({
            dealer_id: effectiveDealerId,
            customer_id: effectiveCustomerId,
            date_from: dateFrom || undefined,
            date_to: dateTo || undefined,
            q: collectionSearch.trim() || undefined,
            top: topCustomerLimit,
            collector_id: collectorFilter !== "all" ? Number(collectorFilter) : undefined,
            method: collectionMethodFilter !== "all"
              ? collectionMethodFilter as "cash" | "transfer" | "check" | "note" | "cc" | "factory_cc"
              : undefined,
            page: collectionPage,
            per_page: 25,
            async: false,
          }),
        sales: () =>
          getReportSales({
            dealer_id: effectiveDealerId,
            customer_id: effectiveCustomerId,
            date_from: dateFrom || undefined,
            date_to: dateTo || undefined,
            breakdown: salesBreakdown,
            per_page: 100,
            async: false,
          }),
      }) satisfies Record<
        ReportKey,
        () => Promise<Record<string, unknown> | ReportQueueResponse>
      >,
    [collectionMethodFilter, collectionPage, collectionSearch, collectorFilter, dateFrom, dateTo, effectiveCustomerId, effectiveDealerId, salesBreakdown, topCustomerLimit]
  );

  const loadAllReports = useCallback(() => {
    setLoadingKey("all");
    setError(null);

    void (async () => {
      for (const key of REPORT_KEYS) {
        const payload = await reportActions[key]();

        if (hasRun(payload)) {
          throw new Error("Rapor kuyruğa alındı. Lütfen sync rapor ayarını kontrol edin.");
        }

        setReportPayload(key, payload);
      }
    })()
      .catch((err) => setError(err instanceof Error ? err.message : "Raporlar alınamadı"))
      .finally(() => setLoadingKey(null));
  }, [reportActions, setReportPayload]);

  useEffect(() => {
    const timer = window.setTimeout(loadAllReports, 0);

    return () => window.clearTimeout(timer);
  }, [loadAllReports]);

  useEffect(() => {
    let refreshTimer: number | null = null;
    const onRealtime = (message: Event) => {
      const detail = (message as CustomEvent<{ event?: string }>).detail;
      if (!detail?.event || !["collection_added", "collection_updated", "customer_balance_changed", "stock_transfer_received"].includes(detail.event)) {
        return;
      }

      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(loadAllReports, 350);
    };

    window.addEventListener("powersa:realtime", onRealtime);
    return () => {
      window.removeEventListener("powersa:realtime", onRealtime);
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
    };
  }, [loadAllReports]);

  const loadedReportCount = useMemo(
    () => REPORT_KEYS.filter((key) => Boolean(reportsByKey[key])).length,
    [reportsByKey]
  );

  const salesRows = extractPreviewRows("sales", reportsByKey.sales);
  const customerRows = extractPreviewRows("customer", reportsByKey.customer);
  const orderRows = extractPreviewRows("order", reportsByKey.order);
  const collectionRows = extractPreviewRows("collection", reportsByKey.collection);
  const allCustomerRows = extractPreviewRows("customer", reportsByKey.customer, 100);
  const allOrderRows = extractPreviewRows("order", reportsByKey.order, 100);
  const allCollectionRows = extractPreviewRows("collection", reportsByKey.collection, 100);
  const customerOptions = extractCustomerFilterOptions(
    reportsByKey.customer,
    reportsByKey.order,
    reportsByKey.collection,
    reportsByKey.sales
  );
  const lastUpdated =
    Object.values(updatedAtByKey)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
  const totalSales = getMetricValue(reportsByKey.sales, ["net_total", "grand_total", "total"], "0,00 ₺");
  const totalCollections = getMetricValue(reportsByKey.collection, ["collection_total", "amount", "total"], "0,00 ₺");
  const openOrders = getMetricValue(reportsByKey.order, ["open_grand_total", "order_due", "grand_total"], "0,00 ₺");
  const customerBalance = getMetricValue(reportsByKey.customer, ["balance_total", "total_due", "balance", "grand_total"], "0,00 ₺");
  const salesTaxTotal = getMetricValue(reportsByKey.sales, ["tax_total"], "0,00 ₺");
  const openOrderCount = getMetricNumber(reportsByKey.order, ["open_order_count", "order_count", "count"], 0);
  const customerCount = getMetricNumber(reportsByKey.customer, ["customer_count", "count"], customerRows.length);
  const salesOrderCount = getMetricNumber(reportsByKey.sales, ["order_count", "sale_count", "count"], 0);
  const salesQuantityTotal = getMetricNumber(reportsByKey.sales, ["quantity_total"], 0);
  const collectionCount = getMetricNumber(reportsByKey.collection, ["collection_count", "count"], 0);
  const salesBars = extractSalesBars(reportsByKey.sales);
  const collectionDailyBars = extractCollectionDailyBars(reportsByKey.collection);
  const collectionMethodRows = extractCollectionMethodRows(reportsByKey.collection);
  const collectorRows = extractCollectorRows(reportsByKey.collection);
  const collectionCustomerRows = extractCollectionCustomerRows(reportsByKey.collection);
  const monthlyCollectionRows = extractMonthlyCollectionRows(reportsByKey.collection);
  const collectionTransactions = extractCollectionTransactions(reportsByKey.collection);
  const collectionMeta = asRecord(asRecord(reportsByKey.collection)?.meta);
  const collectionCurrentPage = Number(collectionMeta?.current_page ?? 1) || 1;
  const collectionLastPage = Number(collectionMeta?.last_page ?? 1) || 1;
  const collectorOptions = getPayloadRows(reportsByKey.collection, "collector_options")
    .map((row) => ({
      id: typeof row.id === "number" ? row.id : Number(row.id),
      name: typeof row.name === "string" ? row.name : "Atanmamış",
    }))
    .filter((row) => Number.isFinite(row.id) && row.id > 0);
  const focusedCollector =
    collectorFilter !== "all"
      ? collectorRows.find((row) => row.id === Number(collectorFilter)) ?? null
      : null;
  const methodTotal = (label: string) =>
    collectionMethodRows.find((row) => row.label === label)?.formatted ?? "0,00 ₺";
  const collectionCenterMetrics = [
    ["Toplam", focusedCollector?.total ?? totalCollections],
    ["Nakit", focusedCollector?.cash ?? methodTotal("Nakit")],
    ["Fiziksel POS", focusedCollector?.pos ?? methodTotal("POS")],
    ["Fabrika Kart", focusedCollector?.factoryCard ?? methodTotal("Fabrika Kart")],
    ["Havale / EFT", focusedCollector?.transfer ?? methodTotal("Havale/EFT")],
    ["Çek", focusedCollector?.check ?? methodTotal("Çek")],
    ["Senet", focusedCollector?.note ?? methodTotal("Senet")],
    ["Cari", String(focusedCollector?.customerCount ?? collectionCustomerRows.length)],
    ["İşlem", String(focusedCollector?.transactionCount ?? collectionCount)],
  ] as const;
  const selectedCollector = collectorRows.find((row) => row.id === selectedCollectorId) ?? null;
  const selectedCollectorTransactions = collectionTransactions.filter(
    (row) => row.collectorId === selectedCollectorId
  );
  const orderStatusRows = extractOrderStatusRows(reportsByKey.order);
  const agingRows = extractAgingRows(reportsByKey.customer);
  const agingTotal = agingRows.reduce((sum, row) => sum + row.value, 0);
  const collectionMethodTopPercent = Math.round(collectionMethodRows[0]?.percent ?? 0);
  const detailSourceRows =
    detailView === "balances"
      ? allCustomerRows
      : detailView === "orders"
        ? allOrderRows
        : detailView === "collections"
          ? collectionCustomerRows
          : allCollectionRows;
  const detailRows = detailSourceRows.filter((row) => {
    const matchesSearch =
      detailSearch.trim() === ""
      || Object.values(row).some((value) =>
        value.toLocaleLowerCase("tr-TR").includes(detailSearch.trim().toLocaleLowerCase("tr-TR"))
      );
    const matchesStatus = detailView !== "orders" || detailStatus === "all" || row.Durum === detailStatus;

    return matchesSearch && matchesStatus;
  });
  const detailStatuses = Array.from(new Set(allOrderRows.map((row) => row.Durum).filter(Boolean)));
  const detailTitle =
    detailView === "balances"
      ? "Tüm Cari Bakiye Durumları"
      : detailView === "orders"
        ? "Tüm Siparişler"
        : detailView === "collections"
          ? "En Çok Tahsilat Yapılan Cariler"
          : "Tüm Müşteriler";

  const openDetail = (view: DetailView) => {
    setDetailSearch("");
    setDetailStatus("all");
    setDetailView(view);
  };

  const exportRowsCsv = (rows: Array<Record<string, string>>, fileName: string) => {
    const columns = Object.keys(rows[0] ?? {});
    if (columns.length === 0) {
      return;
    }
    const escapeCell = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const csvRows = [
      columns,
      ...rows.map((row) => columns.map((column) => row[column] ?? "")),
    ];
    const csv = `\uFEFF${csvRows.map((row) => row.map(escapeCell).join(";")).join("\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportCollectionCsv = () => {
    const escapeCell = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const rows = [
      ["Tarih", "İrsaliyeci", "Cari", "Tahsilat Türü", "Tutar", "Referans", "Açıklama"],
      ...collectionTransactions.map((row) => [
        row.date,
        row.collector,
        row.customer,
        row.method,
        row.amount,
        row.reference,
        row.note,
      ]),
    ];
    const csv = `\uFEFF${rows.map((row) => row.map(escapeCell).join(";")).join("\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `tahsilat-raporu-${dateFrom || "baslangic"}-${dateTo || "bitis"}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const fieldClassName =
    "h-11 rounded-xl border-[#1d3449] bg-[#081a29] text-sm font-bold text-[#dce9f4] shadow-none placeholder:text-[#6f879d] focus-visible:ring-[#38bdf8]/35";
  const kpis = [
    {
      title: "Toplam Satış",
      value: totalSales,
      detail: "Sipariş Adedi",
      sub: String(salesOrderCount),
      icon: TrendingUp,
      color: "#4ade80",
      className: "border-emerald-400/35 bg-[linear-gradient(145deg,rgba(13,70,48,0.95),rgba(5,36,31,0.98))]",
      visual: <MiniLineChart color="#4ade80" />,
    },
    {
      title: "Tahsilat",
      value: totalCollections,
      detail: "Tahsilat Adedi",
      sub: String(collectionCount),
      icon: BarChart3,
      color: "#60a5fa",
      className: "border-sky-400/35 bg-[linear-gradient(145deg,rgba(11,58,93,0.95),rgba(6,29,51,0.98))]",
      visual: <MiniBars color="#60a5fa" />,
    },
    {
      title: "Açık Sipariş",
      value: openOrders,
      detail: "Sipariş Adedi",
      sub: String(openOrderCount),
      icon: ShoppingCart,
      color: "#fbbf24",
      className: "border-amber-400/35 bg-[linear-gradient(145deg,rgba(105,66,12,0.95),rgba(50,31,7,0.98))]",
      visual: <ShoppingCart className="h-16 w-16 text-amber-300/70" />,
    },
    {
      title: "Cari Bakiye",
      value: customerBalance,
      detail: "Cari Adedi",
      sub: String(customerCount),
      icon: Wallet,
      color: "#34d399",
      className: "border-emerald-400/35 bg-[linear-gradient(145deg,rgba(7,83,64,0.95),rgba(5,41,35,0.98))]",
      visual: <Wallet className="h-16 w-16 text-emerald-300/70" />,
    },
    {
      title: "Satış KDV",
      value: salesTaxTotal,
      detail: "Satış Adedi",
      sub: String(salesQuantityTotal),
      icon: Activity,
      color: "#c084fc",
      className: "border-violet-400/35 bg-[linear-gradient(145deg,rgba(67,43,126,0.95),rgba(36,24,78,0.98))]",
      visual: <MiniLineChart color="#c084fc" />,
    },
  ];

  return (
    <div className="reports-pro-screen -mx-1 max-w-full space-y-3 overflow-x-hidden rounded-[22px] bg-[#04111c] p-3 text-[#dce9f4] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <Panel className="bg-[linear-gradient(180deg,rgba(7,26,41,0.96),rgba(5,21,34,0.96))] p-3">
        <div className="mb-3 flex flex-wrap gap-2">
          {DATE_PRESETS.map((preset) => (
            <Button
              key={preset.key}
              type="button"
              variant="outline"
              disabled={isAnyLoading}
              onClick={() => {
                const range = dateRangeForPreset(preset.key);
                setDateFrom(range.from);
                setDateTo(range.to);
              }}
              className="h-8 rounded-lg border-[#23415a] bg-[#0a1c2c] px-3 text-[11px] font-black text-[#a9bed1] hover:border-sky-400/50 hover:bg-[#102b42] hover:text-white"
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <div className="grid gap-3 xl:grid-cols-[180px_180px_220px_minmax(220px,1fr)_minmax(180px,1fr)_auto] xl:items-end">
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-black text-[#7f96aa]">Başlangıç</span>
            <Input type="date" value={dateFrom} disabled={isAnyLoading} onChange={(event) => setDateFrom(event.target.value)} className={fieldClassName} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-black text-[#7f96aa]">Bitiş</span>
            <Input type="date" value={dateTo} disabled={isAnyLoading} onChange={(event) => setDateTo(event.target.value)} className={fieldClassName} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-black text-[#7f96aa]">Satış Kırılımı</span>
            <Select value={salesBreakdown} onValueChange={(value) => setSalesBreakdown(value as "product" | "brand" | "customer")} disabled={isAnyLoading}>
              <SelectTrigger className={fieldClassName}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="product">Ürün</SelectItem>
                <SelectItem value="brand">Marka</SelectItem>
                <SelectItem value="customer">Müşteri</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <div className="block">
            <span className="mb-1.5 block text-[11px] font-black text-[#7f96aa]">Kapsam</span>
            <div className={cn(fieldClassName, "flex items-center truncate px-3")}>{scopeLabel}</div>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-black text-[#7f96aa]">Müşteri</span>
            <Select value={customerFilter} onValueChange={setCustomerFilter} disabled={isAnyLoading}>
              <SelectTrigger className={fieldClassName}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tümü</SelectItem>
                {customerOptions.slice(0, 16).map((option) => (
                  <SelectItem key={`customer-filter-${option.id}`} value={String(option.id)}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <div className="flex flex-wrap gap-2 xl:justify-end">
            <Button onClick={loadAllReports} disabled={isAnyLoading} className="h-11 rounded-xl bg-[#2f9e61] px-5 text-sm font-black text-white hover:bg-[#39b56f]">
              {loadingKey === "all" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
              Yenile
            </Button>
            <Button
              variant="outline"
              disabled={isAnyLoading || !hasActiveFilters}
              onClick={() => {
                const range = currentMonthRange();
                setDateFrom(range.from);
                setDateTo(range.to);
                setSalesBreakdown("product");
                setCustomerFilter("all");
                setCollectionSearch("");
                setTopCustomerLimit(20);
                setCollectorFilter("all");
                setCollectionMethodFilter("all");
                setCollectionPage(1);
              }}
              className="h-11 rounded-xl border-[#26384e] bg-[#0b1625] px-4 text-sm font-black text-[#91a6ba] hover:bg-[#122237] hover:text-white"
            >
              <RotateCcw className="h-4 w-4" /> Temizle
            </Button>
            <Button
              variant="outline"
              onClick={() => window.print()}
              className="h-11 rounded-xl border-red-500/25 bg-red-500/12 px-4 text-sm font-black text-red-200 hover:bg-red-500/20"
            >
              <FileDown className="h-4 w-4" /> PDF
            </Button>
            <Button
              variant="outline"
              onClick={exportCollectionCsv}
              disabled={collectionTransactions.length === 0}
              className="h-11 rounded-xl border-emerald-400/25 bg-emerald-500/12 px-4 text-sm font-black text-emerald-200 hover:bg-emerald-500/20"
            >
              <FileSpreadsheet className="h-4 w-4" /> Excel
            </Button>
          </div>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <Input
            value={collectionSearch}
            onChange={(event) => {
              setCollectionSearch(event.target.value);
              setCollectionPage(1);
            }}
            placeholder="Tahsilat raporunda cari kodu veya adı ara"
            className={fieldClassName}
          />
          <Select value={collectionMethodFilter} onValueChange={(value) => {
            setCollectionMethodFilter(value);
            setCollectionPage(1);
          }}>
            <SelectTrigger className={fieldClassName}><SelectValue placeholder="Tahsilat türü" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tüm tahsilat türleri</SelectItem>
              <SelectItem value="cash">Nakit</SelectItem>
              <SelectItem value="cc">POS</SelectItem>
              <SelectItem value="factory_cc">Fabrika Kart</SelectItem>
              <SelectItem value="transfer">Havale / EFT</SelectItem>
              <SelectItem value="check">Çek</SelectItem>
              <SelectItem value="note">Senet</SelectItem>
            </SelectContent>
          </Select>
          <Select value={String(topCustomerLimit)} onValueChange={(value) => setTopCustomerLimit(Number(value) as 10 | 20 | 50)}>
            <SelectTrigger className={fieldClassName}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="10">En iyi 10 cari</SelectItem>
              <SelectItem value="20">En iyi 20 cari</SelectItem>
              <SelectItem value="50">En iyi 50 cari</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] font-bold text-[#7890a8]">
          <span className="h-2.5 w-2.5 rounded-full bg-[#22c55e]" />
          Veriler {lastUpdated ? formatDateTime(lastUpdated) : `${loadedReportCount}/4 rapor hazır`} itibarıyla günceldir.
          {activeFilterCount > 0 ? <span className="rounded-full bg-[#10263a] px-2 py-1 text-[#8cc5ff]">{activeFilterCount} aktif filtre</span> : null}
        </div>
      </Panel>

      {error ? (
        <div className="rounded-xl border border-red-400/30 bg-red-500/12 px-4 py-3 text-sm font-bold text-red-200">{error}</div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;
          return (
            <section key={kpi.title} className={cn("min-h-[148px] overflow-hidden rounded-[18px] border p-4 shadow-[0_24px_60px_-44px_rgba(0,0,0,0.85)]", kpi.className)}>
              <div className="flex items-start justify-between gap-3">
                <span className="grid h-12 w-12 place-items-center rounded-2xl border border-white/10 bg-white/10" style={{ color: kpi.color }}>
                  <Icon className="h-6 w-6" />
                </span>
                <span className="rounded-full border border-white/10 bg-white/8 px-2 py-1 text-[10px] font-black text-[#c2d4e5]">Canlı</span>
              </div>
              <div className="mt-3 flex items-end justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[11px] font-black uppercase tracking-[0.13em] text-[#8fa3b8]">{kpi.title}</p>
                  <p className="mt-1 truncate text-2xl font-black text-white">{kpi.value}</p>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[12px]">
                    <span className="font-semibold text-[#8fa3b8]">{kpi.detail}</span>
                    <span className="font-black text-[#dce9f4]">{kpi.sub}</span>
                  </div>
                </div>
                <div className="shrink-0">{kpi.visual}</div>
              </div>
            </section>
          );
        })}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
        {(["Nakit", "Kart", "POS", "Fabrika Kart", "Havale/EFT", "Çek", "Senet"] as const).map((label) => {
          const row = collectionMethodRows.find((item) => item.label === label);

          return (
            <section key={label} className="rounded-[16px] border border-[#1d3449] bg-[linear-gradient(145deg,#0a2132,#071522)] p-4">
              <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[#7f96aa]">{label}</p>
              <p className="mt-2 truncate text-lg font-black text-white">{row?.formatted ?? "0,00 ₺"}</p>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#142b3d]">
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${Math.max(0, row?.percent ?? 0)}%`,
                    backgroundColor: row?.color ?? "#334155",
                  }}
                />
              </div>
            </section>
          );
        })}
      </div>

      <div className="grid gap-3 xl:grid-cols-[1.08fr_0.96fr_0.98fr]">
        <Panel>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-black text-white">Satış Kırılımı</h2>
            <span className="rounded-xl border border-[#1d3449] px-3 py-1.5 text-xs font-black text-[#9fb2c4]">{salesBreakdown === "product" ? "Ürün" : salesBreakdown === "brand" ? "Marka" : "Müşteri"}</span>
          </div>
          <div className="grid h-[238px] gap-3 rounded-xl bg-[#061522] p-4">
            {salesBars.length === 0 ? (
              <div className="grid place-items-center text-sm font-semibold text-[#7890a8]">Seçili filtrelerde satış kırılımı yok.</div>
            ) : (
              salesBars.map((row) => {
                const maxValue = Math.max(...salesBars.map((item) => item.value), 1);

                return (
                  <div key={row.label} className="grid grid-cols-[120px_minmax(0,1fr)_100px] items-center gap-3 text-sm">
                    <span className="truncate font-bold text-[#9fb2c4]">{row.label}</span>
                    <span className="h-3 overflow-hidden rounded-full bg-[#12283a]">
                      <span className="block h-full rounded-full bg-[linear-gradient(90deg,#4ade80,#7dd3fc)]" style={{ width: `${Math.max(8, percentOf(row.value, maxValue))}%` }} />
                    </span>
                    <span className="truncate text-right font-black text-[#dce9f4]">{row.formatted}</span>
                  </div>
                );
              })
            )}
          </div>
        </Panel>

        <Panel>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-black text-white">Tahsilat Performansı</h2>
            <span className="rounded-xl border border-[#1d3449] px-3 py-1.5 text-xs font-black text-[#9fb2c4]">Günlük</span>
          </div>
          <div className="flex h-[238px] items-end gap-3 rounded-xl bg-[#061522] px-5 pb-8 pt-5">
            {collectionDailyBars.length === 0 ? (
              <div className="grid h-full w-full place-items-center text-sm font-semibold text-[#7890a8]">Seçili filtrelerde tahsilat yok.</div>
            ) : (
              collectionDailyBars.map((row) => {
                const maxValue = Math.max(...collectionDailyBars.map((item) => item.value), 1);

                return (
                  <div key={row.label} className="flex h-full flex-1 flex-col justify-end gap-2 text-center">
                    <span className="rounded-t-lg bg-[linear-gradient(180deg,#63e487,#164b34)]" style={{ height: `${Math.max(6, percentOf(row.value, maxValue))}%` }} title={row.formatted} />
                    <span className="text-[10px] font-bold text-[#8fa3b8]">{row.label}</span>
                  </div>
                );
              })
            )}
          </div>
        </Panel>

        <Panel>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-black text-white">Tahsilat Dağılımı</h2>
            <span className="rounded-xl border border-[#1d3449] px-3 py-1.5 text-xs font-black text-[#9fb2c4]">Bu Ay</span>
          </div>
          <div className="grid h-[238px] grid-cols-[150px_minmax(0,1fr)] items-center gap-6">
            <RingChart value={collectionMethodTopPercent} color="#4ade80" label="En Büyük" />
            <div className="space-y-3 text-sm">
              {(collectionMethodRows.length ? collectionMethodRows : [{ label: "Kayıt yok", color: "#64748b", percent: 0, formatted: "0,00 ₺" }]).map((row) => (
                <div key={row.label} className="grid grid-cols-[16px_minmax(0,1fr)_60px] items-center gap-2">
                  <span className="h-3 w-3 rounded" style={{ backgroundColor: row.color }} />
                  <span className="truncate font-bold text-[#b8c8d8]">{row.label}</span>
                  <span className="text-right font-black text-[#dce9f4]">%{row.percent.toLocaleString("tr-TR", { maximumFractionDigits: 1 })}</span>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      </div>

      <Panel className="min-w-0 overflow-hidden border-sky-400/25 bg-[linear-gradient(145deg,rgba(7,31,49,0.98),rgba(4,19,31,0.98))]">
        <div className="flex flex-col gap-3 border-b border-[#1a3348] pb-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-[0.14em] text-sky-300">Tek Ekran Personel Analizi</p>
            <h2 className="mt-1 text-xl font-black text-white">İrsaliyeci Tahsilat Merkezi</h2>
            <p className="mt-1 text-xs font-semibold text-[#7890a8]">
              Personeli seç; toplamı, tahsilat türlerini, carileri ve bütün hareketleri birlikte gör.
            </p>
          </div>
          <div className="w-full lg:w-[360px]">
            <label className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.08em] text-[#8fa3b8]">
              Pazarlamacı / İrsaliyeci / Plasiyer
            </label>
            <Select value={collectorFilter} onValueChange={(value) => {
              setCollectorFilter(value);
              setCollectionPage(1);
            }}>
              <SelectTrigger className={fieldClassName}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tüm personel</SelectItem>
                {collectorOptions.map((collector) => (
                  <SelectItem key={collector.id} value={String(collector.id)}>{collector.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {collectionCenterMetrics.map(([label, value], index) => (
            <div
              key={label}
              className={cn(
                "min-w-0 rounded-2xl border p-3",
                index === 0
                  ? "border-emerald-400/30 bg-emerald-500/10"
                  : "border-[#1d3449] bg-[#081a29]"
              )}
            >
              <p className="truncate text-[9px] font-black uppercase tracking-[0.1em] text-[#7890a8]">{label}</p>
              <p className={cn("mt-2 truncate text-base font-black", index === 0 ? "text-emerald-200" : "text-white")} title={value}>
                {value}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-black text-white">Cari Bazlı Tahsilat Dağılımı</h3>
              <p className="mt-1 text-xs font-semibold text-[#7890a8]">
                {focusedCollector ? `${focusedCollector.name} tarafından alınan tahsilatlar` : "Tüm personelin cari dağılımı"}
              </p>
            </div>
            <span className="rounded-lg border border-sky-400/25 bg-sky-500/10 px-3 py-2 text-xs font-black text-sky-200">
              {collectionCustomerRows.length} cari
            </span>
          </div>

          {collectionCustomerRows.length === 0 ? (
            <div className="grid min-h-32 place-items-center rounded-2xl border border-dashed border-[#1d3449] bg-[#061522] px-4 text-center text-sm font-bold text-[#7890a8]">
              Seçilen personel ve tarih aralığında tahsilat bulunamadı.
            </div>
          ) : (
            <div className="grid gap-3 xl:grid-cols-2">
              {collectionCustomerRows.map((row, index) => (
                <article key={`${row.Cari}-${index}`} className="min-w-0 rounded-2xl border border-[#1a3348] bg-[#071827] p-4">
                  <div className="flex min-w-0 flex-col gap-2 border-b border-[#163047] pb-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="min-w-0 truncate text-sm font-black text-white" title={row.Cari}>{row.Cari}</p>
                    <p className="shrink-0 text-lg font-black text-emerald-200">{row.Toplam}</p>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {[
                      ["Nakit", row.Nakit],
                      ["Fiziksel POS", row.POS],
                      ["Fabrika Kart", row["Fabrika Kart"]],
                      ["Havale", row.Havale],
                      ["Çek", row.Çek],
                      ["Senet", row.Senet],
                      ["İşlem", row.İşlem],
                      ["Son İşlem", row["Son İşlem"]],
                    ].map(([label, value]) => (
                      <div key={label} className="min-w-0 rounded-xl bg-[#0a1d2c] px-3 py-2.5">
                        <p className="truncate text-[9px] font-black uppercase tracking-[0.08em] text-[#71899f]">{label}</p>
                        <p className="mt-1 truncate text-xs font-black text-[#dce9f4]" title={value}>{value}</p>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>

        <div className="mt-5 border-t border-[#1a3348] pt-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-black text-white">Tahsilat Hareketleri</h3>
              <p className="mt-1 text-xs font-semibold text-[#7890a8]">Cari, yöntem, tutar, tarih ve belge bilgisi</p>
            </div>
            <Button
              variant="outline"
              onClick={exportCollectionCsv}
              disabled={collectionTransactions.length === 0}
              className="border-emerald-400/25 bg-emerald-500/10 font-black text-emerald-200"
            >
              <FileSpreadsheet className="h-4 w-4" /> Excel
            </Button>
          </div>
          {collectionTransactions.length === 0 ? (
            <div className="grid min-h-28 place-items-center rounded-2xl border border-dashed border-[#1d3449] text-sm font-bold text-[#7890a8]">
              Tahsilat hareketi bulunamadı.
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {collectionTransactions.map((row) => (
                <article key={row.id} className="min-w-0 rounded-2xl border border-[#1a3348] bg-[#071827] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-black text-white" title={row.customer}>{row.customer}</p>
                      <p className="mt-1 truncate text-xs font-bold text-[#7890a8]">{row.collector}</p>
                    </div>
                    <p className="shrink-0 text-sm font-black text-emerald-200">{row.amount}</p>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] font-black">
                    <span className="rounded-full border border-sky-300/25 bg-sky-400/10 px-2.5 py-1 text-sky-100">{row.method}</span>
                    <span className="rounded-full border border-[#27435a] px-2.5 py-1 text-[#a9bed1]">{row.date}</span>
                    <span className="max-w-40 truncate rounded-full border border-[#27435a] px-2.5 py-1 text-[#a9bed1]" title={row.reference}>{row.reference}</span>
                  </div>
                  {row.note !== "-" ? <p className="mt-3 line-clamp-2 text-xs font-semibold text-[#8fa3b8]">{row.note}</p> : null}
                </article>
              ))}
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs font-bold text-[#7890a8]">
              Sayfa {collectionCurrentPage.toLocaleString("tr-TR")} / {collectionLastPage.toLocaleString("tr-TR")}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={isAnyLoading || collectionCurrentPage <= 1}
                onClick={() => setCollectionPage((page) => Math.max(1, page - 1))}
                className="border-[#26384e] bg-[#0b1625] font-black text-[#b7c7d6]"
              >
                Önceki
              </Button>
              <Button
                variant="outline"
                disabled={isAnyLoading || collectionCurrentPage >= collectionLastPage}
                onClick={() => setCollectionPage((page) => page + 1)}
                className="border-[#26384e] bg-[#0b1625] font-black text-[#b7c7d6]"
              >
                Sonraki
              </Button>
            </div>
          </div>
        </div>
      </Panel>

      <div className="hidden">
        <Panel>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-base font-black text-white">İrsaliyeci Performans Merkezi</h2>
              <p className="mt-1 text-xs font-semibold text-[#7890a8]">Aktif irsaliyecilerin tamamı; işlem yapmayanlar sıfır değerle gösterilir.</p>
            </div>
            <span className="rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-3 py-1.5 text-xs font-black text-emerald-200">{collectorRows.length} Aktif İrsaliyeci</span>
          </div>
          <div className="max-h-[480px] overflow-auto rounded-xl border border-[#1a3348]">
            <table className="w-full min-w-[1450px] text-left text-[11px]">
              <thead className="sticky top-0 z-10 bg-[#0b2032] text-[10px] font-black uppercase tracking-[0.06em] text-[#8fa3b8]">
                <tr>
                  <th className="px-3 py-3">İrsaliyeci</th>
                  <th className="px-3 py-3 text-right">Toplam</th>
                  <th className="px-3 py-3 text-right">Nakit</th>
                  <th className="px-3 py-3 text-right">Kart</th>
                  <th className="px-3 py-3 text-right">POS</th>
                  <th className="px-3 py-3 text-right">Fabrika Kart</th>
                  <th className="px-3 py-3 text-right">Cari</th>
                  <th className="px-3 py-3 text-right">İşlem</th>
                  <th className="px-3 py-3 text-right">Ortalama</th>
                  <th className="px-3 py-3">Son İşlem</th>
                  <th className="px-3 py-3 text-center">Detay</th>
                </tr>
              </thead>
              <tbody>
                {collectorRows.map((row) => (
                  <tr key={row.id} className="border-t border-[#132c3f] text-[#d6e3ef] hover:bg-[#0b2132]">
                    <td className="px-3 py-3 font-black text-white">{row.name}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right font-black text-emerald-200">{row.total}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right font-bold">{row.cash}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right font-bold">{row.card}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right font-bold">{row.pos}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right font-bold">{row.factoryCard}</td>
                    <td className="px-3 py-3 text-right font-black">{row.customerCount.toLocaleString("tr-TR")}</td>
                    <td className="px-3 py-3 text-right font-black">{row.transactionCount.toLocaleString("tr-TR")}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right font-bold">{row.average}</td>
                    <td className="whitespace-nowrap px-3 py-3 font-bold">{row.lastDate}</td>
                    <td className="px-3 py-3 text-center">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setSelectedCollectorId(row.id);
                          setCollectorFilter(String(row.id));
                          setCollectionPage(1);
                        }}
                        className="h-8 border-sky-300/30 bg-sky-400/10 px-3 text-[10px] font-black text-sky-100 hover:bg-sky-400/20"
                      >
                        Detay Gör
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-black text-white">Cari Bazlı Tahsilat</h2>
            <span className="rounded-xl border border-sky-400/25 bg-sky-500/10 px-3 py-1.5 text-xs font-black text-sky-200">Top {topCustomerLimit}</span>
          </div>
          <div className="overflow-x-auto">
            <div className="min-w-[760px]">
              <CompactTable
                rows={collectionCustomerRows}
                footerLabel="En çok tahsilat yapılan cariler"
                onFooterClick={() => openDetail("collections")}
              />
            </div>
          </div>
        </Panel>
      </div>

      <Panel className="hidden">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-black text-white">İrsaliyeci → Cari Tahsilat Detayı</h2>
            <p className="mt-1 text-xs font-semibold text-[#7890a8]">
              Hangi irsaliyeci, hangi cariden, ne zaman ve hangi yöntemle tahsilat almış
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs font-black">
            <span className="rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-3 py-2 text-emerald-200">
              {collectionCount.toLocaleString("tr-TR")} işlem
            </span>
            <span className="rounded-lg border border-sky-400/25 bg-sky-500/10 px-3 py-2 text-sky-200">
              {totalCollections}
            </span>
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-[#1a3348]">
          <table className="w-full min-w-[1120px] text-left text-[12px]">
            <thead className="bg-[#0b2032] text-[10px] font-black uppercase tracking-[0.08em] text-[#8fa3b8]">
              <tr>
                <th className="px-3 py-3">Tarih</th>
                <th className="px-3 py-3">İrsaliyeci</th>
                <th className="px-3 py-3">Cari</th>
                <th className="px-3 py-3">Tahsilat Türü</th>
                <th className="px-3 py-3 text-right">Tutar</th>
                <th className="px-3 py-3">Referans</th>
                <th className="px-3 py-3">Açıklama</th>
              </tr>
            </thead>
            <tbody>
              {collectionTransactions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm font-bold text-[#7890a8]">
                    Seçilen irsaliyeci, cari ve tahsilat türünde işlem bulunamadı.
                  </td>
                </tr>
              ) : collectionTransactions.map((row) => (
                <tr key={row.id} className="border-t border-[#132c3f] text-[#d6e3ef] hover:bg-[#0b2132]">
                  <td className="whitespace-nowrap px-3 py-3 font-bold">{row.date}</td>
                  <td className="max-w-48 truncate px-3 py-3 font-black text-white">{row.collector}</td>
                  <td className="max-w-72 truncate px-3 py-3 font-bold">{row.customer}</td>
                  <td className="px-3 py-3">
                    <span className="inline-flex rounded-full border border-sky-300/25 bg-sky-400/10 px-2.5 py-1 font-black text-sky-100">
                      {row.method}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right text-sm font-black text-emerald-200">{row.amount}</td>
                  <td className="max-w-40 truncate px-3 py-3 font-bold">{row.reference}</td>
                  <td className="max-w-64 truncate px-3 py-3 text-[#9fb2c4]" title={row.note}>{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs font-bold text-[#7890a8]">
            Sayfa {collectionCurrentPage.toLocaleString("tr-TR")} / {collectionLastPage.toLocaleString("tr-TR")}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={isAnyLoading || collectionCurrentPage <= 1}
              onClick={() => setCollectionPage((page) => Math.max(1, page - 1))}
              className="border-[#26384e] bg-[#0b1625] font-black text-[#b7c7d6]"
            >
              Önceki
            </Button>
            <Button
              variant="outline"
              disabled={isAnyLoading || collectionCurrentPage >= collectionLastPage}
              onClick={() => setCollectionPage((page) => page + 1)}
              className="border-[#26384e] bg-[#0b1625] font-black text-[#b7c7d6]"
            >
              Sonraki
            </Button>
          </div>
        </div>
      </Panel>

      <Panel>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-black text-white">Aylık Tahsilat Performansı</h2>
            <p className="mt-1 text-xs font-semibold text-[#7890a8]">Toplam tutar, işlem adedi ve ortalama tahsilat karşılaştırması</p>
          </div>
        </div>
        <div className="flex h-[260px] items-end gap-3 overflow-x-auto rounded-xl bg-[#061522] px-5 pb-12 pt-6">
          {monthlyCollectionRows.length === 0 ? (
            <div className="grid h-full w-full place-items-center text-sm font-semibold text-[#7890a8]">Seçili tarih aralığında aylık veri yok.</div>
          ) : monthlyCollectionRows.map((row) => {
            const maxValue = Math.max(...monthlyCollectionRows.map((item) => item.value), 1);

            return (
              <div key={row.label} className="group relative flex h-full min-w-24 flex-1 flex-col justify-end gap-2 text-center">
                <div className="pointer-events-none absolute left-1/2 top-0 z-10 hidden w-48 -translate-x-1/2 rounded-xl border border-sky-300/25 bg-[#0a1d2c] p-3 text-left text-xs shadow-xl group-hover:block">
                  <p className="font-black text-white">{formatMetricValue("total", row.value, "TRY")}</p>
                  <p className="mt-1 text-[#9fb2c4]">{row.count} işlem · Ort. {row.average}</p>
                </div>
                <span className="rounded-t-lg bg-[linear-gradient(180deg,#38bdf8,#155e75)] transition-opacity group-hover:opacity-80" style={{ height: `${Math.max(7, percentOf(row.value, maxValue))}%` }} />
                <span className="text-[10px] font-black text-[#8fa3b8]">{row.label}</span>
              </div>
            );
          })}
        </div>
      </Panel>

      <div className="grid gap-3 xl:grid-cols-[1.05fr_0.84fr_1.06fr]">
        <Panel>
          <h2 className="mb-4 text-base font-black text-white">En Çok Satan Ürün Grupları</h2>
          <div className="space-y-3">
            {salesRows.length === 0 ? (
              <div className="grid min-h-[132px] place-items-center rounded-xl border border-dashed border-[#1a3348] text-sm font-semibold text-[#7890a8]">
                Seçili filtrelerde satış kaydı yok.
              </div>
            ) : salesRows.slice(0, 5).map((row, index) => (
              <div key={`sales-row-${index}`} className="grid grid-cols-[100px_minmax(0,1fr)_90px] items-center gap-3 text-sm">
                <span className="truncate font-bold text-[#9fb2c4]">{row.Kırılım ?? row.Cari ?? "Ürün"}</span>
                <span className="h-3 overflow-hidden rounded-full bg-[#12283a]">
                  <span className="block h-full rounded-full bg-[linear-gradient(90deg,#4ade80,#7dd3fc)]" style={{ width: `${Math.max(24, 92 - index * 14)}%` }} />
                </span>
                <span className="truncate text-right font-black text-[#dce9f4]">{row.Tutar ?? "-"}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel>
          <h2 className="mb-4 text-base font-black text-white">Sipariş Durumları</h2>
          <div className="grid grid-cols-[1fr_130px] items-center gap-4">
            <div className="space-y-3 text-sm">
              {(orderStatusRows.length ? orderStatusRows : [{ label: "Kayıt yok", count: 0, total: "0,00 ₺", color: "bg-slate-500" }]).map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2 font-bold text-[#b8c8d8]">
                    <span className={cn("h-3 w-3 rounded-full", row.color)} />
                    {row.label}
                  </span>
                  <span className="font-black text-[#dce9f4]">{row.count}</span>
                </div>
              ))}
            </div>
            <RingChart value={Math.min(100, openOrderCount)} color="#3b82f6" label="Açık" />
          </div>
        </Panel>

        <Panel>
          <h2 className="mb-4 text-base font-black text-white">Vade Analizi</h2>
          <div className="overflow-hidden rounded-xl border border-[#1a3348] text-center text-sm">
            <div className="grid grid-cols-4 bg-[#0b2032] text-[12px] font-black text-[#cbd5e1]">
              {[...agingRows.map((row) => row.label), "Toplam"].map((label) => <span key={label} className="border-r border-[#1a3348] px-2 py-3 last:border-r-0">{label}</span>)}
            </div>
            <div className="grid grid-cols-4 text-[12px] font-black text-[#dce9f4]">
              {[...agingRows.map((row) => row.formatted), formatMetricValue("balance", agingTotal, "TRY")].map((label, index) => <span key={index} className="border-r border-t border-[#1a3348] px-2 py-3 last:border-r-0">{label}</span>)}
            </div>
            <div className="grid grid-cols-4 text-[12px] font-black text-[#dce9f4]">
              {[...agingRows.map((row) => `%${row.percent.toLocaleString("tr-TR", { maximumFractionDigits: 1 })}`), agingTotal > 0 ? "%100" : "%0"].map((label, index) => <span key={index} className="border-r border-t border-[#1a3348] px-2 py-3 last:border-r-0">{label}</span>)}
            </div>
          </div>
          <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-[#12283a]">
            {agingRows.map((row, index) => (
              <span
                key={row.label}
                className={cn(["bg-emerald-400", "bg-amber-400", "bg-red-400"][index])}
                style={{ width: `${agingTotal > 0 ? row.percent : index === 0 ? 100 : 0}%` }}
              />
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid gap-3 xl:grid-cols-3">
        <Panel>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-black text-white">Cari Bakiye Durumları</h2>
            <span className="text-xs font-black text-[#5aa7e8]">Tümü</span>
          </div>
          <CompactTable
            rows={customerRows}
            footerLabel="Tüm cari bakiye durumlarını görüntüle"
            onFooterClick={() => openDetail("balances")}
          />
        </Panel>
        <Panel>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-black text-white">Sipariş Bakiye Durumları</h2>
            <span className="text-xs font-black text-[#5aa7e8]">Güncel</span>
          </div>
          <CompactTable
            rows={orderRows}
            footerLabel="Tüm siparişleri görüntüle"
            onFooterClick={() => openDetail("orders")}
          />
        </Panel>
        <Panel>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-black text-white">En Aktif Müşteriler</h2>
            <span className="text-xs font-black text-[#5aa7e8]">Bu Ay</span>
          </div>
          <CompactTable
            rows={collectionRows.length ? collectionRows : customerRows}
            footerLabel="Tüm müşterileri görüntüle"
            onFooterClick={() => openDetail("customers")}
          />
        </Panel>
      </div>

      <Dialog open={detailView !== null} onOpenChange={(open) => {
        if (!open) {
          setDetailView(null);
        }
      }}>
        <DialogContent className="max-h-[92vh] max-w-[min(1280px,calc(100vw-24px))] overflow-hidden rounded-[24px] border border-sky-300/20 bg-[#061522] p-0 text-[#dce9f4]">
          <DialogHeader className="border-b border-[#1a3348] bg-[linear-gradient(135deg,#0b2940,#071827)] px-5 py-4 pr-12">
            <DialogTitle className="text-xl font-black text-white">{detailTitle}</DialogTitle>
            <DialogDescription className="font-semibold text-[#8fa3b8]">
              Seçili tarih ve kapsam filtrelerine göre gerçek kayıtlar
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 overflow-y-auto p-4">
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_220px_auto]">
              <Input
                value={detailSearch}
                onChange={(event) => setDetailSearch(event.target.value)}
                placeholder="Sipariş no, cari veya personel ara"
                className={fieldClassName}
              />
              <Select value={detailStatus} onValueChange={setDetailStatus} disabled={detailView !== "orders"}>
                <SelectTrigger className={fieldClassName}><SelectValue placeholder="Durum" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tüm Durumlar</SelectItem>
                  {detailStatuses.map((status) => (
                    <SelectItem key={status} value={status}>{statusLabel(status)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                disabled={detailRows.length === 0}
                onClick={() => exportRowsCsv(detailRows, `${detailView ?? "rapor"}-${dateFrom}-${dateTo}.csv`)}
                className="h-11 rounded-xl border-emerald-400/25 bg-emerald-500/10 font-black text-emerald-200"
              >
                <FileSpreadsheet className="h-4 w-4" /> Excel
              </Button>
            </div>
            <div className="max-h-[62vh] overflow-auto rounded-xl border border-[#1a3348]">
              {detailRows.length === 0 ? (
                <div className="grid min-h-52 place-items-center text-sm font-bold text-[#7890a8]">Kayıt bulunamadı.</div>
              ) : (
                <table className="w-full min-w-[940px] text-left text-[12px]">
                  <thead className="sticky top-0 z-10 bg-[#0b2032] text-[10px] font-black uppercase tracking-[0.06em] text-[#8fa3b8]">
                    <tr>
                      {Object.keys(detailRows[0]).map((column) => (
                        <th key={column} className="whitespace-nowrap px-3 py-3">{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {detailRows.map((row, index) => (
                      <tr key={`${detailView}-${index}`} className="border-t border-[#132c3f] hover:bg-[#0b2132]">
                        {Object.keys(detailRows[0]).map((column) => (
                          <td key={`${index}-${column}`} className="max-w-72 truncate whitespace-nowrap px-3 py-3 font-bold" title={row[column]}>
                            {column === "Durum" ? statusLabel(row[column]) : row[column]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <p className="text-xs font-bold text-[#7890a8]">{detailRows.length.toLocaleString("tr-TR")} kayıt gösteriliyor.</p>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={selectedCollector !== null} onOpenChange={(open) => {
        if (!open) {
          setSelectedCollectorId(null);
        }
      }}>
        <DialogContent className="max-h-[92vh] max-w-[min(1180px,calc(100vw-24px))] overflow-y-auto rounded-[24px] border border-sky-300/20 bg-[#061522] p-0 text-[#dce9f4]">
          <DialogHeader className="mb-0 border-b border-[#1a3348] bg-[linear-gradient(135deg,#0b2940,#071827)] px-6 py-5 pr-12">
            <DialogTitle className="text-2xl font-black text-white">{selectedCollector?.name ?? "İrsaliyeci Detayı"}</DialogTitle>
            <DialogDescription className="font-semibold text-[#8fa3b8]">
              Seçili tarih aralığındaki gerçek tahsilat performansı ve cari hareketleri
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 p-5">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {[
                ["Toplam", selectedCollector?.total ?? "0,00 ₺"],
                ["Nakit", selectedCollector?.cash ?? "0,00 ₺"],
                ["POS", selectedCollector?.pos ?? "0,00 ₺"],
                ["Fabrika Kart", selectedCollector?.factoryCard ?? "0,00 ₺"],
                ["İşlem", String(selectedCollector?.transactionCount ?? 0)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-2xl border border-[#1d3449] bg-[#0a1d2c] p-4">
                  <p className="text-[10px] font-black uppercase tracking-[0.1em] text-[#7890a8]">{label}</p>
                  <p className="mt-2 truncate text-lg font-black text-white">{value}</p>
                </div>
              ))}
            </div>

            <div className="grid gap-4 lg:grid-cols-[0.9fr_1.4fr]">
              <section className="rounded-2xl border border-[#1a3348] bg-[#071827] p-4">
                <h3 className="font-black text-white">En Çok Tahsilat Alınan Cariler</h3>
                <div className="mt-4 space-y-3">
                  {collectionCustomerRows.length === 0 ? (
                    <p className="py-8 text-center text-sm font-bold text-[#7890a8]">Bu dönemde cari tahsilatı yok.</p>
                  ) : collectionCustomerRows.slice(0, 10).map((row, index) => (
                    <div key={`${row.Cari}-${index}`} className="grid grid-cols-[minmax(0,1fr)_110px] items-center gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-black text-[#d6e3ef]">{row.Cari}</p>
                        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[#132c3f]">
                          <span className="block h-full rounded-full bg-[linear-gradient(90deg,#38bdf8,#4ade80)]" style={{ width: `${Math.max(12, 100 - index * 8)}%` }} />
                        </div>
                      </div>
                      <span className="truncate text-right text-xs font-black text-emerald-200">{row.Toplam}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="overflow-hidden rounded-2xl border border-[#1a3348] bg-[#071827]">
                <div className="border-b border-[#1a3348] px-4 py-3">
                  <h3 className="font-black text-white">Tahsilat Hareketleri</h3>
                </div>
                <div className="max-h-[360px] overflow-auto">
                  <table className="w-full min-w-[720px] text-left text-[11px]">
                    <thead className="sticky top-0 bg-[#0b2032] text-[10px] font-black uppercase text-[#8fa3b8]">
                      <tr>
                        <th className="px-3 py-2.5">Cari</th>
                        <th className="px-3 py-2.5">Tür</th>
                        <th className="px-3 py-2.5 text-right">Tutar</th>
                        <th className="px-3 py-2.5">Tarih</th>
                        <th className="px-3 py-2.5">Belge No</th>
                      </tr>
                    </thead>
                    <tbody>
                      {isAnyLoading ? (
                        <tr><td colSpan={5} className="px-4 py-10 text-center font-bold text-[#7890a8]"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Detay yükleniyor</td></tr>
                      ) : selectedCollectorTransactions.length === 0 ? (
                        <tr><td colSpan={5} className="px-4 py-10 text-center font-bold text-[#7890a8]">Tahsilat hareketi bulunamadı.</td></tr>
                      ) : selectedCollectorTransactions.map((row) => (
                        <tr key={`modal-${row.id}`} className="border-t border-[#132c3f] hover:bg-[#0b2132]">
                          <td className="max-w-64 truncate px-3 py-2.5 font-bold">{row.customer}</td>
                          <td className="px-3 py-2.5 font-black text-sky-200">{row.method}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-right font-black text-emerald-200">{row.amount}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 font-bold">{row.date}</td>
                          <td className="max-w-40 truncate px-3 py-2.5 font-bold">{row.reference}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
