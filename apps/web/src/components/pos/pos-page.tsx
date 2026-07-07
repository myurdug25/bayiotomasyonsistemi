"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import {
  Activity,
  Barcode,
  Check,
  CreditCard,
  History,
  Loader2,
  Minus,
  PackageSearch,
  Plus,
  Printer,
  RefreshCcw,
  ReceiptText,
  ShoppingCart,
  Search,
  Trash2,
  Users as UsersIcon,
  UserRound,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";

import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { notifyPosDayEndRefresh } from "@/lib/pos-day-end-events";
import {
  closePosSession,
  createCustomerCollection,
  createPosExpense,
  createPosSale,
  getCurrentPosSession,
  getPosSale,
  listCustomerCollections,
  listCustomerLedger,
  listPosExpenses,
  listPosCustomers,
  listPosSales,
  openPosSession,
  searchPosProductsQuick,
  type CollectionRecord,
  type CustomerListItem,
  type LedgerEntryDto,
  type PosDocumentType,
  type PosExpenseDto,
  type PosSaleDto,
  type PosSaleType,
  type ProductSearchItem,
} from "@/lib/api";
import { useSession } from "@/components/auth/session-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const QUICK_SEARCH_LIMIT = 20;
const CUSTOMER_LIMIT = 50;
const BATUM_POINT_DISPLAY_CURRENCY_LABEL = "GEL";
const ERZURUM_POINT_DISPLAY_CURRENCY_LABEL = "TL";
const BATUM_POINT_LEDGER_CURRENCY = "GEL";
const ERZURUM_POINT_LEDGER_CURRENCY = "TRY";
const DEFAULT_VAT_RATE = 20;
const RECEIPT_VAT_RATE_LABEL = "%20";
const POINT_ANONYMOUS_CUSTOMER_CODE = "POINT-CARISI-OLMAYAN";
const POINT_RESET_AFTER_SALE_STORAGE_KEY = "powersa:point-pos-reset-after-sale";
const POS_SAVE_AND_PRINT_LABEL = "Kaydet ve Yazdır";
const ERZURUM_POINT_SPECIAL_CODE = "D";
const POS_SALE_TYPE_OPTIONS: Array<{ value: PosSaleType; label: string }> = [
  { value: "cash", label: "Nakit" },
  { value: "card", label: "Kredi Kartı" },
  { value: "transfer", label: "Havale" },
];
const POINT_ANONYMOUS_SALE_TYPE_OPTIONS = POS_SALE_TYPE_OPTIONS.filter(
  (option) => option.value === "cash" || option.value === "card"
);
const POS_EXPENSE_CATEGORIES = ["Kargo", "Yol", "İkram", "Ofis", "Operasyon", "Diğer"] as const;
const POINT_COLLECTION_METHOD_OPTIONS = [
  { value: "cash", label: "Nakit" },
  { value: "cc", label: "Kredi Kartı" },
] as const;
const POINT_LEDGER_DATE_FORMATTER = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "medium",
});
type PosActionDialog = "session" | "sale" | "collection" | "expense";

const POINT_STOCK_COLUMNS = [
  { key: "erz-depo", label: "Erz. Depo", permissionKey: "search.stock.warehouse.erzurum_depo", aliases: ["1", "25", "genel", "erzurum", "erzurum dep", "erzurum depo", "erz depo", "erz. depo", "depo"] },
  { key: "erz-point", label: "Erz.Point", permissionKey: "search.stock.warehouse.erzurum_point", aliases: ["0", "erzurum point", "erz point", "erz.point", "point"] },
  { key: "trabzon", label: "Trabzon", permissionKey: "search.stock.warehouse.trabzon", aliases: ["2", "61", "trabzon dep", "trabzon depo", "trabzon", "trb"] },
  { key: "samsun", label: "Samsun", permissionKey: "search.stock.warehouse.samsun", aliases: ["3", "55", "samsun depo", "samsun", "sam"] },
  { key: "batum", label: "Batum", permissionKey: "search.stock.warehouse.batum", aliases: ["4", "batum depo", "batum", "batumi"] },
] as const;

const POINT_BATUM_PRODUCT_STOCK_COLUMNS = POINT_STOCK_COLUMNS.filter(
  (column) => column.key === "erz-depo" || column.key === "batum"
);

type PointStockColumn = (typeof POINT_STOCK_COLUMNS)[number];
type PointStockLocation = NonNullable<ProductSearchItem["stock_locations"]>[number];

function normalizePointStockText(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLocaleLowerCase("tr-TR")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ");
}

function includesBatum(value?: string | number | null): boolean {
  return String(value ?? "").trim().toLocaleUpperCase("tr-TR").includes("BATUM");
}

function productPointStockLocations(product: ProductSearchItem): PointStockLocation[] {
  if (product.stock_locations && product.stock_locations.length > 0) {
    return product.stock_locations;
  }

  return [
    {
      branch: "Genel",
      warehouse_code: null,
      stock: product.available_total,
      shelf_address: product.shelf_address ?? null,
    },
  ];
}

function pointStockRows(product: ProductSearchItem, columns: readonly PointStockColumn[]) {
  const locations = productPointStockLocations(product);

  return columns.map((column) => {
    const matchedLocations = locations.filter((location) => {
      const haystack = [
        normalizePointStockText(location.branch),
        normalizePointStockText(location.warehouse_code),
        normalizePointStockText(`${location.branch} ${location.warehouse_code ?? ""}`),
      ].filter(Boolean);

      return column.aliases.some((alias) => {
        const normalizedAlias = normalizePointStockText(alias);
        const numericAlias = /^\d+$/.test(normalizedAlias);

        return haystack.some((value) => (numericAlias ? value === normalizedAlias : value.includes(normalizedAlias)));
      });
    });
    const stock = matchedLocations.reduce((total, location) => total + location.stock, 0);
    const shelfAddress = matchedLocations.find((location) => location.shelf_address)?.shelf_address ?? null;

    return {
      ...column,
      stock: matchedLocations.length > 0 ? stock : null,
      shelfAddress,
    };
  });
}

function visiblePointStockColumns(featurePermissionSet: Set<string>, roleSlugs: string[]): readonly PointStockColumn[] {
  if (roleSlugs.includes("admin") || roleSlugs.includes("moderator")) {
    return POINT_STOCK_COLUMNS;
  }

  const selectedColumns = POINT_STOCK_COLUMNS.filter((column) => featurePermissionSet.has(column.permissionKey));

  return selectedColumns.length > 0 ? selectedColumns : POINT_STOCK_COLUMNS;
}

function getCustomerInitials(customer: Pick<CustomerListItem, "title" | "code">): string {
  const source = customer.title || customer.code;
  const parts = source
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) {
    return "C";
  }

  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("tr-TR") ?? "")
    .join("");
}

const posHeaderSchema = z.object({
  sale_type: z.enum(["cash", "card", "transfer"]),
  document_type: z.enum(["invoice", "delivery"]),
  customer_id: z.number().int().positive().nullable(),
});

const sessionOpenSchema = z.object({
  cashbox_id: z.number().int().positive().optional(),
  opening_cash: z.number().min(0),
});

const sessionCloseSchema = z.object({
  closing_cash_counted: z.number().min(0),
  note: z.string().max(255).optional(),
});

const paymentSchema = z.object({
  cash_received: z.number().min(0),
  reference_note: z.string().max(120).optional(),
});

const expenseSchema = z.object({
  amount: z.number().gt(0),
  category: z.string().trim().min(2).max(80),
  note: z.string().max(255).optional(),
});

const collectionSchema = z.object({
  method: z.enum(["cash", "cc"]),
  amount: z.number().gt(0),
  note: z.string().max(255).optional(),
  reference_no: z.string().max(120).optional(),
  card_holder: z.string().max(120).optional(),
  masked_pan: z.string().max(32).optional(),
  auth_code: z.string().max(64).optional(),
});

type PosHeaderFormValues = z.infer<typeof posHeaderSchema>;
type SessionOpenFormValues = z.infer<typeof sessionOpenSchema>;
type SessionCloseFormValues = z.infer<typeof sessionCloseSchema>;
type PaymentFormValues = z.infer<typeof paymentSchema>;
type ExpenseFormValues = z.infer<typeof expenseSchema>;
type CollectionFormValues = z.infer<typeof collectionSchema>;

type PosCartItem = {
  product_id: number;
  sku: string;
  oem: string | null;
  name: string;
  brand: string | null;
  available_total: number;
  shelf_address: string | null;
  qty: number;
  unit_price_cents: number;
  original_unit_price_cents: number;
  vat_rate: number;
};

type ReceiptPrintSaleItem = {
  sku?: string | null;
  name?: string | null;
  qty: string | number;
  unit_price: string | number;
  line_total: string | number;
};

type ReceiptPrintSale = {
  document_type: PosDocumentType;
  receipt_no: string;
  created_at: string;
  subtotal: string | number;
  discount_total: string | number;
  vat_total: string | number;
  grand_total: string | number;
  customer: {
    title?: string | null;
    code?: string | null;
  };
  items: ReceiptPrintSaleItem[];
};

function createEmptyPointCartItemsBySaleType(): Record<PosSaleType, PosCartItem[]> {
  return {
    cash: [],
    card: [],
    transfer: [],
  };
}

type MovementRow = {
  id: string;
  created_at: string;
  receipt_no: string;
  direction: "in" | "out";
  qty: string;
  status: string;
  customer: string;
};

function toCents(value: number): number {
  return Math.round(value * 100);
}

function fromCents(value: number): string {
  return (value / 100).toFixed(2);
}

function getMinimumEditablePriceCents(originalUnitPriceCents: number): number {
  return Math.round(originalUnitPriceCents * 0.9);
}

function formatPointAmount(value: number | string, currencyLabel = BATUM_POINT_DISPLAY_CURRENCY_LABEL): string {
  const amount = typeof value === "number" ? value : Number(value);

  return Number.isFinite(amount)
    ? `${currencyLabel} ${amount.toLocaleString("tr-TR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`
    : "-";
}

function formatPointAmountNumber(value: number | string, currencyLabel = BATUM_POINT_DISPLAY_CURRENCY_LABEL): string {
  const formatted = formatPointAmount(value, currencyLabel);

  return formatted.startsWith(`${currencyLabel} `)
    ? formatted.slice(currencyLabel.length + 1)
    : formatted;
}

