"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  Calculator,
  ImageIcon,
  Loader2,
  Minus,
  PackageSearch,
  Plus,
  Search,
  ShoppingCart,
  X,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useCart } from "@/components/cart/cart-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type ProductPreviousPurchase,
  type ProductSearchItem,
  getProductFilterOptions,
  resolveApiBaseUrl,
  searchProducts,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const PAGE_LIMIT = 12;
const SEARCH_DEBOUNCE_MS = 500;
const MIN_SEARCH_LENGTH = 2;
const PRODUCT_PREVIEW_IMAGE_WIDTH = 960;
const ALL_FILTER_VALUE = "__all";
const PRODUCT_TABLE_GRID =
  "grid w-full items-stretch gap-0";
const PRODUCT_FILTER_TRIGGER_CLASS =
  "admin-dashboard-ghost h-12 w-full rounded-xl bg-[var(--surface-soft)] px-4 text-left text-sm font-extrabold shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-colors hover:border-[var(--brand-primary)]/55 hover:bg-[color-mix(in_oklab,var(--brand-primary)_10%,var(--surface))] focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]/45";
const PRODUCT_FILTER_CONTENT_CLASS =
  "max-h-[340px] w-[var(--radix-select-trigger-width)] min-w-[var(--radix-select-trigger-width)] rounded-xl border border-[var(--brand-border)] bg-[#111c1e] p-1 text-[#e8f1ec] shadow-[0_24px_52px_-30px_rgba(0,0,0,0.88)]";
const PRODUCT_FILTER_ITEM_CLASS =
  "min-h-10 cursor-pointer rounded-lg py-2.5 pl-9 pr-3 text-[13px] font-extrabold text-[#e8f1ec] outline-none transition-colors hover:bg-[#1d3431] hover:text-white focus:bg-[#24423d] focus:text-white data-[highlighted]:bg-[#24423d] data-[highlighted]:text-white data-[state=checked]:text-[#bff3c2]";
const PRODUCT_RESET_QUERY_KEYS = ["q", "brand_id", "kod2", "kod3", "all", "sort"];
type ProductSort = "recommended" | "stock_desc" | "price_asc" | "price_desc";
type ProductMetaFilters = {
  kod2: string;
  kod3: string;
};
type CalculatorOperator = "+" | "-" | "*" | "/";
type ProductSearchPageParam = {
  cursor: string | null;
  page: number;
};

function productTableGridStyle(stockColumnCount: number): CSSProperties {
  const normalizedStockColumnCount = Math.max(stockColumnCount, 1);
  const stockColumnWidth = Math.min(210, Math.max(88, normalizedStockColumnCount * 58));
  const minWidth = 925 + stockColumnWidth;
  const stockColumnFlex = normalizedStockColumnCount >= 5 ? 0.94 : normalizedStockColumnCount === 2 ? 0.58 : 0.42;

  return {
    minWidth,
    gridTemplateColumns: `40px minmax(84px,0.64fr) minmax(64px,0.42fr) minmax(250px,1.55fr) minmax(62px,0.36fr) 48px 78px minmax(${stockColumnWidth}px,${stockColumnFlex}fr) 154px 58px`,
  };
}

const PRODUCT_SORT_OPTIONS: Array<{ value: ProductSort; label: string }> = [
  { value: "recommended", label: "Önerilen" },
  { value: "stock_desc", label: "Stok: Çoktan aza" },
  { value: "price_asc", label: "Fiyat: Artan" },
  { value: "price_desc", label: "Fiyat: Azalan" },
];

function parseSort(value: string | null): ProductSort {
  return PRODUCT_SORT_OPTIONS.some((option) => option.value === value)
    ? (value as ProductSort)
    : "recommended";
}

function parseOptionalNumber(value: string | null): number | null {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseMetaFilters(params: URLSearchParams): ProductMetaFilters {
  return {
    kod2: params.get("kod2") ?? "",
    kod3: params.get("kod3") ?? "",
  };
}

function shouldResetFiltersAfterReload(params: URLSearchParams): boolean {
  if (typeof window === "undefined" || typeof window.performance === "undefined") {
    return false;
  }

  const navigation = window.performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const isReload = navigation?.type === "reload";
  if (!isReload) {
    return false;
  }

  return PRODUCT_RESET_QUERY_KEYS.some((key) => params.has(key));
}

function formatTry(value: string | null): string {
  if (!value) {
    return "-";
  }

  const parsed = parseDecimalValue(value);
  if (!Number.isFinite(parsed)) {
    return `${value} TRY`;
  }

  return formatTryAmount(parsed);
}

function currencyLabel(currency: string | null | undefined): string {
  const normalized = typeof currency === "string" ? currency.trim().toUpperCase() : "";

  if (normalized === "GEL" || normalized === "LARI") {
    return "GEL";
  }

  if (normalized === "TRY" || normalized === "TL" || normalized === "TRL") {
    return "TRY";
  }

  return normalized || "TRY";
}

function formatPriceValue(value: string | null | undefined, currency?: string | null): string {
  if (!value) {
    return "-";
  }

  const parsed = parseDecimalValue(value);
  if (parsed === null || !Number.isFinite(parsed)) {
    return value;
  }

  const formatted = parsed.toLocaleString("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const label = currencyLabel(currency);

  return label === "TRY" ? formatted : `${formatted} ${label}`;
}

function formatProductDate(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function formatProductDateTime(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatPercentValue(value: string | null | undefined): string {
  const parsed = parseDecimalValue(value);
  if (parsed === null) {
    return "-";
  }

  return `%${parsed.toLocaleString("tr-TR", { maximumFractionDigits: 2 })}`;
}

function parseDecimalValue(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = typeof value === "number" ? value : Number(String(value).replace(",", "."));

  return Number.isFinite(parsed) ? parsed : null;
}

function formatTryAmount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "-";
  }

  return `${value.toLocaleString("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} TRY`;
}

function formatProductAmount(value: number | null, currency?: string | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "-";
  }

  return `${value.toLocaleString("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currencyLabel(currency)}`;
}

function formatProductModalPrice(product: ProductSearchItem, value: string | null | undefined, includeVat: boolean): string {
  const parsed = parseDecimalValue(value);
  if (parsed === null) {
    return "-";
  }

  const vatRate = parseDecimalValue(product.vat_rate) ?? 0;

  return formatProductAmount(includeVat ? parsed * (1 + vatRate / 100) : parsed, product.currency);
}

function formatPackageQuantity(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  const parsed = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  if (!Number.isFinite(parsed)) {
    return String(value);
  }

  return parsed.toLocaleString("tr-TR", {
    maximumFractionDigits: 3,
  });
}

function calculateValue(left: number, operator: CalculatorOperator, right: number): number {
  switch (operator) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      return right === 0 ? left : left / right;
  }
}

function formatCalculatorValue(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }

  return Number(value.toFixed(6)).toString();
}

function normalizeCalculatorInput(value: string): string {
  const normalized = value.replace(",", ".").replace(/[^\d.-]/g, "");
  const isNegative = normalized.startsWith("-");
  const unsigned = normalized.replace(/-/g, "");
  const [integerPart = "", ...decimalParts] = unsigned.split(".");
  const integerValue = integerPart.replace(/^0+(?=\d)/, "") || "0";
  const decimalValue = decimalParts.join("");
  const nextValue = decimalParts.length > 0 ? `${integerValue}.${decimalValue}` : integerValue;

  return `${isNegative ? "-" : ""}${nextValue}`.slice(0, 16);
}

