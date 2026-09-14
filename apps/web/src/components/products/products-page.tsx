"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Calculator,
  ImageIcon,
  Info,
  Loader2,
  PackageSearch,
  Search,
  ShoppingCart,
  SlidersHorizontal,
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
  type ProductPreviousPurchaseHistoryItem,
  type ProductPreviousPurchasesResponse,
  type ProductSearchItem,
  getProductPreviousPurchases,
  getProductFilterOptions,
  resolveApiBaseUrl,
  searchProducts,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const PAGE_LIMIT = 12;
const SHOW_ALL_PAGE_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 220;
const MIN_SEARCH_LENGTH = 2;
const PRODUCT_PREVIEW_IMAGE_WIDTH = 960;
const ALL_FILTER_VALUE = "__all";
const PRODUCT_TABLE_GRID =
  "grid w-full items-stretch gap-0";
const PRODUCT_FILTER_TRIGGER_CLASS =
  "admin-dashboard-ghost h-9 w-full rounded-lg bg-[var(--surface-soft)] px-3 text-left text-xs font-extrabold shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-colors hover:border-[var(--brand-primary)]/55 hover:bg-[color-mix(in_oklab,var(--brand-primary)_10%,var(--surface))] focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]/45";
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
  const stockColumnWidth = Math.min(252, Math.max(86, normalizedStockColumnCount * 72));
  const minWidth = Math.max(1080, 842 + stockColumnWidth);

  return {
    minWidth,
    gridTemplateColumns: `42px minmax(112px,0.66fr) minmax(82px,0.42fr) minmax(300px,1.8fr) minmax(92px,0.48fr) 52px 90px minmax(${stockColumnWidth}px,0.72fr) 54px 64px`,
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

function formatDiscountList(discounts: number[] | null | undefined): string {
  const visible = (discounts ?? [])
    .map((discount) => Number(discount))
    .filter((discount) => Number.isFinite(discount) && discount > 0);

  return visible.length > 0
    ? visible.map((discount) => `%${discount.toLocaleString("tr-TR", { maximumFractionDigits: 2 })}`).join(" + ")
    : "-";
}

function parseDecimalValue(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = typeof value === "number" ? value : Number(String(value).replace(",", "."));

  return Number.isFinite(parsed) ? parsed : null;
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

function formatProductModalPrice(
  product: ProductSearchItem,
  value: string | null | undefined,
  includeVat: boolean,
  currencyOverride?: string
): string {
  const parsed = parseDecimalValue(value);
  if (parsed === null) {
    return "-";
  }

  const vatRate = parseDecimalValue(product.vat_rate) ?? 0;

  return formatProductAmount(includeVat ? parsed * (1 + vatRate / 100) : parsed, currencyOverride ?? product.currency);
}

function campaignTierUnitPrice(
  product: ProductSearchItem,
  tier: {
    unit_price: string | null;
    discount_percent?: number | null;
  }
): number | null {
  const fixedPrice = parseDecimalValue(tier.unit_price);
  if (fixedPrice !== null) {
    return fixedPrice;
  }

  const basePrice = parseDecimalValue(product.net_price ?? product.list_price);
  if (basePrice === null || tier.discount_percent === null || tier.discount_percent === undefined) {
    return null;
  }

  return Math.max(0, basePrice * (1 - Number(tier.discount_percent) / 100));
}

function formatCampaignTierPrice(
  product: ProductSearchItem,
  tier: {
    min_quantity: number;
    unit_price: string | null;
    currency?: string | null;
    discount_percent?: number | null;
  },
  includeVat: boolean,
  currencyOverride?: string
): { unit: string; total: string } {
  const unitPrice = campaignTierUnitPrice(product, tier);
  const vatRate = parseDecimalValue(product.vat_rate) ?? 0;
  const displayUnitPrice =
    unitPrice === null ? null : includeVat ? unitPrice * (1 + vatRate / 100) : unitPrice;
  const currency = currencyOverride ?? (tier.unit_price ? tier.currency : product.currency);

  return {
    unit: formatProductAmount(displayUnitPrice, currency),
    total: formatProductAmount(
      displayUnitPrice === null ? null : displayUnitPrice * Math.max(1, tier.min_quantity),
      currency
    ),
  };
}

function batumCampaignUnitPrice(product: ProductSearchItem): number | null {
  if (currencyLabel(product.currency) !== "GEL") {
    return null;
  }

  const tier = (product.campaigns ?? [])
    .flatMap((campaign) => campaign.tiers)
    .filter((campaignTier) => campaignTier.min_quantity <= 1 && currencyLabel(campaignTier.currency) === "GEL")
    .sort((left, right) => {
      const leftPrice = parseDecimalValue(left.unit_price) ?? Number.MAX_SAFE_INTEGER;
      const rightPrice = parseDecimalValue(right.unit_price) ?? Number.MAX_SAFE_INTEGER;

      return leftPrice - rightPrice;
    })[0];

  return tier ? parseDecimalValue(tier.unit_price) : null;
}

function batumCampaignListPrice(product: ProductSearchItem): number | null {
  const unitPrice = batumCampaignUnitPrice(product);

  return unitPrice === null ? null : unitPrice * 2;
}

function stripPriceCurrency(value: string): string {
  return value.replace(/\s*(TRY|TL|₺|GEL|USD|EUR)\s*$/i, "").trim();
}

function campaignTierLabel(tier: { min_quantity: number; condition?: string | null }): string {
  const condition = tier.condition?.trim() ?? "";
  const greaterThan = condition.match(/\bP1\s*>\s*(\d+)/i);

  if (greaterThan) {
    return `${greaterThan[1]}+ adet`;
  }

  return tier.min_quantity > 1 ? `${tier.min_quantity} adet` : "Size özel fiyat";
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

function productBranchStockHeaderLabel(branch: BranchStockColumn) {
  if (branch.key === "erz-depo") {
    return (
      <>
        ERZ.<br />
        DEPO
      </>
    );
  }

  if (branch.key === "erz-point") {
    return (
      <>
        ERZ.<br />
        POINT
      </>
    );
  }

  return <>{branch.label}</>;
}

function normalizeBranchText(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLocaleLowerCase("tr-TR")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ");
}

function customerCodeLooksLikeBatum(value: string | null | undefined): boolean {
  const segments = (value ?? "").trim().split(/[^0-9]+/).filter(Boolean);

  return segments[1] === "00";
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
  const orderedKeys = (() => {
    switch (normalizedUsername) {
      case "erzurum hizlisatis":
        return ["erz-point", "erz-depo"];
      case "ahmet arac":
      case "huseyin ozguney":
      case "mehmet aksoy":
        return ["erz-depo"];
      default:
        return null;
    }
  })();

  return orderedKeys
    ? orderedKeys
      .map((key) => BRANCH_STOCK_COLUMNS.find((column) => column.key === key))
      .filter((column): column is BranchStockColumn => Boolean(column))
    : null;
}

function orderBranchStockColumns(
  columns: readonly BranchStockColumn[],
  branchIdentity: string | null | undefined,
): readonly BranchStockColumn[] {
  const normalizedIdentity = normalizeBranchText(branchIdentity);
  const preferredKeys = normalizedIdentity.includes("batum")
    ? ["batum", "erz-depo", "erz-point", "trabzon", "samsun"]
    : normalizedIdentity.includes("trabzon")
      ? ["trabzon", "erz-depo", "erz-point", "samsun", "batum"]
      : normalizedIdentity.includes("samsun")
        ? ["samsun", "erz-depo", "erz-point", "trabzon", "batum"]
        : normalizedIdentity.includes("erzurum") || normalizedIdentity.includes("erz depo")
          ? ["erz-depo", "erz-point", "trabzon", "samsun", "batum"]
          : BRANCH_STOCK_COLUMNS.map((column) => column.key);
  const rank = new Map(preferredKeys.map((key, index) => [key, index]));

  return [...columns].sort((left, right) =>
    (rank.get(left.key) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.key) ?? Number.MAX_SAFE_INTEGER)
  );
}

function visibleBranchStockColumns(
  featurePermissionSet: Set<string>,
  roleSlugs: string[],
  username: string | null | undefined,
  branchIdentity: string | null | undefined,
): readonly BranchStockColumn[] {
  const userSpecificColumns = userSpecificBranchStockColumns(username);
  if (userSpecificColumns !== null) {
    return userSpecificColumns;
  }

  const selectedColumns = BRANCH_STOCK_COLUMNS.filter((column) => featurePermissionSet.has(column.permissionKey));
  const hasExplicitStockPolicy =
    featurePermissionSet.has("search.stock") ||
    BRANCH_STOCK_COLUMNS.some((column) => featurePermissionSet.has(column.permissionKey));

  if (hasExplicitStockPolicy) {
    return orderBranchStockColumns(selectedColumns, branchIdentity);
  }

  if (roleSlugs.includes("admin") || roleSlugs.includes("moderator")) {
    return orderBranchStockColumns(BRANCH_STOCK_COLUMNS, branchIdentity);
  }

  return orderBranchStockColumns(selectedColumns.length > 0 ? selectedColumns : BRANCH_STOCK_COLUMNS, branchIdentity);
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
  pricesIncludeVat: boolean;
  showRetailPriceHint: boolean;
  tableGridStyle: CSSProperties;
  style?: CSSProperties;
  campaignNames?: string[];
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
  history?: ProductPreviousPurchasesResponse | null;
  loading?: boolean;
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
  if (!canViewStock) {
    const totalStock = productStockLocations(product).reduce((total, location) => total + Math.max(0, location.stock ?? 0), 0);
    const tone = totalStock > 10 ? "high" : totalStock > 0 ? "low" : "none";
    const label = tone === "high" ? "Stok Var" : tone === "low" ? "Stok Az" : "Stok Yok";

    return (
      <div className="product-stock-cell flex h-full w-full items-center justify-center px-1 text-center">
        <span
          className={cn(
            "inline-flex min-h-7 items-center justify-center rounded-full border px-2.5 text-[10px] font-black",
            tone === "high" && "border-[#00a83a] bg-[#00e052] text-[#001f0b]",
            tone === "low" && "border-[#1d4ed8] bg-[#2563eb] text-white shadow-[0_6px_16px_-10px_rgba(37,99,235,0.95)]",
            tone === "none" && "border-[#cc0000] bg-[#ff0000] text-white"
          )}
        >
          {label}
        </span>
      </div>
    );
  }

  const branchRows = branchStockRows(product, columns);

  if (branchRows.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center text-sm font-black text-[var(--muted-foreground)]">
        -
      </div>
    );
  }

  return (
    <div className="admin-product-stock product-stock-cell h-full w-full min-w-0">
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
                  "product-stock-branch flex min-w-0 flex-col items-center justify-center gap-0.5 border-l border-[var(--brand-border)] px-1 py-0.5 text-center leading-none first:border-l-0",
                isPositive
                  ? "bg-emerald-300/10 text-emerald-100"
                  : "text-[var(--muted-foreground)]",
                index === 0 && isPositive && "bg-emerald-300/14"
              )}
            >
              <span className={cn("block w-full truncate text-[12px] font-black", isPositive ? "text-emerald-200" : "text-[var(--foreground)]")}>
                {canViewStock && branch.stock !== null ? branch.stock.toLocaleString("tr-TR") : "-"}
              </span>
              <span
                className={cn(
                  "product-shelf-badge inline-flex min-h-4 w-auto max-w-full min-w-0 items-center justify-center gap-1 rounded-md border px-1.5 text-[9px] font-black leading-[10px] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]",
                  hasShelfAddress
                    ? "border-sky-300/35 bg-sky-300/14 text-sky-100"
                    : "border-slate-500/20 bg-slate-500/10 text-slate-400"
                )}
                title={`${branch.title} raf adresi: ${shelfText}`}
              >
                <span className="min-w-0 truncate text-center">{shelfText}</span>
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
  pricesIncludeVat,
  showRetailPriceHint,
  tableGridStyle,
  style,
  campaignNames,
  onOpenCartModal,
  onPreviewImage,
  onShowCompetitorCodes,
  onShowOemCode,
  onShowVehicleFitments,
  onShowPreviousPurchase,
}: ProductRowProps) {
  const batumDerivedListPrice = batumCampaignListPrice(product);
  const effectiveNetPrice = product.special_discounted_price ?? product.net_price;
  const displayListPrice = batumDerivedListPrice === null
    ? product.list_price ?? effectiveNetPrice
    : String(batumDerivedListPrice);
  const hasPrice = canViewPrices && Boolean(displayListPrice);
  const hasCategory = Boolean(product.category?.name);
  const priceText = canViewPrices
    ? pricesIncludeVat
      ? formatProductModalPrice(product, displayListPrice, true, batumDerivedListPrice !== null ? "GEL" : product.currency)
      : formatPriceValue(displayListPrice, batumDerivedListPrice !== null ? "GEL" : product.currency)
    : "-";
  const priceCards = product.price_cards ?? [];
  const masterPriceCard = priceCards.find((card) => /^F(?:[1-9]|1[0-2])$/.test(card.code));
  const retailPriceCard = priceCards.find((card) =>
    ["PRK", "PERAK", "PERAKENDE"].includes(card.code) || card.label.toLocaleUpperCase("tr-TR").includes("PERAKENDE")
  );
  const formatPriceCard = (card: NonNullable<ProductSearchItem["price_cards"]>[number] | undefined) => {
    if (!card?.price) return "-";

    return pricesIncludeVat
      ? formatProductModalPrice(product, card.price, true, card.currency ?? undefined)
      : formatPriceValue(card.price, card.currency ?? product.currency);
  };
  const retailPriceText = formatPriceCard(retailPriceCard);
  const masterPriceText = formatPriceCard(masterPriceCard);
  const competitorCodes = product.competitor_codes ?? [];
  const vehicleFitments = product.vehicle_fitments ?? [];
  const previousPurchase = normalizePreviousPurchase(product.previous_purchase);
  const isCampaignRow = Boolean(campaignNames && campaignNames.length > 0);
  const shouldShowPriceCards = showRetailPriceHint && hasPrice && Boolean(masterPriceCard || retailPriceCard);

  return (
    <div
      style={style}
      role="row"
      className="admin-product-row product-result-row w-full"
    >
      <div
        className={cn(
          "admin-product-row-grid group min-h-[34px] border-b border-l-4 border-[var(--brand-border)] border-l-transparent bg-[var(--surface)] transition-[background-color,border-color,box-shadow] duration-150 hover:border-l-[#8bd19f] hover:bg-[#1d3024] hover:shadow-[inset_0_0_0_9999px_rgba(139,209,159,0.08)]",
          isCampaignRow && "product-campaign-row border-l-[#ffff00] bg-[#ffff00] text-slate-950 shadow-[inset_0_0_0_1px_rgba(255,255,0,0.88)] hover:border-l-[#ffff00] hover:bg-[#ffff00]",
          PRODUCT_TABLE_GRID
        )}
        style={tableGridStyle}
      >
        <div role="cell" className="flex items-center justify-center px-1 py-0.5">
          <ProductImageCell product={product} onPreviewImage={onPreviewImage} />
        </div>

        <div role="cell" className="product-sku-cell flex min-w-0 items-center border-l border-[var(--brand-border)] px-1.5 py-0.5">
          <p className="truncate text-[13px] font-black tracking-[0.02em] text-[#f8fff9] drop-shadow-[0_1px_1px_rgba(0,0,0,0.42)]">
            {product.sku}
          </p>
        </div>

        <div role="cell" className="flex min-w-0 flex-col justify-center border-l border-[var(--brand-border)] px-1.5 py-0.5">
          <p className="truncate text-[10px] font-extrabold text-[var(--foreground)]">
            {product.brand.name ?? "-"}
          </p>
          {hasCategory ? (
            <p className="truncate text-[8px] font-medium text-[var(--muted-foreground)]">
              {product.category?.name}
            </p>
          ) : null}
        </div>

        <div role="cell" className="flex min-w-0 items-start border-l border-[var(--brand-border)] px-2 py-0.5 flex-col justify-center gap-0.5">
          <p className="line-clamp-1 text-[12px] font-semibold leading-[13px] text-[var(--foreground)]">
            {product.name}
          </p>
        </div>

        <div role="cell" className="flex min-w-0 items-center border-l border-[var(--brand-border)] px-1.5 py-0.5">
          <p className="truncate text-[10px] font-extrabold leading-[12px] text-[var(--muted-foreground)]">
            {product.type_name ?? "-"}
          </p>
        </div>

        <div role="cell" className="flex min-w-0 items-center justify-center border-l border-[var(--brand-border)] px-1 py-0.5">
          <p className="text-center text-[11px] font-extrabold text-[var(--foreground)]">
            {formatPackageQuantity(product.package_quantity)}
          </p>
        </div>

        <div role="cell" className="admin-product-price product-list-price-cell flex min-w-0 items-center justify-center border-l border-[var(--brand-border)] px-1.5 py-0.5">
          <p className="flex max-w-full justify-center text-center text-[11px] font-extrabold text-[var(--foreground)]">
            <span className="group/retail-price relative inline-flex max-w-full">
              <span className="truncate">{priceText}</span>
              {shouldShowPriceCards ? (
                <>
                  {masterPriceCard ? (
                    <span className="product-price-tooltip pointer-events-none absolute right-full top-1/2 z-50 mr-2 hidden w-max -translate-y-1/2 whitespace-nowrap rounded-xl border border-emerald-200/35 bg-[#101b18]/98 px-4 py-2 text-left font-black text-[#f3fff5] opacity-0 shadow-[0_18px_38px_-18px_rgba(0,0,0,0.98),0_0_28px_-12px_rgba(139,209,159,0.9)] ring-1 ring-white/10 group-hover/retail-price:block group-hover/retail-price:opacity-100">
                      <span className="block text-[11px] uppercase tracking-[0.1em] text-[#9fb5a8]">Usta Satış {masterPriceCard.code}</span>
                      <span className="mt-1 block text-[18px] leading-none text-[#faee56]">{masterPriceText}</span>
                    </span>
                  ) : null}
                  {retailPriceCard ? (
                    <span className="product-price-tooltip pointer-events-none absolute left-full top-1/2 z-50 ml-2 hidden w-max -translate-y-1/2 whitespace-nowrap rounded-xl border border-emerald-200/35 bg-[#101b18]/98 px-4 py-2 text-left font-black text-[#f3fff5] opacity-0 shadow-[0_18px_38px_-18px_rgba(0,0,0,0.98),0_0_28px_-12px_rgba(139,209,159,0.9)] ring-1 ring-white/10 group-hover/retail-price:block group-hover/retail-price:opacity-100">
                      <span className="block text-[11px] uppercase tracking-[0.1em] text-[#9fb5a8]">Perakende Satış</span>
                      <span className="mt-1 block text-[18px] leading-none text-[#faee56]">{retailPriceText}</span>
                    </span>
                  ) : null}
                </>
              ) : null}
            </span>
          </p>
        </div>

        <div role="cell" className="product-stock-cell flex min-w-0 items-stretch border-l border-[var(--brand-border)] px-0 py-0">
          <ProductStockCell product={product} canViewStock={canViewStock} columns={visibleStockColumns} />
        </div>

        <div
          role="cell"
          className={cn(
            "product-info-action-cell relative z-20 flex min-w-0 items-center justify-center border-l border-[var(--brand-border)] px-1 py-0.5 shadow-[-10px_0_18px_-20px_rgba(0,0,0,0.95)] lg:sticky lg:right-16",
            isCampaignRow
              ? "bg-[#ffff00] group-hover:bg-[#ffff00]"
              : "bg-[var(--surface)] group-hover:bg-[#1d3024]"
          )}
        >
          <details data-product-info className="group/details relative">
            <summary
              className="product-info-button flex h-7 w-9 cursor-pointer list-none items-center justify-center rounded-lg border border-[#faee56]/55 bg-[#6b611f] text-[#fff4a3] shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_10px_18px_-18px_rgba(250,238,86,0.9)] transition-colors hover:bg-[#7d7228] [&::-webkit-details-marker]:hidden"
              title="Ürün bilgileri"
              aria-label={`${product.sku} ürün bilgileri`}
            >
              <Info className="h-4 w-4" strokeWidth={3} />
            </summary>
            <div className="product-info-popover absolute right-0 top-8 z-50 hidden w-56 rounded-xl border border-[#faee56]/35 bg-[#101817]/98 p-2 shadow-[0_24px_44px_-18px_rgba(0,0,0,0.92),0_0_24px_-16px_rgba(250,238,86,0.9)] group-open/details:block">
              <div className="grid max-w-full min-w-0 grid-cols-2 gap-1.5 text-[9px] font-black leading-tight">
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
              onClick={() => onShowPreviousPurchase({ sku: product.sku, name: product.name, previousPurchase })}
              className={cn(
                "relative flex h-7 min-w-0 items-center justify-between gap-1 rounded-lg border border-[var(--brand-border)] bg-[var(--surface-soft)] px-1 text-[var(--foreground)] transition-colors hover:border-[#8bd19f]/60 hover:bg-[#213b31]",
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
                {previousPurchase ? 1 : "?"}
              </span>
            </button>
              </div>
            </div>
          </details>
        </div>

        <div
          role="cell"
          className={cn(
            "admin-product-actions right-0 z-20 flex min-w-0 items-center justify-center border-l border-[var(--brand-border)] px-1 py-0.5 shadow-[-14px_0_22px_-22px_rgba(0,0,0,0.95)] lg:sticky",
            "product-cart-action-cell",
            isCampaignRow
              ? "bg-[#ffff00] group-hover:bg-[#ffff00]"
              : "bg-[var(--surface)] group-hover:bg-[#1d3024]"
          )}
        >
          <Button
            type="button"
            size="icon"
            onClick={() => onOpenCartModal(product, qty)}
	            disabled={!canAdd}
            className="cart-primary-button product-cart-button relative mx-auto h-8 w-8 rounded-lg border border-red-200/45 bg-gradient-to-b from-[#ff4a43] via-[#d71920] to-[#8d070d] text-white shadow-[0_2px_0_#8a070d,0_10px_18px_-18px_rgba(255,35,35,0.9),inset_0_1px_0_rgba(255,255,255,0.48)] transition-transform hover:-translate-y-0.5 hover:from-[#ff625b] hover:via-[#e51f26] hover:to-[#9b080e] active:translate-y-0.5 active:shadow-[0_1px_0_#8a070d,0_8px_18px_-18px_rgba(255,35,35,0.82),inset_0_1px_0_rgba(255,255,255,0.34)] disabled:!translate-y-0 disabled:!border-slate-500/40 disabled:!bg-[#617488] disabled:!bg-none disabled:!text-[#07120d] disabled:!shadow-none"
            aria-label={`${product.sku} sepete ekle`}
            title="Sepete ekle"
          >
            {mutating ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={3} /> : <ShoppingCart className="h-5 w-5 drop-shadow-[0_2px_1px_rgba(0,0,0,0.42)]" strokeWidth={3.2} />}
            {qty > 0 ? (
              <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full border border-white/50 bg-[#faee56] px-1 text-[9px] font-black text-[#193126] shadow-[0_4px_10px_-4px_rgba(250,238,86,0.92)]">
                {qty}
              </span>
            ) : null}
            {cartDistinctLineCount > 0 ? (
              <span className="absolute -left-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full border border-cyan-100/80 bg-cyan-300 px-1 text-[9px] font-black text-[#0b2631] shadow-[0_4px_10px_-4px_rgba(103,232,249,0.88)]">
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
  const skipNextDebouncedEmptySearchRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const cartQuantityInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const closeProductInfoOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      document
        .querySelectorAll<HTMLDetailsElement>("details[data-product-info][open]")
        .forEach((details) => {
          if (!details.contains(target)) {
            details.removeAttribute("open");
          }
        });
    };

    document.addEventListener("pointerdown", closeProductInfoOutside);
    return () => document.removeEventListener("pointerdown", closeProductInfoOutside);
  }, []);

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
  const {
    cartData,
    upsertQuantity,
    mutating,
  } = useCart();
  const roleSlugs = useMemo(() => user?.roles.map((role) => role.slug) ?? [], [user?.roles]);
  const isPointPanel = useMemo(() => roleSlugs.includes("point"), [roleSlugs]);
  const isCustomerUser = useMemo(() => roleSlugs.includes("customer"), [roleSlugs]);
  const featurePermissionSet = useMemo(() => new Set(user?.feature_permissions ?? []), [user?.feature_permissions]);
  const canViewSearchPrices = !isCustomerUser || featurePermissionSet.has("search.prices");
  const canViewCampaigns = !isCustomerUser || featurePermissionSet.has("search.campaigns");
  // Müşteri panelinde gerçek depo adedi ve raf adresi gösterilmez.
  // Yetki verilmiş olsa bile müşteri sadece stok durum rozetini görür.
  const canViewSearchStock = !isCustomerUser;
  const canUseSearchCart = !isCustomerUser || featurePermissionSet.has("search.add_to_cart");
  const canUseDepotTransferCart =
    roleSlugs.includes("admin") ||
    roleSlugs.includes("dealer_admin") ||
    roleSlugs.includes("warehouse") ||
    roleSlugs.includes("point") ||
    featurePermissionSet.has("cart.warehouse_transfer");
  const branchIdentity = useMemo(() => {
    const selectedCustomerIdentity = [
      selectedCustomer?.branch_code,
      selectedCustomer?.branch_name,
      selectedCustomer?.region_code,
      selectedCustomer?.region_name,
    ].filter(Boolean).join(" ");
    const followsSelectedCustomerBranch =
      roleSlugs.includes("admin") ||
      roleSlugs.includes("moderator") ||
      roleSlugs.includes("global") ||
      roleSlugs.includes("accounting");

    if (followsSelectedCustomerBranch && selectedCustomerIdentity !== "") {
      return selectedCustomerIdentity;
    }

    const userIdentity = [
      user?.username,
      user?.branch_code,
      user?.branch_name,
      user?.region_code,
      user?.region_name,
    ].filter(Boolean).join(" ");
    const normalizedUserIdentity = normalizeBranchText(userIdentity);
    const hasKnownUserBranch = ["batum", "trabzon", "samsun", "erzurum", "erz depo"]
      .some((branch) => normalizedUserIdentity.includes(branch));

    if (hasKnownUserBranch) {
      return userIdentity;
    }

    return selectedCustomerIdentity;
  },
    [
      selectedCustomer?.branch_code,
      selectedCustomer?.branch_name,
      selectedCustomer?.region_code,
      selectedCustomer?.region_name,
      roleSlugs,
      user?.branch_code,
      user?.branch_name,
      user?.region_code,
      user?.region_name,
      user?.username,
    ]
  );
  const isBatumPriceScope =
    normalizeBranchText(branchIdentity).includes("batum") ||
    customerCodeLooksLikeBatum(selectedCustomer?.code);
  const showPriceCardsOnSearch = isPointPanel || isBatumPriceScope;
  const visibleStockColumns = useMemo(
    () => (isCustomerUser && !canViewSearchStock ? [] : visibleBranchStockColumns(featurePermissionSet, roleSlugs, user?.username, branchIdentity)),
    [branchIdentity, canViewSearchStock, featurePermissionSet, isCustomerUser, roleSlugs, user?.username]
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
  const [cartDuplicateConfirm, setCartDuplicateConfirm] = useState<{
    product: ProductSearchItem;
    quantity: number;
    campaignKey: string | null;
  } | null>(null);
  const [cartCalculatorOpen, setCartCalculatorOpen] = useState(false);
  const [cartPricesIncludeVat, setCartPricesIncludeVat] = useState(false);
  const [calculatorDisplay, setCalculatorDisplay] = useState("0");
  const [calculatorStored, setCalculatorStored] = useState<number | null>(null);
  const [calculatorOperator, setCalculatorOperator] = useState<CalculatorOperator | null>(null);
  const [calculatorShouldReplace, setCalculatorShouldReplace] = useState(false);
  const [shouldLoadFilterOptions, setShouldLoadFilterOptions] = useState(true);
  const selectedCustomerContextId = selectedCustomer?.id ?? null;
  const competitorCodeRows = useMemo(
    () => normalizeCompetitorCodeRows(competitorCodesPreview?.codes ?? []),
    [competitorCodesPreview],
  );
  const handleShowPreviousPurchase = useCallback(async (preview: ProductPreviousPurchasePreview) => {
    if (!selectedCustomerContextId) {
      toast.error("Önceki alımları görüntülemek için önce bir cari seçiniz.");
      return;
    }

    setPreviousPurchasePreview({
      ...preview,
      history: null,
      loading: true,
    });

    try {
      const history = await getProductPreviousPurchases(preview.sku, {
        customer_id: selectedCustomerContextId,
        limit: 50,
      });

      setPreviousPurchasePreview({
        ...preview,
        history,
        loading: false,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Önceki alımlar şu anda alınamadı.");
      setPreviousPurchasePreview((current) => current?.sku === preview.sku
        ? { ...current, history: null, loading: false }
        : current);
    }
  }, [selectedCustomerContextId]);

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

    if (window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 768) {
      cartQuantityInputRef.current?.blur();
      return;
    }

    const focusTimer = window.setTimeout(() => {
      cartQuantityInputRef.current?.focus({ preventScroll: true });
      cartQuantityInputRef.current?.select();
    }, 60);

    return () => window.clearTimeout(focusTimer);
  }, [cartModalProduct]);

  useEffect(() => {
    const resetTimer = window.setTimeout(() => {
      setImagePreview(null);
      setCompetitorCodesPreview(null);
      setOemCodePreview(null);
      setVehicleFitmentsPreview(null);
      setPreviousPurchasePreview(null);
      setCartModalProduct(null);
      setCartDuplicateConfirm(null);
      setCartCalculatorOpen(false);
      setCartPricesIncludeVat(false);
    }, 0);

    return () => window.clearTimeout(resetTimer);
  }, [selectedCustomerContextId]);

  const filterOptionsQuery = useQuery({
    queryKey: ["product-filter-options", "search"],
    queryFn: () => getProductFilterOptions({ scope: "search" }),
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: 2,
    staleTime: 2 * 60 * 60_000,
    gcTime: 4 * 60 * 60_000,
    enabled: shouldLoadFilterOptions,
  });

  useEffect(() => {
    const nextSearch = search.trim();
    const nextSubmittedSearch = nextSearch.length >= MIN_SEARCH_LENGTH ? nextSearch : "";
    if (nextSearch === "" && skipNextDebouncedEmptySearchRef.current) {
      skipNextDebouncedEmptySearchRef.current = false;
      return;
    }
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
  const productPageLimit = showAllProducts && !normalizedSearch && !hasMetaFilters ? SHOW_ALL_PAGE_LIMIT : PAGE_LIMIT;

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

    const nextUrl = nextQuery ? `${pathname}?${nextQuery}` : pathname;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, [brandId, metaFilters, normalizedSearch, pathname, resetFiltersAfterReload, showAllProducts, sort]);

  const productsQuery = useInfiniteQuery({
    queryKey: [
      "products",
      selectedCustomerContextId,
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
          limit: productPageLimit,
          cursor: sort === "recommended" ? pageParam.cursor ?? undefined : undefined,
          page: sort === "recommended" ? undefined : pageParam.page,
          include_equivalents: showAllProducts,
          customer_id: selectedCustomerContextId ?? undefined,
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
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: 0,
    staleTime: 0,
    gcTime: 15 * 60_000,
    enabled: shouldFetchProducts,
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
        root: null,
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
  const cartModalCanSubmit = Boolean(cartModalProduct && (selectedCustomer || canUseDepotTransferCart) && cartModalHasPrice && !mutating);
  const cartModalCampaigns = useMemo(
    () => canViewCampaigns ? (cartModalProduct?.campaigns ?? []) : [],
    [canViewCampaigns, cartModalProduct?.campaigns]
  );
  const cartModalCampaignTiers = useMemo(
    () => cartModalCampaigns
      .flatMap((campaign) => campaign.tiers.map((tier) => ({ campaign, tier })))
      .sort((left, right) => left.tier.min_quantity - right.tier.min_quantity),
    [cartModalCampaigns]
  );
  const cartModalHasCampaignOffers = Boolean(cartModalProduct?.special_discounted_price) || cartModalCampaigns.length > 0;
  const cartModalPricesIncludeVat = isBatumPriceScope ? false : cartPricesIncludeVat;
  const cartModalShowBaseSalesPrice = !(isBatumPriceScope && cartModalCampaigns.length > 0);
  const cartModalApplicableCampaign = useMemo(() => {
    const quantity = Math.max(1, Number(cartModalQuantity) || 1);
    const applicableCampaigns = cartModalCampaigns
      .map((campaign) => {
        const tier = campaign.tiers
          .filter((item) => item.min_quantity <= quantity)
          .sort((left, right) => {
            if (right.min_quantity !== left.min_quantity) {
              return right.min_quantity - left.min_quantity;
            }

            return Number(left.unit_price ?? Number.MAX_SAFE_INTEGER) - Number(right.unit_price ?? Number.MAX_SAFE_INTEGER);
          })[0];

        return tier ? { campaign, tier } : null;
      })
      .filter(
        (
          item
        ): item is {
          campaign: (typeof cartModalCampaigns)[number];
          tier: (typeof cartModalCampaigns)[number]["tiers"][number];
        } => Boolean(item)
      );

    return applicableCampaigns.sort((left, right) => {
      const leftPrice = Number(left.tier.unit_price ?? Number.MAX_SAFE_INTEGER);
      const rightPrice = Number(right.tier.unit_price ?? Number.MAX_SAFE_INTEGER);

      if (leftPrice !== rightPrice) {
        return leftPrice - rightPrice;
      }

      return (right.tier.discount_percent ?? 0) - (left.tier.discount_percent ?? 0);
    })[0] ?? null;
  }, [cartModalCampaigns, cartModalQuantity]);
  const resetCalculator = useCallback(() => {
    setCalculatorDisplay("0");
    setCalculatorStored(null);
    setCalculatorOperator(null);
    setCalculatorShouldReplace(false);
  }, []);
  const prepareSearchInputForNextProduct = useCallback(() => {
    setSearch("");
    setSubmittedSearch("");

    window.setTimeout(() => {
      if (window.matchMedia("(max-width: 767px)").matches) {
        return;
      }

      searchInputRef.current?.focus({ preventScroll: true });
      searchInputRef.current?.select();
    }, 0);
  }, [setSearch, setSubmittedSearch]);

  const handleSetQuantity = useCallback(
    (product: ProductSearchItem, nextQty: number, campaignKey?: string | null, mode: "added" | "updated" = "added") => {
      if (!selectedCustomer && !canUseDepotTransferCart) {
        return;
      }

      const quantity = Math.max(0, nextQty);
      void upsertQuantity(product.id, quantity, campaignKey).then(() => {
        toast.success(mode === "updated" ? "Sepetteki ürün güncellendi" : "Ürün sepete eklendi", {
          description: `${product.sku} · ${quantity.toLocaleString("tr-TR")} adet`,
          duration: 2600,
        });
      });
    },
    [canUseDepotTransferCart, selectedCustomer, upsertQuantity]
  );

  const handleOpenCartModal = useCallback((product: ProductSearchItem, currentQty: number) => {
    setCartModalProduct(product);
    setCartModalQuantity(currentQty || "");
    setCartCalculatorOpen(false);
    setCartPricesIncludeVat(false);
    resetCalculator();
  }, [resetCalculator]);

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
    if ((!selectedCustomer && !canUseDepotTransferCart) || !cartModalHasPrice) {
      return;
    }

    const quantity = Math.max(0, Number(cartModalQuantity) || 0);
    const campaignKey = cartModalApplicableCampaign?.campaign.key ?? null;
    const existingQuantity = cartData?.items.find((item) => item.product_id === cartModalProduct.id)?.quantity ?? 0;

    if (existingQuantity > 0 && quantity > 0) {
      setCartDuplicateConfirm({ product: cartModalProduct, quantity, campaignKey });
      setCartModalProduct(null);
      setCartCalculatorOpen(false);
      return;
    }

    handleSetQuantity(cartModalProduct, quantity, campaignKey, "added");
    setCartModalProduct(null);
    setCartCalculatorOpen(false);
    prepareSearchInputForNextProduct();
  }, [
    cartData?.items,
    cartModalApplicableCampaign?.campaign.key,
    cartModalHasPrice,
    cartModalProduct,
    cartModalQuantity,
    handleSetQuantity,
    prepareSearchInputForNextProduct,
    canUseDepotTransferCart,
    selectedCustomer,
  ]);

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
    if (nextSearch.length >= MIN_SEARCH_LENGTH) {
      skipNextDebouncedEmptySearchRef.current = true;
      setSearch("");
    }
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

  const filterControls = (
    <div className="product-filter-grid grid gap-1.5 rounded-lg border border-[var(--brand-border)] bg-[color-mix(in_oklab,var(--surface)_72%,transparent)] p-1.5 lg:grid-cols-4">
      <div className="space-y-0.5">
        <span className="text-[9px] font-black uppercase tracking-[0.1em] text-[var(--muted-foreground)]">Sıralama</span>
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

      <div className="space-y-0.5">
        <span className="text-[9px] font-black uppercase tracking-[0.1em] text-[var(--muted-foreground)]">Marka</span>
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
        <div key={filter.key} className="space-y-0.5">
          <span className="text-[9px] font-black uppercase tracking-[0.1em] text-[var(--muted-foreground)]">{filter.label}</span>
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
  );

  return (
    <div className="admin-catalog-page min-w-0 space-y-2">
      <Card className="admin-catalog-list dashboard-panel-card min-h-[560px]">
        <CardHeader className="space-y-2 pb-2">
          <div className="product-search-actions grid gap-2 lg:grid-cols-[minmax(260px,1fr)_120px_112px_148px]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-[var(--muted-foreground)]" />
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
                className="admin-dashboard-input h-10 rounded-lg pl-10 text-sm font-semibold"
              />
            </div>

            <Button
              type="button"
              className="product-search-button h-10 w-full rounded-lg border border-[#3f8f54] bg-[#2f7f56] px-4 text-sm font-black text-white shadow-[0_12px_22px_-20px_rgba(47,127,86,0.9)] hover:bg-[#276d49] hover:text-white"
              onClick={handleSubmitSearch}
            >
              <Search className="h-4 w-4" />
              Ara
            </Button>

            <Button
              type="button"
              variant="outline"
              className="product-clear-button h-10 w-full rounded-lg border-[#ef4444] bg-[#dc2626] px-4 text-sm font-black text-white shadow-[0_12px_22px_-20px_rgba(220,38,38,0.95)] hover:border-[#dc2626] hover:bg-[#b91c1c] hover:text-white disabled:border-[#dc2626] disabled:bg-[#b91c1c] disabled:text-white disabled:opacity-70"
              disabled={!search && !normalizedSearch && !hasMetaFilters && !showAllProducts && sort === "recommended"}
              onClick={handleResetFilters}
            >
              <X className="h-4 w-4" />
              Sil
            </Button>

            <Button
              variant={showAllProducts ? "default" : "outline"}
              onClick={() => {
                setShowAllProducts((current) => !current);
              }}
              className={cn(
                "product-show-all-toggle h-10 w-full rounded-lg text-sm font-extrabold",
                showAllProducts ? "admin-primary-action" : "admin-dashboard-ghost"
              )}
            >
              {showAllProducts ? "Sadece E Göster" : "E + H Göster"}
            </Button>
          </div>

          <div className="product-filter-desktop hidden lg:block">{filterControls}</div>
          <details className="product-filter-mobile rounded-lg border border-[var(--brand-border)] bg-[var(--surface)] lg:hidden" open={hasMetaFilters}>
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-black uppercase tracking-[0.08em] text-[var(--brand-primary-strong)] [&::-webkit-details-marker]:hidden">
              <SlidersHorizontal className="h-4 w-4 text-[var(--brand-primary)]" />
              Filtreler
              <span className="ml-auto rounded-full bg-[var(--brand-primary-soft)] px-2 py-1 text-[10px] text-[var(--brand-primary-strong)]">
                {hasMetaFilters ? "Aktif" : "Kapalı"}
              </span>
            </summary>
            <div className="border-t border-[var(--brand-border)] p-2">{filterControls}</div>
          </details>
        </CardHeader>

        <CardContent>
          {!selectedCustomer && !canUseDepotTransferCart ? (
            <p className="mb-3 rounded-xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm font-bold text-amber-100">
              Sepete ürün eklemek için önce müşteri seçin.
            </p>
          ) : null}

          {shouldFetchProducts && productsQuery.isLoading ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 rounded-lg border border-[var(--brand-border)] bg-[var(--surface-soft)] px-3 py-2 text-xs font-black text-[var(--foreground)]">
                <Loader2 className="h-4 w-4 animate-spin text-[var(--brand-primary)]" />
                Ürünler aranıyor...
              </div>
              {Array.from({ length: 8 }).map((_, index) => (
                <div
                  key={`product-skeleton-${index}`}
                  className={cn(PRODUCT_TABLE_GRID, "rounded-md bg-[var(--surface)] px-2 py-2")}
                  style={tableGridStyle}
                >
                  <Skeleton className="h-8 w-8 rounded-lg" />
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
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
                className="product-results-scroll max-h-none min-h-[340px] max-w-full overflow-x-auto overflow-y-visible rounded-[18px] bg-[var(--surface)] px-1.5 pb-2 pt-2 shadow-[0_24px_42px_-36px_rgba(0,0,0,0.7)] [scrollbar-color:#8aa0b0_#122022] [scrollbar-width:thin] lg:max-h-[calc(100dvh-230px)] lg:overflow-auto lg:overscroll-contain"
              >
                <div className="rounded-xl border border-[var(--brand-border)] bg-[var(--surface-soft)]">
                  <div
                    role="row"
                    className={cn(
                      PRODUCT_TABLE_GRID,
                      "product-results-table-head z-30 border border-emerald-300/35 bg-[radial-gradient(circle_at_8%_16%,rgba(34,197,94,0.42)_0%,transparent_34%),linear-gradient(135deg,rgba(15,118,54,0.96)_0%,rgba(3,48,31,0.98)_100%)] text-[9px] font-black uppercase tracking-[0.08em] text-emerald-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),inset_0_-1px_0_rgba(34,197,94,0.12),0_16px_34px_-30px_rgba(34,197,94,0.84)] lg:sticky lg:top-0"
                    )}
                    style={tableGridStyle}
                  >
                    <span role="columnheader" className="flex items-center justify-center px-1.5 py-2 text-center drop-shadow-[0_1px_1px_rgba(0,0,0,0.44)]">Resim</span>
                    <span role="columnheader" className="flex items-center border-l border-white/10 px-1.5 py-2 drop-shadow-[0_1px_1px_rgba(0,0,0,0.44)]">Stok Kodu</span>
                    <span role="columnheader" className="flex items-center border-l border-white/10 px-1.5 py-2 drop-shadow-[0_1px_1px_rgba(0,0,0,0.44)]">Marka</span>
                    <span role="columnheader" className="flex items-center border-l border-white/10 px-1.5 py-2 drop-shadow-[0_1px_1px_rgba(0,0,0,0.44)]">Ürün Adı</span>
                    <span role="columnheader" className="flex items-center border-l border-white/10 px-1.5 py-2 drop-shadow-[0_1px_1px_rgba(0,0,0,0.44)]">Ürün Tipi</span>
                    <span role="columnheader" className="flex items-center justify-center border-l border-white/10 px-1 py-2 text-center drop-shadow-[0_1px_1px_rgba(0,0,0,0.44)]">Koli</span>
                    <span role="columnheader" className="flex items-center justify-center border-l border-white/10 px-1.5 py-2 text-center drop-shadow-[0_1px_1px_rgba(0,0,0,0.44)]">Liste Fiyatı</span>
                    <span
                      role="columnheader"
                      className="grid items-stretch border-l border-white/10 drop-shadow-[0_1px_1px_rgba(0,0,0,0.44)]"
                      style={{ gridTemplateColumns: `repeat(${Math.max(visibleStockColumns.length, 1)}, minmax(0, 1fr))` }}
                    >
                      {!canViewSearchStock ? (
                        <span className="flex min-w-0 items-center justify-center whitespace-nowrap px-1 py-2 text-center text-[7px] tracking-[0.02em]">
                          Stok Durumu
                        </span>
                      ) : visibleStockColumns.length > 0 ? visibleStockColumns.map((branch) => (
                        <span
                          key={`stock-head-${branch.key}`}
                          className="product-stock-header-cell flex min-w-0 items-center justify-center whitespace-nowrap border-l border-white/10 px-1 py-2 text-center text-[7px] tracking-[0.02em] first:border-l-0"
                        >
                          {productBranchStockHeaderLabel(branch)}
                        </span>
                      )) : (
                        <span className="flex min-w-0 items-center justify-center whitespace-nowrap px-1 py-2 text-center text-[7px] tracking-[0.02em]">
                          Stok
                        </span>
                      )}
                    </span>
	                    <span role="columnheader" className="product-info-header-cell right-16 z-30 flex items-center justify-center border-l border-white/10 bg-[linear-gradient(135deg,rgba(10,96,54,0.98)_0%,rgba(3,48,31,1)_100%)] px-1.5 py-2 text-center drop-shadow-[0_1px_1px_rgba(0,0,0,0.44)] shadow-[-10px_0_18px_-20px_rgba(0,0,0,0.95)] lg:sticky">Bilgi</span>
		                    <span role="columnheader" className="product-cart-header-cell right-0 z-30 flex items-center justify-center border-l border-white/10 bg-[linear-gradient(135deg,rgba(10,96,54,0.98)_0%,rgba(3,48,31,1)_100%)] px-1.5 py-2 text-center drop-shadow-[0_1px_1px_rgba(0,0,0,0.44)] shadow-[-14px_0_22px_-22px_rgba(0,0,0,0.95)] lg:sticky">Sepet</span>
                  </div>
                </div>
                <div className={cn("product-results-body rounded-xl border border-t-0 border-[var(--brand-border)]", compact ? "min-h-[360px]" : "min-h-[520px]")}>
                  {products.map((product) => {
                    const qty = qtyByProductId.get(product.id) ?? 0;
                    const campaignNames = canViewCampaigns
                      ? (product.campaigns ?? []).map((campaign) => campaign.name)
                      : [];

                    return (
                      <ProductRow
                        key={product.id}
                        product={product}
                        qty={qty}
                        cartDistinctLineCount={cartDistinctLineCount}
                        mutating={mutating}
                        canAdd={(Boolean(selectedCustomer) || canUseDepotTransferCart) && canUseSearchCart}
                        canViewPrices={canViewSearchPrices}
                        pricesIncludeVat={false}
                        canViewStock={canViewSearchStock}
                        visibleStockColumns={visibleStockColumns}
                        showRetailPriceHint={showPriceCardsOnSearch}
                        tableGridStyle={tableGridStyle}
                        campaignNames={campaignNames}
                        onOpenCartModal={handleOpenCartModal}
	                        onPreviewImage={setImagePreview}
	                        onShowCompetitorCodes={setCompetitorCodesPreview}
	                        onShowOemCode={setOemCodePreview}
	                        onShowVehicleFitments={setVehicleFitmentsPreview}
	                        onShowPreviousPurchase={handleShowPreviousPurchase}
                      />
                    );
                  })}
                  <div
                    ref={infiniteScrollMarkerRef}
                    className={cn(
                      PRODUCT_TABLE_GRID,
                      "product-results-status-row min-h-16 border-b border-l-4 border-[var(--brand-border)] border-l-transparent bg-[var(--surface)]"
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
        <DialogContent className="product-cart-dialog z-[60] flex max-h-[calc(100dvh-12px)] max-w-[min(760px,calc(100vw-16px))] flex-col overflow-hidden rounded-[20px] border border-emerald-300/20 bg-[radial-gradient(circle_at_50%_0%,rgba(213,205,42,0.1)_0%,transparent_34%),linear-gradient(145deg,rgba(12,24,32,0.98)_0%,rgba(7,15,23,0.98)_55%,rgba(10,30,23,0.98)_100%)] p-0 text-slate-100 shadow-[0_34px_90px_-46px_rgba(0,0,0,0.9)] sm:max-h-[calc(100dvh-32px)] sm:rounded-[26px]">
	          <DialogHeader className="mb-0 shrink-0 border-b border-white/10 px-3 py-3 sm:px-5 sm:py-4">
	            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
	              <div className="min-w-0">
	                <DialogTitle className="flex items-center gap-2 text-lg font-black text-white sm:gap-3 sm:text-2xl">
	                  <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-300/25 bg-emerald-300/10 text-emerald-300 sm:h-11 sm:w-11 sm:rounded-2xl">
	                    <ShoppingCart className="h-5 w-5" strokeWidth={3} />
	                  </span>
	                  Sepete Ekle
	                </DialogTitle>
	                <DialogDescription className="sr-only">
	                  Ürün miktarını seçin
	                </DialogDescription>
	                {cartModalProduct ? (
	                  <div className="product-cart-modal-heading mt-2 flex w-full max-w-full min-w-0 flex-wrap items-center gap-2 overflow-hidden rounded-[14px] border border-white/10 bg-white/[0.035] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] sm:mt-3 sm:gap-2.5 sm:rounded-[20px] sm:px-4 sm:py-2.5">
	                    <p className="shrink-0 whitespace-nowrap text-lg font-black leading-none tracking-[0.02em] text-[#f8f3a1] drop-shadow-[0_6px_14px_rgba(0,0,0,0.42)] sm:text-xl">
	                      {cartModalProduct.sku}
	                    </p>
	                    <span className="max-w-[9rem] shrink-0 truncate rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1 text-xs font-black uppercase tracking-[0.08em] text-emerald-100">
	                      {cartModalProduct.brand.name ?? "Marka Yok"}
	                    </span>
	                    <span className="product-cart-modal-name min-w-[12rem] flex-1 truncate text-sm font-extrabold leading-tight text-slate-300 sm:text-[15px]" title={cartModalProduct.name}>
	                      {cartModalProduct.name}
	                    </span>
	                  </div>
	                ) : null}
	              </div>
	              <div className="flex flex-col gap-2 md:items-end">
	                <div className="flex flex-wrap items-center gap-2 md:justify-end">
	                  <Button
	                    type="button"
	                    variant="outline"
	                    className="h-10 rounded-xl border-[#d8cf42]/25 bg-[#d8cf42]/10 px-3 text-xs font-black uppercase tracking-[0.08em] text-[#f8f3a1] hover:bg-[#d8cf42]/16 hover:text-white"
	                    onClick={() => {
	                      setCartCalculatorOpen((open) => {
	                        const nextOpen = !open;
	                        if (nextOpen) {
	                          window.setTimeout(() => {
	                            document
	                              .getElementById("product-cart-calculator")
	                              ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
	                          }, 0);
	                        }
	                        return nextOpen;
	                      });
	                    }}
	                  >
	                    <Calculator className="h-4 w-4" />
	                    Hesap Makinesi
	                  </Button>
	                  {!isBatumPriceScope ? (
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
	                  ) : null}
	                </div>
	              </div>
	            </div>
	          </DialogHeader>

          {cartModalProduct ? (
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 sm:px-5 sm:py-4">
              <div
                className={cn(
                  "grid gap-3",
                  cartModalShowBaseSalesPrice && cartModalHasCampaignOffers && "lg:grid-cols-[190px_minmax(0,1fr)]",
                  cartModalShowBaseSalesPrice && !cartModalHasCampaignOffers && "place-items-center"
                )}
              >
                {cartModalShowBaseSalesPrice ? (
                <div
                  className={cn(
                    "grid content-center rounded-2xl border border-[#d8cf42]/25 bg-[#d8cf42]/[0.10] p-3 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
                    !cartModalHasCampaignOffers && "min-h-[132px] w-full p-5 sm:p-6"
                  )}
                >
	                  <span className="block text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
	                    Satış Fiyatı
	                  </span>
	                  <strong className={cn("mt-1 block font-black text-[#f8f3a1]", cartModalHasCampaignOffers ? "text-2xl" : "text-3xl sm:text-4xl")}>
	                    {stripPriceCurrency(formatProductModalPrice(cartModalProduct, cartModalProduct.net_price, cartModalPricesIncludeVat, isBatumPriceScope ? "GEL" : undefined))}{isBatumPriceScope ? " GEL" : ""}
	                  </strong>
	                </div>
                ) : null}
                {cartModalHasCampaignOffers ? (
                <div className="flex flex-wrap gap-2">
                  {cartModalProduct.special_discounted_price ? (
                    <div className="min-w-[180px] flex-1 rounded-2xl border border-emerald-300/25 bg-emerald-400/[0.10] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                      <span className="block text-[10px] font-black uppercase tracking-[0.12em] text-emerald-100/70">
                        Özel İskonto
                      </span>
                      <strong className="mt-1 block text-xl font-black text-emerald-100">
                        {stripPriceCurrency(formatProductModalPrice(cartModalProduct, cartModalProduct.special_discounted_price, cartModalPricesIncludeVat, isBatumPriceScope ? "GEL" : undefined))}{isBatumPriceScope ? " GEL" : ""}
                      </strong>
                    </div>
                  ) : null}
                  {cartModalCampaignTiers.map(({ campaign, tier }) => {
                      const tierPrice = formatCampaignTierPrice(cartModalProduct, tier, cartModalPricesIncludeVat, isBatumPriceScope ? "GEL" : undefined);
                      const active =
                        cartModalApplicableCampaign?.campaign.key === campaign.key &&
                        cartModalApplicableCampaign.tier.min_quantity === tier.min_quantity;

                      return (
                        <div
                          key={`${campaign.key}-${tier.min_quantity}-${tier.unit_price}`}
                          className={cn(
                            "grid min-w-[180px] flex-1 content-center rounded-2xl border border-[#bda800] bg-[#ffff00] p-3 text-center text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)]",
                            active && "ring-2 ring-emerald-600 ring-offset-2 ring-offset-[#06130f]"
                          )}
                        >
                          <span className="block text-[13px] font-black uppercase tracking-[0.08em] text-slate-800">
                            {campaignTierLabel(tier)}
                          </span>
                          <strong className="mt-1.5 block text-xl font-black leading-none text-slate-950">
                            {stripPriceCurrency(tierPrice.unit)}{isBatumPriceScope ? " GEL" : ""}
                          </strong>
                          <span className="mt-2 block text-[10px] font-black uppercase tracking-[0.08em] text-slate-700">
                            {isBatumPriceScope ? "Net fiyat" : cartModalPricesIncludeVat ? "KDV Dahil" : "KDV Hariç"}
                          </span>
                        </div>
                      );
                    })}
                </div>
                ) : null}
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

	              <div className="mt-3 rounded-[16px] border border-emerald-300/15 bg-emerald-300/[0.045] p-2.5 sm:mt-4 sm:rounded-[18px] sm:p-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[auto_minmax(9rem,12rem)_minmax(8rem,9rem)_auto] sm:items-center">
                  <label className="shrink-0 text-[12px] font-black uppercase tracking-[0.16em] text-slate-400">
                    Miktar
                  </label>
                  <div className="w-full">
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
                    className="h-12 rounded-2xl border-emerald-300/25 bg-slate-950/55 px-4 text-left text-xl font-black text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)] [appearance:textfield] focus-visible:ring-2 focus-visible:ring-emerald-300/55 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  </div>
                  <div className="product-cart-modal-stock-stack">
                    <span>
                      <em>Stok</em>
                      <strong>{cartModalProduct.available_total.toLocaleString("tr-TR")}</strong>
                    </span>
                    <span>
                      <em>Koli</em>
                      <strong>{formatPackageQuantity(cartModalProduct.package_quantity)}</strong>
                    </span>
                    <span>
                      <em>Raf</em>
                      <strong>{productShelfAddress(cartModalProduct)}</strong>
                    </span>
                  </div>
                  <div className="flex flex-row flex-nowrap gap-2 sm:justify-self-end sm:gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11 rounded-xl border-white/10 bg-white/[0.04] px-4 text-sm font-extrabold text-slate-200 hover:bg-white/[0.08] hover:text-white sm:h-12 sm:rounded-2xl sm:px-6"
                      onClick={() => setCartModalProduct(null)}
                    >
                      Vazgeç
                    </Button>
                    <Button
                      type="button"
                      className="h-11 rounded-xl border border-red-200/45 bg-gradient-to-b from-[#ff4a43] via-[#d71920] to-[#8d070d] px-4 text-sm font-black text-white shadow-[0_3px_0_#8a070d,0_14px_24px_-18px_rgba(255,35,35,0.92),inset_0_1px_0_rgba(255,255,255,0.48)] hover:from-[#ff625b] hover:via-[#e51f26] hover:to-[#9b080e] sm:h-12 sm:rounded-2xl sm:px-7 sm:text-base"
                      disabled={!cartModalCanSubmit}
                      onClick={handleConfirmCartQuantity}
                    >
                      {mutating ? <Loader2 className="h-5 w-5 animate-spin" /> : <ShoppingCart className="h-5 w-5" />}
                      {cartModalCurrentQty > 0 ? "Güncelle" : "Sepete Ekle"}
                    </Button>
                  </div>
                </div>
                {cartCalculatorOpen ? (
                  <div id="product-cart-calculator" className="mt-4 scroll-mt-3 rounded-[20px] border border-[#d8cf42]/20 bg-slate-950/55 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
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

        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(cartDuplicateConfirm)}
        onOpenChange={(open) => {
          if (!open) {
            setCartDuplicateConfirm(null);
          }
        }}
      >
        <DialogContent className="z-[80] max-w-[min(460px,calc(100vw-24px))] overflow-hidden rounded-[28px] border border-red-200/30 bg-[radial-gradient(circle_at_20%_0%,rgba(255,77,79,0.22)_0%,transparent_34%),linear-gradient(145deg,rgba(12,24,32,0.98)_0%,rgba(7,15,23,0.98)_58%,rgba(42,8,12,0.98)_100%)] p-0 text-slate-100 shadow-[0_34px_90px_-42px_rgba(0,0,0,0.95)]">
          <DialogHeader className="border-b border-white/10 px-5 py-4">
            <div className="flex items-start gap-3">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-red-200/30 bg-red-500/15 text-red-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">
                <ShoppingCart className="h-6 w-6" />
              </span>
              <div className="min-w-0">
                <DialogTitle className="text-2xl font-black tracking-[-0.03em] text-white">
                  Bu ürün zaten sepette
                </DialogTitle>
                <DialogDescription className="mt-1 text-sm font-semibold leading-5 text-slate-300">
                  Aynı ürün mevcut sepette var. Miktarı yeni değerle güncelleyelim mi?
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {cartDuplicateConfirm ? (
            <div className="px-5 py-4">
              <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                <p className="truncate text-xl font-black text-[#f8f3a1]" title={cartDuplicateConfirm.product.sku}>
                  {cartDuplicateConfirm.product.sku}
                </p>
                <p className="mt-1 line-clamp-2 text-sm font-extrabold text-slate-200" title={cartDuplicateConfirm.product.name}>
                  {cartDuplicateConfirm.product.name}
                </p>
                <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1.5 text-sm font-black text-emerald-100">
                  Yeni miktar
                  <strong className="text-base text-emerald-300">
                    {cartDuplicateConfirm.quantity.toLocaleString("tr-TR")}
                  </strong>
                </div>
              </div>
            </div>
          ) : null}

          <DialogFooter className="grid gap-2 border-t border-white/10 px-5 py-4 sm:grid-cols-2">
            <Button
              type="button"
              variant="outline"
              className="h-12 rounded-2xl border-white/10 bg-white/[0.045] font-black text-slate-200 hover:bg-white/[0.08] hover:text-white"
              onClick={() => setCartDuplicateConfirm(null)}
            >
              Hayır
            </Button>
            <Button
              type="button"
              className="h-12 rounded-2xl border border-red-200/45 bg-gradient-to-b from-[#ff4a43] via-[#d71920] to-[#8d070d] font-black text-white shadow-[0_3px_0_#8a070d,0_16px_28px_-18px_rgba(255,35,35,0.92),inset_0_1px_0_rgba(255,255,255,0.48)] hover:from-[#ff625b] hover:via-[#e51f26] hover:to-[#9b080e]"
              onClick={() => {
                if (!cartDuplicateConfirm) {
                  return;
                }

                handleSetQuantity(
                  cartDuplicateConfirm.product,
                  cartDuplicateConfirm.quantity,
                  cartDuplicateConfirm.campaignKey,
                  "updated"
                );
                setCartDuplicateConfirm(null);
                prepareSearchInputForNextProduct();
              }}
            >
              Evet, Güncelle
            </Button>
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
        <DialogContent className="max-w-5xl border-emerald-300/20 bg-[radial-gradient(circle_at_50%_0%,rgba(52,211,153,0.12)_0%,transparent_34%),linear-gradient(145deg,rgba(12,24,32,0.98)_0%,rgba(7,15,23,0.98)_58%,rgba(10,30,23,0.98)_100%)] text-slate-100">
          <DialogHeader>
            <DialogTitle className="text-2xl font-black text-white">Önceki Alımlar</DialogTitle>
            <DialogDescription className="font-bold text-slate-400">
              {previousPurchasePreview
                ? `${previousPurchasePreview.sku} - ${previousPurchasePreview.name}`
                : "Ürün önceki alım bilgisi"}
            </DialogDescription>
          </DialogHeader>

          {previousPurchasePreview?.loading ? (
            <div className="flex min-h-64 items-center justify-center rounded-2xl border border-white/10 bg-black/15 text-sm font-black text-slate-200">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Eryaz önceki alımları yükleniyor
            </div>
          ) : previousPurchasePreview?.history && previousPurchasePreview.history.items.length > 0 ? (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
                {[
                  { label: "Son Alım", value: formatProductDate(previousPurchasePreview.history.summary.last_purchase_date) },
                  {
                    label: "Son Miktar",
                    value: previousPurchasePreview.history.summary.last_quantity !== null && previousPurchasePreview.history.summary.last_quantity !== undefined
                      ? `${Number(previousPurchasePreview.history.summary.last_quantity).toLocaleString("tr-TR")} ${previousPurchasePreview.history.summary.last_unit ?? "AD"}`
                      : "-",
                  },
                  {
                    label: "Son Net Fiyat",
                    value: previousPurchasePreview.history.summary.last_net_price !== null && previousPurchasePreview.history.summary.last_net_price !== undefined
                      ? formatProductAmount(Number(previousPurchasePreview.history.summary.last_net_price), isBatumPriceScope ? "GEL" : "TRY")
                      : "-",
                  },
                  {
                    label: "Toplam Alım",
                    value: `${Number(previousPurchasePreview.history.summary.total_quantity ?? 0).toLocaleString("tr-TR")} ${previousPurchasePreview.history.summary.last_unit ?? "AD"}`,
                  },
                  { label: "Toplam Net", value: formatProductAmount(Number(previousPurchasePreview.history.summary.total_net_amount ?? 0), isBatumPriceScope ? "GEL" : "TRY") },
                  { label: "Belge Sayısı", value: Number(previousPurchasePreview.history.summary.purchase_count ?? 0).toLocaleString("tr-TR") },
                ].map((item) => (
                  <div key={item.label} className="rounded-2xl border border-white/10 bg-white/[0.055] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
                    <span className="block text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">{item.label}</span>
                    <strong className="mt-2 block min-h-7 break-words text-base font-black text-white">{item.value}</strong>
                  </div>
                ))}
              </div>

              <div className="max-h-[55vh] overflow-y-auto rounded-2xl border border-emerald-300/18 bg-emerald-300/[0.06]">
                <div className="hidden grid-cols-[92px_1fr_82px_78px_92px_92px_130px_108px] gap-2 border-b border-white/10 bg-black/20 px-3 py-3 text-[10px] font-black uppercase tracking-[0.08em] text-emerald-100/75 lg:grid">
                  <span>Tarih</span>
                  <span>Belge / Açıklama</span>
                  <span className="text-right">Miktar</span>
                  <span>Birim</span>
                  <span className="text-right">Birim</span>
                  <span className="text-right">Net</span>
                  <span>İskonto</span>
                  <span className="text-right">Net Tutar</span>
                </div>
                <div className="divide-y divide-white/10">
                  {previousPurchasePreview.history.items.map((item: ProductPreviousPurchaseHistoryItem, index: number) => (
                    <div
                      key={`${item.document_no ?? "doc"}-${item.date ?? "date"}-${index}`}
                      className="grid gap-2 px-3 py-3 text-sm lg:grid-cols-[92px_1fr_82px_78px_92px_92px_130px_108px] lg:items-center"
                    >
                      <span className="font-black text-white">{formatProductDate(item.date)}</span>
                      <span className="min-w-0">
                        <span className="block truncate font-black text-slate-100">{item.document_no || "-"}</span>
                        <span className="mt-0.5 block truncate text-xs font-semibold text-slate-400">{item.description || "-"}</span>
                      </span>
                      <span className="flex justify-between gap-3 lg:block lg:text-right">
                        <span className="text-[10px] font-black uppercase text-slate-500 lg:hidden">Miktar</span>
                        <strong>{Number(item.quantity ?? 0).toLocaleString("tr-TR")}</strong>
                      </span>
                      <span className="flex justify-between gap-3 lg:block">
                        <span className="text-[10px] font-black uppercase text-slate-500 lg:hidden">Birim</span>
                        <strong>{item.unit || "AD"}</strong>
                      </span>
                      <span className="flex justify-between gap-3 lg:block lg:text-right">
                        <span className="text-[10px] font-black uppercase text-slate-500 lg:hidden">Birim Fiyat</span>
                        <strong>{formatProductAmount(Number(item.unit_price ?? 0), isBatumPriceScope ? "GEL" : "TRY")}</strong>
                      </span>
                      <span className="flex justify-between gap-3 lg:block lg:text-right">
                        <span className="text-[10px] font-black uppercase text-slate-500 lg:hidden">Net Fiyat</span>
                        <strong>{formatProductAmount(Number(item.net_price ?? 0), isBatumPriceScope ? "GEL" : "TRY")}</strong>
                      </span>
                      <span className="flex justify-between gap-3 lg:block">
                        <span className="text-[10px] font-black uppercase text-slate-500 lg:hidden">İskonto</span>
                        <strong>{formatDiscountList(item.discounts)}</strong>
                      </span>
                      <span className="flex justify-between gap-3 lg:block lg:text-right">
                        <span className="text-[10px] font-black uppercase text-slate-500 lg:hidden">Net Tutar</span>
                        <strong>{formatProductAmount(Number(item.net_total ?? 0), isBatumPriceScope ? "GEL" : "TRY")}</strong>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-[var(--brand-border)] bg-[var(--surface-soft)] p-6 text-center text-sm font-semibold text-[var(--muted-foreground)]">
              Bu müşterinin bu ürüne ait önceki alımı bulunamadı.
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