function toPointLedgerAmount(value: string | number): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatPointLedgerAmount(
  value: string | number,
  currency: string,
  currencyLabel = BATUM_POINT_DISPLAY_CURRENCY_LABEL
): string {
  const amount = toPointLedgerAmount(value);
  const normalizedCurrency = currency.trim().toUpperCase();

  if (normalizedCurrency === "TRY" || normalizedCurrency === "GEL" || normalizedCurrency === "LARI") {
    return formatPointAmount(amount, currencyLabel);
  }

  return `${normalizedCurrency} ${amount.toLocaleString("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPointLedgerDate(value: string): string {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return POINT_LEDGER_DATE_FORMATTER.format(parsed);
}

function getPointLedgerTypeLabel(type: LedgerEntryDto["type"]): string {
  if (type === "invoice") {
    return "Fatura";
  }

  if (type === "payment") {
    return "Tahsilat";
  }

  if (type === "credit") {
    return "Alacak";
  }

  return "Borç";
}

function consumePointResetAfterSaleFlag(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const shouldReset = window.sessionStorage.getItem(POINT_RESET_AFTER_SALE_STORAGE_KEY) === "1";
    if (shouldReset) {
      window.sessionStorage.removeItem(POINT_RESET_AFTER_SALE_STORAGE_KEY);
    }

    return shouldReset;
  } catch {
    return false;
  }
}

function reloadPointPosAfterSale() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(POINT_RESET_AFTER_SALE_STORAGE_KEY, "1");
  } catch {
    // Reload is still useful even when session storage is unavailable.
  }

  window.setTimeout(() => window.location.reload(), 250);
}

function formatLogoOutboundStatus(status: string | null | undefined): string {
  if (status === "synced") {
    return "Logo işlendi";
  }

  if (status === "failed") {
    return "Logo hata";
  }

  if (status === "processing") {
    return "Logo işleniyor";
  }

  return "Logo bekliyor";
}

function normalizeCustomerText(value: string): string {
  return value
    .toLocaleUpperCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/İ/g, "I")
    .replace(/Ş/g, "S")
    .replace(/Ğ/g, "G")
    .replace(/Ü/g, "U")
    .replace(/Ö/g, "O")
    .replace(/Ç/g, "C")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLookupCode(value: string): string {
  return value.toLocaleUpperCase("tr-TR").replace(/\s+/g, "").trim();
}

function isLikelyPointStockCodeQuery(value: string): boolean {
  const normalized = normalizeLookupCode(value);

  return normalized.length >= 2 && /\d/.test(normalized) && /^[A-Z0-9._/\-]+$/.test(normalized);
}

function productMatchesPointStockCode(product: ProductSearchItem, rawQuery: string): boolean {
  const normalizedCodeQuery = normalizeLookupCode(rawQuery);

  if (normalizedCodeQuery === "") {
    return false;
  }

  const normalizedSku = normalizeLookupCode(product.sku);
  const normalizedOem = normalizeLookupCode(product.oem ?? "");

  return (
    normalizedSku === normalizedCodeQuery ||
    normalizedSku.includes(normalizedCodeQuery) ||
    (normalizedOem !== "" && (normalizedOem === normalizedCodeQuery || normalizedOem.includes(normalizedCodeQuery)))
  );
}

function isAnonymousPointCustomer(customer: CustomerListItem | null | undefined): boolean {
  if (!customer) {
    return false;
  }

  const normalizedCode = normalizeLookupCode(customer.code);
  const normalizedTitle = normalizeCustomerText(customer.title);

  return (
    normalizedCode === POINT_ANONYMOUS_CUSTOMER_CODE ||
    normalizedTitle.includes("CARISI OLMAYAN")
  );
}

function isVatIncludedPointCustomer(customer: CustomerListItem | null | undefined): boolean {
  if (!customer) {
    return false;
  }

  const haystack = normalizeCustomerText(`${customer.code} ${customer.title}`);
  return haystack.includes("SATIS") && (haystack.includes("NAKIT") || haystack.includes("KREDI"));
}

function normalizeVatRate(_value?: string | number | null): number {
  return DEFAULT_VAT_RATE;
}

function grossCentsFromNet(netCents: number, vatRate: number): number {
  return Math.round(netCents * (1 + vatRate / 100));
}

function netCentsFromGross(grossCents: number, vatRate: number): number {
  return Math.round(grossCents / (1 + vatRate / 100));
}

function displayPriceCents(unitNetPriceCents: number, vatRate: number, includesVat: boolean): number {
  return includesVat ? grossCentsFromNet(unitNetPriceCents, vatRate) : unitNetPriceCents;
}

function netPriceCentsFromDisplay(displayUnitPriceCents: number, vatRate: number, includesVat: boolean): number {
  return includesVat ? netCentsFromGross(displayUnitPriceCents, vatRate) : displayUnitPriceCents;
}

function formatPointProductDisplayPrice(
  product: ProductSearchItem,
  includesVat: boolean,
  currencyLabel = BATUM_POINT_DISPLAY_CURRENCY_LABEL
): string {
  const parsedNetPrice = Number(product.net_price ?? 0);
  const unitNetPriceCents = toCents(Number.isFinite(parsedNetPrice) ? parsedNetPrice : 0);
  const vatRate = normalizeVatRate(product.vat_rate);

  return formatPointAmount(fromCents(displayPriceCents(unitNetPriceCents, vatRate, includesVat)), currencyLabel);
}

function getPointSaleContextLabel(saleType: PosSaleType): string {
  if (saleType === "card") {
    return "BATUM PERAKENDE KREDİ KARTI SATIŞ";
  }

  if (saleType === "transfer") {
    return "BATUM DEPO (SİPARİŞ)";
  }

  return "BATUM PERAKENDE NAKİT SATIŞ";
}

function getNonBatumPointSaleContextLabel(saleType: PosSaleType): string {
  if (saleType === "card") {
    return "Kredi Kartı Satış";
  }

  if (saleType === "transfer") {
    return "Depo (Sipariş)";
  }

  return "Nakit Satış";
}

function resolvePointDefaultCustomerId(
  saleType: PosSaleType,
  customers: CustomerListItem[]
): number | null {
  if (!customers.length) {
    return null;
  }

  const normalized = customers.map((customer) => ({
    customer,
    haystack: normalizeCustomerText(`${customer.code} ${customer.title}`),
  }));

  const cashPatterns = ["POINT", "NAKIT", "POINT-NAKIT"];
  const cardPatterns = ["POINT", "KREDI", "KARTI", "POINT-KREDI-KARTI"];

  const patterns = saleType === "card" ? cardPatterns : cashPatterns;
  const exact = normalized.find(({ haystack }) => patterns.every((pattern) => haystack.includes(pattern)));

  if (exact) {
    return exact.customer.id;
  }

  const fallback = normalized.find(({ haystack }) =>
    saleType === "card" ? haystack.includes("KREDI") : haystack.includes("NAKIT")
  );

  return fallback?.customer.id ?? normalized[0].customer.id;
}

function resolveSaleTotals(
  items: PosCartItem[],
  rawDiscountCents: number,
  pricesIncludeVat = false,
  applyVat = true
) {
  const normalizedItems = items.map((item) => {
    const displayedLineTotalCents = displayPriceCents(item.unit_price_cents, item.vat_rate, pricesIncludeVat) * item.qty;
    const lineTotalCents = pricesIncludeVat
      ? netCentsFromGross(displayedLineTotalCents, item.vat_rate)
      : item.unit_price_cents * item.qty;

    return {
      ...item,
      line_total_cents: lineTotalCents,
      displayed_line_total_cents: displayedLineTotalCents,
    };
  });

  const subtotalCents = normalizedItems.reduce((sum, item) => sum + item.line_total_cents, 0);
  const discountTotalCents = Math.max(0, Math.min(rawDiscountCents, subtotalCents));

  let remainingDiscount = discountTotalCents;
  let vatTotalCents = 0;

  const pricedItems = normalizedItems.map((item, index) => {
    const isLast = index === normalizedItems.length - 1;

    let lineDiscountCents = 0;
    if (discountTotalCents > 0 && subtotalCents > 0) {
      lineDiscountCents = isLast
        ? remainingDiscount
        : Math.floor((item.line_total_cents / subtotalCents) * discountTotalCents);
    }

    remainingDiscount -= lineDiscountCents;

    const taxBaseCents = Math.max(0, item.line_total_cents - lineDiscountCents);
    const effectiveVatRate = applyVat ? item.vat_rate : 0;
    const lineVatCents = pricesIncludeVat && applyVat && discountTotalCents === 0
      ? Math.max(0, item.displayed_line_total_cents - taxBaseCents)
      : Math.round(taxBaseCents * (effectiveVatRate / 100));

    vatTotalCents += lineVatCents;

    return {
      ...item,
      line_discount_cents: lineDiscountCents,
      line_vat_cents: lineVatCents,
      tax_base_cents: taxBaseCents,
      vat_rate: effectiveVatRate,
    };
  });

  const grandTotalCents = pricesIncludeVat && applyVat && discountTotalCents === 0
    ? normalizedItems.reduce((sum, item) => sum + item.displayed_line_total_cents, 0)
    : subtotalCents - discountTotalCents + vatTotalCents;

  return {
    items: pricedItems,
    subtotalCents,
    discountTotalCents,
    vatTotalCents,
    grandTotalCents,
  };
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function formatReceiptAmount(value: string | number, currencyLabel = BATUM_POINT_DISPLAY_CURRENCY_LABEL): string {
  const amount = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(amount)) {
    return "-";
  }

  const formatted = amount.toLocaleString("tr-TR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
  const suffix = currencyLabel === ERZURUM_POINT_DISPLAY_CURRENCY_LABEL ? "₺" : currencyLabel;

  return `${formatted} ${suffix}`;
}

function formatReceiptDate(value: string): string {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleDateString("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function generatePointReceiptNo(): string {
  const now = new Date();
  const pad = (value: number) => value.toString().padStart(2, "0");
  const timestamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase().padEnd(5, "X");

  return `POS-${timestamp}-${suffix}`;
}

function escapeReceiptText(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function printHtmlDocument(html: string) {
  if (typeof window === "undefined") {
    return;
  }

  const frame = window.document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  frame.style.opacity = "0";
  frame.style.pointerEvents = "none";

  const cleanup = () => {
    window.setTimeout(() => {
      frame.remove();
    }, 250);
  };

  frame.onload = () => {
    const printWindow = frame.contentWindow;

    if (!printWindow) {
      cleanup();
      toast.error("Yazdırma penceresi hazırlanamadı.");
      return;
    }

    printWindow.focus();
    printWindow.print();
    cleanup();
  };

  window.document.body.appendChild(frame);
  const printDocument = frame.contentDocument;

  if (!printDocument) {
    cleanup();
    toast.error("Yazdırma penceresi hazırlanamadı.");
    return;
  }

  printDocument.open();
  printDocument.write(html);
  printDocument.close();
}

function openReceiptPrintWindow(
  sale: ReceiptPrintSale,
  currencyLabel = BATUM_POINT_DISPLAY_CURRENCY_LABEL,
  selectedCustomer?: CustomerListItem | null
) {
  if (typeof window === "undefined") {
    return;
  }

  const documentLabel = sale.document_type === "delivery" ? "Sevk İrsaliyesi" : "POS Fişi";
  const receiptTitle = sale.receipt_no ? `${documentLabel} - ${sale.receipt_no}` : documentLabel;
  const customerTitle = selectedCustomer?.title ?? sale.customer.title ?? sale.customer.code ?? "-";
  const customerAddress = [
    selectedCustomer?.district,
    selectedCustomer?.city,
  ].filter(Boolean).join(" / ");
  const receiptSubtotal = Math.max(0, Number(sale.subtotal) - Number(sale.discount_total));

  const lines = sale.items
    .map(
      (item) => `
        <div class="table-row">
          <div class="sku">${escapeReceiptText(item.sku ?? item.name ?? "-")}</div>
          <div class="qty">${escapeReceiptText(item.qty)}</div>
          <div class="price">${formatReceiptAmount(item.unit_price, currencyLabel)}</div>
          <div class="line-total">${formatReceiptAmount(item.line_total, currencyLabel)}</div>
        </div>
      `
    )
    .join("");

  printHtmlDocument(`
    <html>
      <head>
        <title>${escapeReceiptText(receiptTitle)}</title>
        <style>
          @page { size: 90mm 110mm portrait; margin: 0; }
          * { box-sizing: border-box; }
          html {
            width: 90mm;
            min-width: 90mm;
            max-width: 90mm;
            height: 110mm;
            min-height: 110mm;
            max-height: 110mm;
            margin: 0;
            background: #fff;
          }
          body {
            width: 90mm;
            min-width: 90mm;
            max-width: 90mm;
            height: 110mm;
            min-height: 110mm;
            max-height: 110mm;
            margin: 0;
            padding: 0;
            color: #111;
            background: #fff;
            font-family: "Courier New", Courier, monospace;
            font-size: 10.8px;
            font-weight: 900;
            line-height: 1.22;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
            user-select: none;
          }
          .receipt {
            position: relative;
            width: 90mm;
            height: 110mm;
            margin: 0 auto;
            padding: 7mm 7mm 5mm;
            overflow: hidden;
            user-select: none;
          }
          .top { display: grid; grid-template-columns: minmax(0,1fr) 28mm; column-gap: 4mm; align-items: start; }
          .customer { min-height: 14mm; font-size: 12.4px; font-weight: 900; line-height: 1.18; letter-spacing: 0.01em; text-transform: uppercase; word-break: break-word; }
          .meta { padding-top: 0.4mm; text-align: left; font-size: 10.6px; font-weight: 900; line-height: 1.5; white-space: nowrap; }
          .meta div:empty { display: none; }
          .address { min-height: 8mm; margin-top: 8mm; padding-bottom: 1.6mm; border-bottom: 1px dashed #111; white-space: pre-line; text-transform: uppercase; }
          .items-table { width: 100%; margin-top: 3.2mm; }
          .table-head, .table-row { display: grid; grid-template-columns: 29mm 8mm 18mm 21mm; column-gap: 0; align-items: baseline; }
          .table-head { border-bottom: 1.5px solid #111; padding-bottom: 1mm; font-size: 10.4px; font-weight: 900; }
          .table-row { padding: 1mm 0 0.8mm; font-size: 11.8px; font-weight: 900; line-height: 1.1; }
          .table-row + .table-row { border-top: 1px dotted #999; }
          .sku { overflow-wrap: anywhere; }
          .qty { text-align: right; }
          .price { padding-left: 1.8mm; text-align: right; white-space: nowrap; }
          .line-total { padding-left: 2.4mm; text-align: right; white-space: nowrap; }
          .bottom { position: absolute; right: 7mm; bottom: 5mm; left: 33mm; display: block; }
          .totals { display: grid; gap: 1.1mm; border-top: 1.5px solid #111; padding-top: 1.5mm; font-weight: 900; }
          .total-line { display: grid; grid-template-columns: 1fr 20mm; gap: 3mm; white-space: nowrap; }
          .total-line span:last-child { text-align: right; }
          .grand { border-top: 1.5px solid #111; margin-top: 0.6mm; padding-top: 1mm; font-size: 11.5px; font-weight: 900; }
          @media screen {
            html { width: 100%; height: 100%; min-width: 0; max-width: none; min-height: 100%; max-height: none; }
            body { width: 100%; height: auto; min-width: 0; max-width: none; min-height: 100%; max-height: none; display: flex; justify-content: center; align-items: flex-start; background: #d7d9dd; padding: 14px 0; overflow: auto; }
            .receipt { flex: 0 0 auto; background: #fff; box-shadow: 0 0 0 1px #c9ccd2, 0 18px 42px rgba(15, 23, 42, 0.18); }
          }
          @media print {
            @page { size: 90mm 110mm portrait; margin: 0; }
            html, body {
              width: 90mm !important;
              min-width: 90mm !important;
              max-width: 90mm !important;
              height: 110mm !important;
              min-height: 110mm !important;
              max-height: 110mm !important;
              margin: 0 !important;
              overflow: hidden !important;
              background: #fff;
            }
            body { padding: 0; }
            .receipt {
              width: 90mm !important;
              min-width: 90mm !important;
              max-width: 90mm !important;
              height: 110mm !important;
              min-height: 110mm !important;
              max-height: 110mm !important;
              box-shadow: none;
              margin: 0;
            }
          }
        </style>
      </head>
      <body>
        <div class="receipt">
          <div class="top">
            <div class="customer">${escapeReceiptText(customerTitle)}</div>
            <div class="meta">
              <div>${formatReceiptDate(sale.created_at)}</div>
              <div>${escapeReceiptText(sale.receipt_no)}</div>
            </div>
          </div>
          <div class="address">${escapeReceiptText(customerAddress)}</div>
          <div class="items-table">
            <div class="table-head">
              <div class="sku">Stok Kodu</div>
              <div class="qty">Adet</div>
              <div class="price">Fiyat</div>
              <div class="line-total">Tutar</div>
            </div>
            <div>${lines}</div>
          </div>
          <div class="bottom">
            <div class="totals">
              <div class="total-line"><span>Toplam</span><span>${formatReceiptAmount(receiptSubtotal, currencyLabel)}</span></div>
              <div class="total-line"><span>KDV (${RECEIPT_VAT_RATE_LABEL})</span><span>${formatReceiptAmount(sale.vat_total, currencyLabel)}</span></div>
              <div class="total-line grand"><span>Genel Toplam</span><span>${formatReceiptAmount(sale.grand_total, currencyLabel)}</span></div>
            </div>
          </div>
        </div>
      </body>
    </html>
  `);
}

function openLinePrintWindow(item: PosCartItem, currencyLabel = BATUM_POINT_DISPLAY_CURRENCY_LABEL) {
  if (typeof window === "undefined") {
    return;
  }

  printHtmlDocument(`
    <html>
      <head>
        <title>Ürün Etiketi</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 14px; }
          .title { font-weight: 700; font-size: 15px; margin-bottom: 4px; }
          .meta { font-size: 12px; margin-bottom: 2px; }
          .price { margin-top: 8px; font-size: 18px; font-weight: 700; }
        </style>
      </head>
      <body>
        <div class="title">${item.name}</div>
        <div class="meta">SKU: ${item.sku}</div>
        <div class="meta">OEM: ${item.oem ?? "-"}</div>
        <div class="meta">Stok: ${item.available_total}</div>
        <div class="price">${formatPointAmount(item.unit_price_cents / 100, currencyLabel)}</div>
      </body>
    </html>
  `);
}

export function PosPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, selectCustomer: syncContextCustomer } = useSession();
  const quickInputRef = useRef<HTMLInputElement | null>(null);
  const pointProductCodeInputRef = useRef<HTMLInputElement | null>(null);
  const pointQtyInputRef = useRef<HTMLInputElement | null>(null);
  const pointPriceInputRef = useRef<HTMLInputElement | null>(null);
  const customerListScrollRef = useRef<HTMLDivElement | null>(null);
  const customerListLoadMoreRef = useRef<HTMLDivElement | null>(null);
  const pointPrintAfterSaveRef = useRef(false);
  const pointSessionBootstrapAttemptedRef = useRef(false);
  const roleSlugs = useMemo(() => user?.roles.map((role) => role.slug) ?? [], [user?.roles]);
  const featurePermissionSet = useMemo(() => new Set(user?.feature_permissions ?? []), [user?.feature_permissions]);
  const hasPointRole = roleSlugs.includes("point");
  const hasPosMenuPermission = user?.menu_permissions?.includes("pos") ?? false;
  const isAdminRole = roleSlugs.includes("admin");
  const canAccessPosExpenses = isAdminRole || (user?.menu_permissions?.includes("pos-expenses") ?? false);
  const canAccessPosDayEnd = isAdminRole || (user?.menu_permissions?.includes("pos-day-end") ?? false);
  const hasStandalonePosMenuAccess =
    hasPosMenuPermission && !roleSlugs.some((role) => role === "admin" || role === "dealer_admin" || role === "cashier");
  const usePointSpecificPosFlow = true;
  const isPointRole = usePointSpecificPosFlow && (hasPointRole || hasStandalonePosMenuAccess);
  const isBatumPointFlowByUser = useMemo(
    () =>
      [
        user?.branch_code,
        user?.branch_name,
        user?.region_code,
        user?.region_name,
      ].some(includesBatum),
    [user?.branch_code, user?.branch_name, user?.region_code, user?.region_name]
  );
  const visiblePointProductStockColumns = useMemo(() => {
    const permittedColumns = visiblePointStockColumns(featurePermissionSet, roleSlugs);

    if (!isPointRole || !isBatumPointFlowByUser) {
      return permittedColumns;
    }

    const permittedKeys = new Set(permittedColumns.map((column) => column.key));
    const scopedColumns = POINT_BATUM_PRODUCT_STOCK_COLUMNS.filter((column) => permittedKeys.has(column.key));

    return scopedColumns.length > 0 ? scopedColumns : POINT_BATUM_PRODUCT_STOCK_COLUMNS;
  }, [featurePermissionSet, isPointRole, isBatumPointFlowByUser, roleSlugs]);
  const canAccessPos =
    hasPointRole ||
    hasPosMenuPermission ||
    roleSlugs.some((role) => role === "admin" || role === "dealer_admin" || role === "cashier");
  const isErzurumPointFlow = canAccessPos && !isBatumPointFlowByUser;
  const erzurumPointCustomerParams = isErzurumPointFlow
    ? { specode4: ERZURUM_POINT_SPECIAL_CODE }
    : null;

  const [quickQuery, setQuickQuery] = useState("");
  const [activeQuickIndex, setActiveQuickIndex] = useState(0);
  const [quickQtyInput, setQuickQtyInput] = useState("1");
  const [cartItems, setCartItems] = useState<PosCartItem[]>([]);
  const [pointCartItemsBySaleType, setPointCartItemsBySaleType] = useState<Record<PosSaleType, PosCartItem[]>>(
    () => createEmptyPointCartItemsBySaleType()
  );
  const [discountInput, setDiscountInput] = useState("0");
  const [rememberedCustomers, setRememberedCustomers] = useState<CustomerListItem[]>([]);
  const [pointProductCodeInput, setPointProductCodeInput] = useState("");
  const [pointQtyInput, setPointQtyInput] = useState("1");
  const [pointPriceInput, setPointPriceInput] = useState("");
  const [pointCartPriceInputs, setPointCartPriceInputs] = useState<Record<number, string>>({});
  const [pointFocusedInput, setPointFocusedInput] = useState<"qty" | "price" | null>(null);
  const [pointReceiptNoInput, setPointReceiptNoInput] = useState("");
  const [pointProductLookupPending, setPointProductLookupPending] = useState(false);
  const [pointDraftProduct, setPointDraftProduct] = useState<ProductSearchItem | null>(null);
  const [pointProductDialogOpen, setPointProductDialogOpen] = useState(false);
  const [pointProductDialogQuery, setPointProductDialogQuery] = useState("");
  const [activePointCartProductId, setActivePointCartProductId] = useState<number | null>(null);
  const [clock, setClock] = useState(() => new Date());

  const [customerDialogOpen, setCustomerDialogOpen] = useState(false);
  const [customerQuery, setCustomerQuery] = useState("");
  const [manualCustomerOverride, setManualCustomerOverride] = useState(() => consumePointResetAfterSaleFlag());

  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [pointLedgerDialogOpen, setPointLedgerDialogOpen] = useState(false);
  const [closeSessionDialogOpen, setCloseSessionDialogOpen] = useState(false);
  const [posActionDialog, setPosActionDialog] = useState<PosActionDialog | null>(null);
  const [pointSaveResult, setPointSaveResult] = useState<PosSaleDto | null>(null);

  const [movementProduct, setMovementProduct] = useState<PosCartItem | null>(null);

  const posForm = useForm<PosHeaderFormValues>({
    resolver: zodResolver(posHeaderSchema),
    defaultValues: {
      sale_type: "cash",
      document_type: "invoice",
      customer_id: null,
    },
  });

  const openSessionForm = useForm<SessionOpenFormValues>({
    resolver: zodResolver(sessionOpenSchema),
    defaultValues: {
      cashbox_id: undefined,
      opening_cash: 0,
    },
  });

  const closeSessionForm = useForm<SessionCloseFormValues>({
    resolver: zodResolver(sessionCloseSchema),
    defaultValues: {
      closing_cash_counted: 0,
      note: "",
    },
  });

  const paymentForm = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentSchema),
    defaultValues: {
      cash_received: 0,
      reference_note: "",
    },
  });

  const expenseForm = useForm<ExpenseFormValues>({
    resolver: zodResolver(expenseSchema),
    defaultValues: {
      amount: 0,
      category: "Operasyon",
      note: "",
    },
  });

  const collectionForm = useForm<CollectionFormValues>({
    resolver: zodResolver(collectionSchema),
    defaultValues: {
      method: "cash",
      amount: 0,
      note: "",
      reference_no: "",
      card_holder: "",
      masked_pan: "",
      auth_code: "",
    },
  });

  const saleType = useWatch({ control: posForm.control, name: "sale_type" });
  const documentType = useWatch({ control: posForm.control, name: "document_type" });
  const selectedCustomerId = useWatch({ control: posForm.control, name: "customer_id" });
  const expenseCategory = useWatch({ control: expenseForm.control, name: "category" });
  const collectionMethod = useWatch({ control: collectionForm.control, name: "method" });

  const debouncedQuickQuery = useDebouncedValue(quickQuery, 120);
  const debouncedPointProductDialogQuery = useDebouncedValue(pointProductDialogQuery, 180);
  const debouncedCustomerQuery = useDebouncedValue(customerQuery, 300);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 30_000);

    return () => window.clearInterval(timer);
  }, []);

  const currentSessionQuery = useQuery({
    queryKey: ["pos", "session", "current"],
    queryFn: () => getCurrentPosSession(),
    refetchInterval: 20_000,
    enabled: canAccessPos,
  });

  const posExpensesQuery = useQuery({
    queryKey: ["pos", "expenses", currentSessionQuery.data?.data?.id ?? null],
    queryFn: () =>
      listPosExpenses({
        pos_session_id: currentSessionQuery.data?.data?.id ?? undefined,
        limit: 50,
      }),
    enabled: canAccessPos && canAccessPosExpenses && !isPointRole && Boolean(currentSessionQuery.data?.data?.id),
    refetchInterval: 20_000,
  });

  const selectedCustomerCollectionsQuery = useQuery({
    queryKey: ["pos", "customer-collections", selectedCustomerId ?? null],
    queryFn: () => {
      if (!selectedCustomerId) {
        throw new Error("No selected customer");
      }

      return listCustomerCollections(selectedCustomerId, { per_page: 5 });
    },
    enabled: canAccessPos && !isPointRole && Boolean(selectedCustomerId),
    refetchInterval: 20_000,
  });

  const pointCustomersQuery = useQuery({
    queryKey: [
      "pos",
      isPointRole || isErzurumPointFlow ? "dealer-customers" : "point-customers",
      isErzurumPointFlow ? `special-customer:${ERZURUM_POINT_SPECIAL_CODE}` : "no-special-customer",
    ],
    queryFn: () =>
      listPosCustomers(
        isPointRole || isErzurumPointFlow
          ? {
              limit: CUSTOMER_LIMIT,
              ...(erzurumPointCustomerParams ?? {}),
            }
          : { q: "POINT", limit: CUSTOMER_LIMIT }
      ),
    staleTime: 120_000,
    enabled: canAccessPos,
  });
  const effectivePosDealerId =
    user?.dealer_id ??
    pointCustomersQuery.data?.data.find((customer) => customer.id === selectedCustomerId)?.dealer_id ??
    pointCustomersQuery.data?.data[0]?.dealer_id ??
    undefined;

  const customerSearchQuery = useInfiniteQuery({
    queryKey: [
      "pos",
      "customers",
      debouncedCustomerQuery,
      isErzurumPointFlow ? `special-customer:${ERZURUM_POINT_SPECIAL_CODE}` : "no-special-customer",
    ],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listPosCustomers({
        q: debouncedCustomerQuery || undefined,
        cursor: pageParam ?? undefined,
        limit: CUSTOMER_LIMIT,
        ...(erzurumPointCustomerParams ?? {}),
      }),
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled: canAccessPos && customerDialogOpen,
    refetchOnWindowFocus: false,
  });

  const quickSearchQuery = useQuery({
    queryKey: ["pos", "quick-search", debouncedQuickQuery],
    queryFn: () =>
      searchPosProductsQuick({
        q: debouncedQuickQuery,
        dealer_id: effectivePosDealerId,
        in_stock: false,
        limit: QUICK_SEARCH_LIMIT,
      }),
    enabled: canAccessPos && debouncedQuickQuery.trim().length >= 2,
    staleTime: 20_000,
  });

  const pointProductDialogSearchQuery = useQuery({
    queryKey: ["pos", "point-product-dialog-search", debouncedPointProductDialogQuery],
    queryFn: () =>
      searchPosProductsQuick({
        q: debouncedPointProductDialogQuery.trim(),
        dealer_id: effectivePosDealerId,
        in_stock: false,
        limit: QUICK_SEARCH_LIMIT,
      }),
    enabled:
      canAccessPos &&
      isPointRole &&
      pointProductDialogOpen &&
      debouncedPointProductDialogQuery.trim().length >= 2,
    staleTime: 20_000,
  });

  const movementQuery = useQuery({
    queryKey: ["pos", "stock-movements", movementProduct?.product_id],
    enabled: canAccessPos && Boolean(movementProduct),
    queryFn: async (): Promise<MovementRow[]> => {
      if (!movementProduct) {
        return [];
      }

      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - 30);

      const list = await listPosSales({
        date_from: fromDate.toISOString().slice(0, 10),
        limit: 30,
      });

      const details = await Promise.all(
        list.data.slice(0, 20).map(async (sale) => {
          try {
            return (await getPosSale(sale.id)).data;
          } catch {
            return null;
          }
        })
      );

      const rows: MovementRow[] = [];
      for (const sale of details) {
        if (!sale) {
          continue;
        }

        for (const item of sale.items) {
          if (item.product_id !== movementProduct.product_id) {
            continue;
          }

          rows.push({
            id: `${sale.id}-${item.id}`,
            created_at: sale.created_at,
            receipt_no: sale.receipt_no,
            direction: sale.status === "cancelled" ? "in" : "out",
            qty: item.qty,
            status: sale.status,
            customer: sale.customer.title ?? sale.customer.code ?? "-",
          });
        }
      }

      return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    },
    refetchInterval: 15_000,
  });

  const openSessionMutation = useMutation({
    mutationFn: openPosSession,
    onSuccess: (response) => {
      if (!isPointRole) {
        toast.success(`POS oturumu açıldı (#${response.data.id})`);
      }
      void currentSessionQuery.refetch();
      void posExpensesQuery.refetch();
    },
    onError: (error) => {
      const message = isPointRole
        ? "Hızlı satış oturumu hazırlanamadı. Açık kasa varsa gün sonunu kapatıp yeniden deneyin."
        : error instanceof Error
          ? error.message
          : "POS oturumu açılamadı";
      toast.error(message);
    },
  });

  const closeSessionMutation = useMutation({
    mutationFn: closePosSession,
    onSuccess: () => {
      toast.success("POS oturumu kapatıldı");
      setCloseSessionDialogOpen(false);
      closeSessionForm.reset({ closing_cash_counted: 0, note: "" });
      void currentSessionQuery.refetch();
      void posExpensesQuery.refetch();
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "POS oturumu kapatılamadı";
      toast.error(message);
    },
  });

  const createSaleMutation = useMutation({
    mutationFn: createPosSale,
    onSuccess: (response) => {
      const shouldPrintAfterSave = pointPrintAfterSaveRef.current;

      if (isPointRole) {
        toast.success("Satış kaydedildi. Gün sonu raporuna işlendi.");
      } else {
        toast.success(
          `${response.data.document_type === "delivery" ? "İrsaliye hazır" : "Satış tamamlandı"}: ${response.data.receipt_no} · ${formatLogoOutboundStatus(response.data.logo_sync_status)}`
        );
      }
      setCartItems([]);
      setPointCartItemsBySaleType(createEmptyPointCartItemsBySaleType());
      setDiscountInput("0");
      setQuickQuery("");
      setActiveQuickIndex(0);
      setPointDraftProduct(null);
      setPointProductCodeInput("");
      setPointQtyInput("1");
      setPointPriceInput("");
      setPointCartPriceInputs({});
      setPointReceiptNoInput("");
      setPaymentDialogOpen(false);
      paymentForm.reset({ cash_received: 0, reference_note: "" });
      notifyPosDayEndRefresh("sale", response.data.session.id);
      void queryClient.invalidateQueries({ queryKey: ["pos", "day-end"] });
      void queryClient.invalidateQueries({ queryKey: ["pos", "session", "current"] });

      if (shouldPrintAfterSave) {
        openReceiptPrintWindow(response.data, pointDisplayCurrencyLabel, selectedCustomer);
      }

      pointPrintAfterSaveRef.current = false;
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "POS satış kaydı başarısız";
      toast.error(message);
    },
  });

  const createExpenseMutation = useMutation({
    mutationFn: createPosExpense,
    onSuccess: (response) => {
      toast.success(`Masraf kaydedildi: ${response.data.category} · ${formatLogoOutboundStatus(response.data.logo_sync_status)}`);
      expenseForm.reset({
        amount: 0,
        category: expenseForm.getValues("category") || "Operasyon",
        note: "",
      });
      void posExpensesQuery.refetch();
      notifyPosDayEndRefresh("expense", response.data.pos_session_id);
      void queryClient.invalidateQueries({ queryKey: ["pos", "day-end"] });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Masraf kaydı başarısız";
      toast.error(message);
    },
  });

  const createCollectionMutation = useMutation({
    mutationFn: ({
      customerId,
      payload,
    }: {
      customerId: number;
      payload: Parameters<typeof createCustomerCollection>[1];
    }) => createCustomerCollection(customerId, payload),
    onSuccess: async () => {
      toast.success("Tahsilat kaydedildi, cari bakiyesinden düşüldü.");
      collectionForm.reset({
        method: collectionForm.getValues("method") || "cash",
        amount: 0,
        note: "",
        reference_no: "",
        card_holder: "",
        masked_pan: "",
        auth_code: "",
      });
      await Promise.all([
        selectedCustomerCollectionsQuery.refetch(),
        pointCustomersQuery.refetch(),
        customerSearchQuery.refetch(),
      ]);
      notifyPosDayEndRefresh("collection", currentSession?.id ?? null);
      void queryClient.invalidateQueries({ queryKey: ["pos", "day-end"] });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Tahsilat kaydı başarısız";
      toast.error(message);
    },
  });

  const currentSession = currentSessionQuery.data?.data ?? null;

  useEffect(() => {
    if (!user || canAccessPos) {
      return;
    }

    router.replace(roleSlugs.includes("salesperson") ? "/dashboard" : "/dashboard");
  }, [canAccessPos, roleSlugs, router, user]);

  const shouldRedirectFromPos = Boolean(user) && !canAccessPos;

  const recentExpenses = useMemo<PosExpenseDto[]>(
    () => posExpensesQuery.data?.data ?? [],
    [posExpensesQuery.data?.data]
  );
  const expenseTotal = useMemo(
    () => recentExpenses.reduce((sum, expense) => sum + Number(expense.amount ?? 0), 0),
    [recentExpenses]
  );
  const recentCollections = useMemo<CollectionRecord[]>(
    () => selectedCustomerCollectionsQuery.data?.data ?? [],
    [selectedCustomerCollectionsQuery.data?.data]
  );
  const customerCollectionTotal = useMemo(
    () => recentCollections.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
    [recentCollections]
  );

  const pointCustomers = useMemo(() => pointCustomersQuery.data?.data ?? [], [pointCustomersQuery.data?.data]);
  const searchCustomers = useMemo(
    () => customerSearchQuery.data?.pages.flatMap((page) => page.data) ?? [],
    [customerSearchQuery.data?.pages]
  );
  const customerSearchTotal = customerSearchQuery.data?.pages[0]?.total_count ?? null;

  const customersById = useMemo(() => {
    const map: Record<number, CustomerListItem> = {};
    for (const customer of rememberedCustomers) {
      map[customer.id] = customer;
    }
    for (const customer of pointCustomers) {
      map[customer.id] = customer;
    }
    for (const customer of searchCustomers) {
      map[customer.id] = customer;
    }
    return map;
  }, [pointCustomers, rememberedCustomers, searchCustomers]);

  const defaultCustomerBySaleType = useMemo(() => {
    const cashId = resolvePointDefaultCustomerId("cash", pointCustomers);
    const cardId = resolvePointDefaultCustomerId("card", pointCustomers);

    if (isPointRole) {
      const anonymousId = pointCustomers.find((customer) => isAnonymousPointCustomer(customer))?.id ?? null;

      return {
        cash: anonymousId ?? cashId,
        card: anonymousId ?? cardId,
        transfer: anonymousId ?? cashId,
      } as Record<PosSaleType, number | null>;
    }

    return {
      cash: cashId,
      card: cardId,
      transfer: cashId,
    } as Record<PosSaleType, number | null>;
  }, [isPointRole, pointCustomers]);

  useEffect(() => {
    if (isPointRole || manualCustomerOverride) {
      return;
    }

    const defaultCustomerId = defaultCustomerBySaleType[saleType];
    if (!defaultCustomerId || selectedCustomerId === defaultCustomerId) {
      return;
    }

    posForm.setValue("customer_id", defaultCustomerId, { shouldDirty: true, shouldValidate: true });
  }, [defaultCustomerBySaleType, isPointRole, manualCustomerOverride, posForm, saleType, selectedCustomerId]);

  useEffect(() => {
    if (selectedCustomerId) {
      const customer = customersById[selectedCustomerId] ?? null;
      if (customer && !isAnonymousPointCustomer(customer)) {
        posForm.setValue("document_type", "delivery", { shouldDirty: true, shouldValidate: true });
      } else {
        posForm.setValue("document_type", "invoice", { shouldDirty: true, shouldValidate: true });
      }
    } else {
      posForm.setValue("document_type", "invoice", { shouldDirty: true, shouldValidate: true });
    }
  }, [selectedCustomerId, posForm, customersById]);

  const selectedCustomer = selectedCustomerId ? customersById[selectedCustomerId] ?? null : null;
  const selectedCustomerIsAnonymous = isPointRole && isAnonymousPointCustomer(selectedCustomer);
  const isBatumPointFlow = isPointRole && (
    isBatumPointFlowByUser ||
    Boolean(
      selectedCustomer &&
        ([
          selectedCustomer.branch_code,
          selectedCustomer.branch_name,
          selectedCustomer.region_code,
          selectedCustomer.region_name,
          selectedCustomer.title,
        ].some(includesBatum) || selectedCustomer.code?.trim().startsWith("120-00-") === true)
    )
  );
  const pointSaleAppliesVat = Boolean(selectedCustomer) && !selectedCustomerIsAnonymous;
  const pointPriceIncludesVat = pointSaleAppliesVat && isVatIncludedPointCustomer(selectedCustomer);
  const pointDisplayCurrencyLabel = isBatumPointFlow
    ? BATUM_POINT_DISPLAY_CURRENCY_LABEL
    : ERZURUM_POINT_DISPLAY_CURRENCY_LABEL;
  const pointLedgerCurrency = isBatumPointFlow ? BATUM_POINT_LEDGER_CURRENCY : ERZURUM_POINT_LEDGER_CURRENCY;
  const formatCurrency = useCallback(
    (value: number | string) => formatPointAmount(value, pointDisplayCurrencyLabel),
    [pointDisplayCurrencyLabel]
  );
  const formatPointCurrencyNumber = useCallback(
    (value: number | string) => formatPointAmountNumber(value, pointDisplayCurrencyLabel),
    [pointDisplayCurrencyLabel]
  );
  const formatPointLedgerCurrency = useCallback(
    (value: string | number, currency: string) => formatPointLedgerAmount(value, currency, pointDisplayCurrencyLabel),
    [pointDisplayCurrencyLabel]
  );
  const pointLedgerQuery = useQuery({
    queryKey: ["pos", "point-ledger", selectedCustomer?.id ?? null],
    queryFn: () => {
      if (!selectedCustomer) {
        throw new Error("Cari seçilmedi");
      }

      return listCustomerLedger(selectedCustomer.id, { per_page: 25 });
    },
    enabled: canAccessPos && pointLedgerDialogOpen && Boolean(selectedCustomer),
    staleTime: 30_000,
    refetchInterval: 15_000,
  });
  const pointLedgerRows = useMemo(
    () => pointLedgerQuery.data?.data ?? [],
    [pointLedgerQuery.data?.data]
  );
  const pointLedgerSaleRows = useMemo(
    () => pointLedgerRows.filter((row) => row.type === "invoice" || row.type === "debit"),
    [pointLedgerRows]
  );
  const pointLedgerCollectionRows = useMemo(
    () => pointLedgerRows.filter((row) => row.type === "payment" || row.type === "credit"),
    [pointLedgerRows]
  );
  const renderPointLedgerTableBody = (rows: LedgerEntryDto[], emptyMessage: string) => {
    if (pointLedgerQuery.isLoading) {
      return Array.from({ length: 5 }).map((_, index) => (
        <TableRow key={`ledger-skeleton-${index}`} className="border-[#1e342b]">
          <TableCell colSpan={7}>
            <Skeleton className="h-9 w-full rounded-xl bg-[#173421]" />
          </TableCell>
        </TableRow>
      ));
    }

    if (pointLedgerQuery.isError) {
      return (
        <TableRow className="border-[#1e342b]">
          <TableCell colSpan={7} className="h-28 text-center text-sm font-bold text-red-200">
            Cari hareketler alınamadı. Yenile ile tekrar deneyin.
          </TableCell>
        </TableRow>
      );
    }

    if (!selectedCustomer) {
      return (
        <TableRow className="border-[#1e342b]">
          <TableCell colSpan={7} className="h-28 text-center text-sm font-bold text-[#8fa394]">
            Önce cari seçin.
          </TableCell>
        </TableRow>
      );
    }

    if (rows.length === 0) {
      return (
        <TableRow className="border-[#1e342b]">
          <TableCell colSpan={7} className="h-28 text-center text-sm font-bold text-[#8fa394]">
            {emptyMessage}
          </TableCell>
        </TableRow>
      );
    }

    return rows.map((row) => (
      <TableRow key={row.id} className="border-[#1e342b] hover:bg-[#102018]">
        <TableCell className="whitespace-nowrap font-bold text-[#e6f3e9]">
          {formatPointLedgerDate(row.date)}
        </TableCell>
        <TableCell>
          <Badge className="border-[#5f7f44] bg-[#1b3a24] text-[#faee56] hover:bg-[#1b3a24]">
            {getPointLedgerTypeLabel(row.type)}
          </Badge>
        </TableCell>
        <TableCell className="max-w-[260px] truncate font-semibold text-[#c2d3c6]">
          {row.description ?? "-"}
        </TableCell>
        <TableCell className="whitespace-nowrap font-semibold text-[#8fa394]">
          {row.reference_no ?? "-"}
        </TableCell>
        <TableCell className="whitespace-nowrap text-right font-black text-red-200">
          {toPointLedgerAmount(row.debit) > 0 ? formatPointLedgerCurrency(row.debit, row.currency) : "-"}
        </TableCell>
        <TableCell className="whitespace-nowrap text-right font-black text-[#91d39a]">
          {toPointLedgerAmount(row.credit) > 0 ? formatPointLedgerCurrency(row.credit, row.currency) : "-"}
        </TableCell>
        <TableCell className="whitespace-nowrap text-right font-black text-white">
          {formatPointLedgerCurrency(row.balance_after, row.currency)}
        </TableCell>
      </TableRow>
    ));
  };

  useEffect(() => {
    if (!selectedCustomerIsAnonymous || saleType !== "transfer") {
      return;
    }

    posForm.setValue("sale_type", "cash", {
      shouldDirty: true,
      shouldValidate: true,
    });
  }, [posForm, saleType, selectedCustomerIsAnonymous]);

  useEffect(() => {
    if (collectionMethod !== "cash") {
      return;
    }

    collectionForm.setValue("card_holder", "", { shouldDirty: false });
    collectionForm.setValue("masked_pan", "", { shouldDirty: false });
    collectionForm.setValue("auth_code", "", { shouldDirty: false });
  }, [collectionForm, collectionMethod]);

  const quickProducts = useMemo(
    () => quickSearchQuery.data?.data ?? [],
    [quickSearchQuery.data?.data]
  );
  const pointProductDialogProducts = useMemo(() => {
    const products = pointProductDialogSearchQuery.data?.data ?? [];
    const query = debouncedPointProductDialogQuery.trim();

    if (!isLikelyPointStockCodeQuery(query)) {
      return products;
    }

    return [...products].sort((left, right) => {
      const leftExact = productMatchesPointStockCode(left, query);
      const rightExact = productMatchesPointStockCode(right, query);

      if (leftExact === rightExact) {
        return 0;
      }

      return leftExact ? -1 : 1;
    });
  }, [debouncedPointProductDialogQuery, pointProductDialogSearchQuery.data?.data]);
  const pointProductDialogGridTemplate = useMemo(
    () => `150px minmax(240px,1fr) ${visiblePointProductStockColumns.map(() => "112px").join(" ")} 110px`,
    [visiblePointProductStockColumns]
  );
  const pointProductDialogGridMinWidth = 500 + visiblePointProductStockColumns.length * 112;
  const activeCartItems = isPointRole ? pointCartItemsBySaleType[saleType] ?? [] : cartItems;
  const visibleCartItems = useMemo(
    () => activeCartItems.filter((item) => item.qty > 0),
    [activeCartItems]
  );

  const normalizedActiveQuickIndex = quickProducts.length
    ? Math.min(activeQuickIndex, quickProducts.length - 1)
    : 0;

  const rawDiscountCents = useMemo(() => {
    const parsed = Number(discountInput.replace(",", "."));
    return toCents(Number.isFinite(parsed) ? parsed : 0);
  }, [discountInput]);

  const totals = useMemo(
    () => resolveSaleTotals(visibleCartItems, rawDiscountCents, pointPriceIncludesVat, pointSaleAppliesVat),
    [pointPriceIncludesVat, pointSaleAppliesVat, visibleCartItems, rawDiscountCents]
  );
  const cartLineCount = visibleCartItems.length;
  const cartQtyTotal = useMemo(
    () => visibleCartItems.reduce((sum, item) => sum + item.qty, 0),
    [visibleCartItems]
  );
  const pointSaleContextLabel = useMemo(
    () => (isBatumPointFlow ? getPointSaleContextLabel(saleType) : getNonBatumPointSaleContextLabel(saleType)),
    [isBatumPointFlow, saleType]
  );
  const pointDisplayedProductName = pointDraftProduct?.name ?? "";
  const pointDisplayedProductShelf = pointDraftProduct?.shelf_address ?? null;
  const pointDisplayedProductStock = pointDraftProduct?.available_total ?? null;

  useEffect(() => {
    setPointCartPriceInputs({});

    if (pointDraftProduct) {
      const parsedNetPrice = Number(pointDraftProduct.net_price ?? 0);
      const unitNetPriceCents = toCents(Number.isFinite(parsedNetPrice) ? parsedNetPrice : 0);
      const vatRate = normalizeVatRate(pointDraftProduct.vat_rate);
      setPointPriceInput(fromCents(displayPriceCents(unitNetPriceCents, vatRate, pointPriceIncludesVat)).replace(".", ","));
    } else {
      setPointPriceInput("");
    }
  }, [pointDraftProduct, pointPriceIncludesVat]);
  useEffect(() => {
    if (!isPointRole) {
      return;
    }

    setPointCartPriceInputs({});
    setActivePointCartProductId(null);
  }, [isPointRole, saleType]);
  const pointDraftLineTotal = useMemo(() => {
    const qty = Number(pointQtyInput.replace(",", "."));
    const price = Number(pointPriceInput.replace(",", "."));

    if (!Number.isFinite(qty) || !Number.isFinite(price)) {
      return 0;
    }

    return Math.max(0, qty) * Math.max(0, price);
  }, [pointPriceInput, pointQtyInput]);
  const pointClockLabel = useMemo(
    () =>
      clock.toLocaleString("tr-TR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [clock]
  );

  const canSubmitSale = Boolean(currentSession && selectedCustomer && visibleCartItems.length > 0);
  const quickQty = useMemo(() => {
    const parsed = Number(quickQtyInput.replace(",", "."));
    return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : 1;
  }, [quickQtyInput]);
  const isMutating =
    createSaleMutation.isPending ||
    createExpenseMutation.isPending ||
    createCollectionMutation.isPending ||
    openSessionMutation.isPending ||
    closeSessionMutation.isPending ||
    currentSessionQuery.isFetching;

  const updateActiveCartItems = useCallback(
    (updater: (previous: PosCartItem[]) => PosCartItem[]) => {
      if (isPointRole) {
        setPointCartItemsBySaleType((previous) => ({
          ...previous,
          [saleType]: updater(previous[saleType] ?? []),
        }));
        return;
      }

      setCartItems(updater);
    },
    [isPointRole, saleType]
  );

  useEffect(() => {
    if (!isPointRole) {
      return;
    }

    if (currentSession) {
      pointSessionBootstrapAttemptedRef.current = true;
      return;
    }

    if (currentSessionQuery.isFetching || openSessionMutation.isPending) {
      return;
    }

    if (pointSessionBootstrapAttemptedRef.current) {
      return;
    }

    pointSessionBootstrapAttemptedRef.current = true;

    void openSessionMutation.mutateAsync({
      opening_cash: 0,
    });
  }, [currentSession, currentSessionQuery.isFetching, isPointRole, openSessionMutation]);

  const upsertCartItem = useCallback(
    (
      product: ProductSearchItem,
      options?: {
        qty?: number;
        unitPriceCents?: number;
      }
    ) => {
      if (product.available_total <= 0) {
        toast.warning("Stok bilgisi sıfır görünüyor; ürün sepete eklendi.");
      }

      const fallbackUnitPrice = Number(product.net_price ?? 0);
      const vatRate = normalizeVatRate(product.vat_rate);
      const resolvedUnitPriceCents =
        options?.unitPriceCents ?? (Number.isFinite(fallbackUnitPrice) ? toCents(fallbackUnitPrice) : null);

      if (resolvedUnitPriceCents === null) {
        toast.error("Ürün fiyatı okunamadı");
        return;
      }

      const qtyToAdd = Math.max(1, Math.trunc(options?.qty ?? 1));

      updateActiveCartItems((previous) => {
        const existingIndex = previous.findIndex((item) => item.product_id === product.id);
        if (existingIndex === -1) {
          return [
            {
              product_id: product.id,
              sku: product.sku,
              oem: product.oem ?? null,
              name: product.name,
              brand: product.brand.name ?? null,
              available_total: product.available_total,
              shelf_address: product.shelf_address ?? null,
              qty: qtyToAdd,
              unit_price_cents: resolvedUnitPriceCents,
              original_unit_price_cents: resolvedUnitPriceCents,
              vat_rate: vatRate,
            },
            ...previous,
          ];
        }

        const next = [...previous];
        const existing = next[existingIndex];
        next[existingIndex] = {
          ...existing,
          qty: existing.qty + qtyToAdd,
          unit_price_cents: resolvedUnitPriceCents,
          original_unit_price_cents: resolvedUnitPriceCents,
          vat_rate: vatRate,
          available_total: product.available_total,
          shelf_address: product.shelf_address ?? existing.shelf_address,
        };
        return next;
      });

      setQuickQuery("");
      setActiveQuickIndex(0);
      quickInputRef.current?.focus();
    },
    [updateActiveCartItems]
  );

  const changeQty = useCallback((productId: number, delta: number) => {
    updateActiveCartItems((previous) => {
      const next = previous
        .map((item) => {
          if (item.product_id !== productId) {
            return item;
          }

          const updated = item.qty + delta;
          const clamped = Math.max(0, updated);
          return {
            ...item,
            qty: clamped,
          };
        })
        .filter((item) => item.qty > 0);

      return next;
    });
  }, [updateActiveCartItems]);

  const setItemQty = useCallback((productId: number, qty: number) => {
    const nextQty = Math.max(1, Math.trunc(qty));

    updateActiveCartItems((previous) =>
      previous.map((item) =>
        item.product_id === productId
          ? {
              ...item,
              qty: nextQty,
            }
          : item
      )
    );
  }, [updateActiveCartItems]);

  const setItemUnitPriceCents = useCallback((productId: number, unitPriceCents: number) => {
    const nextUnitPriceCents = Math.max(0, Math.trunc(unitPriceCents));

    updateActiveCartItems((previous) =>
      previous.map((item) =>
        item.product_id === productId
          ? {
              ...item,
              unit_price_cents: nextUnitPriceCents,
            }
          : item
      )
    );
  }, [updateActiveCartItems]);

  const removeItem = useCallback((productId: number) => {
    updateActiveCartItems((previous) => previous.filter((item) => item.product_id !== productId));
    setPointCartPriceInputs((previous) => {
      const next = { ...previous };
      delete next[productId];
      return next;
    });
    setActivePointCartProductId((current) => (current === productId ? null : current));
  }, [updateActiveCartItems]);

  const addQuickProduct = useCallback(
    (product: ProductSearchItem) => {
      upsertCartItem(product, { qty: quickQty });
      setQuickQtyInput("1");
    },
    [quickQty, upsertCartItem]
  );

  const selectPointDraftProduct = useCallback(
    (product: ProductSearchItem) => {
      const parsedNetPrice = Number(product.net_price ?? 0);
      const unitNetPriceCents = toCents(Number.isFinite(parsedNetPrice) ? parsedNetPrice : 0);
      const vatRate = normalizeVatRate(product.vat_rate);

      setPointDraftProduct(product);
      setActivePointCartProductId(product.id);
      setPointProductCodeInput(product.sku);
      setPointQtyInput("1");
      setPointPriceInput(fromCents(displayPriceCents(unitNetPriceCents, vatRate, pointPriceIncludesVat)).replace(".", ","));
      window.setTimeout(() => {
        pointQtyInputRef.current?.focus();
        pointQtyInputRef.current?.select();
      }, 30);
    },
    [pointPriceIncludesVat]
  );

  const openPointProductDialog = useCallback(() => {
    setPointProductDialogQuery(pointProductCodeInput.trim());
    setPointProductDialogOpen(true);
  }, [pointProductCodeInput]);

  const selectPointProductFromDialog = useCallback(
    (product: ProductSearchItem) => {
      selectPointDraftProduct(product);
      setPointProductDialogOpen(false);
    },
    [selectPointDraftProduct]
  );

  const handlePointProductCodeChange = useCallback(
    (value: string) => {
      setPointProductCodeInput(value);

      if (!pointDraftProduct) {
        return;
      }

      const nextCode = normalizeLookupCode(value);
      const draftSku = normalizeLookupCode(pointDraftProduct.sku);
      const draftOem = normalizeLookupCode(pointDraftProduct.oem ?? "");

      if (nextCode === draftSku || (draftOem !== "" && nextCode === draftOem)) {
        return;
      }

      setPointDraftProduct(null);
      setPointPriceInput("");
    },
    [pointDraftProduct]
  );

  const onQuickKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!quickProducts.length) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveQuickIndex((prev) => (prev + 1) % quickProducts.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveQuickIndex((prev) => (prev - 1 + quickProducts.length) % quickProducts.length);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const selected = quickProducts[normalizedActiveQuickIndex] ?? quickProducts[0];
      if (selected) {
        addQuickProduct(selected);
      }
      return;
    }

    if (event.key === "Escape") {
      setQuickQuery("");
    }
  };

  const openPaymentModal = useCallback((options?: { printAfterSave?: boolean }) => {
    if (!canSubmitSale) {
      toast.error("Önce oturum, cari ve ürün satırlarını tamamlayın.");
      return;
    }

    pointPrintAfterSaveRef.current = Boolean(options?.printAfterSave);
    paymentForm.reset({
      cash_received: totals.grandTotalCents / 100,
      reference_note: "",
    });
    setPaymentDialogOpen(true);
  }, [canSubmitSale, paymentForm, totals.grandTotalCents]);

  const submitExpense = expenseForm.handleSubmit(async (values) => {
    if (!canAccessPosExpenses) {
      toast.error("Masraf kaydı için yetkiniz yok.");
      return;
    }

    if (!currentSession) {
      toast.error("Önce açık POS oturumu oluşturun.");
      return;
    }

    await createExpenseMutation.mutateAsync({
      pos_session_id: currentSession.id,
      amount: values.amount,
      category: values.category.trim(),
      note: values.note?.trim() || undefined,
    });
  });

  const submitCollection = collectionForm.handleSubmit(async (values) => {
    if (!currentSession) {
      toast.error("Önce açık POS oturumu oluşturun.");
      return;
    }

    if (!selectedCustomer || selectedCustomerIsAnonymous) {
      toast.error("Tahsilat için cari hesabı olan bir müşteri seçin.");
      return;
    }

    const referenceFields: Record<string, string | number> = {};
    if (values.method === "cc") {
      if (!values.card_holder?.trim() || !values.masked_pan?.trim() || !values.auth_code?.trim()) {
        toast.error("Kredi kartı tahsilatında kart bilgileri zorunlu.");
        return;
      }

      referenceFields.card_holder = values.card_holder.trim();
      referenceFields.masked_pan = values.masked_pan.trim();
      referenceFields.auth_code = values.auth_code.trim();
    }

    await createCollectionMutation.mutateAsync({
      customerId: selectedCustomer.id,
      payload: {
        method: values.method,
        amount: values.amount,
        currency: pointLedgerCurrency,
        date: new Date().toISOString().slice(0, 10),
        note: values.note?.trim() || undefined,
        reference_no: values.reference_no?.trim() || undefined,
        reference_fields: Object.keys(referenceFields).length > 0 ? referenceFields : undefined,
        meta: {
          source: "point_collection",
          pos_session_id: currentSession.id,
          cashbox_id: currentSession.cashbox.id ?? null,
        },
      },
    });
  });

  useEffect(() => {
    if (customerDialogOpen || pointProductDialogOpen || paymentDialogOpen || closeSessionDialogOpen || posActionDialog || movementProduct) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (isPointRole) {
        if (selectedCustomer) {
          pointProductCodeInputRef.current?.focus();
        }
        return;
      }

      quickInputRef.current?.focus();
    }, 60);

    return () => window.clearTimeout(timer);
  }, [closeSessionDialogOpen, customerDialogOpen, isPointRole, movementProduct, paymentDialogOpen, pointProductDialogOpen, posActionDialog, selectedCustomer]);

  useEffect(() => {
    const onGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.key === "/" && !isEditableTarget(event.target)) {
        event.preventDefault();
        if (isPointRole) {
          pointProductCodeInputRef.current?.focus();
          return;
        }

        quickInputRef.current?.focus();
        return;
      }

      if (event.key === "F9") {
        event.preventDefault();
        openPaymentModal();
      }
    };

    window.addEventListener("keydown", onGlobalKeyDown);
    return () => window.removeEventListener("keydown", onGlobalKeyDown);
  }, [canSubmitSale, isPointRole, openPaymentModal]);

  const submitSale = paymentForm.handleSubmit(async (values) => {
    const formValues = posForm.getValues();
    const resolved = posHeaderSchema.safeParse(formValues);

    if (!resolved.success) {
      toast.error("Satış formunu kontrol edin.");
      return;
    }

    const currentSessionResult = await currentSessionQuery.refetch();
    let effectiveCurrentSession = currentSessionResult.data?.data ?? currentSession;

    if (!effectiveCurrentSession && isPointRole) {
      const openedSession = await openSessionMutation.mutateAsync({
        opening_cash: 0,
      });
      effectiveCurrentSession = openedSession.data;
    }

    if (!effectiveCurrentSession || effectiveCurrentSession.status !== "open") {
      toast.error("Açık POS oturumu yok.");
      return;
    }

    if (!resolved.data.customer_id) {
      toast.error("Cari seçimi zorunludur.");
      return;
    }

    if (totals.items.length === 0) {
      toast.error("En az bir ürün ekleyin.");
      return;
    }

    if (selectedCustomerIsAnonymous && resolved.data.sale_type === "transfer") {
      toast.error("Carisi olmayan satış sadece nakit veya kredi kartı ile tamamlanabilir.");
      return;
    }

    const grandTotal = totals.grandTotalCents / 100;
    if (resolved.data.sale_type === "cash" && values.cash_received < grandTotal) {
      paymentForm.setError("cash_received", {
        type: "manual",
        message: "Nakit alınan tutar genel toplamdan küçük olamaz.",
      });
      return;
    }

    const meta: Record<string, unknown> = {};
    if (resolved.data.sale_type === "cash") {
      meta.cash_received = Number(values.cash_received.toFixed(2));
      meta.change = Number((values.cash_received - grandTotal).toFixed(2));
    }

    if (values.reference_note?.trim()) {
      meta.reference_note = values.reference_note.trim();
    }

    await createSaleMutation.mutateAsync({
      pos_session_id: effectiveCurrentSession.id,
      customer_id: resolved.data.customer_id,
      sale_type: resolved.data.sale_type,
      document_type: resolved.data.document_type,
      receipt_no: pointReceiptNoInput.trim() !== "" ? pointReceiptNoInput.trim() : undefined,
      discount_total: Number(fromCents(totals.discountTotalCents)),
      items: totals.items.map((item) => ({
        product_id: item.product_id,
        qty: item.qty,
        unit_price: Number(fromCents(item.unit_price_cents)),
        line_total: Number(fromCents(item.line_total_cents)),
        vat_rate: pointSaleAppliesVat ? item.vat_rate : 0,
      })),
      payments: [
        {
          method: resolved.data.sale_type,
          amount: Number(fromCents(totals.grandTotalCents)),
          meta_json: Object.keys(meta).length > 0 ? meta : undefined,
        },
      ],
    });
  });

  const printPointDraftDirectly = useCallback(() => {
    if (!canSubmitSale) {
      toast.error("Önce oturum, cari ve ürün satırlarını tamamlayın.");
      return;
    }

    const receiptNo = pointReceiptNoInput.trim() || generatePointReceiptNo();
    if (pointReceiptNoInput.trim() === "") {
      setPointReceiptNoInput(receiptNo);
    }

    const draftSale: ReceiptPrintSale = {
      document_type: documentType,
      receipt_no: receiptNo,
      created_at: new Date().toISOString(),
      subtotal: fromCents(totals.subtotalCents),
      discount_total: fromCents(totals.discountTotalCents),
      vat_total: fromCents(totals.vatTotalCents),
      grand_total: fromCents(totals.grandTotalCents),
      customer: {
        title: selectedCustomer?.title ?? null,
        code: selectedCustomer?.code ?? null,
      },
      items: visibleCartItems.map((item) => ({
        sku: item.sku,
        name: item.name,
        qty: item.qty,
        unit_price: fromCents(item.unit_price_cents),
        line_total: fromCents(item.unit_price_cents * item.qty),
      })),
    };

    openReceiptPrintWindow(draftSale, pointDisplayCurrencyLabel, selectedCustomer);
  }, [canSubmitSale, documentType, pointDisplayCurrencyLabel, pointReceiptNoInput, selectedCustomer, totals.discountTotalCents, totals.grandTotalCents, totals.subtotalCents, totals.vatTotalCents, visibleCartItems]);

  const submitPointSaleDirectly = useCallback(async () => {
    if (!canSubmitSale) {
      toast.error("Önce oturum, cari ve ürün satırlarını tamamlayın.");
      return;
    }

    pointPrintAfterSaveRef.current = false;
    paymentForm.reset({
      cash_received: totals.grandTotalCents / 100,
      reference_note: "",
    });

    await submitSale();

    if (typeof window !== "undefined" && window.location.pathname !== "/pos") {
      window.history.replaceState(null, "", "/pos");
    }
  }, [canSubmitSale, paymentForm, submitSale, totals.grandTotalCents]);

  const handleOpenSession = openSessionForm.handleSubmit(async (values) => {
    await openSessionMutation.mutateAsync(values);
  });

  const handleCloseSession = closeSessionForm.handleSubmit(async (values) => {
    await closeSessionMutation.mutateAsync({
      cashbox_id: currentSession?.cashbox.id ?? undefined,
      closing_cash_counted: values.closing_cash_counted,
      note: values.note,
    });
  });

  const rememberCustomer = useCallback((customer: CustomerListItem) => {
    setRememberedCustomers((previous) =>
      previous.some((item) => item.id === customer.id) ? previous : [customer, ...previous]
    );
  }, []);

  const handleSelectCustomer = useCallback(
    (
      customer: CustomerListItem,
      options?: {
        closeDialog?: boolean;
        showToast?: boolean;
        manualOverride?: boolean;
      }
    ) => {
      const closeDialog = options?.closeDialog ?? true;
      const showToast = options?.showToast ?? true;
      const manualOverride = options?.manualOverride ?? true;

      rememberCustomer(customer);
      posForm.setValue("customer_id", customer.id, { shouldDirty: true, shouldValidate: true });
      setManualCustomerOverride(manualOverride);

      if (closeDialog) {
        setCustomerDialogOpen(false);
      }

      if (isPointRole) {
        void syncContextCustomer(customer.id).catch(() => undefined);
        window.setTimeout(() => pointProductCodeInputRef.current?.focus(), 10);
      }

      if (showToast) {
        toast.success(`${customer.code} seçildi`);
      }
    },
    [isPointRole, posForm, rememberCustomer, syncContextCustomer]
  );

  const selectAnonymousPointCustomer = useCallback(async () => {
    const existingCustomer =
      [selectedCustomer, ...rememberedCustomers, ...pointCustomers, ...searchCustomers].find((customer) =>
        isAnonymousPointCustomer(customer)
      ) ?? null;

    if (existingCustomer) {
      handleSelectCustomer(existingCustomer, {
        closeDialog: false,
        showToast: false,
        manualOverride: true,
      });
      toast.success("Carisi olmayan müşteri seçildi");
      window.setTimeout(() => pointProductCodeInputRef.current?.focus(), 10);
      return;
    }

    try {
      const response = await listPosCustomers({ q: POINT_ANONYMOUS_CUSTOMER_CODE, limit: 10 });
      const match = response.data.find((customer) => isAnonymousPointCustomer(customer)) ?? null;

      if (!match) {
        toast.error("Carisi olmayan müşteri kaydı bulunamadı.");
        return;
      }

      handleSelectCustomer(match, {
        closeDialog: false,
        showToast: false,
        manualOverride: true,
      });
      toast.success("Carisi olmayan müşteri seçildi");
      window.setTimeout(() => pointProductCodeInputRef.current?.focus(), 10);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Özel müşteri seçilemedi";
      toast.error(message);
    }
  }, [handleSelectCustomer, pointCustomers, rememberedCustomers, searchCustomers, selectedCustomer]);

  const lookupPointProduct = useCallback(async () => {
    if (pointProductLookupPending) {
      return;
    }

    const rawQuery = pointProductCodeInput.trim();
    const normalizedQuery = normalizeLookupCode(rawQuery);
    if (normalizedQuery === "") {
      toast.error("Stok kodu girin.");
      return;
    }

    if (!isLikelyPointStockCodeQuery(rawQuery)) {
      toast.error("Sadece stok kodu girin. Ürün adı ile aramak için seçim butonunu kullanın.");
      return;
    }

    setPointProductLookupPending(true);

    try {
      const response = await searchPosProductsQuick({
        q: rawQuery,
        dealer_id: effectivePosDealerId,
        in_stock: false,
        limit: 5,
        code_only: true,
      });

      const match = response.data.find((product) => productMatchesPointStockCode(product, rawQuery)) ?? null;

      if (!match) {
        toast.error("Yazılan stok koduyla tam eşleşen ürün bulunamadı.");
        return;
      }

      selectPointDraftProduct(match);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ürün aranamadı";
      toast.error(message);
    } finally {
      setPointProductLookupPending(false);
    }
  }, [effectivePosDealerId, pointProductCodeInput, pointProductLookupPending, selectPointDraftProduct]);

  const addPointDraftLine = useCallback(() => {
    if (!pointDraftProduct) {
      toast.error("Önce stok kodu ile ürünü çağırın veya seçim penceresinden ürün seçin.");
      return;
    }

    const qty = Number(pointQtyInput.replace(",", "."));
    const price = Number(pointPriceInput.replace(",", "."));

    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error("Geçerli miktar girin.");
      return;
    }

    if (!Number.isFinite(price) || price < 0) {
      toast.error("Geçerli fiyat girin.");
      return;
    }

    const vatRate = normalizeVatRate(pointDraftProduct.vat_rate);
    const unitNetPriceCents = netPriceCentsFromDisplay(toCents(price), vatRate, pointPriceIncludesVat);

    upsertCartItem(pointDraftProduct, {
      qty: Math.trunc(qty),
      unitPriceCents: unitNetPriceCents,
    });

    setActivePointCartProductId(pointDraftProduct.id);
    setPointDraftProduct(null);
    setPointProductCodeInput("");
    setPointQtyInput("1");
    setPointPriceInput("");
    window.setTimeout(() => pointProductCodeInputRef.current?.focus(), 10);
  }, [pointDraftProduct, pointPriceIncludesVat, pointPriceInput, pointQtyInput, upsertCartItem]);

  const restoreDefaultCustomer = () => {
    const candidate = defaultCustomerBySaleType[saleType];
    if (!candidate) {
      toast.error("Bu satış tipi için varsayılan POS carisi bulunamadı.");
      return;
    }

    setManualCustomerOverride(false);
    posForm.setValue("customer_id", candidate, { shouldDirty: true, shouldValidate: true });
    toast.success("Varsayılan POS carisine dönüldü.");
  };

  const customerOptions = useMemo(() => {
    if (!customerDialogOpen) {
      return [];
    }

    const unique = new Map<number, CustomerListItem>();

    for (const customer of rememberedCustomers) {
      unique.set(customer.id, customer);
    }

    if (debouncedCustomerQuery.trim() === "") {
      for (const customer of pointCustomers) {
        unique.set(customer.id, customer);
      }
    }

    for (const customer of searchCustomers) {
      unique.set(customer.id, customer);
    }

    return Array.from(unique.values());
  }, [customerDialogOpen, debouncedCustomerQuery, pointCustomers, rememberedCustomers, searchCustomers]);

  useEffect(() => {
    if (!customerDialogOpen || !customerSearchQuery.hasNextPage || customerSearchQuery.isFetchingNextPage) {
      return;
    }

    const marker = customerListLoadMoreRef.current;
    if (!marker) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && customerSearchQuery.hasNextPage && !customerSearchQuery.isFetchingNextPage) {
          void customerSearchQuery.fetchNextPage();
        }
      },
      {
        root: customerListScrollRef.current,
        rootMargin: "420px 0px",
        threshold: 0,
      },
    );

    observer.observe(marker);

    return () => observer.disconnect();
  }, [customerDialogOpen, customerSearchQuery]);

  const pointOrderStyle = useCallback(
    (order: number) => (isPointRole ? { order } : undefined),
    [isPointRole]
  );

  const posPanelClassName =
    "overflow-hidden border-[var(--brand-border)] bg-[linear-gradient(180deg,var(--surface)_0%,var(--surface-soft)_100%)] shadow-[0_22px_48px_-34px_rgba(10,32,20,0.36)]";
  const posLargeButtonClassName =
    "h-20 rounded-3xl border-[var(--brand-border)] bg-[var(--surface)] text-base font-extrabold text-[var(--brand-primary-strong)] hover:border-[var(--brand-primary)] hover:bg-[var(--surface-soft)]";
  const scrollToPosSection = (id: string) => {
    const dialogBySectionId: Record<string, PosActionDialog> = {
      "pos-session": "session",
      "pos-expense": "expense",
      "pos-collection": "collection",
      "point-sales": "sale",
    };
    const dialog = dialogBySectionId[id];

    if (dialog) {
      setPosActionDialog(dialog);
      return;
    }

    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const totalsPanel = (
    <Card
      className={cn(
        !isPointRole && posPanelClassName,
        isPointRole &&
          "overflow-hidden border-[var(--brand-border)] bg-[linear-gradient(180deg,var(--surface)_0%,var(--surface-soft)_100%)] shadow-[0_26px_60px_-38px_rgba(10,32,20,0.48)]"
      )}
    >
      <CardHeader className={cn("pb-3", isPointRole && "border-b border-[var(--brand-border)] bg-[var(--surface)] pb-4")}>
        <CardTitle className="flex items-center gap-2 text-xl font-black">
          <CreditCard className="h-5 w-5" />
          Toplam
        </CardTitle>
      </CardHeader>
      <CardContent className={cn("space-y-4", isPointRole && "space-y-4 p-5")}>
        <div className="rounded-3xl border border-[var(--brand-border)] bg-[var(--surface)] p-5">
          <p className="text-sm font-bold text-[var(--muted-foreground)]">Genel Toplam</p>
          <p className="mt-2 text-4xl font-black tracking-tight text-[var(--brand-primary-strong)]">
            {formatCurrency(fromCents(totals.grandTotalCents))}
          </p>
          <p className="mt-3 inline-flex items-center gap-1.5 text-sm font-bold text-[var(--muted-foreground)]">
            <Activity className="h-4 w-4" />
            {cartLineCount} kalem · {cartQtyTotal} adet
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
          <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--surface)] p-3">
            <p className="text-xs font-bold text-[var(--muted-foreground)]">İskonto</p>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={discountInput}
              onChange={(event) => setDiscountInput(event.target.value)}
              className="mt-2 h-12 rounded-xl text-lg font-black"
            />
          </div>

          <div className="space-y-2 rounded-2xl border border-[var(--brand-border)] bg-[var(--surface)] p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-[var(--muted-foreground)]">Ara Toplam</span>
              <span className="font-bold">{formatCurrency(fromCents(totals.subtotalCents))}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[var(--muted-foreground)]">İskonto</span>
              <span className="font-bold">{formatCurrency(fromCents(totals.discountTotalCents))}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[var(--muted-foreground)]">KDV</span>
              <span className="font-bold">{formatCurrency(fromCents(totals.vatTotalCents))}</span>
            </div>
          </div>
        </div>

        <Button className="h-16 w-full rounded-2xl text-base font-black" onClick={() => openPaymentModal()} disabled={!canSubmitSale || isMutating}>
          {createSaleMutation.isPending ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : saleType === "cash" ? (
            <Wallet className="h-5 w-5" />
          ) : (
            <CreditCard className="h-5 w-5" />
          )}
          {isPointRole
            ? selectedCustomerIsAnonymous
              ? documentType === "delivery"
                ? "Kaydet ve İrsaliyeyi Yazdır (F9)"
                : "Kaydet ve Faturayı Yazdır (F9)"
              : documentType === "delivery"
                ? "Kaydet ve İrsaliyeyi Yazdır (F9)"
                : "Kaydet ve Faturayı Yazdır (F9)"
            : POS_SAVE_AND_PRINT_LABEL}
        </Button>
      </CardContent>
    </Card>
  );

  const pointQuickSalesShell = (children: ReactNode) => (
    <div
      className="point-sale-screen point-sale-embedded point-sale-fit-screen space-y-4 text-[#eef8ef]"
      data-point-theme="dark"
    >
      {children}
    </div>
  );

  const pointRetailContent = (
    <div className="space-y-5">
      <header className="grid gap-4 rounded-[22px] border border-[var(--brand-border)] bg-[var(--surface)] p-5 shadow-[0_24px_58px_-44px_rgba(10,32,20,0.62)] xl:grid-cols-[minmax(0,1fr)_360px] xl:items-center">
        <div className="min-w-0">
          <p className="text-[12px] font-black uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
            Perakende POS
          </p>
          <h1 className="mt-1 text-3xl font-black tracking-tight text-[var(--brand-primary-strong)] md:text-4xl">
            Hızlı Satış
          </h1>
                <p className="mt-2 max-w-[680px] text-base font-semibold text-[var(--muted-foreground)]">
                  Kapı müşterisi veya cari seç, stok kodunu okut, sepete ekle ve satışı tamamla.
                </p>
        </div>
        <div className="rounded-[18px] border border-[var(--brand-border)] bg-[var(--surface-soft)] px-5 py-4 text-right">
          <p className="text-[12px] font-black uppercase tracking-[0.14em] text-[var(--muted-foreground)]">Genel Toplam</p>
          <p className="mt-1 text-4xl font-black text-[var(--brand-primary-strong)]">
            {formatCurrency(fromCents(totals.grandTotalCents))}
          </p>
          <p className="mt-1 text-sm font-bold text-[var(--muted-foreground)]">
            {cartLineCount} kalem · {cartQtyTotal} adet
          </p>
        </div>
      </header>

      <div className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-5">
          <section className="rounded-[22px] border border-[var(--brand-border)] bg-[var(--surface)] p-5 shadow-[0_20px_48px_-40px_rgba(10,32,20,0.48)]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[12px] font-black uppercase tracking-[0.14em] text-[var(--muted-foreground)]">1. Müşteri</p>
                <h2 className="mt-1 text-2xl font-black text-[var(--brand-primary-strong)]">Müşteri seç</h2>
              </div>
              {selectedCustomer ? (
                <Badge className="h-9 rounded-full px-4 text-sm">
                  {selectedCustomerIsAnonymous ? "Kapı Müşterisi" : "Cari Seçildi"}
                </Badge>
              ) : (
                <Badge variant="outline" className="h-9 rounded-full px-4 text-sm">Müşteri bekleniyor</Badge>
              )}
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-2">
              <Button
                type="button"
                variant={selectedCustomerIsAnonymous ? "default" : "outline"}
                onClick={() => void selectAnonymousPointCustomer()}
                className="h-24 rounded-[18px] text-xl font-black"
              >
                <ShoppingCart className="h-7 w-7" />
                Kapı Müşterisi
              </Button>
              <Button
                type="button"
                onClick={() => setCustomerDialogOpen(true)}
                className="h-24 rounded-[18px] text-xl font-black"
              >
                <UserRound className="h-7 w-7" />
                Cari Seç
              </Button>
            </div>

            <div className="mt-4 rounded-[18px] border border-[var(--brand-border)] bg-[var(--surface-soft)] px-4 py-3">
              <p className="text-[12px] font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Seçili müşteri</p>
              <p className="mt-1 truncate text-xl font-black text-[var(--brand-primary-strong)]">
                {selectedCustomer ? selectedCustomer.title : "Henüz müşteri seçilmedi"}
              </p>
              {selectedCustomer ? (
                <p className="mt-1 text-sm font-bold text-[var(--muted-foreground)]">{selectedCustomer.code}</p>
              ) : null}
            </div>
          </section>

          <section className="rounded-[22px] border border-[var(--brand-border)] bg-[var(--surface)] p-5 shadow-[0_20px_48px_-40px_rgba(10,32,20,0.48)]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[12px] font-black uppercase tracking-[0.14em] text-[var(--muted-foreground)]">2. Ürün</p>
                <h2 className="mt-1 text-2xl font-black text-[var(--brand-primary-strong)]">Stok kodu okut veya ürün seç</h2>
              </div>
              <div className="rounded-[14px] border border-[var(--brand-border)] bg-[var(--surface-soft)] px-4 py-2 text-right">
                <p className="text-[11px] font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Satır</p>
                <p className="text-xl font-black text-[var(--brand-primary-strong)]">{formatCurrency(pointDraftLineTotal)}</p>
              </div>
            </div>

            <div className="mt-5 grid gap-3 xl:grid-cols-[minmax(0,1fr)_220px]">
              <div className="relative">
                <Barcode className="pointer-events-none absolute left-4 top-1/2 h-6 w-6 -translate-y-1/2 text-[var(--muted-foreground)]" />
                <Input
                  ref={pointProductCodeInputRef}
                  value={pointProductCodeInput}
                  onChange={(event) => handlePointProductCodeChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") {
                      return;
                    }

                    event.preventDefault();

                    if (
                      pointDraftProduct &&
                      productMatchesPointStockCode(pointDraftProduct, pointProductCodeInput)
                    ) {
                      addPointDraftLine();
                      return;
                    }

                    void lookupPointProduct();
                  }}
                  placeholder="Stok kodu yazın"
                  className="h-16 rounded-[18px] pl-14 text-xl font-black"
                />
              </div>
              <Button
                type="button"
                onClick={openPointProductDialog}
                className="h-16 rounded-[18px] text-xl font-black"
              >
                <PackageSearch className="h-6 w-6" />
                Ürün Seç
              </Button>
            </div>

            <div className="mt-4 rounded-[18px] border border-[var(--brand-border)] bg-[var(--surface-soft)] p-4">
              {pointDraftProduct ? (
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px] xl:items-end">
                  <div className="min-w-0">
                    <p className="text-[12px] font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                      {pointDraftProduct.sku}
                    </p>
                    <p className="mt-1 text-xl font-black text-[var(--brand-primary-strong)]">{pointDraftProduct.name}</p>
                    <p className="mt-1 text-sm font-semibold text-[var(--muted-foreground)]">
                      {pointDraftProduct.brand.name ?? "Marka yok"}
                      {pointDraftProduct.oem ? ` · OEM: ${pointDraftProduct.oem}` : ""}
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div>
                      <label className="mb-1 block text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Adet</label>
                      <Input
                        type="number"
                        min={1}
                        step={1}
                        value={pointQtyInput}
                        onChange={(event) => setPointQtyInput(event.target.value)}
                        className="h-14 rounded-[14px] text-center text-xl font-black"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Fiyat</label>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        value={pointPriceInput}
                        onChange={(event) => setPointPriceInput(event.target.value)}
                        className="h-14 rounded-[14px] text-xl font-black"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Stok</label>
                      <Input
                        value={String(pointDraftProduct.available_total)}
                        readOnly
                        className="h-14 rounded-[14px] text-xl font-black"
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-base font-semibold text-[var(--muted-foreground)]">Ürünü getirmek için stok kodu veya ürün adı yazın.</p>
              )}

              <Button
                type="button"
                onClick={addPointDraftLine}
                disabled={!pointDraftProduct}
                className="mt-4 h-16 w-full rounded-[18px] text-xl font-black"
              >
                <Plus className="h-6 w-6" />
                Sepete Ekle
              </Button>
            </div>
          </section>

          <section className="rounded-[22px] border border-[var(--brand-border)] bg-[var(--surface)] p-5 shadow-[0_20px_48px_-40px_rgba(10,32,20,0.48)]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[12px] font-black uppercase tracking-[0.14em] text-[var(--muted-foreground)]">3. Sepet</p>
                <h2 className="mt-1 text-2xl font-black text-[var(--brand-primary-strong)]">Satış kalemleri</h2>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => updateActiveCartItems(() => [])}
                disabled={visibleCartItems.length === 0}
                className="h-12 rounded-[14px] text-base font-black"
              >
                <Trash2 className="h-5 w-5" />
                Sepeti Temizle
              </Button>
            </div>

            <div className="mt-4 overflow-hidden rounded-[18px] border border-[var(--brand-border)]">
              <Table>
                <TableHeader>
	                  <TableRow>
	                    <TableHead>Ürün</TableHead>
	                    <TableHead>Raf</TableHead>
	                    <TableHead className="text-right">Adet</TableHead>
	                    <TableHead className="text-right">Fiyat</TableHead>
	                    <TableHead className="text-right">Toplam</TableHead>
	                    <TableHead className="w-[116px] text-right">Sil</TableHead>
	                  </TableRow>
                </TableHeader>
                <TableBody>
	                  {visibleCartItems.length === 0 ? (
	                    <TableRow>
	                      <TableCell colSpan={6} className="py-12 text-center text-base font-semibold text-[var(--muted-foreground)]">
	                        Sepet boş. Ürün getirip sepete ekleyin.
	                      </TableCell>
	                    </TableRow>
	                  ) : (
                    visibleCartItems.map((item) => (
                      <TableRow key={item.product_id}>
                        <TableCell>
	                          <p className="text-base font-black text-[var(--brand-primary-strong)]">{item.sku}</p>
	                          <p className="mt-1 text-sm font-semibold text-[var(--foreground)]">{item.name}</p>
	                        </TableCell>
	                        <TableCell className="text-sm font-bold text-[var(--muted-foreground)]">{item.shelf_address ?? "-"}</TableCell>
	                        <TableCell className="text-right">
	                          <div className="inline-flex items-center gap-2">
                            <Button type="button" size="icon" variant="outline" className="h-11 w-11 rounded-[12px]" onClick={() => changeQty(item.product_id, -1)}>
                              <Minus className="h-5 w-5" />
                            </Button>
                            <span className="min-w-10 text-center text-lg font-black">{item.qty}</span>
                            <Button
                              type="button"
                              size="icon"
                              variant="outline"
                              className="h-11 w-11 rounded-[12px]"
                              onClick={() => changeQty(item.product_id, 1)}
                            >
                              <Plus className="h-5 w-5" />
                            </Button>
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-base font-black">{formatCurrency(fromCents(item.unit_price_cents))}</TableCell>
                        <TableCell className="text-right text-base font-black">{formatCurrency(fromCents(item.unit_price_cents * item.qty))}</TableCell>
                        <TableCell className="text-right">
                          <Button type="button" size="icon" variant="destructive" className="h-11 w-11 rounded-[12px]" onClick={() => removeItem(item.product_id)}>
                            <Trash2 className="h-5 w-5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </section>
        </div>

        <aside className="space-y-5 2xl:sticky 2xl:top-5 2xl:h-fit">
          <section className="rounded-[22px] border border-[var(--brand-border)] bg-[var(--surface)] p-5 shadow-[0_20px_48px_-40px_rgba(10,32,20,0.48)]">
            <p className="text-[12px] font-black uppercase tracking-[0.14em] text-[var(--muted-foreground)]">Ödeme</p>
            <div className="mt-4 grid gap-3">
              {POINT_ANONYMOUS_SALE_TYPE_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  type="button"
                  variant={saleType === option.value ? "default" : "outline"}
                  onClick={() =>
                    posForm.setValue("sale_type", option.value, {
                      shouldDirty: true,
                      shouldValidate: true,
                    })
                  }
                  className="h-16 justify-start rounded-[18px] text-xl font-black"
                >
                  {option.value === "cash" ? <Wallet className="h-6 w-6" /> : <CreditCard className="h-6 w-6" />}
                  {option.label}
                </Button>
              ))}
            </div>
          </section>

          <section className="rounded-[22px] border border-[var(--brand-border)] bg-[var(--surface)] p-5 shadow-[0_20px_48px_-40px_rgba(10,32,20,0.48)]">
            <p className="text-[12px] font-black uppercase tracking-[0.14em] text-[var(--muted-foreground)]">Satış Özeti</p>
            <div className="mt-4 space-y-3 text-base font-semibold">
              <div className="flex items-center justify-between">
                <span className="text-[var(--muted-foreground)]">Ara Toplam</span>
                <span>{formatCurrency(fromCents(totals.subtotalCents))}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[var(--muted-foreground)]">KDV</span>
                <span>{formatCurrency(fromCents(totals.vatTotalCents))}</span>
              </div>
              <div className="border-t border-[var(--brand-border)] pt-4">
                <div className="flex items-end justify-between gap-4">
                  <span className="text-xl font-black text-[var(--brand-primary-strong)]">Toplam</span>
                  <span className="text-4xl font-black text-[var(--brand-primary-strong)]">
                    {formatCurrency(fromCents(totals.grandTotalCents))}
                  </span>
                </div>
              </div>
            </div>

            <Button
              type="button"
              onClick={() => openPaymentModal()}
              disabled={!canSubmitSale || isMutating}
              className="mt-6 h-20 w-full rounded-[20px] text-2xl font-black"
            >
              {createSaleMutation.isPending ? <Loader2 className="h-7 w-7 animate-spin" /> : <CreditCard className="h-7 w-7" />}
              Satışı Tamamla
            </Button>
          </section>
        </aside>
      </div>
    </div>
  );

  const mainContent = (
    <div className="flex flex-col gap-4">
      {!isPointRole ? (
      <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
        <button
          type="button"
          onClick={() => scrollToPosSection("pos-session")}
          className="group rounded-3xl border border-emerald-400/35 bg-[linear-gradient(145deg,rgba(12,47,31,0.98),rgba(38,111,70,0.86))] p-4 text-left text-white shadow-[0_22px_46px_-34px_rgba(0,0,0,0.6)]"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/12">
            <Wallet className="h-6 w-6" />
          </span>
          <span className="mt-4 block text-lg font-black">Oturum</span>
          <span className="mt-1 block text-2xl font-black">{currentSession ? `#${currentSession.id}` : "Aç"}</span>
        </button>

        <button
          type="button"
          onClick={() => setCustomerDialogOpen(true)}
          className="group rounded-3xl border border-violet-300/35 bg-[linear-gradient(145deg,rgba(40,25,72,0.98),rgba(111,65,166,0.84))] p-4 text-left text-white shadow-[0_22px_46px_-34px_rgba(0,0,0,0.6)]"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/12">
            <UserRound className="h-6 w-6" />
          </span>
          <span className="mt-4 block text-lg font-black">Cari</span>
          <span className="mt-1 block truncate text-2xl font-black">{selectedCustomer ? selectedCustomer.code : "Seç"}</span>
        </button>

        <button
          type="button"
          onClick={() => scrollToPosSection("point-sales")}
          className="group rounded-3xl border border-sky-300/35 bg-[linear-gradient(145deg,rgba(9,36,67,0.98),rgba(37,99,148,0.84))] p-4 text-left text-white shadow-[0_22px_46px_-34px_rgba(0,0,0,0.6)]"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/12">
            <ShoppingCart className="h-6 w-6" />
          </span>
          <span className="mt-4 block text-lg font-black">Sepet</span>
          <span className="mt-1 block text-2xl font-black">{cartLineCount} / {cartQtyTotal}</span>
        </button>

        <button
          type="button"
          onClick={() => (canSubmitSale ? openPaymentModal() : scrollToPosSection("point-sales"))}
          className="group rounded-3xl border border-amber-300/45 bg-[linear-gradient(145deg,rgba(70,42,8,0.98),rgba(151,92,18,0.86))] p-4 text-left text-white shadow-[0_22px_46px_-34px_rgba(0,0,0,0.6)]"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/12">
            <CreditCard className="h-6 w-6" />
          </span>
          <span className="mt-4 block text-lg font-black">Ödeme</span>
          <span className="mt-1 block text-2xl font-black">{formatCurrency(fromCents(totals.grandTotalCents))}</span>
        </button>
      </div>
      ) : null}

        {!isPointRole ? (
          <div id="pos-session" style={pointOrderStyle(3)}>
            <Card className={posPanelClassName}>
              <CardContent className="space-y-4 p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--brand-border)] bg-[var(--surface)] text-[var(--brand-primary)]">
                      <Wallet className="h-6 w-6" />
                    </span>
                    <h2 className="text-2xl font-black text-[var(--brand-primary-strong)]">Oturum</h2>
                  </div>
                  <Badge variant={currentSession ? "secondary" : "outline"}>{currentSession ? "Açık" : "Kapalı"}</Badge>
                </div>

                {currentSessionQuery.isLoading ? (
                  <div className="grid gap-2 md:grid-cols-3">
                    <Skeleton className="h-10" />
                    <Skeleton className="h-10" />
                    <Skeleton className="h-10" />
                  </div>
                ) : null}

                {currentSession ? (
                  <div className="space-y-4">
                    <div className="rounded-3xl border border-[var(--brand-border)] bg-[var(--surface)] p-4">
                      <p className="text-sm font-bold text-[var(--muted-foreground)]">Açık Oturum #{currentSession.id}</p>
                      <p className="mt-1 text-2xl font-black text-[var(--brand-primary-strong)]">
                        {currentSession.cashbox.code ?? "-"}
                      </p>
                      <p className="mt-1 text-sm font-semibold text-[var(--muted-foreground)]">
                        {formatCurrency(currentSession.opening_cash)}
                      </p>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-3">
                      <Button
                        variant="outline"
                        className={posLargeButtonClassName}
                        onClick={() => void currentSessionQuery.refetch()}
                        disabled={isMutating}
                      >
                        <RefreshCcw className="h-6 w-6" /> Yenile
                      </Button>
                      {canAccessPosDayEnd ? (
                        <Button asChild variant="outline" className={posLargeButtonClassName}>
                          <Link href="/pos/day-end">
                            <Printer className="h-6 w-6" /> Gün Sonu
                          </Link>
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        className="h-20 rounded-3xl border border-amber-300/45 bg-[linear-gradient(145deg,#f59e0b_0%,#16a34a_100%)] text-base font-black text-white shadow-[0_24px_46px_-28px_rgba(22,163,74,0.72)] hover:brightness-110"
                        onClick={() => (canSubmitSale ? openPaymentModal() : setPosActionDialog("sale"))}
                        disabled={isMutating}
                      >
                        <Printer className="h-6 w-6" /> {POS_SAVE_AND_PRINT_LABEL}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <form className="grid gap-3 md:grid-cols-[1fr_1fr_220px]" onSubmit={handleOpenSession}>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">
                        Kasa ID (opsiyonel)
                      </label>
                      <Input
                        type="number"
                        min={1}
                        step={1}
                        placeholder="Bos birakilirsa otomatik secilir"
                        className="h-14 rounded-2xl"
                        {...openSessionForm.register("cashbox_id", {
                          setValueAs: (value) => {
                            if (value === "" || value === null || value === undefined) {
                              return undefined;
                            }

                            const parsed = Number(value);
                            return Number.isFinite(parsed) ? parsed : undefined;
                          },
                        })}
                        disabled={isMutating}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">
                        Açılış Nakit
                      </label>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        className="h-14 rounded-2xl"
                        {...openSessionForm.register("opening_cash", { valueAsNumber: true })}
                        disabled={isMutating}
                      />
                    </div>
                    <div className="flex items-end">
                      <Button type="submit" className="h-14 w-full rounded-2xl text-base font-extrabold" disabled={isMutating}>
                        {openSessionMutation.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Wallet className="h-4 w-4" />
                        )}
                        Oturum Aç
                      </Button>
                    </div>
                  </form>
                )}
              </CardContent>
            </Card>
          </div>
        ) : null}

        {!isPointRole && canAccessPosExpenses ? (
        <div id="pos-expense" style={pointOrderStyle(5)}>
        <Card className={posPanelClassName}>
          <CardContent className="space-y-4 p-4 sm:p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--brand-border)] bg-[var(--surface)] text-[var(--brand-primary)]">
                <ReceiptText className="h-6 w-6" />
              </span>
              <h2 className="text-2xl font-black text-[var(--brand-primary-strong)]">Masraf</h2>
            </div>
            {currentSession ? (
              <>
                <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
                  {POS_EXPENSE_CATEGORIES.map((category) => (
                    <Button
                      key={category}
                      type="button"
                      variant={expenseCategory === category ? "default" : "outline"}
                      className="h-14 rounded-2xl text-base font-extrabold"
                      onClick={() => expenseForm.setValue("category", category, { shouldDirty: true, shouldValidate: true })}
                      disabled={isMutating}
                    >
                      {category}
                    </Button>
                  ))}
                </div>

                <form
                  className="grid gap-3 md:grid-cols-[180px_minmax(0,1fr)_180px]"
                  onSubmit={submitExpense}
                >
                  <div>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="Tutar"
                      className="h-16 rounded-2xl text-lg font-black"
                      {...expenseForm.register("amount", { valueAsNumber: true })}
                      disabled={isMutating}
                    />
                  </div>

                  <div>
                    <Input
                      placeholder="Not"
                      className="h-16 rounded-2xl text-base"
                      {...expenseForm.register("note")}
                      disabled={isMutating}
                    />
                  </div>

                  <div className="flex items-end">
                    <Button type="submit" className="h-16 w-full rounded-2xl text-base font-extrabold" disabled={isMutating}>
                      {createExpenseMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <ReceiptText className="h-4 w-4" />
                      )}
                      Kaydet
                    </Button>
                  </div>
                </form>

                <div className="rounded-3xl border border-[var(--brand-border)] bg-[var(--surface)] p-4">
                  <p className="text-sm font-bold text-[var(--muted-foreground)]">Masraf Toplamı</p>
                  <p className="mt-1 text-3xl font-black text-[var(--brand-primary-strong)]">
                    {formatCurrency(expenseTotal)}
                  </p>
                </div>
              </>
            ) : (
              <Button type="button" className="h-16 rounded-2xl text-base font-extrabold" onClick={() => scrollToPosSection("pos-session")}>
                Önce Oturum Aç
              </Button>
            )}
          </CardContent>
        </Card>
        </div>
        ) : null}

        {!isPointRole ? (
        <div id="pos-collection" style={pointOrderStyle(4)}>
        <Card className={posPanelClassName}>
          <CardContent className="space-y-4 p-4 sm:p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--brand-border)] bg-[var(--surface)] text-[var(--brand-primary)]">
                <CreditCard className="h-6 w-6" />
              </span>
              <h2 className="text-2xl font-black text-[var(--brand-primary-strong)]">Tahsilat</h2>
            </div>
            {!currentSession ? (
              <Button type="button" className="h-16 rounded-2xl text-base font-extrabold" onClick={() => scrollToPosSection("pos-session")}>
                Önce Oturum Aç
              </Button>
            ) : !selectedCustomer ? (
              <Button type="button" className="h-16 rounded-2xl text-base font-extrabold" onClick={() => setCustomerDialogOpen(true)}>
                Cari Seç
              </Button>
            ) : selectedCustomerIsAnonymous ? (
              <Button type="button" className="h-16 rounded-2xl text-base font-extrabold" onClick={() => scrollToPosSection("point-sales")}>
                Nakit Satışa Git
              </Button>
            ) : (
              <>
                <div className="rounded-3xl border border-[var(--brand-border)] bg-[var(--surface)] p-4">
                  <p className="text-sm font-bold text-[var(--muted-foreground)]">{selectedCustomer.code}</p>
                  <p className="mt-1 truncate text-xl font-black text-[var(--brand-primary-strong)]">{selectedCustomer.title}</p>
                  <p className="mt-2 text-3xl font-black text-[var(--brand-primary-strong)]">
                    {formatCurrency(selectedCustomer.balance_summary.total_due)}
                  </p>
                </div>

                <form
                  className="grid gap-3 md:grid-cols-[220px_180px_minmax(0,1fr)_180px]"
                  onSubmit={submitCollection}
                >
                  <div>
                    <div className="grid grid-cols-2 gap-2">
                      {POINT_COLLECTION_METHOD_OPTIONS.map((option) => (
                        <Button
                          key={option.value}
                          type="button"
                          variant={collectionMethod === option.value ? "default" : "outline"}
                          className="h-16 rounded-2xl text-base font-extrabold"
                          onClick={() =>
                            collectionForm.setValue("method", option.value, {
                              shouldDirty: true,
                              shouldValidate: true,
                            })
                          }
                          disabled={isMutating}
                        >
                          {option.label}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="Tutar"
                      className="h-16 rounded-2xl text-lg font-black"
                      {...collectionForm.register("amount", { valueAsNumber: true })}
                      disabled={isMutating}
                    />
                  </div>

                  <div>
                    <Input
                      placeholder="Not"
                      className="h-16 rounded-2xl text-base"
                      {...collectionForm.register("note")}
                      disabled={isMutating}
                    />
                  </div>

                  <div className="flex items-end">
                    <Button type="submit" className="h-16 w-full rounded-2xl text-base font-extrabold" disabled={isMutating}>
                      {createCollectionMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <CreditCard className="h-4 w-4" />
                      )}
                      Tahsilat Kaydet
                    </Button>
                  </div>
                </form>

                {collectionMethod === "cc" ? (
                  <div className="grid gap-3 md:grid-cols-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">
                        Kart Sahibi
                      </label>
                      <Input
                        placeholder="Kart sahibi"
                        {...collectionForm.register("card_holder")}
                        disabled={isMutating}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">
                        Maskeli Kart No
                      </label>
                      <Input
                        placeholder="**** **** **** 1234"
                        {...collectionForm.register("masked_pan")}
                        disabled={isMutating}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">
                        Onay Kodu
                      </label>
                      <Input
                        placeholder="Auth code"
                        {...collectionForm.register("auth_code")}
                        disabled={isMutating}
                      />
                    </div>
                  </div>
                ) : null}

                <div className="max-w-xl">
                  <Input
                    placeholder={collectionMethod === "cc" ? "Slip no" : "Makbuz / dekont no"}
                    className="h-14 rounded-2xl"
                    {...collectionForm.register("reference_no")}
                    disabled={isMutating}
                  />
                </div>

                <div className="rounded-3xl border border-[var(--brand-border)] bg-[var(--surface)] p-4">
                  <p className="text-sm font-bold text-[var(--muted-foreground)]">Tahsilat Toplamı</p>
                  <p className="mt-1 text-3xl font-black text-[var(--brand-primary-strong)]">
                    {formatCurrency(customerCollectionTotal)}
                  </p>
                </div>
              </>
            )}
          </CardContent>
        </Card>
        </div>
        ) : null}

        {isPointRole ? (
        <div id="point-sales" style={pointOrderStyle(1)}>
        <Card
          className={cn(
            !isPointRole && posPanelClassName,
            isPointRole &&
              "overflow-hidden border-[var(--brand-border)] bg-[linear-gradient(180deg,var(--surface)_0%,var(--surface-soft)_100%)] shadow-[0_30px_70px_-46px_rgba(8,33,20,0.58)]"
            )}
        >
          <CardHeader className={cn("pb-3", isPointRole && "border-b border-[var(--brand-border)] bg-[var(--surface)] pb-4")}>
            <CardTitle className={cn("flex items-center gap-2 text-xl font-black", isPointRole && "text-lg font-extrabold")}>
              <ShoppingCart className="h-5 w-5" /> Hızlı Satış
            </CardTitle>
            {isPointRole ? (
              <p className="text-sm text-[var(--muted-foreground)]">
                Cariyi seçin, stok kodu ile ürünü çağırın veya seçim penceresinden ürünü seçip kalemi ekleyin.
              </p>
            ) : null}
          </CardHeader>
          <CardContent className={cn("space-y-4", isPointRole && "space-y-5 p-5")}>
            {isPointRole ? (
              <>
                <div className="grid gap-4 2xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
                  <section className="rounded-[28px] border border-[var(--brand-border)] bg-[var(--surface)] p-4 shadow-[0_22px_48px_-36px_rgba(12,35,22,0.36)]">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                          1. Cari / Müşteri
                        </p>
                        <p className="mt-1 text-sm font-semibold text-[var(--brand-primary-strong)]">
                          Önce cari seçin, sonra ürün akışına geçin.
                        </p>
                      </div>
                      {selectedCustomerIsAnonymous ? (
                        <Badge className="border-none bg-[#faee56] text-[#123a29]">Carisi Olmayan</Badge>
                      ) : selectedCustomer ? (
                        <Badge variant="secondary">Cari Aktif</Badge>
                      ) : (
                        <Badge variant="outline">Cari Bekleniyor</Badge>
                      )}
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button type="button" onClick={() => setCustomerDialogOpen(true)} className="min-w-[140px]">
                        Cari Seç
                      </Button>
                      <Button
                        type="button"
                        variant={selectedCustomerIsAnonymous ? "default" : "outline"}
                        onClick={() => void selectAnonymousPointCustomer()}
                      >
                        Carisi Olmayan
                      </Button>
                    </div>

                    <div className="mt-4 rounded-[24px] border border-[var(--brand-border)] bg-[linear-gradient(180deg,var(--surface)_0%,var(--surface-soft)_100%)] p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                        Seçili Cari
                      </p>
                      {selectedCustomer ? (
                        <>
                          <p className="mt-2 text-lg font-extrabold tracking-tight text-[var(--brand-primary-strong)]">
                            {selectedCustomer.title}
                          </p>
                          <p className="mt-1 text-sm text-[var(--foreground)]">
                            {selectedCustomer.code}
                            {selectedCustomer.city ? ` · ${selectedCustomer.city}` : ""}
                            {selectedCustomer.district ? ` / ${selectedCustomer.district}` : ""}
                          </p>
                          <div className="mt-3 grid gap-2 sm:grid-cols-2">
                            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--surface)] px-3 py-2">
                              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                                Telefon
                              </p>
                              <p className="mt-1 text-sm font-semibold text-[var(--foreground)]">
                                {selectedCustomer.phone ?? "Tanımsız"}
                              </p>
                            </div>
                            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--surface)] px-3 py-2">
                              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                                Açık Bakiye
                              </p>
                              <p className="mt-1 text-sm font-semibold text-[var(--foreground)]">
                                {selectedCustomerIsAnonymous
                                  ? "Cari bakiye yok"
                                  : formatCurrency(selectedCustomer.balance_summary.total_due)}
                              </p>
                            </div>
                          </div>
                          <p className="mt-3 text-xs leading-5 text-[var(--muted-foreground)]">
                            {selectedCustomerIsAnonymous
                              ? "Cari hesabı olmayan peşin satış müşterisi. Tahsilat nakit veya kredi kartı ile kapanır."
                              : "Cari seçildi. Şimdi ürün kodu ile kalem ekleyebilirsiniz."}
                          </p>
                        </>
                      ) : (
                        <p className="mt-2 text-sm text-[var(--muted-foreground)]">
                          Cari seçmek için `Cari Seç` butonunu kullanın.
                        </p>
                      )}
                    </div>

                    <div className="mt-4 max-w-[260px]">
                      <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">
                        Belge No
                      </label>
                      <Input
                        value={pointReceiptNoInput}
                        onChange={(event) => setPointReceiptNoInput(event.target.value)}
                        placeholder="Opsiyonel"
                        className="h-12 rounded-2xl"
                      />
                    </div>

                    <div className="mt-4">
                      <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">
                        {selectedCustomerIsAnonymous ? "Ödeme Tipi" : "Satış Tipi"}
                      </label>
                      {selectedCustomerIsAnonymous ? (
                        <div className="grid gap-2 sm:grid-cols-2">
                          {POINT_ANONYMOUS_SALE_TYPE_OPTIONS.map((option) => (
                            <Button
                              key={option.value}
                              type="button"
                              variant={saleType === option.value ? "default" : "outline"}
                              className="h-11 justify-start rounded-2xl"
                              onClick={() =>
                                posForm.setValue("sale_type", option.value, {
                                  shouldDirty: true,
                                  shouldValidate: true,
                                })
                              }
                            >
                              {option.label}
                            </Button>
                          ))}
                        </div>
                      ) : (
                        <Select
                          value={saleType}
                          onValueChange={(value) => {
                            posForm.setValue("sale_type", value as PosSaleType, {
                              shouldDirty: true,
                              shouldValidate: true,
                            });
                          }}
                        >
                          <SelectTrigger className="h-12 rounded-2xl">
                            <SelectValue placeholder="Satış tipi" />
                          </SelectTrigger>
                          <SelectContent>
                            {POS_SALE_TYPE_OPTIONS.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  </section>

                  <section className="rounded-[28px] border border-[var(--brand-border)] bg-[var(--surface)] p-4 shadow-[0_22px_48px_-36px_rgba(12,35,22,0.36)]">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                          2. Ürün / Kalem
                        </p>
                        <p className="mt-1 text-sm font-semibold text-[var(--brand-primary-strong)]">
                          Stok kodu girin veya seçim penceresinden ürünü seçin.
                        </p>
                      </div>
                      <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--surface-soft)] px-3 py-2 text-right">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                          Satır Tutarı
                        </p>
                        <p className="mt-1 text-lg font-extrabold text-[var(--brand-primary-strong)]">
                          {formatCurrency(pointDraftLineTotal)}
                        </p>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_168px]">
                      <div>
                        <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">Stok Kodu</label>
                        <Input
                          ref={pointProductCodeInputRef}
                          value={pointProductCodeInput}
                          onChange={(event) => handlePointProductCodeChange(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter") {
                              return;
                            }

                            event.preventDefault();

                            if (
                              pointDraftProduct &&
                              productMatchesPointStockCode(pointDraftProduct, pointProductCodeInput)
                            ) {
                              addPointDraftLine();
                              return;
                            }

                            void lookupPointProduct();
                          }}
                          placeholder="Stok kodu yazın"
                          className="h-12 rounded-2xl text-base font-semibold"
                        />
                      </div>

                      <div className="flex items-end">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={openPointProductDialog}
                          className="h-12 w-full rounded-2xl"
                        >
                          <PackageSearch className="h-4 w-4" />
                          Ürün Seç
                        </Button>
                      </div>
                    </div>

                    <div className="mt-4 rounded-[24px] border border-[#dce7de] bg-[linear-gradient(180deg,#f9fcfa_0%,#f1f6f2_100%)] p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                        Ürün Bilgisi
                      </p>
                      {pointDraftProduct ? (
                        <>
                          <p className="mt-2 text-lg font-extrabold tracking-tight text-[var(--brand-primary-strong)]">
                            {pointDraftProduct.sku}
                          </p>
                          <p className="mt-1 text-sm font-semibold text-[var(--foreground)]">
                            {pointDraftProduct.name}
                          </p>
                          <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                            {pointDraftProduct.brand.name ?? "Marka yok"}
                            {pointDraftProduct.oem ? ` · OEM: ${pointDraftProduct.oem}` : ""}
                          </p>
                        </>
                      ) : (
                        <p className="mt-2 text-sm text-[var(--muted-foreground)]">
                          Stok kodunu yazıp Enter tuşuna basın veya seçim penceresinden ürünü seçin.
                        </p>
                      )}

                      <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-[132px_156px_132px_auto]">
                        <div>
                          <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">Miktar</label>
                          <Input
                            type="number"
                            min={1}
                            step={1}
                            value={pointQtyInput}
                            onChange={(event) => setPointQtyInput(event.target.value)}
                            className="h-11 rounded-2xl"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">Fiyat</label>
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            value={pointPriceInput}
                            onChange={(event) => setPointPriceInput(event.target.value)}
                            className="h-11 rounded-2xl"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">Stok</label>
                          <Input
                            value={pointDraftProduct ? String(pointDraftProduct.available_total) : ""}
                            readOnly
                            className="h-11 rounded-2xl"
                          />
                        </div>
                        <div className="flex items-end">
                          <Button type="button" onClick={addPointDraftLine} disabled={!pointDraftProduct} className="h-11 w-full rounded-2xl">
                            Kalemi Ekle
                          </Button>
                        </div>
                      </div>
                    </div>
                  </section>
                </div>
              </>
            ) : (
              <>
                <div className="grid gap-4 2xl:grid-cols-[1fr_0.75fr]">
                  <div className="rounded-3xl border border-[var(--brand-border)] bg-[var(--surface)] p-4">
                    <div className="mb-3 flex items-center gap-2">
                      <CreditCard className="h-5 w-5 text-[var(--brand-primary)]" />
                      <h3 className="text-lg font-black text-[var(--brand-primary-strong)]">Satış Tipi</h3>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-3">
                      {POS_SALE_TYPE_OPTIONS.map((option) => (
                        <Button
                          key={option.value}
                          type="button"
                          variant={saleType === option.value ? "default" : "outline"}
                          className="h-16 rounded-2xl text-base font-extrabold"
                          onClick={() =>
                            posForm.setValue("sale_type", option.value, {
                              shouldDirty: true,
                              shouldValidate: true,
                            })
                          }
                        >
                          {option.value === "cash" ? (
                            <Wallet className="h-5 w-5" />
                          ) : option.value === "card" ? (
                            <CreditCard className="h-5 w-5" />
                          ) : (
                            <RefreshCcw className="h-5 w-5" />
                          )}
                          {option.label}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-3xl border border-[var(--brand-border)] bg-[var(--surface)] p-4">
                    <div className="mb-3 flex items-center gap-2">
                      <ReceiptText className="h-5 w-5 text-[var(--brand-primary)]" />
                      <h3 className="text-lg font-black text-[var(--brand-primary-strong)]">Belge</h3>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-1">
                      {[
                        { value: "invoice" as PosDocumentType, label: "Fatura" },
                        { value: "delivery" as PosDocumentType, label: "İrsaliye" },
                      ].map((option) => (
                        <Button
                          key={option.value}
                          type="button"
                          variant={documentType === option.value ? "default" : "outline"}
                          className="h-16 rounded-2xl text-base font-extrabold"
                          onClick={() =>
                            posForm.setValue("document_type", option.value, {
                              shouldDirty: true,
                              shouldValidate: true,
                            })
                          }
                        >
                          <ReceiptText className="h-5 w-5" />
                          {option.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="grid gap-3 rounded-3xl border border-[var(--brand-border)] bg-[var(--surface)] p-4 md:grid-cols-[minmax(0,1fr)_220px_220px]">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-[var(--muted-foreground)]">Cari</p>
                    <p className="mt-1 truncate text-xl font-black text-[var(--brand-primary-strong)]">
                      {selectedCustomer ? selectedCustomer.title : "Cari seçilmedi"}
                    </p>
                    {selectedCustomer ? (
                      <p className="mt-1 text-sm font-bold text-[var(--muted-foreground)]">{selectedCustomer.code}</p>
                    ) : null}
                  </div>
                  <Button type="button" className="h-16 rounded-2xl text-base font-extrabold" onClick={() => setCustomerDialogOpen(true)}>
                    <UserRound className="h-5 w-5" />
                    Cari Seç
                  </Button>
                  <Button
                    type="button"
                    className="h-16 rounded-2xl text-base font-extrabold"
                    variant="outline"
                    onClick={restoreDefaultCustomer}
                    disabled={!defaultCustomerBySaleType[saleType]}
                  >
                    <UsersIcon className="h-5 w-5" />
                    Varsayılan POINT Cari
                  </Button>
                </div>

                <div className="relative">
                  <h3 className="mb-3 flex items-center gap-2 text-lg font-black text-[var(--brand-primary-strong)]">
                    <Barcode className="h-5 w-5 text-[var(--brand-primary)]" />
                    Ürün Ekle
                  </h3>
                  <div className="relative">
                    <Barcode className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[var(--muted-foreground)]" />
                    <Input
                      ref={quickInputRef}
                      value={quickQuery}
                      onChange={(event) => {
                        setQuickQuery(event.target.value);
                        setActiveQuickIndex(0);
                      }}
                      onKeyDown={onQuickKeyDown}
                      placeholder="Barkod, stok kodu veya ürün adı yazın"
                      className="h-16 rounded-2xl pl-12 text-lg font-bold"
                    />
                  </div>

                  {debouncedQuickQuery.trim().length >= 2 ? (
                    <div className="absolute z-20 mt-2 w-full rounded-3xl border border-[var(--brand-border)] bg-[var(--surface)] p-2 shadow-sm">
                      {quickSearchQuery.isLoading ? (
                        <div className="space-y-1 p-2">
                          {Array.from({ length: 4 }).map((_, index) => (
                            <Skeleton key={`quick-skeleton-${index}`} className="h-14 rounded-2xl" />
                          ))}
                        </div>
                      ) : quickProducts.length > 0 ? (
                        <ScrollArea className="max-h-64">
                          <div className="grid gap-2 p-1">
                            {quickProducts.map((product, index) => (
                              <button
                                key={product.id}
                                type="button"
                                className={cn(
                                  "flex w-full items-center justify-between gap-3 rounded-2xl border border-[var(--brand-border)] px-4 py-3 text-left transition",
                                  index === normalizedActiveQuickIndex
                                    ? "bg-[var(--brand-accent-soft)]"
                                    : "bg-[var(--surface-soft)] hover:border-[var(--brand-primary)]"
                                )}
                                onMouseEnter={() => setActiveQuickIndex(index)}
                                onClick={() => addQuickProduct(product)}
                              >
                                <span className="flex min-w-0 items-center gap-3">
                                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--surface)] text-[var(--brand-primary)]">
                                    <Plus className="h-5 w-5" />
                                  </span>
                                  <span className="min-w-0">
                                    <span className="block truncate text-base font-black text-[var(--brand-primary-strong)]">{product.sku}</span>
                                    <span className="block truncate text-sm font-semibold text-[var(--muted-foreground)]">{product.name}</span>
                                  </span>
                                </span>
                                <span className="shrink-0 text-base font-black text-[var(--brand-primary-strong)]">
                                  {formatCurrency(product.net_price ?? "0")}
                                </span>
                              </button>
                            ))}
                          </div>
                        </ScrollArea>
                      ) : (
                        <p className="px-3 py-2 text-sm text-[var(--muted-foreground)]">Sonuç bulunamadı.</p>
                      )}
                    </div>
                  ) : null}
                </div>
              </>
            )}

            {!isPointRole && visibleCartItems.length === 0 ? (
              <div className="flex min-h-[240px] flex-col items-center justify-center rounded-3xl border border-[var(--brand-border)] bg-[var(--surface)] p-8 text-center">
                <span className="flex h-20 w-20 items-center justify-center rounded-3xl bg-[var(--surface-soft)] text-[var(--brand-primary)]">
                  <ShoppingCart className="h-10 w-10" />
                </span>
                <h3 className="mt-5 text-2xl font-black text-[var(--brand-primary-strong)]">Sepet boş</h3>
                <Button type="button" className="mt-5 h-16 rounded-2xl px-8 text-base font-extrabold" onClick={() => quickInputRef.current?.focus()}>
                  <Barcode className="h-5 w-5" />
                  Ürün Ekle
                </Button>
              </div>
            ) : (
            <div
              className={cn(
                "rounded-3xl border border-[var(--brand-border)] bg-[var(--surface-soft)]/45",
                isPointRole && "rounded-2xl border-[var(--brand-border)] bg-[var(--surface)]"
              )}
            >
              <Table>
                <TableHeader>
	                  <TableRow>
	                    <TableHead>Ürün</TableHead>
	                    <TableHead>Raf</TableHead>
	                    <TableHead className="text-right">Birim</TableHead>
	                    <TableHead className="text-right">Adet</TableHead>
	                    <TableHead className="text-right">Stok</TableHead>
	                    <TableHead className="text-right">Satır Toplam</TableHead>
                    <TableHead className={isPointRole ? "w-[150px] text-right" : "w-[220px] text-right"}>
                      Aksiyon
                    </TableHead>
                  </TableRow>
                </TableHeader>

                <TableBody>
	                  {visibleCartItems.length === 0 ? (
	                    <TableRow>
	                      <TableCell colSpan={7} className="py-8 text-center text-sm text-[var(--muted-foreground)]">
	                        {isPointRole ? "Stok kodu ile ürünü getirip kalem ekleyin." : "Barkod veya stok kodu ile ürün ekleyin."}
	                      </TableCell>
	                    </TableRow>
                  ) : (
                    visibleCartItems.map((item) => (
                      <TableRow key={item.product_id}>
                        <TableCell>
                          {isPointRole ? (
                            <>
                              <p className="text-sm font-semibold uppercase tracking-[0.04em] text-[var(--brand-primary-strong)]">
                                {item.sku}
                              </p>
                              <p className="text-xs text-[var(--foreground)]">{item.name}</p>
                              <p className="text-xs text-[var(--muted-foreground)]">
                                {item.oem ? `OEM: ${item.oem}` : item.brand ?? "-"}
                              </p>
                            </>
                          ) : (
                            <>
                              <p className="font-medium">{item.name}</p>
                              <p className="text-xs text-[var(--muted-foreground)]">
                                {item.sku}
                                {item.oem ? ` / ${item.oem}` : ""}
                                {item.brand ? ` · ${item.brand}` : ""}
                              </p>
	                            </>
	                          )}
	                        </TableCell>
	                        <TableCell className="text-sm font-semibold text-[var(--muted-foreground)]">{item.shelf_address ?? "-"}</TableCell>
	                        <TableCell className="text-right">{fromCents(item.unit_price_cents)}</TableCell>
                        <TableCell className="text-right">{item.qty}</TableCell>
                        <TableCell className="text-right">
                          <Badge variant={item.available_total > 0 ? "secondary" : "outline"}>
                            {item.available_total}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">{fromCents(item.unit_price_cents * item.qty)}</TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1.5">
                            <Button
                              type="button"
                              size="icon"
                              variant="outline"
                              title="Adet azalt"
                              onClick={() => changeQty(item.product_id, -1)}
                            >
                              <Minus className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              size="icon"
                              variant="outline"
                              title="Adet artır"
                              onClick={() => changeQty(item.product_id, 1)}
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              size="icon"
                              variant="outline"
                              title="Stok durumunu göster"
                              onClick={() => toast.info(`${item.sku}: kullanılabilir stok ${item.available_total}`)}
                            >
                              <PackageSearch className="h-3.5 w-3.5" />
                            </Button>
                            {!isPointRole ? (
                              <>
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="outline"
                                  title="Stok hareketleri"
                                  onClick={() => setMovementProduct(item)}
                                >
                                  <History className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="outline"
                                  title="Satır yazdır"
                                  onClick={() => openLinePrintWindow(item, pointDisplayCurrencyLabel)}
                                >
                                  <Printer className="h-3.5 w-3.5" />
                                </Button>
                              </>
                            ) : null}
                            <Button
                              type="button"
                              size="icon"
                              variant="destructive"
                              title="Satır sil"
                              onClick={() => removeItem(item.product_id)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
            )}
          </CardContent>
        </Card>
        </div>
        ) : null}

        {isPointRole ? <div style={pointOrderStyle(2)}>{totalsPanel}</div> : null}

        {!isPointRole && currentSession ? (
          <Card className="border-red-500/35 bg-[linear-gradient(180deg,rgba(127,29,29,0.16)_0%,var(--surface)_100%)] shadow-[0_18px_42px_-34px_rgba(127,29,29,0.72)]">
            <CardContent className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_260px] sm:items-center">
              <div>
                <p className="text-lg font-black text-red-700 dark:text-red-300">Oturumu Kapat</p>
                <p className="mt-1 text-sm font-semibold text-[var(--muted-foreground)]">
                  Gün sonunda kasa sayımı yapıp POS oturumunu kapatın.
                </p>
              </div>
              <Button
                type="button"
                variant="destructive"
                className="h-14 rounded-2xl text-base font-black"
                onClick={() => {
                  closeSessionForm.reset({
                    closing_cash_counted: Number(currentSession.opening_cash),
                    note: "",
                  });
                  setCloseSessionDialogOpen(true);
                }}
                disabled={isMutating}
              >
                Oturumu Kapat
              </Button>
            </CardContent>
          </Card>
        ) : null}
      </div>
  );

  const compactPosContent = (
    <div className="space-y-4">
      <section className="rounded-[30px] border border-[var(--brand-border)] bg-[var(--surface)] p-5 shadow-[0_26px_70px_-48px_rgba(22,101,52,0.55)]">
        <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <div className="rounded-[26px] border border-[var(--brand-border)] bg-[linear-gradient(145deg,rgba(22,101,52,0.1)_0%,var(--surface-soft)_100%)] p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-14 w-14 items-center justify-center rounded-[18px] bg-[var(--brand-accent-soft)] text-[var(--brand-primary)]">
                <UserRound className="h-7 w-7" />
              </span>
              <div>
                <p className="text-sm font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">1. Cari Seç</p>
                <p className="text-xl font-black text-[var(--brand-primary-strong)]">Müşteri</p>
              </div>
            </div>
            <div className="mt-5 min-h-[74px] rounded-[22px] border border-[var(--brand-border)] bg-[var(--surface)] p-4">
              <p className="truncate text-2xl font-black text-[var(--brand-primary-strong)]">
                {selectedCustomer ? selectedCustomer.title : "Cari seçilmedi"}
              </p>
              {selectedCustomer ? (
                <p className="mt-1 truncate text-base font-bold text-[var(--muted-foreground)]">{selectedCustomer.code}</p>
              ) : null}
            </div>
            <Button
              type="button"
              className="point-customer-select-button mt-4 h-16 w-full rounded-[20px] text-lg font-black"
              onClick={() => setCustomerDialogOpen(true)}
              disabled={isMutating}
            >
              <UserRound className="h-6 w-6" />
              Cari Seç
            </Button>
          </div>

          <div className="relative rounded-[26px] border border-[var(--brand-border)] bg-[var(--surface-soft)] p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-14 w-14 items-center justify-center rounded-[18px] bg-[var(--brand-accent-soft)] text-[var(--brand-primary)]">
                <Barcode className="h-7 w-7" />
              </span>
              <div>
                <p className="text-sm font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">2. Ürün Seç</p>
                <p className="text-xl font-black text-[var(--brand-primary-strong)]">Barkod / stok / ad</p>
              </div>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-[150px_minmax(0,1fr)]">
              <div>
                <p className="mb-2 text-sm font-black text-[var(--muted-foreground)]">Adet</p>
                <div className="grid grid-cols-[44px_minmax(0,1fr)_44px] overflow-hidden rounded-[20px] border border-[var(--brand-border)] bg-[var(--surface)]">
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-16 rounded-none text-xl font-black"
                    onClick={() => setQuickQtyInput((value) => String(Math.max(1, (Number(value.replace(",", ".")) || 1) - 1)))}
                    disabled={isMutating}
                  >
                    <Minus className="h-5 w-5" />
                  </Button>
                  <Input
                    value={quickQtyInput}
                    onChange={(event) => setQuickQtyInput(event.target.value.replace(/[^\d]/g, ""))}
                    inputMode="numeric"
                    className="h-16 rounded-none border-0 bg-transparent text-center text-xl font-black shadow-none focus-visible:ring-0"
                    disabled={isMutating}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-16 rounded-none text-xl font-black"
                    onClick={() => setQuickQtyInput((value) => String((Number(value.replace(",", ".")) || 1) + 1))}
                    disabled={isMutating}
                  >
                    <Plus className="h-5 w-5" />
                  </Button>
                </div>
              </div>
              <div>
                <p className="mb-2 text-sm font-black text-[var(--muted-foreground)]">Ürün</p>
                <div className="relative">
                  <Barcode className="pointer-events-none absolute left-4 top-1/2 h-6 w-6 -translate-y-1/2 text-[var(--muted-foreground)]" />
                  <Input
                    ref={quickInputRef}
                    value={quickQuery}
                    onChange={(event) => {
                      setQuickQuery(event.target.value);
                      setActiveQuickIndex(0);
                    }}
                    onKeyDown={onQuickKeyDown}
                    placeholder="Barkod, stok kodu veya ürün adı yazın"
                    className="h-16 rounded-[20px] pl-14 text-lg font-black"
                  />
                </div>
              </div>
            </div>
            {debouncedQuickQuery.trim().length >= 2 ? (
              <div className="absolute left-5 right-5 z-30 mt-2 rounded-[20px] border border-[var(--brand-border)] bg-[var(--surface)] p-2 shadow-xl">
                {quickSearchQuery.isLoading ? (
                  <div className="space-y-2 p-2">
                    {Array.from({ length: 3 }).map((_, index) => (
                      <Skeleton key={`quick-compact-skeleton-${index}`} className="h-14 rounded-[16px]" />
                    ))}
                  </div>
                ) : quickProducts.length > 0 ? (
                  <ScrollArea className="max-h-64">
                    <div className="grid gap-2 p-1">
                      {quickProducts.map((product, index) => (
                        <button
                          key={product.id}
                          type="button"
                          className={cn(
                            "flex w-full items-center justify-between gap-3 rounded-[16px] border border-[var(--brand-border)] px-4 py-3 text-left transition",
                            index === normalizedActiveQuickIndex
                              ? "bg-[var(--brand-accent-soft)]"
                              : "bg-[var(--surface-soft)] hover:border-[var(--brand-primary)]"
                          )}
                          onMouseEnter={() => setActiveQuickIndex(index)}
                          onClick={() => addQuickProduct(product)}
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-base font-black text-[var(--brand-primary-strong)]">{product.sku}</span>
                            <span className="block truncate text-sm font-bold text-[var(--muted-foreground)]">{product.name}</span>
                          </span>
                          <span className="shrink-0 text-base font-black text-[var(--brand-primary-strong)]">
                            {formatCurrency(product.net_price ?? "0")}
                          </span>
                        </button>
                      ))}
                    </div>
                  </ScrollArea>
                ) : (
                  <p className="px-3 py-3 text-base font-semibold text-[var(--muted-foreground)]">Sonuç bulunamadı.</p>
                )}
              </div>
            ) : null}
            <div className="mt-4 rounded-[22px] border border-[var(--brand-border)] bg-[var(--surface)] p-4">
              {visibleCartItems.length === 0 ? (
                <div className="flex min-h-[84px] items-center justify-center gap-3 text-base font-bold text-[var(--muted-foreground)]">
                  <ShoppingCart className="h-6 w-6" />
                  Sepet boş
                </div>
              ) : (
                <ScrollArea className="max-h-40">
                  <div className="space-y-2 pr-2">
                    {visibleCartItems.map((item) => (
                      <div key={item.product_id} className="flex items-center justify-between gap-3 rounded-[16px] bg-[var(--surface-soft)] px-3 py-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-black text-[var(--brand-primary-strong)]">{item.name}</p>
                          <p className="text-xs font-bold text-[var(--muted-foreground)]">{item.qty} adet</p>
                        </div>
                        <p className="shrink-0 text-sm font-black text-[var(--brand-primary-strong)]">
                          {formatCurrency(fromCents(item.unit_price_cents * item.qty))}
                        </p>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </div>
          </div>

          <div className="rounded-[26px] border border-[var(--brand-border)] bg-[linear-gradient(145deg,rgba(22,101,52,0.96)_0%,rgba(146,64,14,0.9)_100%)] p-5 text-white shadow-[0_28px_70px_-42px_rgba(22,101,52,0.72)] xl:col-span-2">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-center">
              <div className="flex min-w-0 items-center gap-4">
                <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[18px] bg-white/14">
                  <CreditCard className="h-7 w-7" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-black uppercase tracking-[0.12em] text-white/72">3. Toplam</p>
                  <p className="mt-1 text-5xl font-black tracking-tight">{formatCurrency(fromCents(totals.grandTotalCents))}</p>
                  <p className="mt-1 text-base font-bold text-white/78">{cartLineCount} kalem · {cartQtyTotal} adet</p>
                </div>
              </div>
            <Button
              type="button"
              variant="outline"
              className="h-20 w-full rounded-[24px] border-0 !bg-white !text-[#17351f] text-xl font-black shadow-[0_22px_44px_-28px_rgba(0,0,0,0.55)] hover:!bg-[#f8fff9] hover:!text-[#17351f] disabled:!opacity-100 dark:!bg-white dark:!text-[#17351f] dark:hover:!bg-[#f8fff9]"
              onClick={() => {
                if (!currentSession) {
                  setPosActionDialog("session");
                  return;
                }
                if (!selectedCustomer) {
                  setCustomerDialogOpen(true);
                  return;
                }
                if (visibleCartItems.length === 0) {
                  quickInputRef.current?.focus();
                  return;
                }
                openPaymentModal();
              }}
              disabled={isMutating}
            >
              <Printer className="h-7 w-7" />
              {POS_SAVE_AND_PRINT_LABEL}
            </Button>
            </div>
          </div>
        </div>
      </section>

      {currentSession ? (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            className="h-11 rounded-2xl border-red-500/30 px-4 text-sm font-black text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/30"
            onClick={() => {
              closeSessionForm.reset({
                closing_cash_counted: Number(currentSession.opening_cash),
                note: "",
              });
              setCloseSessionDialogOpen(true);
            }}
            disabled={isMutating}
          >
            Oturumu Kapat
          </Button>
        </div>
      ) : null}
    </div>
  );

  const pointRetailContentV2 = (
    <div className="space-y-3 xl:space-y-4">
	            <div className="space-y-3 xl:space-y-4">
        <section className="point-panel rounded-[18px] border p-3 xl:p-4">
          <div
            className={cn(
              "grid gap-3 xl:items-center",
              isBatumPointFlowByUser
                ? "xl:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_430px]"
                : "xl:grid-cols-1"
            )}
          >
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[var(--point-muted-strong)] xl:text-xs">
                {isBatumPointFlowByUser ? "Batum POS" : "Erzurum Hızlı Satış"}
              </p>
              <h1 className="mt-1 truncate text-2xl font-black tracking-tight text-white xl:text-3xl 2xl:text-4xl">
                {isBatumPointFlowByUser ? pointSaleContextLabel : "ERZURUM HIZLI SATIŞ"}
              </h1>
              <p className="mt-1 text-xs font-bold text-[var(--point-muted-strong)] xl:text-sm">
                {isBatumPointFlowByUser
                  ? "Ürün aramada sadece Erz. Depo ve Batum stokları gösterilir. Fiyat alanı Batum satışında KDV dahil çalışır."
                  : "Cari seç, stok kodunu okut, sepete ekle. Kaydet satış irsaliyesi oluşturur; Yazdır fiş çıktısı alır."}
              </p>
            </div>
            {isBatumPointFlowByUser ? (
              <div className="grid grid-cols-2 gap-2">
                {POINT_ANONYMOUS_SALE_TYPE_OPTIONS.map((option) => {
                  const isSelected = saleType === option.value;

                  return (
                    <Button
                      key={option.value}
                      type="button"
                      variant="outline"
                      className={cn(
                        "h-12 rounded-[14px] text-sm font-black xl:h-14 xl:text-base",
                        isSelected
                          ? "point-yellow-action-button"
                          : "point-secondary-button text-[var(--point-muted-strong)]"
                      )}
                      onClick={() => {
                        if (option.value !== saleType) {
                          setPointCartPriceInputs({});
                          setActivePointCartProductId(null);
                        }

                        posForm.setValue("sale_type", option.value, {
                          shouldDirty: true,
                          shouldValidate: true,
                        });
                      }}
                    >
                      {option.value === "cash" ? <Wallet className="h-4 w-4" /> : <CreditCard className="h-4 w-4" />}
                      {option.label}
                    </Button>
                  );
                })}
              </div>
            ) : null}
          </div>
        </section>
        <section className="point-panel point-customer-panel rounded-[18px] border p-2">
          <div className="grid gap-2 xl:grid-cols-[168px_minmax(0,1fr)] xl:items-stretch 2xl:grid-cols-[200px_minmax(0,1fr)]">
            <Button
              type="button"
              onClick={() => setCustomerDialogOpen(true)}
              className="point-customer-select-button point-yellow-action-button min-h-[58px] rounded-[16px] text-base font-black xl:min-h-[68px] xl:text-lg 2xl:min-h-[78px] 2xl:text-xl"
            >
              <UserRound className="h-5 w-5 xl:h-6 xl:w-6" />
              Cari Seç
            </Button>

            <div
              className={cn(
                "rounded-[18px] border bg-[var(--point-control)]",
                selectedCustomer
                  ? "border-[#faee56]/45 bg-[radial-gradient(circle_at_18%_0%,rgba(250,238,86,0.20),transparent_28%),linear-gradient(135deg,#163f28_0%,#0d261e_48%,#102b3b_100%)] shadow-[0_20px_48px_-34px_rgba(250,238,86,0.7),inset_0_1px_0_rgba(255,255,255,0.10)]"
                  : "border-[var(--point-border)]"
              )}
            >
            {selectedCustomer ? (
              <div className="point-customer-summary-grid grid min-h-[58px] w-full grid-cols-[34px_minmax(82px,0.34fr)_minmax(180px,1fr)_minmax(190px,0.9fr)] items-center gap-2 p-2 xl:min-h-[68px] xl:grid-cols-[38px_minmax(98px,0.34fr)_minmax(230px,1fr)_minmax(250px,0.95fr)] xl:gap-3 xl:p-3 2xl:min-h-[78px] 2xl:grid-cols-[44px_120px_minmax(320px,1fr)_minmax(420px,1.16fr)]">
                <span className="flex h-9 w-9 items-center justify-center rounded-[12px] border border-[#faee56]/70 bg-[linear-gradient(135deg,#faee56_0%,#72bf82_58%,#1f6b45_100%)] text-sm font-black text-[#0b1712] shadow-[0_10px_30px_-16px_rgba(250,238,86,0.95)] xl:h-10 xl:w-10 2xl:h-11 2xl:w-11">
                  <Check className="h-4 w-4 xl:h-5 xl:w-5" />
                </span>

                <span className="min-w-0">
                  <span className="block text-[10px] font-black uppercase tracking-[0.12em] text-[#faee56]">
                    Cari Kod
                  </span>
                  <span className="mt-0.5 block truncate text-base font-black text-[#e6f3e9] xl:text-lg 2xl:mt-1 2xl:text-xl">{selectedCustomer.code}</span>
                </span>

                <span className="min-w-0">
                  <span className="block text-[10px] font-black uppercase tracking-[0.12em] text-[#faee56]">Cari İsim</span>
                  <span className="mt-0.5 block truncate text-lg font-black leading-tight text-white xl:text-2xl 2xl:mt-1 2xl:text-3xl">
                    {selectedCustomer.title}
                  </span>
                </span>

                <span className="point-customer-meta-grid grid min-w-0 grid-cols-2 gap-1.5 xl:grid-cols-4 xl:gap-2">
                  <span className="min-w-0 rounded-lg border border-[#72bf82]/45 bg-[#1f6b45]/45 px-2 py-0.5 text-[11px] font-black text-[#d9ffe1] xl:py-1 xl:text-xs">
                    <span className="block text-[9px] uppercase tracking-[0.12em] opacity-80">Şube</span>
                    <span className="block truncate">{[selectedCustomer.city, selectedCustomer.district].filter(Boolean).join(" / ") || "Merkez"}</span>
                  </span>
                  <span className="min-w-0 rounded-lg border border-[#65b7ff]/35 bg-[#0d3b52]/55 px-2 py-0.5 text-[11px] font-black text-[#d6f0ff] xl:py-1 xl:text-xs">
                    <span className="block text-[9px] uppercase tracking-[0.12em] opacity-80">İl</span>
                    <span className="block truncate">{selectedCustomer.city || "-"}</span>
                  </span>
                  <span className="min-w-0 rounded-lg border border-[#faee56]/35 bg-[#4d4310]/45 px-2 py-0.5 text-[11px] font-black text-[#fff8a8] xl:py-1 xl:text-xs">
                    <span className="block text-[9px] uppercase tracking-[0.12em] opacity-80">İlçe</span>
                    <span className="block truncate">{selectedCustomer.district || "-"}</span>
                  </span>
                  <span className="min-w-0 rounded-lg border border-[#d78cff]/35 bg-[#3a2050]/45 px-2 py-0.5 text-[11px] font-black text-[#f4ddff] xl:py-1 xl:text-xs">
                    <span className="block text-[9px] uppercase tracking-[0.12em] opacity-80">Telefon</span>
                    <span className="block truncate">{selectedCustomer.phone || "-"}</span>
                  </span>
                </span>
              </div>
            ) : (
              <div className="grid min-h-[58px] grid-cols-[38px_minmax(0,1fr)] items-center gap-2 p-2 xl:min-h-[68px] xl:grid-cols-[42px_minmax(0,1fr)] xl:gap-3 xl:p-3 2xl:min-h-[78px]">
                <span className="flex h-9 w-9 items-center justify-center rounded-[12px] border border-[var(--point-border-strong)] bg-[var(--point-panel-soft)] text-[var(--point-accent)] xl:h-10 xl:w-10 2xl:h-11 2xl:w-11">
                  <UserRound className="h-4 w-4 xl:h-5 xl:w-5" />
                </span>
                <div className="min-w-0">
                  <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[var(--point-muted)]">Cari Bilgisi</p>
                  <p className="mt-0.5 truncate text-lg font-black text-white xl:text-xl">Cari seçilmedi</p>
                  <p className="mt-0.5 truncate text-xs font-semibold text-[var(--point-muted)]">
                    Müşteri seçimi bekleniyor.
                  </p>
                </div>
              </div>
            )}
            </div>
          </div>
        </section>

        <section className="point-panel point-product-panel rounded-[18px] border p-3 xl:p-4">
          <div className="point-product-entry-grid grid gap-3 xl:grid-cols-[minmax(0,320px)_minmax(0,1fr)_96px_118px_132px] xl:items-end 2xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)_128px_150px_160px] 2xl:gap-4">
            <label className="block">
              <span className="mb-1 flex h-4 items-center text-xs font-semibold text-[var(--point-muted-strong)] xl:mb-2 xl:h-5 xl:text-sm">Stok Kodu</span>
              <div className="grid h-12 grid-cols-[minmax(0,1fr)_46px] overflow-hidden rounded-[14px] border border-[var(--point-border)] bg-[var(--point-control)] xl:h-14 xl:grid-cols-[minmax(0,1fr)_52px] 2xl:h-16 2xl:grid-cols-[minmax(0,1fr)_58px]">
                <Input
                  ref={pointProductCodeInputRef}
                  value={pointProductCodeInput}
                  onChange={(event) => handlePointProductCodeChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") {
                      return;
                    }

                    event.preventDefault();

                    if (
                      pointDraftProduct &&
                      productMatchesPointStockCode(pointDraftProduct, pointProductCodeInput)
                    ) {
                      addPointDraftLine();
                      return;
                    }

                    void lookupPointProduct();
                  }}
                  placeholder="Stok kodu yazın"
                  className="h-12 rounded-none border-0 bg-transparent text-base font-black shadow-none focus-visible:ring-0 xl:h-14 xl:text-lg 2xl:h-16"
                />
                <Button
                  type="button"
                  variant="ghost"
                  className="h-12 rounded-none border-l border-[var(--point-border)] xl:h-14 2xl:h-16"
                  onClick={openPointProductDialog}
                  title="Ürün seç"
                >
                  <PackageSearch className="h-5 w-5" />
                </Button>
              </div>
            </label>

            <div className="block">
              <span className="mb-1 flex h-4 items-center text-xs font-semibold text-[var(--point-muted-strong)] xl:mb-2 xl:h-5 xl:text-sm">Stok Adı</span>
              <div className="grid min-h-12 items-center gap-1.5 rounded-[14px] border border-[var(--point-border)] bg-[var(--point-control)] p-1.5 sm:grid-cols-[minmax(0,1fr)_84px_92px] xl:min-h-14 xl:grid-cols-[minmax(0,1fr)_96px_108px] xl:gap-2 xl:p-2 2xl:min-h-16 2xl:grid-cols-[minmax(0,1fr)_112px_124px]">
                <div className="min-w-0 px-2 xl:px-3">
                  <p className={cn("truncate text-sm font-black xl:text-base", pointDisplayedProductName ? "text-white" : "text-[var(--point-muted)]")}>
                    {pointDisplayedProductName || "Stok adı otomatik gelir"}
                  </p>
                </div>
                <div className="flex h-9 flex-col justify-center rounded-[10px] border border-[var(--point-border)] bg-black/10 px-2 xl:h-10 xl:px-3 2xl:h-12">
                  <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[var(--point-muted)]">Raf</p>
                  <p className="truncate text-sm font-black text-[#e6f3e9]">{pointDisplayedProductShelf || "-"}</p>
                </div>
                <div className="flex h-9 flex-col justify-center rounded-[10px] border border-[var(--point-border)] bg-black/10 px-2 xl:h-10 xl:px-3 2xl:h-12">
                  <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[var(--point-muted)]">Stok Adeti</p>
                  <p className="text-sm font-black text-[#faee56]">{pointDisplayedProductStock ?? "-"}</p>
                </div>
              </div>
            </div>

            <div>
              <span
                className={cn(
                  "mb-1 flex h-4 items-center text-xs font-semibold text-[var(--point-muted-strong)] xl:mb-2 xl:h-5 xl:text-sm",
                  pointFocusedInput === "qty" && "text-[#faee56]"
                )}
              >
                Adet
              </span>
              <div
                className={cn(
                  "h-12 overflow-hidden rounded-[14px] border border-[var(--point-border-strong)] bg-[var(--point-control)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] xl:h-14 2xl:h-16",
                  pointFocusedInput === "qty" &&
                    "border-[#faee56]/85 bg-[#3b3719]/70 shadow-[0_0_0_2px_rgba(250,238,86,0.18),0_16px_34px_-24px_rgba(250,238,86,0.8)]"
                )}
              >
                <Input
                  ref={pointQtyInputRef}
                  value={pointQtyInput}
                  onChange={(event) => setPointQtyInput(event.target.value.replace(/[^\d]/g, ""))}
                  onFocus={(event) => {
                    setPointFocusedInput("qty");
                    event.currentTarget.select();
                  }}
                  onBlur={() => setPointFocusedInput((current) => (current === "qty" ? null : current))}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") {
                      return;
                    }

                    event.preventDefault();
                    pointPriceInputRef.current?.focus();
                    pointPriceInputRef.current?.select();
                  }}
                  inputMode="numeric"
                  className={cn(
                    "h-12 rounded-none border-0 bg-transparent text-center text-xl font-black shadow-none focus-visible:ring-0 xl:h-14 xl:text-2xl 2xl:h-16",
                    pointFocusedInput === "qty" && "text-[#faee56]"
                  )}
                />
              </div>
            </div>

            <div>
              <span
                className={cn(
                  "mb-1 flex h-4 items-center text-xs font-semibold text-[var(--point-muted-strong)] xl:mb-2 xl:h-5 xl:text-sm",
                  pointFocusedInput === "price" && "text-[#faee56]"
                )}
              >
                {pointPriceIncludesVat ? "KDV Dahil" : "Fiyat"}
              </span>
              <div
                className={cn(
                  "h-12 overflow-hidden rounded-[14px] border border-[var(--point-border-strong)] bg-[var(--point-control)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] xl:h-14 2xl:h-16",
                  pointFocusedInput === "price" &&
                    "border-[#faee56]/85 bg-[#3b3719]/70 shadow-[0_0_0_2px_rgba(250,238,86,0.18),0_16px_34px_-24px_rgba(250,238,86,0.8)]"
                )}
              >
                <Input
                  ref={pointPriceInputRef}
                  value={pointPriceInput}
                  onChange={(event) => {
                    const cleanValue = event.target.value.replace(/[^\d,.]/g, "");
                    setPointPriceInput(cleanValue);
                  }}
                  onFocus={(event) => {
                    setPointFocusedInput("price");
                    event.currentTarget.select();
                  }}
                  onBlur={() => {
                    setPointFocusedInput((current) => (current === "price" ? null : current));
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") {
                      return;
                    }

                    event.preventDefault();
                    if (pointDraftProduct) {
                      addPointDraftLine();
                      return;
                    }

                    pointProductCodeInputRef.current?.focus();
                    pointProductCodeInputRef.current?.select();
                  }}
                  inputMode="decimal"
                  placeholder="0,00"
                  className={cn(
                    "h-12 rounded-none border-0 bg-transparent text-center text-lg font-black shadow-none focus-visible:ring-0 xl:h-14 xl:text-xl 2xl:h-16",
                    pointFocusedInput === "price" && "text-[#faee56]"
                  )}
                />
              </div>
            </div>

            <Button
              type="button"
              onClick={addPointDraftLine}
              disabled={!pointDraftProduct}
              className="point-yellow-action-button h-12 rounded-[14px] text-sm font-black disabled:border-[var(--point-border)] disabled:bg-[var(--point-control-strong)] disabled:text-[var(--point-muted)] disabled:shadow-none xl:h-14 xl:text-base 2xl:h-16 2xl:text-lg"
            >
              <Plus className="h-4 w-4 xl:h-5 xl:w-5" />
              Sepete Ekle
            </Button>
          </div>
        </section>
      </div>

      <section className="point-table overflow-x-auto rounded-[12px] border">
	        <div className="point-cart-head grid min-w-[920px] grid-cols-[38px_124px_minmax(230px,1fr)_96px_76px_96px_112px] border-b border-[var(--point-border)] bg-[linear-gradient(135deg,#1f6b45_0%,#2f7650_55%,#416650_100%)] text-xs font-black text-[#e6f3e9] xl:min-w-[1030px] xl:grid-cols-[44px_150px_minmax(260px,1fr)_118px_90px_116px_130px] xl:text-sm 2xl:min-w-[1160px] 2xl:grid-cols-[48px_176px_minmax(300px,1fr)_140px_104px_130px_150px]">
	          <div className="px-2 py-2 xl:px-3 2xl:px-4">#</div>
	          <div className="px-2 py-2 xl:px-3 2xl:px-4">Stok Kodu</div>
	          <div className="px-2 py-2 xl:px-3 2xl:px-4">Ürün Adı</div>
	          <div className="px-2 py-2 xl:px-3 2xl:px-4">Raf</div>
	          <div className="px-2 py-2 text-center xl:px-3 2xl:px-4">Adet</div>
	          <div className="px-2 py-2 text-center xl:px-3 2xl:px-4">{pointPriceIncludesVat ? "KDV Dahil" : "Fiyat"}</div>
	          <div className="px-2 py-2 text-center xl:px-3 2xl:px-4">Tutar</div>
	        </div>
	        <div className="point-cart-body min-h-[46px] min-w-[920px] xl:min-h-[52px] xl:min-w-[1030px] 2xl:min-w-[1160px]">
          {visibleCartItems.length === 0 ? (
            <div className="flex min-h-[46px] items-center justify-center text-sm font-black text-[var(--point-muted)] xl:min-h-[52px]">
              Stok kodu ile ürünü getirin veya seçim penceresinden ürün seçin.
            </div>
          ) : (
            visibleCartItems.map((item, index) => (
              <div
                key={item.product_id}
                className={cn(
	                  "point-cart-row grid grid-cols-[38px_124px_minmax(230px,1fr)_96px_76px_96px_112px] items-center border-b border-[var(--point-border)] transition-colors last:border-0 xl:grid-cols-[44px_150px_minmax(260px,1fr)_118px_90px_116px_130px] 2xl:grid-cols-[48px_176px_minmax(300px,1fr)_140px_104px_130px_150px]",
	                  activePointCartProductId === item.product_id && "bg-[#1d2f25]/60"
	                )}
                onClick={() => {
                  setActivePointCartProductId(item.product_id);
                  setPointPriceInput("");
                }}
              >
                <div className="px-2 py-1 text-xs font-black xl:px-3 xl:py-1.5 xl:text-sm 2xl:px-4">{index + 1}</div>
                <div className="px-2 py-1 text-xs font-black tracking-wide xl:px-3 xl:py-1.5 xl:text-sm 2xl:px-4">{item.sku}</div>
	                <div className="min-w-0 px-2 py-1 xl:px-3 xl:py-1.5 2xl:px-4">
	                  <p className="truncate text-sm font-black">{item.name}</p>
	                </div>
	                <div className="min-w-0 px-2 py-1 text-xs font-black text-[var(--point-muted-strong)] xl:px-3 xl:py-1.5 xl:text-sm 2xl:px-4">
	                  <p className="truncate">{item.shelf_address ?? "-"}</p>
	                </div>
	                <div className="px-2 py-1 xl:px-3 xl:py-1.5 2xl:px-4">
                  <Input
                    value={item.qty}
                    onChange={(event) => {
                      const parsed = Number(event.target.value.replace(/[^\d]/g, ""));
                      setItemQty(item.product_id, Number.isFinite(parsed) && parsed > 0 ? parsed : 1);
                    }}
                    onClick={(event) => event.stopPropagation()}
                    onFocus={(event) => event.currentTarget.select()}
                    inputMode="numeric"
                    className="h-7 rounded-[9px] border-[var(--point-border-strong)] bg-[var(--point-control)] text-center text-sm font-black xl:h-8 xl:text-base"
                    aria-label={`${item.sku} adeti`}
                  />
                </div>
                <div className="px-2 py-1 xl:px-3 xl:py-1.5 2xl:px-4">
                  <Input
                    value={
                      pointCartPriceInputs[item.product_id] ??
                      fromCents(displayPriceCents(item.unit_price_cents, item.vat_rate, pointPriceIncludesVat)).replace(".", ",")
                    }
                    onChange={(event) => {
                      const cleanValue = event.target.value.replace(/[^\d,.]/g, "");
                      const parsed = Number(cleanValue.replace(",", "."));
                      const nextUnitPriceCents = Number.isFinite(parsed)
                        ? netPriceCentsFromDisplay(toCents(parsed), item.vat_rate, pointPriceIncludesVat)
                        : null;
                      const minimumUnitPriceCents = getMinimumEditablePriceCents(item.original_unit_price_cents);

                      setPointCartPriceInputs((previous) => ({
                        ...previous,
                        [item.product_id]: cleanValue,
                      }));

                      if (nextUnitPriceCents !== null && nextUnitPriceCents >= 0) {
                        if (nextUnitPriceCents < minimumUnitPriceCents) {
                          const minimumDisplayCents = displayPriceCents(minimumUnitPriceCents, item.vat_rate, pointPriceIncludesVat);
                          toast.error(`Fiyat ${formatCurrency(fromCents(minimumDisplayCents))} altına düşemez.`);
                          return;
                        }

                        setItemUnitPriceCents(item.product_id, nextUnitPriceCents);
                      }
                    }}
                    onClick={(event) => event.stopPropagation()}
                    onFocus={(event) => event.currentTarget.select()}
                    onBlur={() => {
                      setPointCartPriceInputs((previous) => ({
                        ...previous,
                        [item.product_id]: fromCents(displayPriceCents(item.unit_price_cents, item.vat_rate, pointPriceIncludesVat)).replace(".", ","),
                      }));
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") {
                        return;
                      }

                      event.preventDefault();

                      setPointCartPriceInputs((previous) => ({
                        ...previous,
                        [item.product_id]: fromCents(displayPriceCents(item.unit_price_cents, item.vat_rate, pointPriceIncludesVat)).replace(".", ","),
                      }));
                      pointProductCodeInputRef.current?.focus();
                      pointProductCodeInputRef.current?.select();
                    }}
                    inputMode="decimal"
                    className="h-7 rounded-[9px] border-[var(--point-border-strong)] bg-[var(--point-control)] text-center text-sm font-black xl:h-8 xl:text-base"
                    aria-label={`${item.sku} fiyatı`}
                  />
                </div>
                <div className="px-2 py-1 text-center text-sm font-black text-[#faee56] xl:px-3 xl:py-1.5 xl:text-base 2xl:px-4">
                  {formatCurrency(fromCents(displayPriceCents(item.unit_price_cents, item.vat_rate, pointPriceIncludesVat) * item.qty))}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <footer className="point-panel point-sales-footer grid gap-2 rounded-[18px] border p-2 sm:grid-cols-2 lg:grid-cols-[78px_92px_112px_126px_104px_104px] xl:grid-cols-[78px_92px_112px_126px_104px_104px_minmax(214px,1.4fr)] 2xl:grid-cols-[86px_104px_130px_142px_126px_126px_minmax(248px,1.35fr)] 2xl:gap-3 2xl:rounded-[22px] 2xl:p-3">
        <div className="grid h-full min-h-[58px] gap-1.5 xl:min-h-[64px] xl:gap-2 2xl:min-h-[78px]">
          {[
            { value: "delivery" as PosDocumentType, label: "İrsaliye" },
            { value: "invoice" as PosDocumentType, label: "Fatura" },
          ].map((option) => {
            const isSelected = documentType === option.value;

            return (
              <Button
                key={option.value}
                type="button"
                variant="outline"
                className={cn(
                  "h-full min-h-0 rounded-[12px] px-1.5 text-[11px] font-black xl:px-2 xl:text-xs 2xl:text-[13px]",
                  isSelected
                    ? "point-yellow-action-button"
                    : "point-secondary-button text-[var(--point-muted-strong)]"
                )}
                onClick={() => {
                  posForm.setValue("document_type", option.value, {
                    shouldDirty: true,
                    shouldValidate: true,
                  });
                }}
              >
                {option.label}
              </Button>
            );
          })}
        </div>
        <Button
          type="button"
          variant="outline"
          className="point-secondary-button h-full min-h-[58px] rounded-[14px] px-1.5 text-xs font-semibold xl:min-h-[64px] xl:px-2 xl:text-sm 2xl:min-h-[72px] 2xl:text-[15px]"
          onClick={() => {
            setCartItems([]);
            setPointCartPriceInputs({});
            setPointDraftProduct(null);
            setActivePointCartProductId(null);
            setPointProductCodeInput("");
            setPointQtyInput("1");
            setPointPriceInput("");
          }}
        >
          <RefreshCcw className="h-4 w-4 text-[#fbbf24] xl:h-5 xl:w-5 2xl:h-7 2xl:w-7" />
          Temizle
        </Button>
        <Button
          type="button"
          variant="outline"
          className="point-secondary-button h-full min-h-[58px] flex-col gap-0.5 rounded-[14px] px-1.5 text-center xl:min-h-[64px] xl:gap-1 xl:px-2 2xl:min-h-[72px]"
          onClick={() => {
            if (!selectedCustomer) {
              setCustomerDialogOpen(true);
              return;
            }

            setPointLedgerDialogOpen(true);
          }}
        >
          <span className="text-[9px] font-black uppercase tracking-[0.1em] text-[var(--point-muted-strong)] xl:text-[10px] 2xl:text-[11px]">Cari Borcu</span>
          <span className="text-sm font-black text-[#faee56] xl:text-base 2xl:text-lg">
            {selectedCustomer ? formatCurrency(selectedCustomer.balance_summary.total_due) : "-"}
          </span>
        </Button>
        <Button
          type="button"
          variant="outline"
          className="point-secondary-button h-full min-h-[58px] flex-col gap-0.5 rounded-[14px] px-1.5 text-center xl:min-h-[64px] xl:gap-1 xl:px-2 2xl:min-h-[72px]"
          onClick={() => {
            if (visibleCartItems.length === 0) {
              pointProductCodeInputRef.current?.focus();
            }
          }}
        >
          <span className="text-[9px] font-black uppercase tracking-[0.1em] text-[var(--point-muted-strong)] xl:text-[10px] 2xl:text-[11px]">İrsaliye Tutarı</span>
          <span className="text-sm font-black text-white xl:text-base 2xl:text-lg">{formatCurrency(fromCents(totals.grandTotalCents))}</span>
        </Button>
        <Button
          type="button"
          className="point-primary-button h-full min-h-[58px] rounded-[14px] px-1.5 text-sm font-black transition-none xl:min-h-[64px] xl:px-2 xl:text-base 2xl:min-h-[72px] 2xl:text-lg"
          onClick={() => {
            if (createSaleMutation.isPending) {
              return;
            }
            if (!currentSession) {
              setPosActionDialog("session");
              return;
            }
            if (!selectedCustomer) {
              setCustomerDialogOpen(true);
              return;
            }
            if (visibleCartItems.length === 0) {
              pointProductCodeInputRef.current?.focus();
              return;
            }
            printPointDraftDirectly();
          }}
          aria-disabled={createSaleMutation.isPending}
        >
          <Printer className="h-4 w-4 xl:h-5 xl:w-5 2xl:h-6 2xl:w-6" />
          Yazdır
        </Button>
        <Button
          type="button"
          className="point-save-button point-yellow-action-button h-full min-h-[58px] rounded-[14px] px-1.5 text-sm font-black disabled:border-[var(--point-border)] disabled:bg-[var(--point-control-strong)] disabled:text-[var(--point-muted)] disabled:shadow-none xl:min-h-[64px] xl:px-2 xl:text-base 2xl:min-h-[72px] 2xl:text-lg"
          onClick={() => {
            if (createSaleMutation.isPending) {
              return;
            }
            if (!currentSession) {
              setPosActionDialog("session");
              return;
            }
            if (!selectedCustomer) {
              setCustomerDialogOpen(true);
              return;
            }
            if (visibleCartItems.length === 0) {
              pointProductCodeInputRef.current?.focus();
              return;
            }
            void submitPointSaleDirectly();
          }}
          disabled={createSaleMutation.isPending}
        >
          <Check className="h-4 w-4 xl:h-5 xl:w-5 2xl:h-6 2xl:w-6" />
          Kaydet
        </Button>
        <div className="point-total-card col-span-full grid min-h-[58px] min-w-0 gap-1 rounded-[14px] border px-2 py-1.5 xl:col-span-1 xl:min-h-[64px] xl:gap-1.5 2xl:min-h-[72px] 2xl:rounded-[16px] 2xl:px-3 2xl:py-2">
          <div className="grid min-w-0 grid-cols-[minmax(58px,0.75fr)_auto_minmax(86px,1fr)] items-center gap-1.5 rounded-[10px] bg-black/10 px-1.5 py-1 text-[11px] font-black xl:grid-cols-[minmax(64px,0.78fr)_auto_minmax(96px,1fr)] xl:text-xs 2xl:grid-cols-[minmax(72px,0.86fr)_auto_minmax(112px,1fr)] 2xl:gap-2 2xl:px-2 2xl:py-1.5 2xl:text-sm">
            <span className="text-[var(--point-muted-strong)]">KDV Hariç</span>
            <span className="text-white">{pointDisplayCurrencyLabel}</span>
            <span className="truncate text-right text-white">
              {formatPointCurrencyNumber(fromCents(totals.subtotalCents - totals.discountTotalCents))}
            </span>
          </div>
          <div className="grid min-w-0 grid-cols-[minmax(58px,0.75fr)_auto_minmax(86px,1fr)] items-center gap-1.5 rounded-[10px] bg-black/10 px-1.5 py-1 text-[11px] font-black xl:grid-cols-[minmax(64px,0.78fr)_auto_minmax(96px,1fr)] xl:text-xs 2xl:grid-cols-[minmax(72px,0.86fr)_auto_minmax(112px,1fr)] 2xl:gap-2 2xl:px-2 2xl:py-1.5 2xl:text-sm">
            <span className="text-[var(--point-muted-strong)]">KDV</span>
            <span className="text-[#faee56]">{pointDisplayCurrencyLabel}</span>
            <span className="truncate text-right text-[#faee56]">{formatPointCurrencyNumber(fromCents(totals.vatTotalCents))}</span>
          </div>
          <div className="grid min-w-0 grid-cols-[minmax(58px,0.75fr)_auto_minmax(86px,1fr)] items-center gap-1.5 px-1.5 pt-0.5 xl:grid-cols-[minmax(64px,0.78fr)_auto_minmax(96px,1fr)] 2xl:grid-cols-[minmax(72px,0.86fr)_auto_minmax(112px,1fr)] 2xl:gap-2 2xl:px-2">
            <span className="text-[9px] font-black uppercase tracking-[0.12em] text-[#f4e84d] xl:text-[10px] 2xl:text-[11px]">KDV Dahil</span>
            <span className="text-sm font-black text-white xl:text-base 2xl:text-lg">{pointDisplayCurrencyLabel}</span>
            <span className="truncate text-right text-xl font-black tracking-tight text-white xl:text-2xl 2xl:text-3xl">
              {formatPointCurrencyNumber(fromCents(totals.grandTotalCents))}
            </span>
          </div>
          <div className="grid min-w-0 grid-cols-[minmax(58px,0.75fr)_auto_minmax(86px,1fr)] items-center gap-1.5 px-1.5 xl:grid-cols-[minmax(64px,0.78fr)_auto_minmax(96px,1fr)] 2xl:grid-cols-[minmax(72px,0.86fr)_auto_minmax(112px,1fr)] 2xl:gap-2 2xl:px-2">
            <span aria-hidden="true" />
            <span aria-hidden="true" />
            <span className="truncate text-right text-[11px] font-bold text-[var(--point-muted-strong)] xl:text-xs">
              {cartLineCount} kalem · {cartQtyTotal} adet
            </span>
          </div>
        </div>
      </footer>
    </div>
  );

  if (shouldRedirectFromPos) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-[var(--muted-foreground)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Yönlendiriliyor...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {pointQuickSalesShell(
        pointRetailContentV2
      )}

      <Dialog open={pointSaveResult !== null} onOpenChange={(open) => !open && setPointSaveResult(null)}>
        <DialogContent className="max-w-[min(480px,calc(100vw-32px))] rounded-[28px] border-[#2f7650] bg-[#071018] p-0 text-[#edf7ef] shadow-[0_34px_110px_-42px_rgba(0,0,0,0.95)]">
          <div className="border-b border-[#244838] bg-[linear-gradient(135deg,rgba(47,118,80,0.38)_0%,rgba(250,238,86,0.08)_58%,rgba(7,16,24,1)_100%)] px-6 py-5">
            <DialogHeader className="text-left">
              <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-[#62d58c]/50 bg-[#143923] text-[#7cf6a3] shadow-[0_20px_44px_-28px_rgba(124,246,163,0.9)]">
                <Check className="h-8 w-8" />
              </div>
              <DialogTitle className="text-3xl font-black tracking-tight text-white">Gönderildi</DialogTitle>
              <DialogDescription className="text-base font-bold text-[#c2d3c6]">
                Satış kaydedildi, ödeme kasaya işlendi.
              </DialogDescription>
            </DialogHeader>
          </div>
          <div className="grid gap-3 px-6 py-5 text-sm font-black">
            <div className="flex items-center justify-between rounded-2xl border border-[#203a30] bg-black/18 px-4 py-3">
              <span className="text-[#9eb1a3]">Fiş No</span>
              <span className="text-right text-white">{pointSaveResult?.receipt_no ?? "-"}</span>
            </div>
            <div className="flex items-center justify-between rounded-2xl border border-[#203a30] bg-black/18 px-4 py-3">
              <span className="text-[#9eb1a3]">Kasa</span>
              <span className="text-right text-white">{pointSaveResult?.session.cashbox.name ?? pointSaveResult?.session.cashbox.code ?? "-"}</span>
            </div>
            <div className="flex items-center justify-between rounded-2xl border border-[#203a30] bg-black/18 px-4 py-3">
              <span className="text-[#9eb1a3]">Tutar</span>
              <span className="text-right text-[#faee56]">
                {formatPointAmount(pointSaveResult?.grand_total ?? 0, pointDisplayCurrencyLabel)}
              </span>
            </div>
            <div className="flex items-center justify-between rounded-2xl border border-[#203a30] bg-black/18 px-4 py-3">
              <span className="text-[#9eb1a3]">Logo</span>
              <span className="text-right text-white">{formatLogoOutboundStatus(pointSaveResult?.logo_sync_status)}</span>
            </div>
          </div>
          <DialogFooter className="border-t border-[#203a30] px-6 py-4">
            <Button
              type="button"
              className="h-12 w-full rounded-2xl bg-[#f0cd35] text-base font-black text-black hover:bg-[#ffe36b]"
              onClick={() => setPointSaveResult(null)}
            >
              Tamam
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={posActionDialog !== null} onOpenChange={(open) => !open && setPosActionDialog(null)}>
        <DialogContent className="max-h-[calc(100vh-32px)] max-w-[min(1180px,calc(100vw-28px))] overflow-hidden rounded-[30px] p-0">
          <div className="border-b border-[var(--brand-border)] bg-[var(--surface)] px-6 py-5">
            <DialogHeader>
              <DialogTitle className="text-3xl font-black tracking-tight text-[var(--brand-primary-strong)]">
                {posActionDialog === "session"
                  ? "POS Oturumu"
                  : posActionDialog === "collection"
                    ? "Tahsilat"
                    : posActionDialog === "expense"
                      ? "Masraf"
                      : POS_SAVE_AND_PRINT_LABEL}
              </DialogTitle>
              <DialogDescription className="text-base font-semibold">
                {posActionDialog === "session"
                  ? "Kasa oturumunu yönetin."
                  : posActionDialog === "collection"
                    ? "Seçili cariden tahsilat alın."
                    : posActionDialog === "expense"
                      ? "Kasa masrafı kaydedin."
                      : "Cari seç, ürünü ekle ve ödemeyi tamamla."}
              </DialogDescription>
            </DialogHeader>
          </div>

          <div className="max-h-[calc(100vh-150px)] overflow-y-auto bg-[var(--surface-soft)]/55 p-5">
            {posActionDialog === "session" ? (
              currentSession ? (
                <div className="space-y-5">
                  <div className="rounded-[24px] border border-[var(--brand-border)] bg-[var(--surface)] p-5">
                    <p className="text-sm font-black uppercase tracking-[0.14em] text-[var(--muted-foreground)]">Açık Oturum</p>
                    <p className="mt-2 text-3xl font-black text-[var(--brand-primary-strong)]">#{currentSession.id}</p>
                    <p className="mt-1 text-lg font-bold text-[var(--foreground)]">{currentSession.cashbox.code ?? "-"}</p>
                    <p className="mt-1 text-lg font-black text-[var(--brand-primary-strong)]">{formatCurrency(currentSession.opening_cash)}</p>
                  </div>
                  <div className="grid gap-3 md:grid-cols-3">
                    <Button variant="outline" className="h-20 rounded-[22px] text-lg font-black" onClick={() => void currentSessionQuery.refetch()} disabled={isMutating}>
                      <RefreshCcw className="h-6 w-6" /> Yenile
                    </Button>
                    {canAccessPosDayEnd ? (
                      <Button asChild variant="outline" className="h-20 rounded-[22px] text-lg font-black">
                        <Link href="/pos/day-end">
                          <Printer className="h-6 w-6" /> Gün Sonu
                        </Link>
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      className="h-20 rounded-[22px] border border-amber-300/45 bg-[linear-gradient(145deg,#f59e0b_0%,#16a34a_100%)] text-lg font-black text-white shadow-[0_24px_46px_-28px_rgba(22,163,74,0.72)] hover:brightness-110"
                      onClick={() => (canSubmitSale ? openPaymentModal() : setPosActionDialog("sale"))}
                      disabled={isMutating}
                    >
                      <Printer className="h-6 w-6" /> {POS_SAVE_AND_PRINT_LABEL}
                    </Button>
                  </div>
                  <div className="rounded-[22px] border border-red-500/30 bg-red-500/10 p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-base font-black text-red-700 dark:text-red-300">Oturumu Kapat</p>
                        <p className="mt-1 text-sm font-semibold text-[var(--muted-foreground)]">Bu işlem gün sonunda kullanılmalı.</p>
                      </div>
                      <Button
                        type="button"
                        variant="destructive"
                        className="h-12 rounded-[16px] px-6 font-black"
                        onClick={() => {
                          closeSessionForm.reset({
                            closing_cash_counted: Number(currentSession.opening_cash),
                            note: "",
                          });
                          setPosActionDialog(null);
                          setCloseSessionDialogOpen(true);
                        }}
                        disabled={isMutating}
                      >
                        Oturumu Kapat
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <form className="grid gap-4 md:grid-cols-[1fr_1fr_220px]" onSubmit={handleOpenSession}>
                  <div>
                    <label className="mb-2 block text-sm font-black text-[var(--muted-foreground)]">Kasa ID</label>
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      placeholder="Boş bırakılabilir"
                      className="h-16 rounded-[18px] text-lg font-black"
                      {...openSessionForm.register("cashbox_id", {
                        setValueAs: (value) => {
                          if (value === "" || value === null || value === undefined) {
                            return undefined;
                          }

                          const parsed = Number(value);
                          return Number.isFinite(parsed) ? parsed : undefined;
                        },
                      })}
                      disabled={isMutating}
                    />
                  </div>
                  <div>
                    <label className="mb-2 block text-sm font-black text-[var(--muted-foreground)]">Açılış Nakit</label>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      className="h-16 rounded-[18px] text-lg font-black"
                      {...openSessionForm.register("opening_cash", { valueAsNumber: true })}
                      disabled={isMutating}
                    />
                  </div>
                  <div className="flex items-end">
                    <Button type="submit" className="h-16 w-full rounded-[18px] text-lg font-black" disabled={isMutating}>
                      {openSessionMutation.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Wallet className="h-5 w-5" />}
                      Oturum Aç
                    </Button>
                  </div>
                </form>
              )
            ) : null}

            {posActionDialog === "collection" ? (
              !currentSession ? (
                <Button type="button" className="h-20 rounded-[22px] text-xl font-black" onClick={() => setPosActionDialog("session")}>
                  Önce Oturum Aç
                </Button>
              ) : !selectedCustomer ? (
                <Button type="button" className="h-20 rounded-[22px] text-xl font-black" onClick={() => setCustomerDialogOpen(true)}>
                  <UserRound className="h-7 w-7" /> Cari Seç
                </Button>
              ) : selectedCustomerIsAnonymous ? (
                <Button type="button" className="h-20 rounded-[22px] text-xl font-black" onClick={() => setPosActionDialog("sale")}>
                  Nakit Satışa Git
                </Button>
              ) : (
                <form className="space-y-5" onSubmit={submitCollection}>
                  <div className="rounded-[24px] border border-[var(--brand-border)] bg-[var(--surface)] p-5">
                    <p className="text-sm font-black text-[var(--muted-foreground)]">{selectedCustomer.code}</p>
                    <p className="mt-1 text-2xl font-black text-[var(--brand-primary-strong)]">{selectedCustomer.title}</p>
                    <p className="mt-2 text-4xl font-black text-[var(--brand-primary-strong)]">{formatCurrency(selectedCustomer.balance_summary.total_due)}</p>
                  </div>
                  <div className="grid gap-3 md:grid-cols-[260px_200px_minmax(0,1fr)_220px]">
                    <div className="grid grid-cols-2 gap-2">
                      {POINT_COLLECTION_METHOD_OPTIONS.map((option) => (
                        <Button
                          key={option.value}
                          type="button"
                          variant={collectionMethod === option.value ? "default" : "outline"}
                          className="h-16 rounded-[18px] text-base font-black"
                          onClick={() => collectionForm.setValue("method", option.value, { shouldDirty: true, shouldValidate: true })}
                          disabled={isMutating}
                        >
                          {option.label}
                        </Button>
                      ))}
                    </div>
                    <Input type="number" min={0} step="0.01" placeholder="Tutar" className="h-16 rounded-[18px] text-lg font-black" {...collectionForm.register("amount", { valueAsNumber: true })} disabled={isMutating} />
                    <Input placeholder="Not" className="h-16 rounded-[18px] text-base font-bold" {...collectionForm.register("note")} disabled={isMutating} />
                    <Button type="submit" className="h-16 rounded-[18px] text-lg font-black" disabled={isMutating}>
                      {createCollectionMutation.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <CreditCard className="h-5 w-5" />}
                      Tahsilat Kaydet
                    </Button>
                  </div>
                  <Input placeholder={collectionMethod === "cc" ? "Slip no" : "Makbuz / dekont no"} className="h-16 max-w-xl rounded-[18px] text-base font-bold" {...collectionForm.register("reference_no")} disabled={isMutating} />
                </form>
              )
            ) : null}

            {posActionDialog === "expense" && canAccessPosExpenses ? (
              !currentSession ? (
                <Button type="button" className="h-20 rounded-[22px] text-xl font-black" onClick={() => setPosActionDialog("session")}>
                  Önce Oturum Aç
                </Button>
              ) : (
                <form className="space-y-5" onSubmit={submitExpense}>
                  <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                    {POS_EXPENSE_CATEGORIES.map((category) => (
                      <Button
                        key={category}
                        type="button"
                        variant={expenseCategory === category ? "default" : "outline"}
                        className="h-16 rounded-[18px] text-base font-black"
                        onClick={() => expenseForm.setValue("category", category, { shouldDirty: true, shouldValidate: true })}
                        disabled={isMutating}
                      >
                        {category}
                      </Button>
                    ))}
                  </div>
                  <div className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)_220px]">
                    <Input type="number" min={0} step="0.01" placeholder="Tutar" className="h-16 rounded-[18px] text-lg font-black" {...expenseForm.register("amount", { valueAsNumber: true })} disabled={isMutating} />
                    <Input placeholder="Not" className="h-16 rounded-[18px] text-base font-bold" {...expenseForm.register("note")} disabled={isMutating} />
                    <Button type="submit" className="h-16 rounded-[18px] text-lg font-black" disabled={isMutating}>
                      {createExpenseMutation.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <ReceiptText className="h-5 w-5" />}
                      Kaydet
                    </Button>
                  </div>
                </form>
              )
            ) : null}

            {posActionDialog === "sale" ? (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_430px]">
                <div className="space-y-4">
                  <section className="grid gap-3 rounded-[24px] border border-[var(--brand-border)] bg-[var(--surface)] p-4 sm:grid-cols-[minmax(0,1fr)_190px] sm:items-center">
                    <div className="min-w-0">
                      <p className="text-sm font-black text-[var(--muted-foreground)]">Cari</p>
                      <p className="mt-1 truncate text-xl font-black text-[var(--brand-primary-strong)]">{selectedCustomer ? selectedCustomer.title : "Henüz cari seçilmedi"}</p>
                      {selectedCustomer ? <p className="mt-1 text-sm font-bold text-[var(--muted-foreground)]">{selectedCustomer.code}</p> : null}
                    </div>
                    <Button type="button" className="h-14 rounded-[16px] text-base font-black" onClick={() => setCustomerDialogOpen(true)}>
                      <UserRound className="h-5 w-5" /> Cari Seç
                    </Button>
                  </section>

                  <section className="relative rounded-[24px] border border-[var(--brand-border)] bg-[var(--surface)] p-4">
                    <h3 className="mb-3 flex items-center gap-2 text-lg font-black text-[var(--brand-primary-strong)]">
                      <Barcode className="h-5 w-5" /> Ürün Seç
                    </h3>
                    <div className="relative">
                      <Barcode className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[var(--muted-foreground)]" />
                      <Input
                        ref={quickInputRef}
                        value={quickQuery}
                        onChange={(event) => {
                          setQuickQuery(event.target.value);
                          setActiveQuickIndex(0);
                        }}
                        onKeyDown={onQuickKeyDown}
                        placeholder="Barkod, stok kodu veya ürün adı"
                        className="h-16 rounded-[18px] pl-12 text-lg font-black"
                      />
                    </div>
                    {debouncedQuickQuery.trim().length >= 2 ? (
                      <div className="absolute left-4 right-4 z-30 mt-2 rounded-[20px] border border-[var(--brand-border)] bg-[var(--surface)] p-2 shadow-xl">
                        {quickSearchQuery.isLoading ? (
                          <div className="space-y-2 p-2">
                            {Array.from({ length: 3 }).map((_, index) => (
                              <Skeleton key={`quick-modal-skeleton-${index}`} className="h-14 rounded-[16px]" />
                            ))}
                          </div>
                        ) : quickProducts.length > 0 ? (
                          <ScrollArea className="max-h-60">
                            <div className="grid gap-2 p-1">
                              {quickProducts.map((product, index) => (
                                <button
                                  key={product.id}
                                  type="button"
                                  className={cn(
                                    "flex w-full items-center justify-between gap-3 rounded-[16px] border border-[var(--brand-border)] px-4 py-3 text-left transition",
                                    index === normalizedActiveQuickIndex ? "bg-[var(--brand-accent-soft)]" : "bg-[var(--surface-soft)] hover:border-[var(--brand-primary)]"
                                  )}
                                  onMouseEnter={() => setActiveQuickIndex(index)}
                                  onClick={() => addQuickProduct(product)}
                                >
                                  <span className="min-w-0">
                                    <span className="block truncate text-base font-black text-[var(--brand-primary-strong)]">{product.sku}</span>
                                    <span className="block truncate text-sm font-bold text-[var(--muted-foreground)]">{product.name}</span>
                                  </span>
                                  <span className="shrink-0 text-base font-black text-[var(--brand-primary-strong)]">{formatCurrency(product.net_price ?? "0")}</span>
                                </button>
                              ))}
                            </div>
                          </ScrollArea>
                        ) : (
                          <p className="px-3 py-3 text-base font-semibold text-[var(--muted-foreground)]">Sonuç bulunamadı.</p>
                        )}
                      </div>
                    ) : null}
                  </section>
                </div>

                <section className="overflow-hidden rounded-[24px] border border-[var(--brand-border)] bg-[var(--surface)]">
                  <div className="flex items-center justify-between gap-3 border-b border-[var(--brand-border)] px-5 py-4">
                    <h3 className="text-xl font-black text-[var(--brand-primary-strong)]">Sepet</h3>
                    <p className="text-3xl font-black text-[var(--brand-primary-strong)]">{formatCurrency(fromCents(totals.grandTotalCents))}</p>
                  </div>
                  <Table>
                    <TableHeader>
	                      <TableRow>
	                        <TableHead>Ürün</TableHead>
	                        <TableHead>Raf</TableHead>
	                        <TableHead className="text-right">Adet</TableHead>
	                        <TableHead className="text-right">Toplam</TableHead>
	                        <TableHead className="w-[150px] text-right">Aksiyon</TableHead>
	                      </TableRow>
                    </TableHeader>
                    <TableBody>
	                      {visibleCartItems.length === 0 ? (
	                        <TableRow>
	                          <TableCell colSpan={5} className="py-10 text-center text-base font-semibold text-[var(--muted-foreground)]">
	                            Sepet boş. Ürün arayıp ekleyin.
	                          </TableCell>
	                        </TableRow>
                      ) : (
                        visibleCartItems.map((item) => (
                          <TableRow key={item.product_id}>
                            <TableCell>
	                              <p className="text-base font-black text-[var(--brand-primary-strong)]">{item.name}</p>
	                              <p className="text-sm font-semibold text-[var(--muted-foreground)]">{item.sku}</p>
	                            </TableCell>
	                            <TableCell className="text-sm font-semibold text-[var(--muted-foreground)]">{item.shelf_address ?? "-"}</TableCell>
	                            <TableCell className="text-right text-lg font-black">{item.qty}</TableCell>
                            <TableCell className="text-right text-lg font-black">{formatCurrency(fromCents(item.unit_price_cents * item.qty))}</TableCell>
                            <TableCell>
                              <div className="flex justify-end gap-2">
                                <Button type="button" size="icon" variant="outline" className="h-11 w-11 rounded-[14px]" onClick={() => changeQty(item.product_id, -1)}>
                                  <Minus className="h-5 w-5" />
                                </Button>
                                <Button type="button" size="icon" variant="outline" className="h-11 w-11 rounded-[14px]" onClick={() => changeQty(item.product_id, 1)}>
                                  <Plus className="h-5 w-5" />
                                </Button>
                                <Button type="button" size="icon" variant="destructive" className="h-11 w-11 rounded-[14px]" onClick={() => removeItem(item.product_id)}>
                                  <Trash2 className="h-5 w-5" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                  <div className="grid gap-3 border-t border-[var(--brand-border)] p-5 md:grid-cols-2">
                    <Button type="button" variant="outline" className="h-16 rounded-[18px] text-lg font-black" onClick={() => setPosActionDialog(null)}>
                      Kapat
                    </Button>
                    <Button
                      type="button"
                      className="h-16 rounded-[18px] text-lg font-black"
                      onClick={() => {
                        setPosActionDialog(null);
                        openPaymentModal();
                      }}
                      disabled={!canSubmitSale || isMutating}
                    >
                      <Printer className="h-6 w-6" /> {POS_SAVE_AND_PRINT_LABEL}
                    </Button>
                  </div>
                </section>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={pointProductDialogOpen} onOpenChange={setPointProductDialogOpen}>
        <DialogContent className="flex max-h-[calc(100vh-48px)] max-w-[min(980px,calc(100vw-32px))] flex-col overflow-hidden rounded-[30px] border-[#243d34] bg-[#071018] p-0 text-[#edf7ef] shadow-[0_34px_110px_-42px_rgba(0,0,0,0.9)]">
          <DialogHeader className="border-b border-[#243d34] bg-[linear-gradient(135deg,rgba(31,107,69,0.26)_0%,rgba(250,238,86,0.055)_52%,rgba(8,19,27,0.98)_100%)] px-6 py-5 text-left">
            <div className="flex items-start justify-between gap-4">
              <div>
                <DialogTitle className="text-2xl font-black tracking-tight text-white">Ürün Seçimi</DialogTitle>
                <DialogDescription className="mt-1 text-sm font-semibold text-[#c2d3c6]">
                  Ürün adı veya stok kodu ile arayın, satıra dokunarak seçin.
                </DialogDescription>
              </div>
              <div className="hidden rounded-2xl border border-[#416650] bg-[#0c1a1d]/90 px-4 py-3 text-right sm:block">
                <p className="text-[11px] font-black uppercase tracking-[0.16em] text-[#8fa394]">Listelenen</p>
                <p className="mt-1 text-2xl font-black text-[#faee56]">{pointProductDialogProducts.length}</p>
              </div>
            </div>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-4 p-5 sm:p-6">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#8fa394]" />
              <Input
                value={pointProductDialogQuery}
                onChange={(event) => setPointProductDialogQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || pointProductDialogProducts.length === 0) {
                    return;
                  }

                  event.preventDefault();
                  selectPointProductFromDialog(pointProductDialogProducts[0]);
                }}
                placeholder="Stok kodu veya ürün adı ara"
                className="h-14 rounded-2xl border-[#416650] bg-[#07120f] pl-12 text-base font-bold text-white shadow-none placeholder:text-[#879a91] focus-visible:ring-[#72bf82]/45"
              />
            </label>

            <div className="overflow-hidden rounded-[24px] border border-[#243d34] bg-[#071018]">
              <div className="overflow-x-auto">
                <div
                  className="grid gap-3 border-b border-[#243d34] bg-[#0c1a1d] px-5 py-3 text-[11px] font-black uppercase tracking-[0.12em] text-[#879a91] max-lg:hidden"
                  style={{ gridTemplateColumns: pointProductDialogGridTemplate, minWidth: pointProductDialogGridMinWidth }}
                >
                  <span>Stok Kodu</span>
                  <span>Ürün Adı</span>
                  {visiblePointProductStockColumns.map((column) => (
                    <span key={column.key} className="text-right">
                      {column.label}
                    </span>
                  ))}
                  <span className="text-right">Seç</span>
                </div>
              </div>
              <div className="h-[clamp(240px,calc(100vh-390px),430px)] overflow-y-auto">
                <div className="space-y-2 overflow-x-auto p-3">
                  {pointProductDialogQuery.trim().length < 2 ? (
                    <div className="rounded-2xl border border-dashed border-[#416650] bg-[#0c1a1d] px-5 py-10 text-center">
                      <p className="text-lg font-black text-white">Ürün arayın</p>
                      <p className="mt-1 text-sm font-semibold text-[#8fa394]">Stok kodu veya ürün adı yazınca sonuçlar burada listelenir.</p>
                    </div>
                  ) : pointProductDialogSearchQuery.isLoading ? (
                    Array.from({ length: 5 }).map((_, index) => (
                      <div key={`product-dialog-skeleton-${index}`} className="grid grid-cols-[minmax(0,1fr)_92px] gap-3 rounded-2xl border border-[#243d34] bg-[#0c1a1d] p-3">
                        <div className="space-y-2">
                          <Skeleton className="h-4 w-36 bg-[#243d34]" />
                          <Skeleton className="h-4 w-72 max-w-full bg-[#243d34]" />
                        </div>
                        <Skeleton className="h-10 w-24 rounded-xl bg-[#243d34]" />
                      </div>
                    ))
                  ) : pointProductDialogProducts.length > 0 ? (
                    pointProductDialogProducts.map((product) => {
                      const stockRows = pointStockRows(product, visiblePointProductStockColumns);

                      return (
                        <button
                          key={product.id}
                          type="button"
                          onClick={() => selectPointProductFromDialog(product)}
                          className="group grid w-full min-w-[520px] grid-cols-[minmax(0,1fr)_92px] items-center gap-3 rounded-2xl border border-[#243d34] bg-[#0c1a1d] p-3 text-left transition-all duration-150 hover:border-[#72bf82]/55 hover:bg-[#10231f] lg:px-5"
                          style={{ gridTemplateColumns: pointProductDialogGridTemplate, minWidth: pointProductDialogGridMinWidth }}
                        >
                          <div className="min-w-0">
                            <p className="truncate text-base font-black text-[#e6f3e9]">{product.sku}</p>
                            <div className="mt-2 flex flex-wrap gap-1.5 lg:hidden">
                              {stockRows.map((row) => (
                                <span key={`${product.id}-${row.key}-mobile`} className="rounded-lg border border-[#315246] bg-[#091712] px-2 py-1 text-[11px] font-black text-[#c2d3c6]">
                                  {row.label}: {row.stock ?? "-"}{row.shelfAddress ? ` · ${row.shelfAddress}` : ""}
                                </span>
                              ))}
                            </div>
                          </div>
                          <div className="min-w-0 max-lg:order-first max-lg:col-span-2">
                            <p className="mb-2 truncate text-base font-black text-[#faee56] lg:hidden">{product.sku}</p>
                            <p className="truncate text-base font-black text-white">{product.name}</p>
                            <p className="mt-1 truncate text-xs font-bold text-[#8fa394]">
                              {formatPointProductDisplayPrice(product, pointPriceIncludesVat, pointDisplayCurrencyLabel)}
                            </p>
                          </div>
                          {stockRows.map((row) => (
                            <div key={`${product.id}-${row.key}`} className="hidden text-right lg:block">
                              <p className={cn("text-sm font-black", row.stock && row.stock > 0 ? "text-[#faee56]" : "text-[#8fa394]")}>
                                {row.stock ?? "-"}
                              </p>
                              <p className="mt-1 truncate text-[11px] font-bold text-[#8fa394]">{row.shelfAddress ?? "-"}</p>
                            </div>
                          ))}
                          <span className="inline-flex h-10 items-center justify-center rounded-xl bg-[#173421] px-4 text-sm font-black text-[#c2d3c6] group-hover:bg-[#1f6b45] group-hover:text-white">
                            Seç
                          </span>
                        </button>
                      );
                    })
                  ) : (
                    <div className="rounded-2xl border border-dashed border-[#416650] bg-[#0c1a1d] px-5 py-10 text-center">
                      <p className="text-lg font-black text-white">Ürün bulunamadı</p>
                      <p className="mt-1 text-sm font-semibold text-[#8fa394]">Stok kodu veya ürün adını kontrol edip tekrar arayın.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <DialogFooter className="border-t border-[#243d34] bg-[#071018] px-6 py-4">
            <Button variant="outline" className="h-11 rounded-2xl border-[#416650] bg-[#0c1a1d] px-5 font-black text-[#e6f3e9] hover:bg-[#14281e] hover:text-white" onClick={() => setPointProductDialogOpen(false)}>
              Kapat
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={customerDialogOpen} onOpenChange={setCustomerDialogOpen}>
        <DialogContent className="flex max-h-[calc(100vh-48px)] max-w-[min(1120px,calc(100vw-32px))] flex-col overflow-hidden rounded-[30px] border-[#243d34] bg-[#071018] p-0 text-[#edf7ef] shadow-[0_34px_110px_-42px_rgba(0,0,0,0.9)]">
          <DialogHeader className="border-b border-[#243d34] bg-[linear-gradient(135deg,rgba(31,107,69,0.26)_0%,rgba(250,238,86,0.055)_52%,rgba(8,19,27,0.98)_100%)] px-6 py-5 text-left">
            <div className="flex items-start justify-between gap-4">
              <div>
                <DialogTitle className="text-2xl font-black tracking-tight text-white">Cari Seçimi</DialogTitle>
                <DialogDescription className="mt-1 text-sm font-semibold text-[#c2d3c6]">
                  Satıra dokunarak cari seçebilirsiniz.
                </DialogDescription>
              </div>
              <div className="hidden rounded-2xl border border-[#416650] bg-[#0c1a1d]/90 px-4 py-3 text-right sm:block">
                <p className="text-[11px] font-black uppercase tracking-[0.16em] text-[#8fa394]">Listelenen</p>
                <p className="mt-1 text-2xl font-black text-[#faee56]">
                  {customerOptions.length}
                  {customerSearchTotal !== null ? <span className="text-base text-[#8fa394]"> / {customerSearchTotal}</span> : null}
                </p>
              </div>
            </div>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-4 p-5 sm:p-6">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#8fa394]" />
              <Input
                value={customerQuery}
                onChange={(event) => setCustomerQuery(event.target.value)}
                placeholder="Cari kodu veya ünvan ara"
                className="h-14 rounded-2xl border-[#416650] bg-[#07120f] pl-12 text-base font-bold text-white shadow-none placeholder:text-[#879a91] focus-visible:ring-[#72bf82]/45"
              />
            </label>

            <div className="overflow-hidden rounded-[24px] border border-[#243d34] bg-[#071018]">
              <div className="grid grid-cols-[170px_minmax(0,1fr)_180px_130px] gap-4 border-b border-[#243d34] bg-[#0c1a1d] px-5 py-3 text-[11px] font-black uppercase tracking-[0.14em] text-[#879a91] max-lg:hidden">
                <span>Kod</span>
                <span>Ünvan</span>
                <span>Telefon</span>
                <span className="text-right">Durum</span>
              </div>
              <div ref={customerListScrollRef} className="h-[clamp(220px,calc(100vh-390px),438px)] overflow-y-auto">
                <div className="space-y-2 p-3">
                  {customerSearchQuery.isLoading ? (
                    Array.from({ length: 6 }).map((_, index) => (
                      <div key={`customer-skeleton-${index}`} className="grid grid-cols-[52px_minmax(0,1fr)_104px] gap-3 rounded-2xl border border-[#243d34] bg-[#0c1a1d] p-3">
                        <Skeleton className="h-12 w-12 rounded-2xl bg-[#243d34]" />
                        <div className="space-y-2 py-1">
                          <Skeleton className="h-4 w-36 bg-[#243d34]" />
                          <Skeleton className="h-4 w-64 max-w-full bg-[#243d34]" />
                        </div>
                        <Skeleton className="h-10 w-24 rounded-xl bg-[#243d34]" />
                      </div>
                    ))
                  ) : customerOptions.length > 0 ? (
                    <>
                    {customerOptions.map((customer) => {
                      const isSelectedCustomer = selectedCustomer?.id === customer.id;
                      const location = [customer.city, customer.district].filter(Boolean).join(" / ");

                      return (
                        <button
                          key={customer.id}
                          type="button"
                          onClick={() => handleSelectCustomer(customer)}
                          className={cn(
                            "group grid w-full grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-4 rounded-2xl border p-3 text-left transition-all duration-150 sm:grid-cols-[52px_170px_minmax(0,1fr)_180px_130px]",
                            isSelectedCustomer
                              ? "border-[#72bf82]/70 bg-[linear-gradient(135deg,rgba(31,107,69,0.34)_0%,rgba(250,238,86,0.075)_100%)] shadow-[0_18px_42px_-32px_rgba(31,107,69,0.75)]"
                              : "border-[#243d34] bg-[#0c1a1d] hover:border-[#72bf82]/55 hover:bg-[#10231f]"
                          )}
                        >
                          <span
                            className={cn(
                              "flex h-12 w-12 items-center justify-center rounded-2xl border text-sm font-black",
                              isSelectedCustomer
                                ? "border-[#72bf82]/70 bg-[#1f6b45] text-white"
                                : "border-[#416650] bg-[#07120f] text-[#72bf82] group-hover:border-[#72bf82]/60"
                            )}
                          >
                            {isSelectedCustomer ? <Check className="h-5 w-5" /> : getCustomerInitials(customer)}
                          </span>

                          <div className="hidden min-w-0 sm:block">
                            <p className="truncate text-base font-black text-[#e6f3e9]">{customer.code}</p>
                            {location ? <p className="mt-1 truncate text-xs font-bold text-[#8fa394]">{location}</p> : null}
                          </div>

                          <div className="min-w-0">
                            <p className="truncate text-base font-black text-white">{customer.title}</p>
                            <p className="mt-1 truncate text-sm font-bold text-[#8fa394] sm:hidden">{customer.code}{location ? ` · ${location}` : ""}</p>
                          </div>

                          <div className="hidden truncate text-sm font-bold text-[#c2d3c6] sm:block">
                            {customer.phone ?? "Telefon yok"}
                          </div>

                          <span
                            className={cn(
                              "inline-flex h-10 items-center justify-center rounded-xl px-4 text-sm font-black",
                              isSelectedCustomer
                                ? "bg-[#faee56] text-[#193126]"
                                : "bg-[#173421] text-[#c2d3c6] group-hover:bg-[#1f6b45] group-hover:text-white"
                            )}
                          >
                            {isSelectedCustomer ? "Seçili" : "Seç"}
                          </span>
                        </button>
                      );
                    })}
                    <div ref={customerListLoadMoreRef} className="min-h-6">
                      {customerSearchQuery.isFetchingNextPage ? (
                        <div className="flex items-center justify-center gap-2 rounded-2xl border border-[#243d34] bg-[#0c1a1d] px-4 py-3 text-sm font-black text-[#c2d3c6]">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Diğer cariler yükleniyor
                        </div>
                      ) : customerSearchQuery.hasNextPage ? (
                        <button
                          type="button"
                          onClick={() => void customerSearchQuery.fetchNextPage()}
                          className="w-full rounded-2xl border border-[#416650] bg-[#0c1a1d] px-4 py-3 text-sm font-black text-[#c2d3c6] transition hover:border-[#72bf82]/60 hover:bg-[#10231f] hover:text-white"
                        >
                          Daha fazla cari yükle
                        </button>
                      ) : customerOptions.length > 0 ? (
                        <p className="py-2 text-center text-xs font-bold text-[#8fa394]">Tüm cariler listelendi.</p>
                      ) : null}
                    </div>
                    </>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-[#416650] bg-[#0c1a1d] px-5 py-10 text-center">
                      <p className="text-lg font-black text-white">Cari bulunamadı</p>
                      <p className="mt-1 text-sm font-semibold text-[#8fa394]">Kod veya ünvanı kontrol edip tekrar arayın.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <DialogFooter className="border-t border-[#243d34] bg-[#071018] px-6 py-4">
            <Button variant="outline" className="h-11 rounded-2xl border-[#416650] bg-[#0c1a1d] px-5 font-black text-[#e6f3e9] hover:bg-[#14281e] hover:text-white" onClick={() => setCustomerDialogOpen(false)}>
              Kapat
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pointLedgerDialogOpen} onOpenChange={setPointLedgerDialogOpen}>
        <DialogContent className="max-h-[calc(100vh-36px)] max-w-[min(1380px,calc(100vw-28px))] overflow-hidden rounded-[30px] border-[#355744] bg-[#071018] p-0 text-[#e6f3e9]">
          <DialogHeader className="border-b border-[#243d34] bg-[#102018] px-6 py-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <DialogTitle className="text-3xl font-black tracking-tight text-white">Cari Satış / Tahsilat Hareketleri</DialogTitle>
                <DialogDescription className="mt-1 truncate text-base font-bold text-[#8fa394]">
                  {selectedCustomer ? `${selectedCustomer.code} · ${selectedCustomer.title}` : "Cari seçilmedi"}
                </DialogDescription>
              </div>

              {selectedCustomer ? (
                <div className="rounded-[18px] border border-[#416650] bg-[#0a1713] px-5 py-3 text-right">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#8fa394]">Cari Bakiye</p>
                  <p className="mt-1 text-2xl font-black text-[#faee56]">
                    {formatCurrency(selectedCustomer.balance_summary.total_due)}
                  </p>
                </div>
              ) : null}
            </div>
          </DialogHeader>

          <div className="space-y-4 p-5">
            <div className="flex flex-col gap-3 rounded-[22px] border border-[#243d34] bg-[#0a1713] p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-lg font-black text-white">
                  {selectedCustomer ? selectedCustomer.title : "Cari seçilmedi"}
                </p>
                <p className="mt-1 text-sm font-bold text-[#8fa394]">
                  {selectedCustomer
                    ? [selectedCustomer.code, selectedCustomer.city, selectedCustomer.district].filter(Boolean).join(" · ")
                    : "Hareket geçmişi için önce cari seçin."}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                className="h-11 rounded-[14px] border-[#416650] bg-[#102018] px-5 font-black text-[#e6f3e9] hover:bg-[#173421] hover:text-white"
                onClick={() => void pointLedgerQuery.refetch()}
                disabled={!selectedCustomer || pointLedgerQuery.isFetching}
              >
                {pointLedgerQuery.isFetching ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCcw className="h-4 w-4" />
                )}
                Yenile
              </Button>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              {[
                {
                  key: "sales",
                  title: "Cari Satışlar",
                  subtitle: "Fatura ve borç hareketleri",
                  rows: pointLedgerSaleRows,
                  emptyMessage: "Bu cari için satış hareketi bulunamadı.",
                },
                {
                  key: "collections",
                  title: "Tahsilatlar",
                  subtitle: "Tahsilat ve alacak hareketleri",
                  rows: pointLedgerCollectionRows,
                  emptyMessage: "Bu cari için tahsilat hareketi bulunamadı.",
                },
              ].map((section) => (
                <section key={section.key} className="overflow-hidden rounded-[22px] border border-[#243d34] bg-[#07120f]">
                  <div className="flex items-center justify-between gap-3 border-b border-[#243d34] bg-[#0f1d17] px-4 py-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-lg font-black text-white">{section.title}</h3>
                      <p className="mt-0.5 truncate text-xs font-bold text-[#8fa394]">{section.subtitle}</p>
                    </div>
                    <Badge className="border-[#416650] bg-[#173421] text-[#faee56] hover:bg-[#173421]">
                      {section.rows.length}
                    </Badge>
                  </div>
                  <ScrollArea className="max-h-[430px]">
                    <div className="overflow-x-auto">
                      <Table className="min-w-[760px]">
                        <TableHeader>
                          <TableRow className="border-[#243d34] bg-[#0f1d17] hover:bg-[#0f1d17]">
                            <TableHead className="text-[#c2d3c6]">Tarih</TableHead>
                            <TableHead className="text-[#c2d3c6]">Tip</TableHead>
                            <TableHead className="text-[#c2d3c6]">Açıklama</TableHead>
                            <TableHead className="text-[#c2d3c6]">Referans</TableHead>
                            <TableHead className="text-right text-[#c2d3c6]">Borç</TableHead>
                            <TableHead className="text-right text-[#c2d3c6]">Alacak</TableHead>
                            <TableHead className="text-right text-[#c2d3c6]">Bakiye</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>{renderPointLedgerTableBody(section.rows, section.emptyMessage)}</TableBody>
                      </Table>
                    </div>
                  </ScrollArea>
                </section>
              ))}
            </div>
          </div>

          <DialogFooter className="border-t border-[#243d34] bg-[#071018] px-6 py-4">
            <Button
              type="button"
              variant="outline"
              className="h-11 rounded-2xl border-[#416650] bg-[#0c1a1d] px-5 font-black text-[#e6f3e9] hover:bg-[#14281e] hover:text-white"
              onClick={() => setPointLedgerDialogOpen(false)}
            >
              Kapat
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={paymentDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            pointPrintAfterSaveRef.current = false;
          }
          setPaymentDialogOpen(open);
        }}
      >
        <DialogContent className="max-w-[min(460px,calc(100vw-32px))] rounded-[24px]">
          <form className="space-y-6" onSubmit={submitSale}>
            <DialogHeader className="text-left">
              <DialogTitle>Sipariş Onayı</DialogTitle>
              <DialogDescription className="text-base font-semibold text-[var(--muted-foreground)]">
                Siparişi onaylamak istediğinizden emin misiniz?
              </DialogDescription>
            </DialogHeader>

            <DialogFooter className="gap-2 sm:justify-end">
              <Button
                type="button"
                variant="outline"
                className="h-12 rounded-[14px] px-7 text-base font-black"
                onClick={() => {
                  pointPrintAfterSaveRef.current = false;
                  setPaymentDialogOpen(false);
                }}
              >
                Hayır
              </Button>
              <Button type="submit" className="h-12 rounded-[14px] px-7 text-base font-black" disabled={createSaleMutation.isPending}>
                {createSaleMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                Evet
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={closeSessionDialogOpen} onOpenChange={setCloseSessionDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Gün Sonu - Oturum Kapat</DialogTitle>
            <DialogDescription>Kasa sayımını girerek POS oturumunu kapatın.</DialogDescription>
          </DialogHeader>

          <form className="space-y-3" onSubmit={handleCloseSession}>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">Sayılan Nakit</label>
              <Input
                type="number"
                min={0}
                step="0.01"
                {...closeSessionForm.register("closing_cash_counted", { valueAsNumber: true })}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">Not</label>
              <Input placeholder="Opsiyonel not" {...closeSessionForm.register("note")} />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCloseSessionDialogOpen(false)}>
                Vazgeç
              </Button>
              <Button type="submit" variant="destructive" disabled={closeSessionMutation.isPending}>
                {closeSessionMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Oturumu Kapat
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(movementProduct)} onOpenChange={(open) => !open && setMovementProduct(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Stok Hareketleri</DialogTitle>
            <DialogDescription>
              {movementProduct
                ? `${movementProduct.sku} · ${movementProduct.name} için son POS hareketleri`
                : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-md border border-[var(--brand-border)]">
            <ScrollArea className="max-h-[380px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tarih</TableHead>
                    <TableHead>Fiş No</TableHead>
                    <TableHead>Müşteri</TableHead>
                    <TableHead>Yön</TableHead>
                    <TableHead className="text-right">Miktar</TableHead>
                    <TableHead>Durum</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {movementQuery.isLoading ? (
                    Array.from({ length: 6 }).map((_, index) => (
                      <TableRow key={`movement-skeleton-${index}`}>
                        <TableCell><Skeleton className="h-4 w-28" /></TableCell>
                        <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                        <TableCell><Skeleton className="h-4 w-28" /></TableCell>
                        <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                        <TableCell><Skeleton className="ml-auto h-4 w-12" /></TableCell>
                        <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                      </TableRow>
                    ))
                  ) : movementQuery.data && movementQuery.data.length > 0 ? (
                    movementQuery.data.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>{new Date(row.created_at).toLocaleString("tr-TR")}</TableCell>
                        <TableCell className="font-medium">{row.receipt_no}</TableCell>
                        <TableCell>{row.customer}</TableCell>
                        <TableCell>
                          <Badge variant={row.direction === "out" ? "outline" : "secondary"}>
                            {row.direction === "out" ? "Çıkış" : "Giriş"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">{row.qty}</TableCell>
                        <TableCell>{row.status}</TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={6} className="py-8 text-center text-sm text-[var(--muted-foreground)]">
                        Hareket bulunamadı.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </ScrollArea>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setMovementProduct(null)}>
              Kapat
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