function normalizePreviousPurchase(value: ProductSearchItem["previous_purchase"]): ProductPreviousPurchase | null {
  if (!value) {
    return null;
  }

  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function formatPreviousPurchase(value: ProductSearchItem["previous_purchase"]): string {
  const purchase = normalizePreviousPurchase(value);
  if (!purchase) {
    return "-";
  }

  const quantity = Number.isFinite(purchase.quantity) ? purchase.quantity.toLocaleString("tr-TR") : "-";
  const date = purchase.ordered_at
    ? new Intl.DateTimeFormat("tr-TR", { day: "2-digit", month: "2-digit", year: "2-digit" }).format(new Date(purchase.ordered_at))
    : null;

  return date ? `${quantity} adet / ${date}` : `${quantity} adet`;
}

function productStockLocations(product: ProductSearchItem): Array<{
  branch: string;
  warehouse_code?: string | null;
  stock: number;
  shelf_address?: string | null;
}> {
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

function productShelfAddress(product: ProductSearchItem): string {
  return (
    product.shelf_address ||
    product.stock_locations?.find((location) => location.shelf_address)?.shelf_address ||
    "-"
  );
}

const BRANCH_STOCK_COLUMNS = [
  { key: "erz-depo", label: "Erz. Depo", title: "Erzurum Depo", permissionKey: "search.stock.warehouse.erzurum_depo", aliases: ["1", "25", "genel", "erzurum", "erzurum dep", "erzurum depo", "erz depot", "erz depo", "erz. depo", "depo"] },
  { key: "erz-point", label: "Erz.Point", title: "Erzurum Point", permissionKey: "search.stock.warehouse.erzurum_point", aliases: ["0", "erzurum poi", "erzurum point", "erz point", "erz.point", "point", "poi"] },
  { key: "trabzon", label: "Trabzon", title: "Trabzon", permissionKey: "search.stock.warehouse.trabzon", aliases: ["2", "61", "trabzon dep", "trabzon depo", "trabzon", "trab"] },
  { key: "samsun", label: "Samsun", title: "Samsun", permissionKey: "search.stock.warehouse.samsun", aliases: ["3", "55", "samsun depo", "samsun", "sam"] },
  { key: "batum", label: "Batum", title: "Batum", permissionKey: "search.stock.warehouse.batum", aliases: ["4", "batum depo", "batum", "batumi"] },
] as const;
type BranchStockColumn = (typeof BRANCH_STOCK_COLUMNS)[number];

function normalizeBranchText(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLocaleLowerCase("tr-TR")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ");
}

function branchStockRows(product: ProductSearchItem, columns: readonly BranchStockColumn[]) {
  const locations = productStockLocations(product);

  return columns.map((branch) => {
    const matchedLocations = locations.filter((location) => {
      const haystack = [
        normalizeBranchText(location.branch),
        normalizeBranchText(location.warehouse_code),
        normalizeBranchText(`${location.branch} ${location.warehouse_code ?? ""}`),
      ].filter(Boolean);

      return branch.aliases.some((alias) => {
        const normalizedAlias = normalizeBranchText(alias);
        const numericAlias = /^\d+$/.test(normalizedAlias);

        return haystack.some((value) => (
          numericAlias ? value === normalizedAlias : value.includes(normalizedAlias)
        ));
      });
    });
    const stock = matchedLocations.reduce((total, location) => total + location.stock, 0);
    const shelfAddress = matchedLocations.find((location) => location.shelf_address)?.shelf_address ?? null;

    return {
      ...branch,
      stock: matchedLocations.length > 0 ? stock : null,
      shelfAddress,
    };
  });
}

function userSpecificBranchStockColumns(username: string | null | undefined): readonly BranchStockColumn[] | null {
  const normalizedUsername = normalizeBranchText(username);
  const allowedKeys = (() => {
    switch (normalizedUsername) {
      case "erzurum hizlisatis":
        return new Set(["erz-point", "erz-depo"]);
      case "ahmet arac":
      case "huseyin ozguney":
      case "mehmet aksoy":
        return new Set(["erz-depo"]);
      default:
        return null;
    }
  })();

  return allowedKeys ? BRANCH_STOCK_COLUMNS.filter((column) => allowedKeys.has(column.key)) : null;
}

function visibleBranchStockColumns(featurePermissionSet: Set<string>, roleSlugs: string[], username: string | null | undefined): readonly BranchStockColumn[] {
  const userSpecificColumns = userSpecificBranchStockColumns(username);
  if (userSpecificColumns !== null) {
    return userSpecificColumns;
  }

  if (roleSlugs.includes("admin") || roleSlugs.includes("moderator")) {
    return BRANCH_STOCK_COLUMNS;
  }

  const selectedColumns = BRANCH_STOCK_COLUMNS.filter((column) => featurePermissionSet.has(column.permissionKey));

  return selectedColumns.length > 0 ? selectedColumns : BRANCH_STOCK_COLUMNS;
}

function normalizeSearchValue(value: string | null | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase("tr-TR");
}

function getSearchPriority(product: ProductSearchItem, searchValue: string): number {
  if (!searchValue) {
    return 99;
  }

  const sku = normalizeSearchValue(product.sku);
  const oem = normalizeSearchValue(product.oem);
  const name = normalizeSearchValue(product.name);

  if (sku === searchValue) {
    return 0;
  }
  if (sku.startsWith(searchValue)) {
    return 1;
  }
  if (sku.includes(searchValue)) {
    return 2;
  }
  if (oem === searchValue) {
    return 3;
  }
  if (oem.startsWith(searchValue)) {
    return 4;
  }
  if (oem.includes(searchValue)) {
    return 5;
  }
  if (name.startsWith(searchValue)) {
    return 6;
  }
  if (name.includes(searchValue)) {
    return 7;
  }

  return 8;
}

type ProductRowProps = {
  product: ProductSearchItem;
  qty: number;
  cartDistinctLineCount: number;
  mutating: boolean;
  canAdd: boolean;
  canViewPrices: boolean;
  canViewStock: boolean;
  visibleStockColumns: readonly BranchStockColumn[];
  showRetailPriceHint: boolean;
  tableGridStyle: CSSProperties;
  style?: CSSProperties;
  onOpenCartModal: (product: ProductSearchItem, currentQty: number) => void;
  onPreviewImage: (preview: ProductImagePreview) => void;
  onShowCompetitorCodes: (preview: ProductCompetitorCodesPreview) => void;
  onShowOemCode: (preview: ProductOemCodePreview) => void;
  onShowVehicleFitments: (preview: ProductVehicleFitmentsPreview) => void;
  onShowPreviousPurchase: (preview: ProductPreviousPurchasePreview) => void;
};

type ProductImagePreview = {
  src: string;
  name: string;
  sku: string;
};

type ProductCompetitorCodesPreview = {
  sku: string;
  name: string;
  codes: NonNullable<ProductSearchItem["competitor_codes"]>;
};

type ProductOemCodePreview = {
  sku: string;
  name: string;
  oem: string | null | undefined;
};

type ProductVehicleFitmentsPreview = {
  sku: string;
  name: string;
  fitments: NonNullable<ProductSearchItem["vehicle_fitments"]>;
};

type ProductPreviousPurchasePreview = {
  sku: string;
  name: string;
  previousPurchase: ProductPreviousPurchase | null;
};

function normalizeCompetitorCodeRows(
  codes: ProductCompetitorCodesPreview["codes"],
): string[] {
  const seen = new Set<string>();
  const rows: string[] = [];

  for (const alias of codes) {
    const parts = alias.code.split(/[,;\n]+/);

    for (const part of parts) {
      const code = part.trim();
      const key = code.toUpperCase();

      if (!code || seen.has(key)) {
        continue;
      }

      seen.add(key);
      rows.push(code);
    }
  }

  return rows;
}

function formatVehicleYears(fitment: NonNullable<ProductSearchItem["vehicle_fitments"]>[number]): string {
  const from = fitment.year_from;
  const to = fitment.year_to;

  if (from && to) {
    return from === to ? String(from) : `${from}-${to}`;
  }
  if (from) {
    return `${from}>`;
  }
  if (to) {
    return `<${to}`;
  }

  return "-";
}

function formatVehicleTitle(fitment: NonNullable<ProductSearchItem["vehicle_fitments"]>[number]): string {
  return [fitment.make, fitment.model, fitment.trim, fitment.engine]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(" ") || "Araç bilgisi";
}

const ProductImageCell = memo(function ProductImageCell({
  product,
  onPreviewImage,
}: {
  product: ProductSearchItem;
  onPreviewImage: (preview: ProductImagePreview) => void;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const rawImageSrc = product.image_url ?? product.image_data_url ?? null;
  const resolvedImageSrc = useMemo(() => resolveProductImageSrc(rawImageSrc), [rawImageSrc]);
  const imageSrc = resolvedImageSrc && failedSrc !== resolvedImageSrc ? resolvedImageSrc : null;

  return (
    <div className="admin-product-media flex h-8 w-8 items-center justify-center overflow-hidden rounded-md border border-[var(--brand-border)] bg-[var(--surface-soft)]">
      {imageSrc ? (
        <button
          type="button"
          className="group h-full w-full cursor-zoom-in rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]"
          onClick={() => onPreviewImage({ src: resolveProductPreviewImageSrc(imageSrc), name: product.name, sku: product.sku })}
          aria-label={`${product.sku} ürün resmini büyüt`}
          title="Resmi büyüt"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageSrc}
            alt={product.name}
            className="h-full w-full object-contain p-1 transition-transform duration-200 group-hover:scale-105"
            loading="lazy"
            onError={() => setFailedSrc(resolvedImageSrc)}
          />
        </button>
      ) : (
        <ImageIcon className="h-5 w-5 text-[var(--muted-foreground)]" />
      )}
    </div>
  );
});

const ProductStockCell = memo(function ProductStockCell({
  product,
  canViewStock,
  columns,
}: {
  product: ProductSearchItem;
  canViewStock: boolean;
  columns: readonly BranchStockColumn[];
}) {
  const branchRows = branchStockRows(product, columns);

  if (branchRows.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center text-sm font-black text-[var(--muted-foreground)]">
        -
      </div>
    );
  }

  return (
    <div className="admin-product-stock h-full w-full min-w-0">
      <div
        className="grid h-full overflow-hidden bg-transparent"
        style={{ gridTemplateColumns: `repeat(${branchRows.length}, minmax(0, 1fr))` }}
      >
        {branchRows.map((branch, index) => {
          const isPositive = canViewStock && (branch.stock ?? 0) > 0;
          const shelfText = canViewStock ? branch.shelfAddress ?? "-" : "-";
          const hasShelfAddress = canViewStock && Boolean(branch.shelfAddress);

          return (
            <div
              key={`${product.id}-branch-stock-${branch.key}`}
              className={cn(
                "flex min-w-0 flex-col items-center justify-center gap-1 border-l border-[var(--brand-border)] px-1.5 py-1 text-center leading-none first:border-l-0",
                isPositive
                  ? "bg-emerald-300/10 text-emerald-100"
                  : "text-[var(--muted-foreground)]",
                index === 0 && isPositive && "bg-emerald-300/14"
              )}
            >
              <span className={cn("block w-full truncate text-[13px] font-black", isPositive ? "text-emerald-200" : "text-[var(--foreground)]")}>
                {canViewStock && branch.stock !== null ? branch.stock.toLocaleString("tr-TR") : "-"}
              </span>
              <span
                className={cn(
                  "inline-flex min-h-5 w-full min-w-0 items-center justify-center gap-1 rounded-md border px-1 text-[10px] font-black leading-[11px] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]",
                  hasShelfAddress
                    ? "border-sky-300/35 bg-sky-300/14 text-sky-100"
                    : "border-slate-500/20 bg-slate-500/10 text-slate-400"
                )}
                title={`${branch.title} raf adresi: ${shelfText}`}
              >
                <span className="min-w-0 whitespace-normal break-words text-center">{shelfText}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
});

function resolveProductImageSrc(source: string | null): string | null {
  if (!source) {
    return null;
  }

  if (source.startsWith("/api/")) {
    return `${resolveApiBaseUrl()}${source}`;
  }

  return source;
}

function resolveProductPreviewImageSrc(source: string): string {
  if (source.startsWith("data:")) {
    return source;
  }

  try {
    const url = new URL(source, typeof window !== "undefined" ? window.location.origin : "https://powersab2b.com");

    if (/\/api\/products\/\d+\/image$/.test(url.pathname)) {
      url.searchParams.set("w", String(PRODUCT_PREVIEW_IMAGE_WIDTH));
      return url.toString();
    }
  } catch {
    return source;
  }

  return source;
}

const ProductRow = memo(function ProductRow({
  product,
  qty,
  cartDistinctLineCount,
  mutating,
  canAdd,
  canViewPrices,
  canViewStock,
  visibleStockColumns,
  showRetailPriceHint,
  tableGridStyle,
  style,
  onOpenCartModal,
  onPreviewImage,
  onShowCompetitorCodes,
  onShowOemCode,
  onShowVehicleFitments,
  onShowPreviousPurchase,
}: ProductRowProps) {
  const effectiveNetPrice = product.special_discounted_price ?? product.net_price;
  const hasPrice = canViewPrices && Boolean(product.list_price ?? effectiveNetPrice);
  const hasCategory = Boolean(product.category?.name);
  const priceText = canViewPrices ? formatPriceValue(product.list_price ?? effectiveNetPrice, product.currency) : "-";
  const retailPriceText = canViewPrices ? formatPriceValue(effectiveNetPrice ?? product.list_price, product.currency) : "-";
  const competitorCodes = product.competitor_codes ?? [];
  const vehicleFitments = product.vehicle_fitments ?? [];
  const previousPurchase = normalizePreviousPurchase(product.previous_purchase);

  return (
    <div
      style={style}
      role="row"
      className="admin-product-row w-full"
    >
      <div
        className={cn("admin-product-row-grid group min-h-[50px] border-b border-l-4 border-[var(--brand-border)] border-l-transparent bg-[var(--surface)] transition-[background-color,border-color,box-shadow] duration-150 hover:border-l-[#8bd19f] hover:bg-[#1d3024] hover:shadow-[inset_0_0_0_9999px_rgba(139,209,159,0.08)]", PRODUCT_TABLE_GRID)}
        style={tableGridStyle}
      >
        <div role="cell" className="flex items-center justify-center px-1.5 py-1">
          <ProductImageCell product={product} onPreviewImage={onPreviewImage} />
        </div>

        <div role="cell" className="flex min-w-0 items-center border-l border-[var(--brand-border)] px-1.5 py-1">
          <p className="truncate text-[14px] font-black tracking-[0.02em] text-[#f8fff9] drop-shadow-[0_1px_1px_rgba(0,0,0,0.42)]">
            {product.sku}
          </p>
        </div>

        <div role="cell" className="flex min-w-0 flex-col justify-center border-l border-[var(--brand-border)] px-1.5 py-1">
          <p className="truncate text-[11px] font-extrabold text-[var(--foreground)]">
            {product.brand.name ?? "-"}
          </p>
          {hasCategory ? (
            <p className="mt-0.5 truncate text-[9px] font-medium text-[var(--muted-foreground)]">
              {product.category?.name}
            </p>
          ) : null}
        </div>

        <div role="cell" className="flex min-w-0 items-center border-l border-[var(--brand-border)] px-2 py-1">
          <p className="line-clamp-2 text-[12px] font-semibold leading-[14px] text-[var(--foreground)]">
            {product.name}
          </p>
        </div>

        <div role="cell" className="flex min-w-0 items-center border-l border-[var(--brand-border)] px-1.5 py-1">
          <p className="line-clamp-2 text-[11px] font-extrabold leading-[13px] text-[var(--muted-foreground)]">
            {product.type_name ?? "-"}
          </p>
        </div>

        <div role="cell" className="flex min-w-0 items-center justify-center border-l border-[var(--brand-border)] px-1 py-1">
          <p className="text-center text-[12px] font-extrabold text-[var(--foreground)]">
            {formatPackageQuantity(product.package_quantity)}
          </p>
        </div>

        <div role="cell" className="admin-product-price flex min-w-0 items-center justify-end border-l border-[var(--brand-border)] px-1.5 py-1">
          <p className="flex max-w-full justify-end text-right text-[12px] font-extrabold text-[var(--foreground)]">
            <span className="group/retail-price relative inline-flex max-w-full">
              <span className="truncate">{priceText}</span>
            {showRetailPriceHint && hasPrice ? (
              <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-3 hidden -translate-y-1/2 whitespace-nowrap rounded-xl border border-emerald-200/35 bg-[#101b18]/98 px-5 py-3 text-left font-black text-[#f3fff5] opacity-0 shadow-[0_18px_38px_-18px_rgba(0,0,0,0.98),0_0_28px_-12px_rgba(139,209,159,0.9)] ring-1 ring-white/10 group-hover/retail-price:block group-hover/retail-price:opacity-100">
                <span className="block text-[13px] uppercase tracking-[0.12em] text-[#9fb5a8]">Perakende Satış</span>
                <span className="mt-1 block text-[22px] leading-none text-[#faee56]">{retailPriceText}</span>
              </span>
            ) : null}
            </span>
          </p>
        </div>

        <div role="cell" className="flex min-w-0 items-stretch border-l border-[var(--brand-border)] px-0 py-0">
          <ProductStockCell product={product} canViewStock={canViewStock} columns={visibleStockColumns} />
        </div>

        <div role="cell" className="flex min-w-0 flex-col gap-1 border-l border-[var(--brand-border)] px-1 py-1">
          <p className="line-clamp-3 text-[10px] leading-[12px] text-[var(--foreground)]">
            {product.description || "-"}
          </p>
          <div className="grid max-w-full min-w-0 grid-cols-2 gap-1 text-[9px] font-black leading-tight">
            <button
              type="button"
              onClick={() => competitorCodes.length > 0 && onShowCompetitorCodes({ sku: product.sku, name: product.name, codes: competitorCodes })}
              disabled={competitorCodes.length === 0}
              className="flex h-7 min-w-0 items-center justify-between gap-1 rounded-lg border border-[var(--brand-border)] bg-[var(--surface-soft)] px-1 text-[var(--foreground)] transition-colors hover:border-[#8bd19f]/60 hover:bg-[#213b31] disabled:cursor-default disabled:opacity-70"
              title="Rakip kodları"
            >
              <span className="truncate text-[8px] uppercase tracking-[0.02em]">Rakip</span>
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--brand-primary)] px-1 text-[9px] text-[var(--primary-foreground)]">
                {competitorCodes.length}
              </span>
            </button>
            <button
              type="button"
              onClick={() => product.oem && onShowOemCode({ sku: product.sku, name: product.name, oem: product.oem })}
              disabled={!product.oem}
              className="flex h-7 min-w-0 items-center justify-between gap-1 rounded-lg border border-[var(--brand-border)] bg-[var(--surface-soft)] px-1 text-[var(--foreground)] transition-colors hover:border-[#8bd19f]/60 hover:bg-[#213b31] disabled:cursor-default disabled:opacity-70"
              title="OEM kodları"
            >
              <span className="truncate text-[8px] uppercase tracking-[0.02em]">OEM</span>
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--brand-primary)] px-1 text-[9px] text-[var(--primary-foreground)]">
                {product.oem ? 1 : 0}
              </span>
            </button>
            <button
              type="button"
              onClick={() => vehicleFitments.length > 0 && onShowVehicleFitments({ sku: product.sku, name: product.name, fitments: vehicleFitments })}
              disabled={vehicleFitments.length === 0}
              className="flex h-7 min-w-0 items-center justify-between gap-1 rounded-lg border border-[var(--brand-border)] bg-[var(--surface-soft)] px-1 text-[var(--foreground)] transition-colors hover:border-[#8bd19f]/60 hover:bg-[#213b31] disabled:cursor-default disabled:opacity-70"
              title="Araç uyumluluğu"
            >
              <span className="truncate text-[8px] uppercase tracking-[0.02em]">
                Araç
              </span>
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--brand-primary)] px-1 text-[9px] text-[var(--primary-foreground)]">
                {vehicleFitments.length}
              </span>
            </button>
            <button
              type="button"
              onClick={() => previousPurchase && onShowPreviousPurchase({ sku: product.sku, name: product.name, previousPurchase })}
              disabled={!previousPurchase}
              className={cn(
                "relative flex h-7 min-w-0 items-center justify-between gap-1 rounded-lg border border-[var(--brand-border)] bg-[var(--surface-soft)] px-1 text-[var(--foreground)] transition-colors hover:border-[#8bd19f]/60 hover:bg-[#213b31] disabled:cursor-default disabled:opacity-70",
                previousPurchase && "border-emerald-300/60 bg-emerald-300/10 shadow-[0_0_18px_-8px_rgba(52,211,153,0.95)]"
              )}
              title="Önceki alım"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "absolute right-1 top-1 h-1.5 w-1.5 rounded-full border border-white/15",
                  previousPurchase
                    ? "bg-emerald-300 shadow-[0_0_10px_3px_rgba(52,211,153,0.58)]"
                    : "bg-slate-600"
                )}
              />
              <span className="truncate text-[8px] uppercase tracking-[0.02em]">Önceki</span>
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--brand-primary)] px-1 text-[9px] text-[var(--primary-foreground)]">
                {previousPurchase ? 1 : 0}
              </span>
            </button>
          </div>
        </div>

        <div role="cell" className="admin-product-actions sticky right-0 z-20 flex min-w-0 items-center justify-center border-l border-[var(--brand-border)] bg-[var(--surface)] px-1 py-1 shadow-[-14px_0_22px_-22px_rgba(0,0,0,0.95)] group-hover:bg-[#1d3024]">
          <Button
            type="button"
            size="icon"
            onClick={() => onOpenCartModal(product, qty)}
	            disabled={!canAdd}
            className="cart-primary-button relative mx-auto h-10 w-10 rounded-lg border border-red-200/45 bg-gradient-to-b from-[#ff4a43] via-[#d71920] to-[#8d070d] text-white shadow-[0_3px_0_#8a070d,0_12px_22px_-18px_rgba(255,35,35,0.9),inset_0_1px_0_rgba(255,255,255,0.48)] transition-transform hover:-translate-y-0.5 hover:from-[#ff625b] hover:via-[#e51f26] hover:to-[#9b080e] active:translate-y-0.5 active:shadow-[0_1px_0_#8a070d,0_8px_18px_-18px_rgba(255,35,35,0.82),inset_0_1px_0_rgba(255,255,255,0.34)] disabled:!translate-y-0 disabled:!border-slate-500/40 disabled:!bg-[#617488] disabled:!bg-none disabled:!text-[#07120d] disabled:!shadow-none"
            aria-label={`${product.sku} sepete ekle`}
            title="Sepete ekle"
          >
            {mutating ? <Loader2 className="h-5 w-5 animate-spin" strokeWidth={3} /> : <ShoppingCart className="h-6 w-6 drop-shadow-[0_2px_1px_rgba(0,0,0,0.42)]" strokeWidth={3.2} />}
            {qty > 0 ? (
              <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full border border-white/50 bg-[#faee56] px-1 text-[10px] font-black text-[#193126] shadow-[0_4px_10px_-4px_rgba(250,238,86,0.92)]">
                {qty}
              </span>
            ) : null}
            {cartDistinctLineCount > 0 ? (
              <span className="absolute -left-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full border border-cyan-100/80 bg-cyan-300 px-1 text-[10px] font-black text-[#0b2631] shadow-[0_4px_10px_-4px_rgba(103,232,249,0.88)]">
                {cartDistinctLineCount}
              </span>
            ) : null}
          </Button>
        </div>
      </div>
    </div>
  );
});

export function ProductsPage({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamsKey = searchParams.toString();
  const [resetFiltersAfterReload, setResetFiltersAfterReload] = useState(() =>
    shouldResetFiltersAfterReload(new URLSearchParams(searchParamsKey)),
  );

  const querySeed = useMemo(() => {
    const params = new URLSearchParams(searchParamsKey);

    return {
      q: resetFiltersAfterReload ? "" : params.get("q") ?? "",
      showAllProducts: resetFiltersAfterReload ? false : params.get("all") === "1",
      sort: resetFiltersAfterReload ? "recommended" : parseSort(params.get("sort")),
      brandId: resetFiltersAfterReload ? null : parseOptionalNumber(params.get("brand_id")),
      metaFilters: resetFiltersAfterReload ? { kod2: "", kod3: "" } : parseMetaFilters(params),
    };
  }, [resetFiltersAfterReload, searchParamsKey]);
  const previousQuerySearchRef = useRef(querySeed.q);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const cartQuantityInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!resetFiltersAfterReload) {
      return;
    }

    const params = new URLSearchParams(searchParamsKey);
    const hasFilterParams = PRODUCT_RESET_QUERY_KEYS.some((key) => params.has(key));
    if (!hasFilterParams) {
      const resetTimer = window.setTimeout(() => setResetFiltersAfterReload(false), 0);

      return () => window.clearTimeout(resetTimer);
    }
  }, [resetFiltersAfterReload, searchParamsKey]);

  const { selectedCustomer, user } = useAuth();
  const { cartData, upsertQuantity, mutating } = useCart();
  const roleSlugs = useMemo(() => user?.roles.map((role) => role.slug) ?? [], [user?.roles]);
  const isPointPanel = useMemo(() => roleSlugs.includes("point"), [roleSlugs]);
  const isCustomerUser = useMemo(() => roleSlugs.includes("customer"), [roleSlugs]);
  const featurePermissionSet = useMemo(() => new Set(user?.feature_permissions ?? []), [user?.feature_permissions]);
  const canViewSearchPrices = !isCustomerUser || featurePermissionSet.has("search.prices");
  const canViewSearchStock = !isCustomerUser || featurePermissionSet.has("search.stock");
  const canUseSearchCart = !isCustomerUser || featurePermissionSet.has("search.add_to_cart");
  const visibleStockColumns = useMemo(
    () => visibleBranchStockColumns(featurePermissionSet, roleSlugs, user?.username),
    [featurePermissionSet, roleSlugs, user?.username]
  );
  const tableGridStyle = useMemo(
    () => productTableGridStyle(visibleStockColumns.length),
    [visibleStockColumns.length]
  );

  const [search, setSearch] = useState(querySeed.q);
  const [submittedSearch, setSubmittedSearch] = useState(querySeed.q);
  const [showAllProducts, setShowAllProducts] = useState(querySeed.showAllProducts);
  const [sort, setSort] = useState<ProductSort>(querySeed.sort);
  const [brandId, setBrandId] = useState<number | null>(querySeed.brandId);
  const [metaFilters, setMetaFilters] = useState<ProductMetaFilters>(querySeed.metaFilters);
  const [imagePreview, setImagePreview] = useState<ProductImagePreview | null>(null);
  const [competitorCodesPreview, setCompetitorCodesPreview] = useState<ProductCompetitorCodesPreview | null>(null);
  const [oemCodePreview, setOemCodePreview] = useState<ProductOemCodePreview | null>(null);
  const [vehicleFitmentsPreview, setVehicleFitmentsPreview] = useState<ProductVehicleFitmentsPreview | null>(null);
  const [previousPurchasePreview, setPreviousPurchasePreview] = useState<ProductPreviousPurchasePreview | null>(null);
  const [cartModalProduct, setCartModalProduct] = useState<ProductSearchItem | null>(null);
  const [cartModalQuantity, setCartModalQuantity] = useState<number | string>(1);
  const [cartModalCampaignKey, setCartModalCampaignKey] = useState<string | null>(null);
  const [cartCalculatorOpen, setCartCalculatorOpen] = useState(false);
  const [cartPricesIncludeVat, setCartPricesIncludeVat] = useState(false);
  const [calculatorDisplay, setCalculatorDisplay] = useState("0");
  const [calculatorStored, setCalculatorStored] = useState<number | null>(null);
  const [calculatorOperator, setCalculatorOperator] = useState<CalculatorOperator | null>(null);
  const [calculatorShouldReplace, setCalculatorShouldReplace] = useState(false);
  const [shouldLoadFilterOptions, setShouldLoadFilterOptions] = useState(() =>
    Boolean(querySeed.brandId || querySeed.metaFilters.kod2 || querySeed.metaFilters.kod3)
  );
  const competitorCodeRows = useMemo(
    () => normalizeCompetitorCodeRows(competitorCodesPreview?.codes ?? []),
    [competitorCodesPreview],
  );

  useEffect(() => {
    if (compact || !selectedCustomer?.id) {
      return;
    }

    const focusTimer = window.setTimeout(() => {
      searchInputRef.current?.focus({ preventScroll: true });
      searchInputRef.current?.select();
    }, 80);

    return () => window.clearTimeout(focusTimer);
  }, [compact, selectedCustomer?.id]);

  useEffect(() => {
    if (!cartModalProduct) {
      return;
    }

    const focusTimer = window.setTimeout(() => {
      cartQuantityInputRef.current?.focus();
      cartQuantityInputRef.current?.select();
    }, 60);

    return () => window.clearTimeout(focusTimer);
  }, [cartModalProduct]);

  const filterOptionsQuery = useQuery({
    queryKey: ["product-filter-options", "search"],
    queryFn: () => getProductFilterOptions({ scope: "search" }),
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: 2,
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    enabled: shouldLoadFilterOptions,
  });

  useEffect(() => {
    const nextSearch = search.trim();
    const nextSubmittedSearch = nextSearch.length >= MIN_SEARCH_LENGTH ? nextSearch : "";
    const timer = window.setTimeout(() => {
      setSubmittedSearch((currentSearch) => {
        if (currentSearch === nextSubmittedSearch) {
          return currentSearch;
        }

        return nextSubmittedSearch;
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [search]);

  const submittedSearchValue = submittedSearch.trim();
  const normalizedSearch = submittedSearchValue.length >= MIN_SEARCH_LENGTH ? submittedSearchValue : "";
  const hasMetaFilters = Boolean(brandId) || Object.values(metaFilters).some(Boolean);
  const shouldFetchProducts = Boolean(normalizedSearch || hasMetaFilters || showAllProducts || sort !== "recommended");

  useEffect(() => {
    const previousQuerySearch = previousQuerySearchRef.current;
    previousQuerySearchRef.current = querySeed.q;

    const syncTimer = window.setTimeout(() => {
      if (resetFiltersAfterReload) {
        setSearch(querySeed.q);
        setSubmittedSearch(querySeed.q);
      } else {
        setSearch((currentSearch) => (currentSearch === previousQuerySearch ? querySeed.q : currentSearch));
        setSubmittedSearch((currentSearch) => (currentSearch === previousQuerySearch ? querySeed.q : currentSearch));
      }
      setShowAllProducts(querySeed.showAllProducts);
      setSort(querySeed.sort);
      setBrandId(querySeed.brandId);
      setMetaFilters(querySeed.metaFilters);
    }, 0);

    return () => window.clearTimeout(syncTimer);
  }, [querySeed, resetFiltersAfterReload]);

  useEffect(() => {
    const params = new URLSearchParams();

    if (showAllProducts) {
      params.set("all", "1");
    }
    if (normalizedSearch) {
      params.set("q", normalizedSearch);
    }
    if (sort !== "recommended") {
      params.set("sort", sort);
    }
    if (brandId) {
      params.set("brand_id", String(brandId));
    }
    if (metaFilters.kod2) {
      params.set("kod2", metaFilters.kod2);
    }
    if (metaFilters.kod3) {
      params.set("kod3", metaFilters.kod3);
    }
    const nextQuery = params.toString();
    const currentQuery = typeof window !== "undefined" ? window.location.search.slice(1) : "";
    if (nextQuery === currentQuery) {
      return;
    }

    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
  }, [brandId, metaFilters, normalizedSearch, pathname, resetFiltersAfterReload, router, showAllProducts, sort]);

  const productsQuery = useInfiniteQuery({
    queryKey: [
      "products",
      {
        q: normalizedSearch,
        showAllProducts,
        sort,
        brandId,
        metaFilters,
        shouldFetchProducts,
      },
    ],
    initialPageParam: { cursor: null, page: 1 } as ProductSearchPageParam,
    queryFn: ({ signal, pageParam }) =>
      searchProducts(
        {
          q: normalizedSearch || undefined,
          sort: sort === "recommended" ? undefined : sort,
          limit: PAGE_LIMIT,
          cursor: sort === "recommended" ? pageParam.cursor ?? undefined : undefined,
          page: sort === "recommended" ? undefined : pageParam.page,
          include_equivalents: showAllProducts,
          brand_id: brandId ?? undefined,
          kod2: metaFilters.kod2 || undefined,
          kod3: metaFilters.kod3 || undefined,
        },
        { signal },
      ),
    getNextPageParam: (lastPage, allPages): ProductSearchPageParam | undefined => {
      if (sort === "recommended") {
        return lastPage.next_cursor ? { cursor: lastPage.next_cursor, page: allPages.length + 1 } : undefined;
      }

      const currentPage = lastPage.current_page ?? allPages.length;
      if (typeof lastPage.total_pages === "number" && currentPage < lastPage.total_pages) {
        return { cursor: null, page: currentPage + 1 };
      }

      return lastPage.next_cursor ? { cursor: null, page: allPages.length + 1 } : undefined;
    },
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: 0,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    enabled: shouldFetchProducts,
    placeholderData: (previousData) => previousData,
  });

  const products = useMemo(() => {
    if (!shouldFetchProducts) {
      return [];
    }

    const seenProductIds = new Set<number>();
    const items = (productsQuery.data?.pages.flatMap((pageData) => pageData.data) ?? [])
      .map((product, index) => ({ product, index }))
      .filter(({ product }) => {
        if (seenProductIds.has(product.id)) {
          return false;
        }

        seenProductIds.add(product.id);
        return true;
      });
    const normalizedQuery = normalizeSearchValue(normalizedSearch);

    if (!normalizedQuery || sort !== "recommended") {
      return items.map((item) => item.product);
    }

    return items
      .sort((left, right) => {
        const leftPriority = getSearchPriority(left.product, normalizedQuery);
        const rightPriority = getSearchPriority(right.product, normalizedQuery);

        if (leftPriority !== rightPriority) {
          return leftPriority - rightPriority;
        }

        if (left.product.available_total !== right.product.available_total) {
          return right.product.available_total - left.product.available_total;
        }

        return left.index - right.index;
      })
      .map((item) => item.product);
  }, [normalizedSearch, productsQuery.data?.pages, shouldFetchProducts, sort]);

  const hasExactTotal = shouldFetchProducts && typeof productsQuery.data?.pages[0]?.total_count === "number";
  const totalProducts = productsQuery.data?.pages[0]?.total_count ?? products.length;
  const latestLogoSyncedAt = useMemo(() => {
    let latestTimestamp = 0;
    let latestValue: string | null = null;

    for (const product of products) {
      const value = product.logo_synced_at;
      if (!value) {
        continue;
      }

      const timestamp = new Date(value).getTime();
      if (!Number.isNaN(timestamp) && timestamp > latestTimestamp) {
        latestTimestamp = timestamp;
        latestValue = value;
      }
    }

    return latestValue;
  }, [products]);
  const productListScrollRef = useRef<HTMLDivElement | null>(null);
  const infiniteScrollMarkerRef = useRef<HTMLDivElement | null>(null);
  const nextProductsPageInFlightRef = useRef(false);

  useEffect(() => {
    if (!productsQuery.isFetchingNextPage) {
      nextProductsPageInFlightRef.current = false;
    }
  }, [productsQuery.isFetchingNextPage]);

  useEffect(() => {
    if (!shouldFetchProducts || !productsQuery.hasNextPage || productsQuery.isFetchingNextPage) {
      return;
    }

    const marker = infiniteScrollMarkerRef.current;
    if (!marker) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (
          entry?.isIntersecting &&
          productsQuery.hasNextPage &&
          !productsQuery.isFetchingNextPage &&
          !nextProductsPageInFlightRef.current
        ) {
          nextProductsPageInFlightRef.current = true;
          void productsQuery.fetchNextPage().finally(() => {
            nextProductsPageInFlightRef.current = false;
          });
        }
      },
      {
        root: productListScrollRef.current,
        rootMargin: "360px 0px",
        threshold: 0,
      },
    );

    observer.observe(marker);

    return () => observer.disconnect();
  }, [productsQuery, shouldFetchProducts]);

  const qtyByProductId = useMemo(() => {
    const map = new Map<number, number>();
    cartData?.items.forEach((item) => map.set(item.product_id, item.quantity));
    return map;
  }, [cartData?.items]);
  const cartDistinctLineCount = cartData?.items.length ?? 0;
  const cartModalCurrentQty = cartModalProduct ? (qtyByProductId.get(cartModalProduct.id) ?? 0) : 0;
  const cartModalHasPrice = Boolean(cartModalProduct?.list_price ?? cartModalProduct?.net_price);
  const cartModalHasStock = (cartModalProduct?.available_total ?? 0) > 0;
  const cartModalCanSubmit = Boolean(cartModalProduct && selectedCustomer && cartModalHasPrice && !mutating);
  const cartModalCampaigns = useMemo(
    () => cartModalProduct?.campaigns ?? [],
    [cartModalProduct?.campaigns]
  );
  const cartModalApplicableCampaign = useMemo(() => {
    const campaign = cartModalCampaigns.find((item) => item.key === cartModalCampaignKey);
    const quantity = Math.max(1, Number(cartModalQuantity) || 1);
    const tier = campaign?.tiers
      .filter((item) => item.min_quantity <= quantity)
      .sort((left, right) => right.min_quantity - left.min_quantity)[0];

    return campaign && tier ? { campaign, tier } : null;
  }, [cartModalCampaignKey, cartModalCampaigns, cartModalQuantity]);

  const resetCalculator = useCallback(() => {
    setCalculatorDisplay("0");
    setCalculatorStored(null);
    setCalculatorOperator(null);
    setCalculatorShouldReplace(false);
  }, []);

  const handleSetQuantity = useCallback(
    (productId: number, nextQty: number, campaignKey?: string | null) => {
      if (!selectedCustomer) {
        return;
      }

      void upsertQuantity(productId, Math.max(0, nextQty), campaignKey);
    },
    [selectedCustomer, upsertQuantity]
  );

  const handleOpenCartModal = useCallback((product: ProductSearchItem, currentQty: number) => {
    const currentItem = cartData?.items.find((item) => item.product_id === product.id);
    setCartModalProduct(product);
    setCartModalQuantity(currentQty || "");
    setCartModalCampaignKey(currentItem?.campaign_key ?? null);
    setCartCalculatorOpen(false);
    setCartPricesIncludeVat(false);
    resetCalculator();
  }, [cartData?.items, resetCalculator]);

  const handleCartModalQuantityChange = useCallback(
    (nextQty: number | string) => {
      if (nextQty === "") {
        setCartModalQuantity("");
        return;
      }
      const parsed = Number(nextQty);
      if (Number.isNaN(parsed)) return;
      setCartModalQuantity(Math.max(0, Math.floor(parsed)));
    },
    []
  );

  const handleConfirmCartQuantity = useCallback(() => {
    if (!cartModalProduct) {
      return;
    }
    if (!selectedCustomer || !cartModalHasPrice) {
      return;
    }

    handleSetQuantity(
      cartModalProduct.id,
      Math.max(0, Number(cartModalQuantity) || 0),
      cartModalCampaignKey
    );
    setCartModalProduct(null);
    setCartCalculatorOpen(false);
  }, [cartModalCampaignKey, cartModalHasPrice, cartModalProduct, cartModalQuantity, handleSetQuantity, selectedCustomer]);

  const handleCalculatorDigit = useCallback((digit: string) => {
    setCalculatorDisplay((current) => {
      if (calculatorShouldReplace) {
        setCalculatorShouldReplace(false);
        return digit === "." ? "0." : digit;
      }
      if (digit === "." && current.includes(".")) {
        return current;
      }
      if (current === "0" && digit !== ".") {
        return digit;
      }

      return `${current}${digit}`;
    });
  }, [calculatorShouldReplace]);

  const handleCalculatorManualInput = useCallback((value: string) => {
    const normalizedValue = normalizeCalculatorInput(value);

    setCalculatorDisplay(normalizedValue === "-" || normalizedValue === "" ? "0" : normalizedValue);
    setCalculatorShouldReplace(false);
  }, []);

  const handleCalculatorOperator = useCallback((operator: CalculatorOperator) => {
    const currentValue = Number(calculatorDisplay);
    if (!Number.isFinite(currentValue)) {
      return;
    }

    setCalculatorStored((storedValue) => {
      if (storedValue !== null && calculatorOperator) {
        const result = calculateValue(storedValue, calculatorOperator, currentValue);
        setCalculatorDisplay(formatCalculatorValue(result));
        return result;
      }

      return currentValue;
    });
    setCalculatorOperator(operator);
    setCalculatorShouldReplace(true);
  }, [calculatorDisplay, calculatorOperator]);

  const handleCalculatorEquals = useCallback(() => {
    if (calculatorStored === null || !calculatorOperator) {
      return;
    }

    const currentValue = Number(calculatorDisplay);
    if (!Number.isFinite(currentValue)) {
      return;
    }

    const result = calculateValue(calculatorStored, calculatorOperator, currentValue);
    setCalculatorDisplay(formatCalculatorValue(result));
    setCalculatorStored(null);
    setCalculatorOperator(null);
    setCalculatorShouldReplace(true);
  }, [calculatorDisplay, calculatorOperator, calculatorStored]);

  const handleCalculatorPercent = useCallback(() => {
    const currentValue = Number(calculatorDisplay);
    if (!Number.isFinite(currentValue)) {
      return;
    }

    const percentValue =
      calculatorStored !== null && (calculatorOperator === "+" || calculatorOperator === "-")
        ? (calculatorStored * currentValue) / 100
        : currentValue / 100;

    setCalculatorDisplay(formatCalculatorValue(percentValue));
    setCalculatorShouldReplace(true);
  }, [calculatorDisplay, calculatorOperator, calculatorStored]);

  const handleCalculatorPercentAdjust = useCallback((direction: 1 | -1) => {
    const currentValue = Number(calculatorDisplay);
    if (!Number.isFinite(currentValue)) {
      return;
    }

    const baseValue = calculatorStored ?? currentValue;
    const nextValue = baseValue + direction * ((baseValue * currentValue) / 100);

    setCalculatorDisplay(formatCalculatorValue(nextValue));
    setCalculatorStored(null);
    setCalculatorOperator(null);
    setCalculatorShouldReplace(true);
  }, [calculatorDisplay, calculatorStored]);

  const handleCalculatorBackspace = useCallback(() => {
    setCalculatorDisplay((current) => (current.length <= 1 || calculatorShouldReplace ? "0" : current.slice(0, -1)));
    setCalculatorShouldReplace(false);
  }, [calculatorShouldReplace]);

  const handleUseCalculatorQuantity = useCallback(() => {
    const nextQuantity = Math.floor(Number(calculatorDisplay));
    if (!Number.isFinite(nextQuantity) || nextQuantity <= 0) {
      return;
    }

    handleCartModalQuantityChange(nextQuantity);
    setCartCalculatorOpen(false);
  }, [calculatorDisplay, handleCartModalQuantityChange]);

  const handleResetFilters = useCallback(() => {
    setSearch("");
    setSubmittedSearch("");
    setShowAllProducts(false);
    setSort("recommended");
    setBrandId(null);
    setMetaFilters({ kod2: "", kod3: "" });
  }, []);

  const handleSubmitSearch = useCallback(() => {
    const nextSearch = search.trim();
    setSubmittedSearch(nextSearch.length >= MIN_SEARCH_LENGTH ? nextSearch : "");
  }, [search]);

  const handleFilterOptionsOpenChange = useCallback((open: boolean) => {
    if (open) {
      setShouldLoadFilterOptions(true);
    }
  }, []);

  const handleMetaFilterChange = useCallback((key: keyof ProductMetaFilters, value: string) => {
    setMetaFilters((current) => ({
      ...current,
      [key]: value === ALL_FILTER_VALUE ? "" : value,
    }));
  }, []);

  const handleBrandFilterChange = useCallback((value: string) => {
    const nextBrandId = value === ALL_FILTER_VALUE ? null : parseOptionalNumber(value);

    setBrandId(nextBrandId);
  }, []);

  return (
    <div className="admin-catalog-page space-y-4">
      <Card className="admin-catalog-list dashboard-panel-card min-h-[560px]">
        <CardHeader className="space-y-3 pb-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <p className="inline-flex items-center gap-1.5 text-base font-extrabold text-[var(--foreground)]">
              <PackageSearch className="h-4 w-4 text-[var(--brand-primary)]" />
              Ürün Listesi
            </p>
          </div>
          <div className="grid gap-3 lg:grid-cols-[minmax(300px,1fr)_150px_138px_190px]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-5 top-1/2 h-6 w-6 -translate-y-1/2 text-[var(--muted-foreground)]" />
              <Input
                ref={searchInputRef}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleSubmitSearch();
                  }
                }}
                placeholder="Stok kodu, OEM, marka veya ürün adı ara..."
                className="admin-dashboard-input h-14 rounded-xl pl-14 text-base font-semibold"
              />
            </div>

            <Button
              type="button"
              className="h-14 w-full rounded-xl border border-[#3f8f54] bg-[#2f7f56] px-5 text-base font-black text-white shadow-[0_16px_28px_-22px_rgba(47,127,86,0.9)] hover:bg-[#276d49] hover:text-white"
              onClick={handleSubmitSearch}
            >
              <Search className="h-5 w-5" />
              Ara
            </Button>

            <Button
              type="button"
              variant="outline"
              className="h-14 w-full rounded-xl border-[#ef4444] bg-[#dc2626] px-5 text-base font-black text-white shadow-[0_16px_30px_-20px_rgba(220,38,38,0.95)] hover:border-[#dc2626] hover:bg-[#b91c1c] hover:text-white disabled:border-[#dc2626] disabled:bg-[#b91c1c] disabled:text-white disabled:opacity-70"
              disabled={!search && !normalizedSearch && !hasMetaFilters && !showAllProducts && sort === "recommended"}
              onClick={handleResetFilters}
            >
              <X className="h-5 w-5" />
              Sil
            </Button>

            <Button
              variant={showAllProducts ? "default" : "outline"}
              onClick={() => {
                setShowAllProducts((current) => !current);
              }}
              className={cn(
                "h-14 w-full rounded-xl text-base font-extrabold",
                showAllProducts ? "admin-primary-action" : "admin-dashboard-ghost"
              )}
            >
              {showAllProducts ? "E + H Ürünler" : "Tüm Ürünler"}
            </Button>
          </div>

          <div className="grid gap-2 rounded-xl border border-[var(--brand-border)] bg-[color-mix(in_oklab,var(--surface)_72%,transparent)] p-2 lg:grid-cols-4">
            <div className="space-y-1">
              <span className="text-[11px] font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Sıralama</span>
              <Select
                value={sort}
                onValueChange={(value) => {
                  setSort(parseSort(value));
                }}
              >
                <SelectTrigger className={PRODUCT_FILTER_TRIGGER_CLASS}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={PRODUCT_FILTER_CONTENT_CLASS}>
                  {PRODUCT_SORT_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value} className={PRODUCT_FILTER_ITEM_CLASS}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <span className="text-[11px] font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Marka</span>
              <Select
                value={brandId ? String(brandId) : ALL_FILTER_VALUE}
                onValueChange={handleBrandFilterChange}
                onOpenChange={handleFilterOptionsOpenChange}
              >
                <SelectTrigger className={PRODUCT_FILTER_TRIGGER_CLASS}>
                  <SelectValue placeholder="Hepsi" />
                </SelectTrigger>
                <SelectContent className={PRODUCT_FILTER_CONTENT_CLASS}>
                  <SelectItem value={ALL_FILTER_VALUE} className={PRODUCT_FILTER_ITEM_CLASS}>Hepsi</SelectItem>
                  {filterOptionsQuery.isLoading && !filterOptionsQuery.data ? (
                    <SelectItem value="__loading_brands" className={PRODUCT_FILTER_ITEM_CLASS} disabled>
                      Yükleniyor...
                    </SelectItem>
                  ) : null}
                  {(filterOptionsQuery.data?.brands ?? []).map((brand) => (
                    <SelectItem key={`brand-${brand.id}`} value={String(brand.id)} className={PRODUCT_FILTER_ITEM_CLASS}>
                      {brand.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {[
              { key: "kod2" as const, label: "Ürün Detayı 1", options: filterOptionsQuery.data?.meta.kod2 ?? [] },
              { key: "kod3" as const, label: "Ürün Detayı 2", options: filterOptionsQuery.data?.meta.kod3 ?? [] },
            ].map((filter) => (
              <div key={filter.key} className="space-y-1">
                <span className="text-[11px] font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">{filter.label}</span>
                <Select
                  value={metaFilters[filter.key] || ALL_FILTER_VALUE}
                  onValueChange={(value) => handleMetaFilterChange(filter.key, value)}
                  onOpenChange={handleFilterOptionsOpenChange}
                >
                  <SelectTrigger className={PRODUCT_FILTER_TRIGGER_CLASS}>
                    <SelectValue placeholder="Hepsi" />
                  </SelectTrigger>
                  <SelectContent className={PRODUCT_FILTER_CONTENT_CLASS}>
                    <SelectItem value={ALL_FILTER_VALUE} className={PRODUCT_FILTER_ITEM_CLASS}>Hepsi</SelectItem>
                    {filterOptionsQuery.isLoading && !filterOptionsQuery.data ? (
                      <SelectItem value={`__loading_${filter.key}`} className={PRODUCT_FILTER_ITEM_CLASS} disabled>
                        Yükleniyor...
                      </SelectItem>
                    ) : null}
                    {filter.options.map((option) => (
                      <SelectItem key={`${filter.key}-${option}`} value={option} className={PRODUCT_FILTER_ITEM_CLASS}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </CardHeader>

        <CardContent>
          {!selectedCustomer ? (
            <p className="mb-3 rounded-xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm font-bold text-amber-100">
              Sepete ürün eklemek için önce müşteri seçin.
            </p>
          ) : null}

          {shouldFetchProducts && productsQuery.isLoading ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-xl border border-[var(--brand-border)] bg-[var(--surface-soft)] px-4 py-3 text-sm font-black text-[var(--foreground)]">
                <Loader2 className="h-4 w-4 animate-spin text-[var(--brand-primary)]" />
                Ürünler aranıyor...
              </div>
              {Array.from({ length: 8 }).map((_, index) => (
                <div
                  key={`product-skeleton-${index}`}
                  className={cn(PRODUCT_TABLE_GRID, "rounded-md bg-[var(--surface)] px-3 py-3")}
                  style={tableGridStyle}
                >
                  <Skeleton className="h-16 w-16 rounded-lg" />
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-14 w-full" />
                  <Skeleton className="h-14 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ))}
            </div>
          ) : shouldFetchProducts && productsQuery.isError ? (
            <div className="flex h-[420px] items-center justify-center text-red-600">
              {(productsQuery.error as Error).message}
            </div>
          ) : !shouldFetchProducts ? (
            <div className="flex h-[420px] flex-col items-center justify-center gap-3 rounded-xl bg-[var(--surface-soft)] p-6 text-center">
              <PackageSearch className="h-9 w-9 text-[var(--muted-foreground)]" />
              <div className="space-y-1">
                <p className="text-sm font-semibold text-[var(--foreground)]">Ürün aramak için yazmaya başlayın</p>
                <p className="text-xs text-[var(--muted-foreground)]">
                  Stok kodu, OEM, marka veya ürün adından en az 2 karakter yazınca sonuçlar otomatik gelir.
                </p>
              </div>
            </div>
          ) : products.length === 0 ? (
            <div className="flex h-[420px] flex-col items-center justify-center gap-3 rounded-xl bg-[var(--surface-soft)] p-6 text-center">
              <PackageSearch className="h-9 w-9 text-[var(--muted-foreground)]" />
              <div className="space-y-1">
                <p className="text-sm font-semibold text-[var(--foreground)]">Sonuç bulunamadı</p>
                <p className="text-xs text-[var(--muted-foreground)]">
                  Ürün adı veya ürün kodunu kontrol edip tekrar aramayı deneyin.
                </p>
              </div>
              <Button variant="outline" onClick={handleResetFilters}>
                Aramayı Temizle
              </Button>
            </div>
          ) : (
            <>
              <div
                ref={productListScrollRef}
                role="table"
                aria-label="Ürün listesi"
                className="max-h-[calc(100dvh-260px)] min-h-[340px] overflow-auto rounded-[22px] bg-[var(--surface)] px-2 pb-3 pt-3 shadow-[0_24px_42px_-36px_rgba(0,0,0,0.7)] overscroll-contain [scrollbar-color:#8aa0b0_#122022] [scrollbar-width:thin] md:max-h-[calc(100dvh-300px)]"
              >
                <div className="rounded-xl border border-[var(--brand-border)] bg-[var(--surface-soft)]">
                  <div
                    role="row"
                    className={cn(
                      PRODUCT_TABLE_GRID,
                      "sticky top-0 z-30 border border-emerald-300/35 bg-[radial-gradient(circle_at_8%_16%,rgba(34,197,94,0.42)_0%,transparent_34%),linear-gradient(135deg,rgba(15,118,54,0.96)_0%,rgba(3,48,31,0.98)_100%)] text-[11px] font-black uppercase tracking-[0.1em] text-emerald-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),inset_0_-1px_0_rgba(34,197,94,0.12),0_16px_34px_-30px_rgba(34,197,94,0.84)]"
                    )}
                    style={tableGridStyle}
                  >
                    <span role="columnheader" className="flex items-center justify-center px-2 py-3 text-center drop-shadow-[0_1px_1px_rgba(0,0,0,0.44)]">Resim</span>
                    <span role="columnheader" className="flex items-center border-l border-white/10 px-2 py-3 drop-shadow-[0_1px_1px_rgba(0,0,0,0.44)]">Stok Kodu</span>
                    <span role="columnheader" className="flex items-center border-l border-white/10 px-2 py-3 drop-shadow-[0_1px_1px_rgba(0,0,0,0.44)]">Marka</span>
                    <span role="columnheader" className="flex items-center border-l border-white/10 px-2 py-3 drop-shadow-[0_1px_1px_rgba(0,0,0,0.44)]">Ürün Adı</span>
                    <span role="columnheader" className="flex items-center border-l border-white/10 px-2 py-3 drop-shadow-[0_1px_1px_rgba(0,0,0,0.44)]">Ürün Tipi</span>
                    <span role="columnheader" className="flex items-center justify-center border-l border-white/10 px-2 py-3 text-center drop-shadow-[0_1px_1px_rgba(0,0,0,0.44)]">Koli Adeti</span>
                    <span role="columnheader" className="flex items-center justify-end border-l border-white/10 px-2 py-3 text-right drop-shadow-[0_1px_1px_rgba(0,0,0,0.44)]">Liste Fiyatı</span>
                    <span
                      role="columnheader"
                      className="grid items-stretch border-l border-white/10 drop-shadow-[0_1px_1px_rgba(0,0,0,0.44)]"
                      style={{ gridTemplateColumns: `repeat(${Math.max(visibleStockColumns.length, 1)}, minmax(0, 1fr))` }}
                    >
                      {visibleStockColumns.length > 0 ? visibleStockColumns.map((branch) => (
                        <span
                          key={`stock-head-${branch.key}`}
                          className="flex min-w-0 items-center justify-center whitespace-nowrap border-l border-white/10 px-1 py-3 text-center text-[8px] tracking-[0.02em] first:border-l-0"
                        >
                          {branch.label}
                        </span>
                      )) : (
                        <span className="flex min-w-0 items-center justify-center whitespace-nowrap px-1 py-3 text-center text-[8px] tracking-[0.02em]">
                          Stok
                        </span>
                      )}
                    </span>
	                    <span role="columnheader" className="flex items-center justify-center border-l border-white/10 px-2 py-3 text-center drop-shadow-[0_1px_1px_rgba(0,0,0,0.44)]">Ürün Detayı</span>
		                    <span role="columnheader" className="sticky right-0 z-30 flex items-center justify-center border-l border-white/10 bg-[linear-gradient(135deg,rgba(10,96,54,0.98)_0%,rgba(3,48,31,1)_100%)] px-2 py-3 text-center drop-shadow-[0_1px_1px_rgba(0,0,0,0.44)] shadow-[-14px_0_22px_-22px_rgba(0,0,0,0.95)]">Sepet</span>
                  </div>
                </div>
                <div className={cn("rounded-xl border border-t-0 border-[var(--brand-border)]", compact ? "min-h-[360px]" : "min-h-[520px]")}>
                  {products.map((product) => {
                    const qty = qtyByProductId.get(product.id) ?? 0;

                    return (
                      <ProductRow
                        key={product.id}
                        product={product}
                        qty={qty}
                        cartDistinctLineCount={cartDistinctLineCount}
                        mutating={mutating}
                        canAdd={Boolean(selectedCustomer) && canUseSearchCart}
                        canViewPrices={canViewSearchPrices}
                        canViewStock={canViewSearchStock}
                        visibleStockColumns={visibleStockColumns}
                        showRetailPriceHint={isPointPanel}
                        tableGridStyle={tableGridStyle}
                        onOpenCartModal={handleOpenCartModal}
	                        onPreviewImage={setImagePreview}
	                        onShowCompetitorCodes={setCompetitorCodesPreview}
	                        onShowOemCode={setOemCodePreview}
	                        onShowVehicleFitments={setVehicleFitmentsPreview}
	                        onShowPreviousPurchase={setPreviousPurchasePreview}
                      />
                    );
                  })}
                  <div
                    ref={infiniteScrollMarkerRef}
                    className={cn(
                      PRODUCT_TABLE_GRID,
                      "min-h-16 border-b border-l-4 border-[var(--brand-border)] border-l-transparent bg-[var(--surface)]"
                    )}
                    style={tableGridStyle}
                  >
                    <div className="col-span-10 flex items-center justify-center px-4 py-4 text-sm font-extrabold text-[var(--muted-foreground)]">
                      {productsQuery.isFetchingNextPage ? (
                        <span className="inline-flex items-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Ürünler yükleniyor
                        </span>
                      ) : productsQuery.hasNextPage ? (
                        "Aşağı indikçe yeni ürünler yüklenecek"
                      ) : (
                        "Tüm ürünler gösterildi"
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between rounded-xl border border-[var(--brand-border)] bg-[var(--surface)] px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[var(--foreground)]">
                    {hasExactTotal ? `${totalProducts.toLocaleString("tr-TR")} ürün içinde ` : ""}
                    {products.length.toLocaleString("tr-TR")} ürün gösteriliyor
                  </p>
                  <p className="mt-1 text-xs font-bold text-[var(--muted-foreground)]">
                    Logo: {latestLogoSyncedAt ? formatProductDateTime(latestLogoSyncedAt) : "ürün sync bekleniyor"}
                    {productsQuery.data?.pages[0]?.search_backend ? ` · ${productsQuery.data.pages[0].search_backend}` : ""}
                  </p>
                </div>
                {productsQuery.isFetching && !productsQuery.isFetchingNextPage ? (
                  <span className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Güncelleniyor
                  </span>
                ) : null}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={Boolean(cartModalProduct)}
        onOpenChange={(open) => {
          if (!open) {
            setCartModalProduct(null);
            setCartCalculatorOpen(false);
          }
        }}
      >
        <DialogContent className="z-[60] max-h-[calc(100vh-32px)] max-w-[820px] overflow-hidden rounded-[30px] border border-emerald-300/20 bg-[radial-gradient(circle_at_50%_0%,rgba(213,205,42,0.1)_0%,transparent_34%),linear-gradient(145deg,rgba(12,24,32,0.98)_0%,rgba(7,15,23,0.98)_55%,rgba(10,30,23,0.98)_100%)] p-0 text-slate-100 shadow-[0_34px_90px_-46px_rgba(0,0,0,0.9)]">
	          <DialogHeader className="mb-0 border-b border-white/10 px-6 py-5">
	            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_190px] md:items-start">
	              <div className="min-w-0">
	                <DialogTitle className="flex items-center gap-3 text-3xl font-black text-white">
	                  <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-emerald-300/25 bg-emerald-300/10 text-emerald-300">
	                    <ShoppingCart className="h-6 w-6" strokeWidth={3} />
	                  </span>
	                  Sepete Ekle
	                </DialogTitle>
	                <DialogDescription className="sr-only">
	                  Ürün miktarını seçin
	                </DialogDescription>
	                {cartModalProduct ? (
	                  <div className="mt-4 flex min-w-0 flex-wrap items-center gap-3 rounded-[22px] border border-white/10 bg-white/[0.035] px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
	                    <p className="shrink-0 text-3xl font-black leading-none tracking-[0.02em] text-[#f8f3a1] drop-shadow-[0_6px_14px_rgba(0,0,0,0.42)]">
	                      {cartModalProduct.sku}
	                    </p>
	                    <span className="shrink-0 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1 text-xs font-black uppercase tracking-[0.08em] text-emerald-100">
	                      {cartModalProduct.brand.name ?? "Marka Yok"}
	                    </span>
	                    <span className="line-clamp-1 min-w-[180px] flex-1 text-base font-extrabold text-slate-300">
	                      {cartModalProduct.name}
	                    </span>
	                  </div>
	                ) : null}
	              </div>
	              <div className="grid gap-3 md:justify-items-stretch">
	                <Button
	                  type="button"
	                  variant="outline"
	                  className="h-11 rounded-xl border-[#d8cf42]/25 bg-[#d8cf42]/10 px-3 text-xs font-black uppercase tracking-[0.08em] text-[#f8f3a1] hover:bg-[#d8cf42]/16 hover:text-white"
	                  onClick={() => setCartCalculatorOpen((open) => !open)}
	                >
	                  <Calculator className="h-4 w-4" />
	                  Hesap Makinesi
	                </Button>
	                <Button
	                  type="button"
	                  variant="outline"
	                  className={cn(
	                    "h-10 rounded-xl px-3 text-xs font-black uppercase tracking-[0.08em]",
	                    cartPricesIncludeVat
	                      ? "border-red-200/35 bg-red-500/16 text-red-100 hover:bg-red-500/22 hover:text-white"
	                      : "border-white/12 bg-white/[0.045] text-slate-200 hover:bg-white/[0.08] hover:text-white"
	                  )}
	                  onClick={() => setCartPricesIncludeVat((includeVat) => !includeVat)}
	                >
		                  {cartPricesIncludeVat ? "Kdv Hariç Göster" : "Kdv Dahil Göster"}
	                </Button>
	              </div>
	            </div>
	          </DialogHeader>

          {cartModalProduct ? (
            <div className="px-6 py-5">
              <div className={cn("grid gap-3 sm:grid-cols-2", cartModalProduct.special_discounted_price ? "xl:grid-cols-4" : "xl:grid-cols-3")}>
                <div className="rounded-2xl border border-[#d8cf42]/20 bg-[#d8cf42]/[0.08] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
	                  <span className="block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
	                    Liste Fiyatı
	                  </span>
	                  <strong className="mt-2 block text-2xl font-black text-[#f8f3a1]">
	                    {formatProductModalPrice(cartModalProduct, cartModalProduct.list_price ?? cartModalProduct.net_price, cartPricesIncludeVat)}
	                  </strong>
	                  <span className="mt-1 block text-[11px] font-black uppercase tracking-[0.08em] text-slate-500">
	                    {cartPricesIncludeVat ? "KDV Dahil" : "KDV Hariç"}
	                  </span>
	                </div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.06] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
	                  <span className="block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
	                    Kampanyasız Fiyat
	                  </span>
	                  <strong className="mt-2 block text-2xl font-black text-white">
	                    {formatProductModalPrice(cartModalProduct, cartModalProduct.net_price ?? cartModalProduct.list_price, cartPricesIncludeVat)}
	                  </strong>
	                  <span className="mt-1 block text-[11px] font-black uppercase tracking-[0.08em] text-slate-500">
	                    {cartPricesIncludeVat ? "KDV Dahil" : "KDV Hariç"}
	                  </span>
	                </div>
                {cartModalProduct.special_discounted_price ? (
                  <div className="rounded-2xl border border-emerald-300/25 bg-emerald-400/[0.10] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                    <span className="block text-[11px] font-black uppercase tracking-[0.14em] text-emerald-100/70">
                      İskontolu Fiyat
                    </span>
                    <strong className="mt-2 block text-2xl font-black text-emerald-100">
                      {formatProductModalPrice(cartModalProduct, cartModalProduct.special_discounted_price, cartPricesIncludeVat)}
                    </strong>
                    <span className="mt-1 block text-[11px] font-black uppercase tracking-[0.08em] text-emerald-100/65">
                      {formatPercentValue(cartModalProduct.special_discount_rate)} özel iskonto
                    </span>
                  </div>
                ) : null}
	                <div className="rounded-2xl border border-white/10 bg-white/[0.06] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
	                  <span className="block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
	                    Sepette
                  </span>
                  <strong className="mt-2 block text-3xl font-black text-cyan-200">
                    {cartModalCurrentQty.toLocaleString("tr-TR")}
	                  </strong>
	                </div>
	              </div>
	              {!cartModalHasPrice ? (
	                <p className="mt-3 rounded-2xl border border-red-300/20 bg-red-500/10 px-4 py-3 text-sm font-black text-red-100">
	                  Bu ürün için fiyat bulunamadı.
	                </p>
	              ) : !cartModalHasStock ? (
	                <p className="mt-3 rounded-2xl border border-amber-200/20 bg-amber-300/10 px-4 py-3 text-sm font-black text-amber-100">
	                  Bu ürün için stok bulunamadı, yine de sepete eklenebilir.
	                </p>
	              ) : null}

                {cartModalCampaigns.length > 0 ? (
                  <div className="mt-5 rounded-[24px] border border-amber-300/20 bg-amber-300/[0.07] p-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-[12px] font-black uppercase tracking-[0.16em] text-amber-200">
                          Logo Kampanyaları
                        </p>
                        <p className="mt-1 text-xs font-semibold text-slate-400">
                          Miktara uygun kademe otomatik seçilir; kampanya siz etkinleştirince uygulanır.
                        </p>
                      </div>
                      {cartModalApplicableCampaign ? (
                        <span className="rounded-full border border-emerald-300/25 bg-emerald-300/12 px-3 py-1 text-xs font-black text-emerald-100">
                          Aktif: {formatPriceValue(cartModalApplicableCampaign.tier.unit_price, cartModalApplicableCampaign.tier.currency)}
                        </span>
                      ) : null}
                    </div>
                    <div className="grid gap-3 lg:grid-cols-2">
                      {cartModalCampaigns.map((campaign) => {
                        const quantity = Math.max(1, Number(cartModalQuantity) || 1);
                        const applicableTier = [...campaign.tiers]
                          .filter((tier) => tier.min_quantity <= quantity)
                          .sort((left, right) => right.min_quantity - left.min_quantity)[0] ?? null;
                        const active = cartModalCampaignKey === campaign.key;

                        return (
                          <div
                            key={campaign.key}
                            className={cn(
                              "rounded-2xl border p-4 transition-colors",
                              active
                                ? "border-emerald-300/40 bg-emerald-300/12"
                                : "border-white/10 bg-slate-950/35"
                            )}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="font-black text-white">{campaign.name}</p>
                                <div className="mt-2 flex flex-wrap gap-2">
                                  {campaign.tiers.map((tier) => (
                                    <span
                                      key={`${campaign.key}-${tier.min_quantity}-${tier.unit_price}`}
                                      className={cn(
                                        "rounded-full border px-2.5 py-1 text-[11px] font-black",
                                        applicableTier === tier
                                          ? "border-amber-200/35 bg-amber-200/15 text-amber-100"
                                          : "border-white/10 bg-white/[0.04] text-slate-400"
                                      )}
                                    >
                                      {tier.min_quantity > 1 ? `${tier.min_quantity}+ adet` : "Tekli"} ·{" "}
                                      {formatPriceValue(tier.unit_price, tier.currency)}
                                    </span>
                                  ))}
                                </div>
                              </div>
                              <Button
                                type="button"
                                variant="outline"
                                className={cn(
                                  "shrink-0 rounded-xl px-3 text-xs font-black",
                                  active
                                    ? "border-red-300/25 bg-red-400/10 text-red-100 hover:bg-red-400/18"
                                    : "border-emerald-300/25 bg-emerald-300/10 text-emerald-100 hover:bg-emerald-300/18"
                                )}
                                disabled={!applicableTier || mutating}
                                onClick={() => setCartModalCampaignKey(active ? null : campaign.key)}
                              >
                                {active ? "Kampanyayı Kapat" : "Kampanyayı Aktif Et"}
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}

	              <div className="mt-5 rounded-[24px] border border-emerald-300/15 bg-emerald-300/[0.055] p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <label className="block text-[12px] font-black uppercase tracking-[0.16em] text-slate-400">
                    Miktar
                  </label>
                </div>
                <div className="grid grid-cols-[64px_minmax(0,1fr)_64px] gap-3">
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-16 w-16 rounded-2xl border-white/10 bg-slate-950/45 text-xl text-slate-200 hover:bg-slate-800 hover:text-white"
                    disabled={Number(cartModalQuantity) <= 1 || mutating}
                    onClick={() => handleCartModalQuantityChange(Number(cartModalQuantity) - 1)}
                  >
                    <Minus className="h-6 w-6" />
                  </Button>
	                  <Input
                    ref={cartQuantityInputRef}
                    type="text"
                    inputMode="numeric"
                    value={cartModalQuantity}
                    onChange={(event) => handleCartModalQuantityChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        handleConfirmCartQuantity();
                      }
                    }}
                    className="h-16 rounded-2xl border-emerald-300/25 bg-slate-950/55 text-center text-4xl font-black text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)] [appearance:textfield] focus-visible:ring-2 focus-visible:ring-emerald-300/55 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-16 w-16 rounded-2xl border-emerald-300/20 bg-emerald-300/10 text-xl text-emerald-200 hover:bg-emerald-300/18 hover:text-emerald-100"
                    disabled={mutating}
                    onClick={() => handleCartModalQuantityChange(Number(cartModalQuantity) + 1)}
                  >
                    <Plus className="h-6 w-6" />
                  </Button>
                </div>
                {cartCalculatorOpen ? (
                  <div className="mt-4 rounded-[20px] border border-[#d8cf42]/20 bg-slate-950/55 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                    <Input
                      aria-label="Hesap makinesi değeri"
                      inputMode="decimal"
                      className="mb-3 h-16 rounded-2xl border-white/10 bg-black/35 px-4 text-right text-3xl font-black text-white shadow-none focus-visible:ring-[#d8cf42]/45"
                      value={calculatorDisplay}
                      onChange={(event) => handleCalculatorManualInput(event.target.value)}
                      onFocus={(event) => event.currentTarget.select()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          handleCalculatorEquals();
                        }
                      }}
                    />
                    <div className="mb-2 grid grid-cols-3 gap-2">
                      <Button type="button" variant="outline" className="h-10 rounded-xl border-[#d8cf42]/20 bg-[#d8cf42]/10 text-xs font-black text-[#f8f3a1] hover:bg-[#d8cf42]/16 hover:text-white" onClick={handleCalculatorPercent}>
                        %
                      </Button>
                      <Button type="button" variant="outline" className="h-10 rounded-xl border-emerald-300/25 bg-emerald-300/12 text-xs font-black text-emerald-100 hover:bg-emerald-300/18 hover:text-white" onClick={() => handleCalculatorPercentAdjust(1)}>
                        % Ekle
                      </Button>
                      <Button type="button" variant="outline" className="h-10 rounded-xl border-red-300/25 bg-red-400/12 text-xs font-black text-red-100 hover:bg-red-400/18 hover:text-white" onClick={() => handleCalculatorPercentAdjust(-1)}>
                        % Düş
                      </Button>
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      {["7", "8", "9", "/","4", "5", "6", "*","1", "2", "3", "-","0", ".", "=", "+"].map((key) => (
                        <Button
                          key={`calculator-${key}`}
                          type="button"
                          variant="outline"
                          className={cn(
                            "h-11 rounded-xl border-white/10 bg-white/[0.045] text-base font-black text-slate-100 hover:bg-white/[0.09] hover:text-white",
                            ["+", "-", "*", "/"].includes(key) && "border-[#d8cf42]/20 bg-[#d8cf42]/10 text-[#f8f3a1]",
                            key === "=" && "border-emerald-300/25 bg-emerald-300/16 text-emerald-100"
                          )}
                          onClick={() => {
                            if (key === "=") {
                              handleCalculatorEquals();
                            } else if (["+", "-", "*", "/"].includes(key)) {
                              handleCalculatorOperator(key as CalculatorOperator);
                            } else {
                              handleCalculatorDigit(key);
                            }
                          }}
                        >
                          {key === "*" ? "×" : key === "/" ? "÷" : key}
                        </Button>
                      ))}
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2">
                      <Button type="button" variant="outline" className="h-10 rounded-xl border-white/10 bg-white/[0.04] text-xs font-black text-slate-300 hover:bg-white/[0.08] hover:text-white" onClick={resetCalculator}>
                        Temizle
                      </Button>
                      <Button type="button" variant="outline" className="h-10 rounded-xl border-white/10 bg-white/[0.04] text-xs font-black text-slate-300 hover:bg-white/[0.08] hover:text-white" onClick={handleCalculatorBackspace}>
                        Sil
                      </Button>
                      <Button type="button" className="h-10 rounded-xl bg-[#d8cf42] text-xs font-black text-[#172018] hover:bg-[#ece65a]" onClick={handleUseCalculatorQuantity}>
                        Miktara Aktar
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          <DialogFooter className="mt-0 flex-col gap-4 border-t border-white/10 bg-black/12 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex h-12 items-center gap-2 rounded-full border border-emerald-300/18 bg-emerald-300/10 px-4 text-sm font-black text-emerald-100">
                Stok <strong className="text-lg text-emerald-300">{cartModalProduct?.available_total.toLocaleString("tr-TR") ?? "-"}</strong>
              </span>
              <span className="inline-flex h-12 items-center gap-2 rounded-full border border-sky-200/18 bg-sky-200/10 px-4 text-sm font-black text-sky-100">
                Açık Sepetler <strong className="text-lg text-sky-200">{(cartModalProduct?.open_cart_quantity ?? 0).toLocaleString("tr-TR")}</strong>
              </span>
              <span className="inline-flex h-12 items-center gap-2 rounded-full border border-[#d8cf42]/18 bg-[#d8cf42]/10 px-4 text-sm font-black text-[#f8f3a1]">
                Koli İçi <strong className="text-lg text-white">{formatPackageQuantity(cartModalProduct?.package_quantity)}</strong>
              </span>
              <span className="inline-flex h-12 max-w-[220px] items-center gap-2 rounded-full border border-cyan-200/18 bg-cyan-200/10 px-4 text-sm font-black text-cyan-100">
                Raf Adresi <strong className="truncate text-lg text-white">{cartModalProduct ? productShelfAddress(cartModalProduct) : "-"}</strong>
              </span>
            </div>
            <div className="flex flex-col-reverse gap-3 sm:flex-row">
              <Button
                type="button"
                variant="outline"
                className="h-[52px] rounded-2xl border-white/10 bg-white/[0.04] px-6 font-extrabold text-slate-200 hover:bg-white/[0.08] hover:text-white"
                onClick={() => setCartModalProduct(null)}
              >
                Vazgeç
              </Button>
              <Button
                type="button"
                className="h-[52px] rounded-2xl border border-red-200/45 bg-gradient-to-b from-[#ff4a43] via-[#d71920] to-[#8d070d] px-7 text-base font-black text-white shadow-[0_3px_0_#8a070d,0_14px_24px_-18px_rgba(255,35,35,0.92),inset_0_1px_0_rgba(255,255,255,0.48)] hover:from-[#ff625b] hover:via-[#e51f26] hover:to-[#9b080e]"
	                disabled={!cartModalCanSubmit}
                onClick={handleConfirmCartQuantity}
              >
                {mutating ? <Loader2 className="h-5 w-5 animate-spin" /> : <ShoppingCart className="h-5 w-5" />}
                {cartModalCurrentQty > 0 ? "Güncelle" : "Sepete Ekle"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(imagePreview)} onOpenChange={(open) => !open && setImagePreview(null)}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>{imagePreview?.sku ?? "Ürün Resmi"}</DialogTitle>
            <DialogDescription>{imagePreview?.name ?? "Ürün görseli"}</DialogDescription>
          </DialogHeader>

          <div className="flex max-h-[78vh] items-center justify-center rounded-2xl border border-[var(--brand-border)] bg-[var(--surface-soft)] p-3">
            {imagePreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imagePreview.src}
                alt={imagePreview.name}
                className="max-h-[72vh] max-w-full object-contain"
              />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(competitorCodesPreview)}
        onOpenChange={(open) => !open && setCompetitorCodesPreview(null)}
      >
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>Rakip Kodları</DialogTitle>
            <DialogDescription>
              {competitorCodesPreview
                ? `${competitorCodesPreview.sku} - ${competitorCodesPreview.name} · ${competitorCodeRows.length} kod`
                : "Ürün rakip kodları"}
            </DialogDescription>
          </DialogHeader>

          {competitorCodesPreview && competitorCodeRows.length > 0 ? (
            <div className="overflow-hidden rounded-xl border border-[var(--brand-border)] bg-white">
              <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-3 bg-[var(--surface-soft)] px-4 py-3 text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--muted-foreground)] sm:grid-cols-2 sm:[&>span:nth-child(odd)]:pl-0 lg:grid-cols-3 xl:grid-cols-4">
                {Array.from({ length: 4 }).map((_, index) => (
                  <span
                    key={`competitor-code-head-${index}`}
                    className={cn(index === 2 && "hidden lg:block", index === 3 && "hidden xl:block")}
                  >
                    Rakip Kod
                  </span>
                ))}
              </div>
              <div className="grid max-h-[520px] grid-cols-1 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {competitorCodeRows.map((code, index) => (
                  <div
                    key={`${code}-${index}`}
                    className="grid min-h-[54px] grid-cols-[46px_minmax(0,1fr)] items-center gap-3 border-t border-[var(--brand-border)] px-4 py-2.5 text-sm odd:bg-white even:bg-[var(--surface-soft)]/50 sm:border-r sm:[&:nth-child(2n)]:border-r-0 lg:[&:nth-child(2n)]:border-r lg:[&:nth-child(3n)]:border-r-0 xl:[&:nth-child(3n)]:border-r xl:[&:nth-child(4n)]:border-r-0"
                  >
                    <span className="rounded-lg bg-[var(--surface-soft)] px-2 py-1 text-center text-xs font-black tabular-nums text-[var(--muted-foreground)]">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="break-all text-base font-black tracking-[0.01em] text-[var(--foreground)]">
                      {code}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-[var(--brand-border)] bg-[var(--surface-soft)] p-6 text-center text-sm font-semibold text-[var(--muted-foreground)]">
              Bu ürün için kayıtlı rakip kodu yok.
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(oemCodePreview)}
        onOpenChange={(open) => !open && setOemCodePreview(null)}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>OEM Kodu</DialogTitle>
            <DialogDescription>
              {oemCodePreview ? `${oemCodePreview.sku} - ${oemCodePreview.name}` : "Ürün OEM kodu"}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[60vh] overflow-y-auto rounded-xl border border-[var(--brand-border)] bg-[var(--surface-soft)] p-4">
            <p className="text-[11px] font-black uppercase tracking-[0.14em] text-[var(--muted-foreground)]">OEM Kodu</p>
            <p className="mt-2 break-all text-2xl font-black text-[var(--foreground)]">
              {oemCodePreview?.oem ?? "-"}
            </p>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(vehicleFitmentsPreview)}
        onOpenChange={(open) => !open && setVehicleFitmentsPreview(null)}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Araç Uyumluluğu</DialogTitle>
            <DialogDescription>
              {vehicleFitmentsPreview
                ? `${vehicleFitmentsPreview.sku} - ${vehicleFitmentsPreview.name} · ${vehicleFitmentsPreview.fitments.length} araç`
                : "Ürün araç uyumluluğu"}
            </DialogDescription>
          </DialogHeader>

          {vehicleFitmentsPreview && vehicleFitmentsPreview.fitments.length > 0 ? (
            <div className="max-h-[60vh] overflow-y-auto rounded-xl border border-[var(--brand-border)] bg-[var(--surface-soft)]">
              {vehicleFitmentsPreview.fitments.map((fitment, index) => (
                <div
                  key={`${fitment.vehicle_id ?? "vehicle"}-${index}`}
                  className="grid gap-3 border-b border-[var(--brand-border)] px-4 py-3 last:border-b-0 sm:grid-cols-[44px_minmax(0,1fr)_96px]"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--surface)] text-xs font-black text-[var(--muted-foreground)]">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="min-w-0">
                    <p className="break-words text-base font-black text-[var(--foreground)]">
                      {formatVehicleTitle(fitment)}
                    </p>
                    <p className="mt-1 text-xs font-bold text-[var(--muted-foreground)]">
                      {[fitment.fuel_type, fitment.position, fitment.fitment_note].filter(Boolean).join(" · ") || "Uyumluluk kaydı"}
                    </p>
                  </div>
                  <span className="inline-flex h-9 items-center justify-center rounded-lg border border-[var(--brand-border)] bg-[var(--surface)] px-3 text-sm font-black text-[var(--foreground)]">
                    {formatVehicleYears(fitment)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-[var(--brand-border)] bg-[var(--surface-soft)] p-6 text-center text-sm font-semibold text-[var(--muted-foreground)]">
              Bu ürün için kayıtlı araç uyumluluğu yok.
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(previousPurchasePreview)}
        onOpenChange={(open) => !open && setPreviousPurchasePreview(null)}
      >
        <DialogContent className="max-w-2xl border-emerald-300/20 bg-[radial-gradient(circle_at_50%_0%,rgba(52,211,153,0.12)_0%,transparent_34%),linear-gradient(145deg,rgba(12,24,32,0.98)_0%,rgba(7,15,23,0.98)_58%,rgba(10,30,23,0.98)_100%)] text-slate-100">
          <DialogHeader>
            <DialogTitle className="text-2xl font-black text-white">Son Alış Hareketi</DialogTitle>
            <DialogDescription className="font-bold text-slate-400">
              {previousPurchasePreview
                ? `${previousPurchasePreview.sku} - ${previousPurchasePreview.name}`
                : "Ürün önceki alım bilgisi"}
            </DialogDescription>
          </DialogHeader>

          {previousPurchasePreview?.previousPurchase ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                {[
                  { label: "Tarih", value: formatProductDate(previousPurchasePreview.previousPurchase.ordered_at) },
                  { label: "Fatura No", value: previousPurchasePreview.previousPurchase.invoice_no || previousPurchasePreview.previousPurchase.order_no || "-" },
                  { label: "Sipariş No", value: previousPurchasePreview.previousPurchase.order_no || "-" },
                ].map((item) => (
                  <div key={item.label} className="rounded-2xl border border-white/10 bg-white/[0.055] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
                    <span className="block text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">{item.label}</span>
                    <strong className="mt-2 block min-h-7 break-words text-lg font-black text-white">{item.value}</strong>
                  </div>
                ))}
              </div>

              <div className="rounded-2xl border border-emerald-300/18 bg-emerald-300/[0.06] p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.16em] text-emerald-200/70">Hareket Özeti</p>
                    <p className="mt-1 text-sm font-bold text-slate-400">Müşterinin bu üründeki en son alış kaydı</p>
                  </div>
                  <span className="rounded-full border border-emerald-300/25 bg-emerald-300/12 px-3 py-1 text-xs font-black uppercase text-emerald-100">
                    {previousPurchasePreview.previousPurchase.status || "Kayıtlı"}
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {[
                    { label: "Adet", value: previousPurchasePreview.previousPurchase.quantity.toLocaleString("tr-TR") },
                    { label: "Birim Fiyat", value: previousPurchasePreview.previousPurchase.unit_net_price ? formatTry(previousPurchasePreview.previousPurchase.unit_net_price) : "-" },
                    { label: "Satır Toplam", value: previousPurchasePreview.previousPurchase.line_total ? formatTry(previousPurchasePreview.previousPurchase.line_total) : "-" },
                    { label: "Para Birimi", value: previousPurchasePreview.previousPurchase.currency || "TRY" },
                    { label: "İskonto", value: formatPercentValue(previousPurchasePreview.previousPurchase.discount_rate) },
                    { label: "KDV", value: formatPercentValue(previousPurchasePreview.previousPurchase.tax_rate) },
                  ].map((row) => (
                    <div key={row.label} className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/16 px-3 py-2.5">
                      <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">{row.label}</span>
                      <span className="min-w-0 break-words text-right text-sm font-black text-slate-100">{row.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-[var(--brand-border)] bg-[var(--surface-soft)] p-6 text-center text-sm font-semibold text-[var(--muted-foreground)]">
              Bu ürün için önceki alım kaydı yok.
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
