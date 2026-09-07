"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Banknote,
  Bus,
  CheckCircle2,
  CreditCard,
  Download,
  FileSpreadsheet,
  Landmark,
  Loader2,
  Minus,
  PackageCheck,
  PencilLine,
  Plus,
  ShoppingCart,
  Trash2,
  Truck,
  Upload,
  Warehouse,
  WalletCards,
} from "lucide-react";
import { toast } from "sonner";

import { useSession } from "@/components/auth/session-provider";
import { useCart } from "@/components/cart/cart-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ApiClientError, bulkUpsertCartItems, listFinanceDefinitions, type CartWarehouseOption } from "@/lib/api";

const PAYMENT_METHODS = [
  {
    key: "current_account",
    title: "Cari Hesap",
    label: "Ödenecek Tutar",
    badge: null,
    multiplier: 1,
    icon: WalletCards,
    tone: "green",
    buttonText: "Cari Hesaba Yaz",
  },
  {
    key: "cash_transfer_single",
    title: "Havale / EFT / Nakit / Tek Çekim",
    label: "Ödenecek Tutar",
    badge: null,
    multiplier: 1,
    icon: Banknote,
    tone: "teal",
    buttonText: "Gönder",
  },
] as const;

const COMBINED_PAYMENT_OPTIONS = [
  {
    key: "bank_transfer",
    label: "Havale / EFT",
    badge: "%10 iskonto",
    multiplier: 0.9,
    icon: Landmark,
    requiresReference: true,
  },
  {
    key: "cash",
    label: "Nakit",
    badge: "%10 iskonto",
    multiplier: 0.9,
    icon: Banknote,
  },
  {
    key: "single_payment",
    label: "Tek Çekim",
    badge: "%10 iskonto",
    multiplier: 0.9,
    icon: CreditCard,
  },
] as const;

const SHIPPING_METHODS = [
  { value: "depo_teslim", label: "Depoya Sevk", icon: PackageCheck, tone: "violet", wide: true },
  { value: "otobus", label: "Otobüs", icon: Bus, tone: "sky", wide: false },
  { value: "kargo", label: "Kargo", icon: Truck, tone: "emerald", wide: false },
] as const;

const SHIPPING_FEE_THRESHOLD = 5000;
const SHIPPING_FEE_AMOUNT = 500;

const BANK_TRANSFER_ACCOUNT = {
  company: "GÜÇSA FİLTRECİM GRUP OTOMOTİV A.Ş.",
  bank: "Ziraat Bankası",
  branch: "0112",
  accountNo: "97607896",
  iban: "TR410001002772976078965006",
} as const;

type PaymentMethodKey = (typeof PAYMENT_METHODS)[number]["key"];
type CombinedPaymentKey = (typeof COMBINED_PAYMENT_OPTIONS)[number]["key"];
type VatSummaryMode = "included" | "excluded" | "detailed";
type BulkCartUploadRow = {
  product_code: string;
  quantity: number;
};

const CHECKOUT_SUMMARY_MODES: Record<VatSummaryMode, { code: string; label: string }> = {
  detailed: { code: "1-F", label: "1 - F" },
  excluded: { code: "2-0", label: "2 - 0" },
  included: { code: "3-B", label: "3 - B" },
};

const CHECKOUT_SUMMARY_MODE_FEATURES: Record<VatSummaryMode, string> = {
  detailed: "cart.sale_type.detailed",
  excluded: "cart.sale_type.excluded",
  included: "cart.sale_type.included",
};

const CHECKOUT_SUMMARY_MODE_ORDER: VatSummaryMode[] = ["detailed", "excluded", "included"];
const LOGO_E_INVOICE_DETAILED_ONLY_MESSAGE = "Logo e-Fatura kullanıcısı carilerde sadece 1-F fatura kesilebilir.";

function isLogoEInvoiceDetailedOnlyError(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) {
    return false;
  }

  const checkoutSummaryErrors = error.payload?.errors?.checkout_summary_mode ?? [];

  return error.message.includes("sadece 1-F") || checkoutSummaryErrors.some((message) => message.includes("sadece 1-F"));
}

function warehouseOptionKey(option: CartWarehouseOption): string {
  return option.warehouse_code ?? option.warehouse_name;
}

function normalizeWarehouseIdentity(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLocaleUpperCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "");
}

function parseShippingRuleAmount(value: unknown): number | null {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const amount = Number(normalized);

  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function resolveOwnWarehouseCode(user: unknown, selectedCustomer: unknown): string | null {
  const userRecord = (user ?? {}) as Record<string, unknown>;
  const customerRecord = (selectedCustomer ?? {}) as Record<string, unknown>;
  const identity = normalizeWarehouseIdentity([
    userRecord.username,
    userRecord.email,
    userRecord.name,
    userRecord.branch_code,
    userRecord.branch_name,
    customerRecord.branch_code,
    customerRecord.branch_name,
    customerRecord.region_code,
    customerRecord.region_name,
  ].filter(Boolean).join(" "));

  if (identity.includes("TRABZON")) return "2";
  if (identity.includes("SAMSUN")) return "3";
  if (identity.includes("BATUM")) return "4";
  if (identity.includes("POINT") || identity.includes("HIZLISATIS")) return "0";
  if (identity.includes("ERZURUM") || identity.includes("ERZDEPO") || identity.includes("AHMETARAC")) return "1";

  return null;
}

function isWarehouseOrderCustomer(selectedCustomer: unknown): boolean {
  const customerRecord = (selectedCustomer ?? {}) as Record<string, unknown>;
  const identity = normalizeWarehouseIdentity([
    customerRecord.code,
    customerRecord.title,
    customerRecord.name,
    customerRecord.branch_code,
    customerRecord.branch_name,
    customerRecord.region_code,
    customerRecord.region_name,
  ].filter(Boolean).join(" "));

  return [
    "ERZURUMDEPOSIPARIS",
    "ERZURUMDEPO",
    "TRABZONDEPOSIPARIS",
    "SAMSUNDEPOSIPARIS",
    "BATUMDEPOSIPARIS",
    "ERZURUMPOINTSIPARIS",
  ].some((needle) => identity.includes(needle));
}

function toAmount(value: string): number {
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatTryAmount(value: number, currency = "TRY"): string {
  const symbol = currency === "TRY" ? "TL" : currency;

  return `${value.toLocaleString("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${symbol}`;
}

function formatStock(value: number): string {
  return value.toLocaleString("tr-TR");
}

function downloadBulkCartTemplate() {
  const rows = [
    ["Ürün Kodu", "Miktar"],
    ["3A826/1", "10"],
    ["3A1313/S", "5"],
    ["EH6655", "20"],
  ];
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><table>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("")}</table></body></html>`;
  const blob = new Blob([html], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "powersa-toplu-sepet-ornek.xls";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function stripHtml(value: string): string {
  return value
    .replace(/<\s*\/\s*(td|th)\s*>/gi, "\t")
    .replace(/<\s*\/\s*tr\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function parseDelimitedLine(line: string): string[] {
  const delimiter = line.includes("\t") ? "\t" : line.includes(";") ? ";" : ",";
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (char === delimiter && !quoted) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function parseBulkCartText(content: string): BulkCartUploadRow[] {
  const text = stripHtml(content).replace(/^\uFEFF/, "");
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines
    .map(parseDelimitedLine)
    .filter((cells) => cells.length >= 2)
    .filter((cells, index) => {
      if (index > 0) return true;
      const first = cells[0]?.toLocaleLowerCase("tr-TR") ?? "";
      const second = cells[1]?.toLocaleLowerCase("tr-TR") ?? "";
      return !(first.includes("ürün") || first.includes("urun") || second.includes("miktar"));
    })
    .map((cells) => ({
      product_code: String(cells[0] ?? "").trim(),
      quantity: Math.max(0, Math.floor(Number(String(cells[1] ?? "").replace(",", ".")))),
    }))
    .filter((row) => row.product_code !== "" && row.quantity > 0);
}

function includesBatum(value?: string | number | null): boolean {
  return String(value ?? "").trim().toLocaleUpperCase("tr-TR").includes("BATUM");
}

function isBatumCustomerIdentity(selectedCustomer: unknown): boolean {
  const customerRecord = (selectedCustomer ?? {}) as Record<string, unknown>;
  const identity = [
    customerRecord.code,
    customerRecord.title,
    customerRecord.name,
    customerRecord.city,
    customerRecord.district,
    customerRecord.branch_code,
    customerRecord.branch_name,
    customerRecord.region_code,
    customerRecord.region_name,
    customerRecord.source_system,
    customerRecord.source_reference,
    (customerRecord.meta as Record<string, unknown> | null | undefined)?.city,
    (customerRecord.meta as Record<string, unknown> | null | undefined)?.district,
    (customerRecord.meta as Record<string, unknown> | null | undefined)?.warehouse_name,
  ];

  return identity.some((value) => includesBatum(typeof value === "number" ? value : value == null ? null : String(value)));
}

const TRANSFER_WAREHOUSE_ORDER = ["ERZURUMDEPO", "TRABZONDEPO", "SAMSUNDEPO", "BATUMDEPO"] as const;

function transferWarehouseRank(option: CartWarehouseOption): number {
  const identity = normalizeWarehouseIdentity([option.warehouse_name, option.warehouse_code].filter(Boolean).join(" "));

  const index = TRANSFER_WAREHOUSE_ORDER.findIndex((name) => identity.includes(name));

  return index === -1 ? 99 : index;
}

function StepTitle({ step, title, icon: Icon }: { step: number; title: string; icon?: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="flex items-center gap-4">
      <span className="flex h-9 w-9 items-center justify-center rounded-full border border-emerald-400/70 bg-emerald-500/15 text-sm font-black text-emerald-300 shadow-[0_0_0_4px_rgba(34,197,94,0.08)]">
        {step}
      </span>
      <div className="flex items-center gap-3">
        {Icon ? <Icon className="h-5 w-5 text-emerald-300" /> : null}
        <h2 className="text-xl font-black text-[var(--foreground)]">{title}</h2>
      </div>
    </div>
  );
}

export function CartPage() {
  const router = useRouter();
  const { selectedCustomer, user } = useSession();
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<PaymentMethodKey>("current_account");
  const [selectedCombinedPaymentMethod, setSelectedCombinedPaymentMethod] = useState<CombinedPaymentKey>("bank_transfer");
  const [selectedWarehouseKey, setSelectedWarehouseKey] = useState("");
  const [selectedShippingWarehouseKey, setSelectedShippingWarehouseKey] = useState("");
  const [depotTransferRequest, setDepotTransferRequest] = useState(false);
  const [quantityDrafts, setQuantityDrafts] = useState<Record<number, string>>({});
  const [vatSummaryMode, setVatSummaryMode] = useState<VatSummaryMode>("detailed");
  const [itemVatSummaryModes, setItemVatSummaryModes] = useState<Record<number, VatSummaryMode>>({});
  const [bulkUploading, setBulkUploading] = useState(false);
  const [bulkUploadResults, setBulkUploadResults] = useState<Array<{ product_code: string; quantity: number; status: string; message: string }>>([]);
  const [selectedProductIds, setSelectedProductIds] = useState<number[]>([]);
  const [deleteDialog, setDeleteDialog] = useState<"selected" | "all" | null>(null);
  const [shippingFeeConfirmOpen, setShippingFeeConfirmOpen] = useState(false);
  const [shippingFeeConfirmed, setShippingFeeConfirmed] = useState(false);
  const bulkUploadInputRef = useRef<HTMLInputElement | null>(null);
  const {
    cartData,
    loading,
    mutating,
    shippingMethod,
    effectiveWarehouseTransfer,
    orderNote,
    setShippingMethod,
    setOrderNote,
    upsertQuantity,
    removeItemByProduct,
    createOrderFromCart,
    refresh: refreshCart,
  } = useCart();
  const shippingRulesQuery = useQuery({
    queryKey: ["finance-definitions", "shipping_rule"],
    queryFn: () => listFinanceDefinitions("shipping_rule"),
    staleTime: 5 * 60 * 1000,
  });
  const shippingRuleAmounts = useMemo(() => {
    const map = new Map<string, number>();

    for (const row of shippingRulesQuery.data?.data ?? []) {
      const amount = parseShippingRuleAmount(row.logo_code ?? row.logo_name ?? row.name);

      if (amount !== null) {
        map.set(row.code.trim().toLocaleLowerCase("tr-TR"), amount);
      }
    }

    return {
      cargoLimit: map.get("cargo_limit") ?? SHIPPING_FEE_THRESHOLD,
      cargoFee: map.get("cargo_fee") ?? SHIPPING_FEE_AMOUNT,
      busFee: map.get("bus_fee") ?? SHIPPING_FEE_AMOUNT,
    };
  }, [shippingRulesQuery.data?.data]);

  useEffect(() => {
    setShippingMethod("depo_teslim");
  }, [setShippingMethod]);

  const items = useMemo(() => cartData?.items ?? [], [cartData?.items]);
  const selectableProductIds = useMemo(() => items.map((item) => item.product_id), [items]);
  const selectedProductIdSet = useMemo(() => new Set(selectedProductIds), [selectedProductIds]);
  const allItemsSelected = items.length > 0 && selectedProductIds.length === items.length;
  const featurePermissionSet = useMemo(() => new Set(user?.feature_permissions ?? []), [user?.feature_permissions]);
  const roleSlugSet = useMemo(() => new Set(user?.roles.map((role) => role.slug) ?? []), [user?.roles]);
  const isCustomerUser = useMemo(() => roleSlugSet.has("customer"), [roleSlugSet]);
  const selectedCustomerFeaturePermissionSet = useMemo(
    () => new Set(selectedCustomer?.customer_user_feature_permissions ?? []),
    [selectedCustomer?.customer_user_feature_permissions]
  );
  const selectedCustomerRequiresDetailedInvoice = Boolean(selectedCustomer?.e_invoice_user);
  const saleTypeFeaturePermissionSet = featurePermissionSet;
  const allowedVatSummaryModes = useMemo(() => {
    if (isCustomerUser) {
      return ["detailed"] satisfies VatSummaryMode[];
    }

    if (selectedCustomerRequiresDetailedInvoice) {
      return ["detailed"] satisfies VatSummaryMode[];
    }

    const customerUserModes = CHECKOUT_SUMMARY_MODE_ORDER.filter((mode) =>
      selectedCustomerFeaturePermissionSet.has(CHECKOUT_SUMMARY_MODE_FEATURES[mode])
    );

    if (customerUserModes.length > 0) {
      return customerUserModes;
    }

    if (roleSlugSet.has("salesperson")) {
      return ["detailed", "included"] satisfies VatSummaryMode[];
    }

    const explicitlyAllowedModes = CHECKOUT_SUMMARY_MODE_ORDER.filter((mode) =>
      saleTypeFeaturePermissionSet.has(CHECKOUT_SUMMARY_MODE_FEATURES[mode])
    );

    return explicitlyAllowedModes;
  }, [isCustomerUser, roleSlugSet, saleTypeFeaturePermissionSet, selectedCustomerFeaturePermissionSet, selectedCustomerRequiresDetailedInvoice]);
  const allowedVatSummaryModeSet = useMemo(() => new Set(allowedVatSummaryModes), [allowedVatSummaryModes]);
  const ownWarehouseCode = useMemo(() => resolveOwnWarehouseCode(user, selectedCustomer), [selectedCustomer, user]);
  const isWarehouseUser = useMemo(() => {
    const roleSlugs = Array.isArray(user?.roles) ? user.roles.map((role) => role.slug) : [];

    return roleSlugs.includes("warehouse");
  }, [user?.roles]);
  const warehouseOptions = useMemo(() => {
    const options = cartData?.warehouse_options ?? [];
    const filteredOptions = options
      .filter((option) => TRANSFER_WAREHOUSE_ORDER.some((name) => normalizeWarehouseIdentity(option.warehouse_name).includes(name)));

    const scopedOptions = ownWarehouseCode
      ? filteredOptions.filter((option) => String(option.warehouse_code ?? "").trim() !== ownWarehouseCode)
      : filteredOptions;

    return [...scopedOptions].sort((left, right) => transferWarehouseRank(left) - transferWarehouseRank(right));
  }, [cartData?.warehouse_options, ownWarehouseCode]);
  const cargoWarehouseOptions = useMemo(() => {
    const options = cartData?.warehouse_options ?? [];

    return options
      .filter((option) => !includesBatum(option.warehouse_name) && String(option.warehouse_code ?? "").trim() !== "4")
      .filter((option) => TRANSFER_WAREHOUSE_ORDER.some((name) => normalizeWarehouseIdentity(option.warehouse_name).includes(name)))
      .sort((left, right) => transferWarehouseRank(left) - transferWarehouseRank(right));
  }, [cartData?.warehouse_options]);

  useEffect(() => {
    setSelectedProductIds((current) => current.filter((productId) => selectableProductIds.includes(productId)));
    setItemVatSummaryModes((current) => {
      const allowed = new Set(selectableProductIds);
      const next = Object.fromEntries(
        Object.entries(current)
          .filter(([productId]) => allowed.has(Number(productId)))
          .map(([productId, mode]) => [productId, mode])
      ) as Record<number, VatSummaryMode>;

      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [selectableProductIds]);

  useEffect(() => {
    const fallbackMode = allowedVatSummaryModes[0] ?? "detailed";

    if (!allowedVatSummaryModeSet.has(vatSummaryMode)) {
      setVatSummaryMode(fallbackMode);
    }

    setItemVatSummaryModes((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([, mode]) => allowedVatSummaryModeSet.has(mode))
      ) as Record<number, VatSummaryMode>;

      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [allowedVatSummaryModeSet, allowedVatSummaryModes, vatSummaryMode]);

  const toggleProductSelection = (productId: number) => {
    setSelectedProductIds((current) => (
      current.includes(productId)
        ? current.filter((currentProductId) => currentProductId !== productId)
        : [...current, productId]
    ));
  };

  const toggleAllProductSelection = () => {
    setSelectedProductIds(allItemsSelected ? [] : selectableProductIds);
  };

  const effectiveVatSummaryModeForProduct = useCallback(
    (productId: number): VatSummaryMode => itemVatSummaryModes[productId] ?? vatSummaryMode,
    [itemVatSummaryModes, vatSummaryMode]
  );

  const handleVatSummaryModeSelect = useCallback((mode: VatSummaryMode) => {
    if (! allowedVatSummaryModeSet.has(mode)) {
      return;
    }

    if (selectedProductIds.length === 0) {
      setVatSummaryMode(mode);
      return;
    }

    setItemVatSummaryModes((current) => {
      const next = { ...current };
      for (const productId of selectedProductIds) {
        next[productId] = mode;
      }

      return next;
    });

    toast.success(`${selectedProductIds.length} ürün ${CHECKOUT_SUMMARY_MODES[mode].code} olarak ayarlandı.`);
  }, [allowedVatSummaryModeSet, selectedProductIds]);

  const confirmDeleteItems = async () => {
    const targetProductIds = deleteDialog === "all" ? selectableProductIds : selectedProductIds;

    if (targetProductIds.length === 0) {
      setDeleteDialog(null);
      return;
    }

    try {
      for (const productId of targetProductIds) {
        await removeItemByProduct(productId);
      }

      setSelectedProductIds([]);
      toast.success(deleteDialog === "all" ? "Sepetteki ürünler silindi." : "Seçilen ürünler silindi.");
    } finally {
      setDeleteDialog(null);
    }
  };
  const setQuantityDraft = (productId: number, nextValue: string) => {
    const numericValue = nextValue.replace(/\D/g, "");

    setQuantityDrafts((previous) => ({
      ...previous,
      [productId]: numericValue,
    }));
  };
  const clearQuantityDraft = (productId: number) => {
    setQuantityDrafts((previous) => {
      const nextDrafts = { ...previous };
      delete nextDrafts[productId];

      return nextDrafts;
    });
  };
  const commitQuantityDraft = (productId: number, currentQuantity: number) => {
    const draftValue = quantityDrafts[productId];

    if (draftValue === undefined) {
      return;
    }

    const parsedQuantity = Number.parseInt(draftValue, 10);

    if (!Number.isFinite(parsedQuantity) || parsedQuantity < 1) {
      clearQuantityDraft(productId);
      return;
    }

    clearQuantityDraft(productId);

    if (parsedQuantity !== currentQuantity) {
      void upsertQuantity(productId, parsedQuantity);
    }
  };
  const currency = cartData?.cart?.currency ?? items[0]?.currency ?? "TRY";
  const subtotal = toAmount(cartData?.totals.subtotal ?? "0.00");
  const vatTotal = toAmount(cartData?.totals.vat_total ?? "0.00");
  const grandTotal = toAmount(cartData?.totals.grand_total ?? "0.00");
  const mixedVatTotals = useMemo(() => {
    return items.reduce(
      (totals, item) => {
        const mode = effectiveVatSummaryModeForProduct(item.product_id);
        const lineTotal = toAmount(item.line_total);
        const vatRate = toAmount(item.vat_rate);
        const lineVat = Number((lineTotal * (vatRate / 100)).toFixed(2));

        totals.base += lineTotal;
        if (mode === "detailed") {
          totals.tax += lineVat;
          totals.payable += lineTotal + lineVat;
        } else if (mode === "included") {
          totals.payable += lineTotal + lineVat;
        } else {
          totals.payable += lineTotal;
        }

        return totals;
      },
      { base: 0, tax: 0, payable: 0 }
    );
  }, [effectiveVatSummaryModeForProduct, items]);
  const selectedPayment = PAYMENT_METHODS.find((method) => method.key === selectedPaymentMethod) ?? PAYMENT_METHODS[0];
  const selectedCombinedPayment = COMBINED_PAYMENT_OPTIONS.find((method) => method.key === selectedCombinedPaymentMethod) ?? COMBINED_PAYMENT_OPTIONS[0];
  const effectiveSelectedWarehouseKey = warehouseOptions.some((option) => warehouseOptionKey(option) === selectedWarehouseKey)
    ? selectedWarehouseKey
    : "";
  const selectedWarehouse =
    warehouseOptions.find((option) => warehouseOptionKey(option) === effectiveSelectedWarehouseKey) ?? null;
  const effectiveSelectedShippingWarehouseKey = cargoWarehouseOptions.some((option) => warehouseOptionKey(option) === selectedShippingWarehouseKey)
    ? selectedShippingWarehouseKey
    : "";
  const selectedShippingWarehouse =
    cargoWarehouseOptions.find((option) => warehouseOptionKey(option) === effectiveSelectedShippingWarehouseKey) ?? null;
  const isCombinedPayment = selectedPayment.key === "cash_transfer_single";
  const selectedPaymentMultiplier = isCombinedPayment ? selectedCombinedPayment.multiplier : selectedPayment.multiplier;
  const selectedShippingMethod = SHIPPING_METHODS.find((option) => option.value === shippingMethod);
  const isBatumBranch = useMemo(() => {
    if (user?.username?.trim().toLocaleLowerCase("tr-TR") === "turgay.buyukkal") {
      return false;
    }

    const userScopeValues = [
      user?.username,
      user?.email,
      user?.name,
      user?.branch_code,
      user?.branch_name,
      user?.region_code,
      user?.region_name,
    ];

    return userScopeValues.some(includesBatum);
  }, [
    user?.branch_code,
    user?.branch_name,
    user?.email,
    user?.name,
    user?.username,
    user?.region_code,
    user?.region_name,
  ]);
  const isBatumSelectedCustomer = useMemo(() => isBatumCustomerIdentity(selectedCustomer), [selectedCustomer]);
  const noteStepNumber = 2;
  const summaryStepNumber = 3;
  const effectiveVatSummaryMode: VatSummaryMode = vatSummaryMode;
  const hasMixedVatSummaryModes = useMemo(
    () => items.some((item) => effectiveVatSummaryModeForProduct(item.product_id) !== vatSummaryMode),
    [effectiveVatSummaryModeForProduct, items, vatSummaryMode]
  );
  const canManageWarehouseTransfer = useMemo(
    () =>
      roleSlugSet.has("warehouse") ||
      roleSlugSet.has("point") ||
      featurePermissionSet.has("cart.warehouse_transfer"),
    [featurePermissionSet, roleSlugSet]
  );
  const shouldAutoEnableDepotTransfer = useMemo(
    () => canManageWarehouseTransfer && isWarehouseOrderCustomer(selectedCustomer),
    [canManageWarehouseTransfer, selectedCustomer]
  );

  useEffect(() => {
    if (!canManageWarehouseTransfer || !shouldAutoEnableDepotTransfer) {
      setDepotTransferRequest(false);
      setSelectedWarehouseKey("");
      return;
    }

    setDepotTransferRequest(true);
  }, [canManageWarehouseTransfer, selectedCustomer?.id, shouldAutoEnableDepotTransfer]);

  const isTransferMode = canManageWarehouseTransfer && depotTransferRequest;
  // Cart ödeme şekli tüm hesaplarda görünmez; gönderim cari hesap ile devam eder.
  const shouldHidePaymentArea = true;
  const shouldHideSaleTypeSelector = isBatumBranch || isBatumSelectedCustomer;
  const shouldShowSaleTypeSelector = !shouldHideSaleTypeSelector && !isTransferMode && allowedVatSummaryModes.length > 0;
  const isBatumCurrencyScope = isBatumBranch || isBatumSelectedCustomer;
  const displayCurrency = isBatumCurrencyScope ? "GEL" : currency;
  const showShippingAndTransferControls = !isBatumCurrencyScope || isWarehouseOrderCustomer(selectedCustomer);
  const canUseAccountPayment = true;
  const allowedCombinedPaymentOptions = COMBINED_PAYMENT_OPTIONS;
  const visiblePaymentMethods = PAYMENT_METHODS.filter((method) => {
    if (isBatumCurrencyScope) return method.key === "current_account" && canUseAccountPayment;
    if (method.key === "current_account") return canUseAccountPayment;
    return allowedCombinedPaymentOptions.length > 0;
  });
  const checkoutDisplayTotal = isTransferMode ? subtotal : isBatumCurrencyScope
    ? grandTotal
    : hasMixedVatSummaryModes
    ? mixedVatTotals.payable
    : effectiveVatSummaryMode === "excluded" ? subtotal : grandTotal;
  const shouldShowShippingFeeNotice =
    !isTransferMode && (shippingMethod === "otobus" || (shippingMethod === "kargo" && checkoutDisplayTotal < shippingRuleAmounts.cargoLimit));
  const shippingFeeAmount = shouldShowShippingFeeNotice
    ? shippingMethod === "otobus"
      ? shippingRuleAmounts.busFee
      : shippingRuleAmounts.cargoFee
    : 0;
  const selectedPayableTotal = isTransferMode ? checkoutDisplayTotal : checkoutDisplayTotal * selectedPaymentMultiplier + shippingFeeAmount;
  const isBankTransferPayment =
    Boolean(isCombinedPayment && "requiresReference" in selectedCombinedPayment && selectedCombinedPayment.requiresReference);

  useEffect(() => {
    if (isBatumCurrencyScope && selectedPaymentMethod !== "current_account") {
      setSelectedPaymentMethod("current_account");
    }
  }, [isBatumCurrencyScope, selectedPaymentMethod]);
  useEffect(() => {
    if (shouldHidePaymentArea && selectedPaymentMethod !== "current_account") {
      setSelectedPaymentMethod("current_account");
    }
  }, [selectedPaymentMethod, shouldHidePaymentArea]);
  useEffect(() => {
    if (!isCustomerUser) return;
    if (selectedPaymentMethod === "current_account" && !canUseAccountPayment && allowedCombinedPaymentOptions.length > 0) {
      setSelectedPaymentMethod("cash_transfer_single");
    }
    if (!allowedCombinedPaymentOptions.some((option) => option.key === selectedCombinedPaymentMethod) && allowedCombinedPaymentOptions[0]) {
      setSelectedCombinedPaymentMethod(allowedCombinedPaymentOptions[0].key);
    }
  }, [allowedCombinedPaymentOptions, canUseAccountPayment, isCustomerUser, selectedCombinedPaymentMethod, selectedPaymentMethod]);
  const generatedTransferReference = [
    "PWR",
    selectedCustomer?.code?.trim() || selectedCustomer?.id || "CARI",
    cartData?.cart?.id ? `S${cartData.cart.id}` : "SEPET",
  ]
    .join("-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .toLocaleUpperCase("tr-TR");
  const canCheckout = !isCustomerUser || featurePermissionSet.has("cart.checkout") || Boolean(selectedCustomer);
  const transferSourceRequired = canManageWarehouseTransfer && depotTransferRequest && !selectedWarehouse;
  const cargoWarehouseRequired = !isTransferMode && shippingMethod === "kargo" && !selectedShippingWarehouse;
  const isFormDisabled = loading || mutating;
  const isCheckoutDisabled =
    mutating ||
    loading ||
    items.length === 0 ||
    (!selectedCustomer && !isTransferMode) ||
    transferSourceRequired ||
    cargoWarehouseRequired ||
    !canCheckout ||
    (!shouldHidePaymentArea && isCustomerUser && visiblePaymentMethods.length === 0);

  useEffect(() => {
    setShippingFeeConfirmed(false);
  }, [shippingFeeAmount, shippingMethod]);

  useEffect(() => {
    if (!depotTransferRequest || warehouseOptions.length === 0 || effectiveSelectedWarehouseKey) {
      return;
    }

    const preferredWarehouse =
      warehouseOptions.find((option) => normalizeWarehouseIdentity(option.warehouse_name).includes("ERZURUMDEPO")) ??
      warehouseOptions[0];

    if (preferredWarehouse) {
      setSelectedWarehouseKey(warehouseOptionKey(preferredWarehouse));
    }
  }, [depotTransferRequest, effectiveSelectedWarehouseKey, warehouseOptions]);

  useEffect(() => {
    if (shippingMethod !== "kargo") {
      setSelectedShippingWarehouseKey("");
      return;
    }

    if (cargoWarehouseOptions.length === 0 || effectiveSelectedShippingWarehouseKey) {
      return;
    }

    const preferredWarehouse =
      cargoWarehouseOptions.find((option) => normalizeWarehouseIdentity(option.warehouse_name).includes("ERZURUMDEPO")) ??
      cargoWarehouseOptions[0];

    if (preferredWarehouse) {
      setSelectedShippingWarehouseKey(warehouseOptionKey(preferredWarehouse));
    }
  }, [cargoWarehouseOptions, effectiveSelectedShippingWarehouseKey, shippingMethod]);

  const handleBulkCartFileChange = useCallback(
    async (file: File | null) => {
      if (!file) {
        return;
      }

      if (!selectedCustomer) {
        toast.error("Toplu sepet yüklemek için önce müşteri seçmelisiniz.");
        return;
      }

      setBulkUploading(true);
      setBulkUploadResults([]);

      try {
        const content = await file.text();
        const bulkItems = parseBulkCartText(content);

        if (bulkItems.length === 0) {
          toast.error("Dosyada okunabilir ürün kodu ve miktar satırı bulunamadı.");
          return;
        }

        const response = await bulkUpsertCartItems({
          items: bulkItems,
          customer_id: selectedCustomer.id,
          shipping_method: shippingMethod || undefined,
          warehouse_transfer: effectiveWarehouseTransfer,
          order_note: orderNote || undefined,
        });

        setBulkUploadResults(response.results);
        await refreshCart();

        if (response.summary.failed > 0) {
          toast.warning(`${response.summary.added} ürün eklendi, ${response.summary.failed} satır eklenemedi.`);
        } else {
          toast.success(`${response.summary.added} ürün sepete eklendi.`);
        }
      } catch (uploadError) {
        const message = uploadError instanceof Error ? uploadError.message : "Excel yükleme başarısız oldu.";
        toast.error(message);
      } finally {
        setBulkUploading(false);
        if (bulkUploadInputRef.current) {
          bulkUploadInputRef.current.value = "";
        }
      }
    },
    [effectiveWarehouseTransfer, orderNote, refreshCart, selectedCustomer, shippingMethod]
  );
  const checkoutNote = useMemo(() => {
    const cleanNote = orderNote.trim();
    const paymentNoteParts: string[] = [];

    if (!isBatumCurrencyScope && isBankTransferPayment) {
      paymentNoteParts.push(`Referans kodu: ${generatedTransferReference}`);
    }

    if (shippingFeeAmount > 0) {
      paymentNoteParts.push(`Ulaşım / nakliye bedeli: ${formatTryAmount(shippingFeeAmount, displayCurrency)}`);
    }

    if (!isBatumCurrencyScope && !isTransferMode && shippingMethod === "kargo" && selectedShippingWarehouse) {
      const warehouseLabel = [
        selectedShippingWarehouse.warehouse_name,
        selectedShippingWarehouse.warehouse_code ? `Kod: ${selectedShippingWarehouse.warehouse_code}` : null,
      ].filter(Boolean).join(" · ");
      paymentNoteParts.push(`Kargo hedef depo: ${warehouseLabel}`);
    }

    if (!isBatumCurrencyScope && isTransferMode && selectedWarehouse) {
      const warehouseLabel = [
        selectedWarehouse.warehouse_name,
        selectedWarehouse.warehouse_code ? `Kod: ${selectedWarehouse.warehouse_code}` : null,
      ].filter(Boolean).join(" · ");
      paymentNoteParts.push(`Depo transfer: ${warehouseLabel}`);
    }

    const paymentNote = paymentNoteParts.join(" · ");

    if (!paymentNote) {
      return cleanNote;
    }

    return cleanNote ? `${cleanNote}\n${paymentNote}` : paymentNote;
  }, [displayCurrency, generatedTransferReference, isBankTransferPayment, isBatumCurrencyScope, isTransferMode, orderNote, selectedShippingWarehouse, selectedWarehouse, shippingFeeAmount, shippingMethod]);

  const shouldShowWarehouseTransferPanel =
    showShippingAndTransferControls &&
    canManageWarehouseTransfer &&
    (shouldAutoEnableDepotTransfer || depotTransferRequest || isWarehouseOrderCustomer(selectedCustomer));

  const compactWarehouseTransferPanel =
    shouldShowWarehouseTransferPanel ? (
      <div className="rounded-[16px] border border-emerald-300/25 bg-[radial-gradient(circle_at_8%_16%,rgba(52,211,153,0.14)_0%,transparent_32%),linear-gradient(135deg,rgba(6,48,37,0.82)_0%,rgba(6,24,32,0.96)_100%)] p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-300/14 text-emerald-100 ring-1 ring-emerald-200/20">
              <Warehouse className="h-3.5 w-3.5" />
            </span>
            <p className="truncate text-xs font-black text-white">Depolar Arası Transfer</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setDepotTransferRequest((current) => {
                if (current) {
                  setSelectedWarehouseKey("");
                }

                return !current;
              });
            }}
            disabled={isFormDisabled}
            aria-pressed={depotTransferRequest}
            className={cn(
              "shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-black transition disabled:cursor-not-allowed disabled:opacity-60",
              depotTransferRequest
                ? "border-amber-100/70 bg-amber-200 text-slate-950"
                : "border-white/12 bg-white/8 text-white/65 hover:border-amber-200/45 hover:text-amber-100"
            )}
          >
            {depotTransferRequest ? "AKTİF" : "PASİF"}
          </button>
        </div>

        <button
          type="button"
          onClick={() => {
            if (!depotTransferRequest) {
              setDepotTransferRequest(true);
            }
          }}
          disabled={isFormDisabled}
          className="mt-2 flex h-9 w-full items-center gap-2 rounded-[11px] border border-emerald-100/16 bg-black/14 px-2.5 text-left transition hover:border-emerald-200/35 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className="shrink-0 text-[10px] font-bold text-emerald-50/60">Gönderen:</span>
          <strong className="min-w-0 flex-1 truncate text-xs font-black text-white">
            {selectedWarehouse?.warehouse_name ?? "Depo seçin"}
          </strong>
        </button>

        {depotTransferRequest && warehouseOptions.length > 0 ? (
          <div className="mt-2 grid gap-1.5">
            {warehouseOptions.map((warehouse) => {
              const key = warehouseOptionKey(warehouse);
              const active = key === effectiveSelectedWarehouseKey;
              const hasEnoughStock = warehouse.missing_quantity <= 0;

              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedWarehouseKey(key)}
                  disabled={isFormDisabled || !warehouse.is_active}
                  aria-pressed={active}
                  className={cn(
                    "grid min-h-11 grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-2 rounded-[11px] border px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-50",
                    active
                      ? "border-[#ffff00] bg-[#ffff00] text-slate-950 shadow-[0_12px_24px_-18px_rgba(255,255,0,0.9)]"
                      : "border-white/10 bg-white/7 text-emerald-50/82 hover:border-[#ffff00]/70 hover:bg-[#ffff00]/14"
                  )}
                >
                  <span className="truncate text-xs font-black">{warehouse.warehouse_name}</span>
                  <span className={cn("whitespace-nowrap text-[10px] font-black", active ? "text-slate-800" : "text-emerald-50/62")}>
                    Stok {formatStock(warehouse.available_total)}
                  </span>
                  <span
                    className={cn(
                      "whitespace-nowrap text-[10px] font-black",
                      hasEnoughStock
                        ? active ? "text-slate-800" : "text-emerald-200"
                        : active ? "text-amber-800" : "text-amber-200"
                    )}
                  >
                    {hasEnoughStock ? "Yeterli" : `Eksik ${formatStock(warehouse.missing_quantity)}`}
                  </span>
                  {active ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                  ) : (
                    <span className="h-4 w-4 shrink-0 rounded-full border border-white/35" />
                  )}
                </button>
              );
            })}
          </div>
        ) : depotTransferRequest ? (
          <div className="mt-2 rounded-[11px] border border-dashed border-emerald-100/20 bg-black/10 px-3 py-2 text-xs font-semibold text-emerald-50/70">
            Bu sepet için depo stok kırılımı bulunamadı.
          </div>
        ) : null}
      </div>
    ) : null;

  return (
    <div className="admin-cart-page flex flex-col gap-4">
      {!selectedCustomer ? (
        <div className="rounded-[18px] border border-amber-300/55 bg-amber-500/10 p-4 text-sm font-bold text-amber-200">
          <p>Sepeti tamamlamak için önce cari seçin.</p>
          <Button asChild size="default" variant="outline" className="mt-3 h-11 rounded-xl">
            <Link href="/customers">Müşteri Seçimine Git</Link>
          </Button>
        </div>
      ) : null}

      {selectedCustomer && !shouldHidePaymentArea ? (
        <Card className="dashboard-panel-card order-2 overflow-hidden">
          <CardContent className="space-y-3 p-3 2xl:p-4">
            <StepTitle step={2} title="Ödeme Şekli" />

            <div className={cn("grid gap-2.5 2xl:gap-3", isBatumCurrencyScope ? "grid-cols-1" : "md:grid-cols-2")}>
              {visiblePaymentMethods.map((method) => {
                const Icon = method.icon;
                const active = selectedPaymentMethod === method.key;
                const methodBadge = method.key === "cash_transfer_single" ? selectedCombinedPayment.badge : method.badge;
                const methodMultiplier = method.key === "cash_transfer_single" ? selectedCombinedPayment.multiplier : method.multiplier;
                const payableTotal = checkoutDisplayTotal * methodMultiplier + shippingFeeAmount;

                return (
                  <div
                    key={method.key}
                    onClick={() => setSelectedPaymentMethod(method.key)}
                    onKeyDown={(event) => {
                      if (isFormDisabled) {
                        return;
                      }

                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedPaymentMethod(method.key);
                      }
                    }}
                    role="button"
                    tabIndex={isFormDisabled ? -1 : 0}
                    aria-pressed={active}
                    className={cn(
                      "relative min-h-[108px] cursor-pointer overflow-hidden rounded-[16px] border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60 2xl:min-h-[112px]",
                      isFormDisabled && "pointer-events-none cursor-not-allowed opacity-60",
                      method.tone === "green" && "bg-[radial-gradient(circle_at_12%_18%,rgba(34,197,94,0.18)_0%,transparent_34%),linear-gradient(135deg,rgba(10,39,27,0.92)_0%,rgba(6,26,20,0.98)_100%)]",
                      method.tone === "teal" && "bg-[radial-gradient(circle_at_12%_18%,rgba(45,212,191,0.16)_0%,transparent_34%),linear-gradient(135deg,rgba(8,46,49,0.92)_0%,rgba(5,25,32,0.98)_100%)]",
                      active
                        ? "border-emerald-400 shadow-[0_24px_42px_-34px_rgba(34,197,94,0.85)]"
                        : "border-[var(--brand-border)] hover:border-[var(--brand-primary)]/65"
                    )}
                  >
                  <span
                    className={cn(
                      "absolute inset-0 opacity-0 transition",
                      active && "opacity-100",
                      method.tone === "green" && "bg-[radial-gradient(circle_at_8%_16%,rgba(34,197,94,0.42)_0%,transparent_33%),linear-gradient(135deg,rgba(15,118,54,0.94)_0%,rgba(3,48,31,0.96)_100%)]",
                      method.tone === "teal" && "bg-[radial-gradient(circle_at_10%_20%,rgba(45,212,191,0.24)_0%,transparent_34%),linear-gradient(135deg,rgba(12,90,86,0.82)_0%,rgba(4,44,45,0.96)_100%)]"
                    )}
                  />
                  {active ? (
                    <span className="absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-400 text-emerald-950">
                      <CheckCircle2 className="h-4 w-4" />
                    </span>
                  ) : null}

                  <span className="relative z-10 flex h-full min-h-[84px] flex-col justify-between gap-2 text-center">
                    <span className="flex items-center justify-between gap-3 pr-7">
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span
                          className={cn(
                            "flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-[var(--brand-primary)]",
                            active
                              ? "border-white/20 bg-white/12 text-white"
                              : "border-[var(--brand-border)] bg-[var(--surface-soft)]"
                          )}
                        >
                          <Icon className="h-5 w-5" />
                        </span>
                        <span className="text-left text-sm font-black leading-tight text-[var(--foreground)] 2xl:text-base">{method.title}</span>
                      </span>
                      <span className="shrink-0 text-right">
                        {methodBadge ? (
                          <span
                            className={cn(
                              "block text-[11px] font-black leading-none",
                              selectedCombinedPayment.key === "single_payment" ? "text-sky-300" : "text-emerald-300"
                            )}
                          >
                            {methodBadge}
                          </span>
                        ) : null}
                        <span className="mt-1 block text-[11px] font-semibold leading-none text-[var(--muted-foreground)]">{method.label}</span>
                        <span className="mt-1 block text-lg font-black leading-none tracking-[0.02em] text-[var(--foreground)] 2xl:text-xl">
                          {formatTryAmount(payableTotal, displayCurrency)}
                        </span>
                      </span>
                    </span>

                    {method.key === "cash_transfer_single" ? (
                      <span className="grid w-full grid-cols-3 gap-1 rounded-[12px] border border-white/10 bg-black/12 p-1">
                        {allowedCombinedPaymentOptions.map((option) => {
                          const OptionIcon = option.icon;
                          const optionActive = active && selectedCombinedPaymentMethod === option.key;

                          return (
                            <button
                              key={option.key}
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setSelectedPaymentMethod("cash_transfer_single");
                                setSelectedCombinedPaymentMethod(option.key);
                              }}
                              disabled={isFormDisabled}
                              aria-pressed={optionActive}
                              className={cn(
                                "flex min-h-8 items-center justify-center gap-1 rounded-[9px] border px-1 text-[10px] font-black leading-tight transition disabled:cursor-not-allowed disabled:opacity-60",
                                optionActive
                                  ? "border-teal-100/70 bg-[linear-gradient(135deg,rgba(45,212,191,0.96)_0%,rgba(13,148,136,0.92)_100%)] text-slate-950 shadow-[0_10px_22px_-18px_rgba(45,212,191,0.9)]"
                                  : "border-white/10 bg-white/8 text-white/76 hover:border-white/25 hover:bg-white/12"
                              )}
                            >
                              <OptionIcon className="h-3.5 w-3.5" />
                              <span>{option.label}</span>
                            </button>
                          );
                        })}
                      </span>
                    ) : null}
                  </span>
                  </div>
                );
              })}
            </div>

            {isBankTransferPayment ? (
              <div className="grid gap-2 rounded-[18px] border border-teal-300/35 bg-[radial-gradient(circle_at_8%_16%,rgba(45,212,191,0.18)_0%,transparent_34%),linear-gradient(135deg,rgba(8,47,73,0.78)_0%,rgba(5,37,38,0.96)_100%)] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <div className="rounded-[14px] border border-white/10 bg-white/8 p-3">
                <p className="text-[10px] font-black uppercase tracking-[0.12em] text-teal-100/70">Alıcı</p>
                <p className="mt-1 text-xs font-black leading-5 text-white">{BANK_TRANSFER_ACCOUNT.company}</p>
              </div>
              <div className="grid gap-1.5 rounded-[14px] border border-white/10 bg-white/8 p-3 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-bold text-teal-100/68">Banka</span>
                  <strong className="text-right text-white">{BANK_TRANSFER_ACCOUNT.bank}</strong>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="font-bold text-teal-100/68">Şube</span>
                  <strong className="text-right text-white">{BANK_TRANSFER_ACCOUNT.branch}</strong>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="font-bold text-teal-100/68">Hesap No</span>
                  <strong className="text-right text-white">{BANK_TRANSFER_ACCOUNT.accountNo}</strong>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="font-bold text-teal-100/68">IBAN</span>
                  <strong className="break-all text-right text-[11px] text-white">{BANK_TRANSFER_ACCOUNT.iban}</strong>
                </div>
              </div>
              <Input
                value={generatedTransferReference}
                readOnly
                disabled={isFormDisabled}
                placeholder="Referans kodu"
                className="h-11 rounded-[14px] border-teal-100/20 bg-white/10 text-sm font-black text-white placeholder:text-white/45 md:col-span-2"
              />
              <p className="rounded-[12px] border border-teal-100/20 bg-teal-300/10 px-3 py-2 text-xs font-bold leading-5 text-teal-50/86 md:col-span-2">
                Havale/EFT yaparken açıklama bölümüne bu referans kodunu yazınız.
              </p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card className="dashboard-panel-card order-1 overflow-hidden">
        <CardContent className="space-y-5 p-4 md:p-6 2xl:p-7">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <StepTitle step={1} title="Ürün Listesi" />
            <div className="flex flex-wrap items-center gap-2">
              {items.length > 0 ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 rounded-xl border-red-400/35 bg-red-500/5 px-3 text-xs font-black text-red-200 hover:bg-red-500/10"
                    disabled={isFormDisabled || selectedProductIds.length === 0}
                    onClick={() => setDeleteDialog("selected")}
                  >
                    Seçilenleri Sil
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 rounded-xl border-red-400/45 bg-red-500/10 px-3 text-xs font-black text-red-100 hover:bg-red-500/15"
                    disabled={isFormDisabled}
                    onClick={() => setDeleteDialog("all")}
                  >
                    Tümünü Sil
                  </Button>
                </>
              ) : null}
              <Button
                type="button"
                variant="outline"
                className="admin-dashboard-ghost h-10 rounded-xl px-3 text-xs font-black"
                onClick={downloadBulkCartTemplate}
              >
                <Download className="h-4 w-4" />
                Örnek Excel İndir
              </Button>
              <input
                ref={bulkUploadInputRef}
                type="file"
                accept=".xls,.csv,.tsv,.txt,text/csv,text/tab-separated-values,application/vnd.ms-excel"
                className="hidden"
                onChange={(event) => void handleBulkCartFileChange(event.target.files?.[0] ?? null)}
              />
              <Button
                type="button"
                className="admin-primary-action h-10 rounded-xl px-3 text-xs font-black"
                disabled={bulkUploading || !selectedCustomer}
                onClick={() => bulkUploadInputRef.current?.click()}
              >
                {bulkUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Excel Yükle
              </Button>
            </div>
          </div>

          {bulkUploadResults.length > 0 ? (
            <div className="rounded-xl border border-[var(--brand-border)] bg-[var(--surface-soft)] p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                <FileSpreadsheet className="h-4 w-4 text-[var(--brand-primary)]" />
                Toplu sepet sonucu
              </div>
              <div className="grid max-h-32 gap-1 overflow-auto text-sm font-semibold sm:grid-cols-2 lg:grid-cols-3">
                {bulkUploadResults.map((result, index) => (
                  <div
                    key={`${result.product_code}-${index}`}
                    className={cn(
                      "rounded-lg border px-3 py-2",
                      result.status === "added"
                        ? "border-emerald-400/35 bg-emerald-400/10 text-emerald-100"
                        : "border-rose-400/35 bg-rose-400/10 text-rose-100"
                    )}
                  >
                    <span className="font-black">{result.product_code}</span>
                    <span className="text-[var(--muted-foreground)]"> · {result.quantity} adet</span>
                    <div className="text-xs">{result.message}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={`cart-page-skeleton-${index}`} className="h-24 w-full rounded-[18px] md:h-28" />
              ))}
            </div>
          ) : null}

          {!loading && items.length === 0 ? (
            <div className="admin-cart-empty flex min-h-[210px] flex-col items-center justify-center gap-3 rounded-[20px] bg-[var(--surface-soft)] p-5 text-center text-sm text-[var(--muted-foreground)] md:min-h-[250px] 2xl:min-h-[280px] 2xl:gap-4">
              <ShoppingCart className="h-12 w-12 text-[var(--brand-primary)] 2xl:h-16 2xl:w-16" />
              <div>
                <p className="text-xl font-extrabold text-[var(--foreground)]">Sepette ürün yok</p>
                <p className="mt-2 max-w-[360px] leading-6">Ürünleri görüntülemek ve sepetinize eklemek için ürün listesine gidin.</p>
              </div>
              <Button asChild size="default" variant="outline" className="admin-primary-action h-12 rounded-2xl px-8 text-base font-black">
                <Link href="/search">Ürünlere Git</Link>
              </Button>
            </div>
          ) : null}

          {items.length > 0 ? (
            <div className="overflow-hidden rounded-[22px] border border-[var(--brand-border)] bg-[var(--surface)]">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1180px] table-fixed border-collapse">
                  <colgroup>
                    <col className="w-[54px]" />
                    <col className="w-[82px]" />
                    <col className="w-[136px]" />
                    <col />
                    <col className="w-[132px]" />
                    <col className="w-[150px]" />
                    <col className="w-[176px]" />
                    <col className="w-[168px]" />
                    <col className="w-[72px]" />
                  </colgroup>
                  <thead className="bg-[radial-gradient(circle_at_8%_16%,rgba(34,197,94,0.42)_0%,transparent_34%),linear-gradient(135deg,rgba(15,118,54,0.96)_0%,rgba(3,48,31,0.98)_100%)]">
                    <tr className="border-b border-emerald-300/35 text-[12px] font-black uppercase tracking-[0.14em] text-emerald-50">
                      <th scope="col" className="border-r border-emerald-200/20 px-3 py-4 text-center">
                        <input
                          type="checkbox"
                          checked={allItemsSelected}
                          onChange={toggleAllProductSelection}
                          disabled={isFormDisabled}
                          aria-label="Tüm ürünleri seç"
                          className="h-4 w-4 rounded border-emerald-200/40 accent-emerald-400"
                        />
                      </th>
                      <th scope="col" className="border-r border-emerald-200/20 px-4 py-4 text-right">Stok</th>
                      <th scope="col" className="border-r border-emerald-200/20 px-4 py-4 text-left">Stok Kodu</th>
                      <th scope="col" className="border-r border-emerald-200/20 px-4 py-4 text-left">Ürün Adı</th>
                      <th scope="col" className="border-r border-emerald-200/20 px-4 py-4 text-left">Marka</th>
                      <th scope="col" className="border-r border-emerald-200/20 px-4 py-4 text-right">Birim Fiyat</th>
                      <th scope="col" className="border-r border-emerald-200/20 px-4 py-4 text-center">Miktar</th>
                      <th scope="col" className="border-r border-emerald-200/20 px-4 py-4 text-right">Toplam Tutar</th>
                      <th scope="col" className="px-3 py-4 text-center">Sil</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => {
                      const effectiveUnitPrice =
                        item.quantity > 0 ? toAmount(item.line_total) / item.quantity : toAmount(item.unit_net_price);
                      const displayedUnitPrice = effectiveUnitPrice;
                      const displayedLineTotal = toAmount(item.line_total);
                      const itemVatMode = effectiveVatSummaryModeForProduct(item.product_id);
                      const itemVatLabel = CHECKOUT_SUMMARY_MODES[itemVatMode].code;

                      return (
                      <tr key={item.id} className="border-b border-[var(--brand-border)] last:border-b-0">
                        <td className="border-r border-[var(--brand-border)] px-3 py-4 text-center align-middle">
                          <input
                            type="checkbox"
                            checked={selectedProductIdSet.has(item.product_id)}
                            onChange={() => toggleProductSelection(item.product_id)}
                            disabled={isFormDisabled}
                            aria-label={`${item.name} seç`}
                            className="h-4 w-4 rounded border-[var(--brand-border)] accent-emerald-400"
                          />
                        </td>
                        <td className="border-r border-[var(--brand-border)] px-4 py-4 text-right align-middle text-base font-black text-emerald-300">
                          {formatStock(item.available_total)}
                        </td>
                        <td className="border-r border-[var(--brand-border)] px-4 py-4 align-middle">
                          <p className="truncate text-sm font-black text-[var(--foreground)]">{item.sku}</p>
                        </td>
                        <td className="border-r border-[var(--brand-border)] px-4 py-4 align-middle">
                          <p className="line-clamp-2 text-base font-black leading-6 text-[var(--foreground)]">{item.name}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            {item.campaign_key ? (
                              <span className="inline-flex rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-emerald-300">
                                Kampanya aktif
                              </span>
                            ) : null}
                            <span className="inline-flex rounded-full border border-amber-200/35 bg-amber-300/12 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-amber-100">
                              {itemVatLabel}
                            </span>
                          </div>
                        </td>
                        <td className="border-r border-[var(--brand-border)] px-4 py-4 align-middle">
                          <p className="truncate text-sm font-black text-[var(--foreground)]">{item.brand ?? "-"}</p>
                        </td>
                        <td className="border-r border-[var(--brand-border)] px-4 py-4 text-right align-middle text-base font-black text-[var(--foreground)]">
                          {formatTryAmount(displayedUnitPrice, displayCurrency)}
                        </td>
                        <td className="border-r border-[var(--brand-border)] px-3 py-4 align-middle">
                          <div className="mx-auto grid h-11 w-[148px] grid-cols-[36px_1fr_36px] items-center rounded-[12px] border border-[var(--brand-border)] bg-[var(--surface-soft)] p-1">
                            <Button size="icon" variant="outline" className="h-9 w-9 rounded-[10px]" onClick={() => void upsertQuantity(item.product_id, item.quantity - 1)} disabled={isFormDisabled}>
                              <Minus className="h-4 w-4" />
                            </Button>
                            <Input
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              value={quantityDrafts[item.product_id] ?? String(item.quantity)}
                              onChange={(event) => setQuantityDraft(item.product_id, event.target.value)}
                              onBlur={() => commitQuantityDraft(item.product_id, item.quantity)}
                              onFocus={(event) => event.currentTarget.select()}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.currentTarget.blur();
                                }
                              }}
                              disabled={isFormDisabled}
                              aria-label={`${item.name} miktarı`}
                              className="h-9 rounded-[10px] border-0 bg-[var(--surface)] px-1 text-center text-base font-black shadow-none focus-visible:ring-1"
                            />
                            <Button size="icon" variant="outline" className="h-9 w-9 rounded-[10px]" onClick={() => void upsertQuantity(item.product_id, item.quantity + 1)} disabled={isFormDisabled}>
                              <Plus className="h-4 w-4" />
                            </Button>
                          </div>
                        </td>
                        <td className="border-r border-[var(--brand-border)] px-4 py-4 text-right align-middle text-base font-black text-[var(--foreground)]">
                          {formatTryAmount(displayedLineTotal, displayCurrency)}
                        </td>
                        <td className="px-3 py-4 text-center align-middle">
                          <Button type="button" variant="outline" size="icon" className="h-10 w-10 rounded-[12px] border-red-500/35 bg-red-500/5 text-red-400 hover:bg-red-500/10 hover:text-red-300" onClick={() => void removeItemByProduct(item.product_id)} disabled={isFormDisabled} aria-label="Kalemi kaldır">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div
        className={cn(
          "order-3 grid items-stretch gap-4 xl:grid-cols-[minmax(330px,0.78fr)_minmax(430px,1.22fr)] 2xl:grid-cols-[minmax(420px,0.82fr)_minmax(520px,1.18fr)]"
        )}
      >
        <div className="grid items-start gap-4">
          <Card className={cn("dashboard-panel-card h-full overflow-hidden", isBatumCurrencyScope && "h-full")}>
            <CardContent className="space-y-3 p-4 2xl:p-5">
              <StepTitle step={noteStepNumber} title="Sipariş Notu" icon={PencilLine} />

              <div className="rounded-[16px] border border-cyan-200/18 bg-[linear-gradient(135deg,rgba(14,116,144,0.18)_0%,rgba(6,24,32,0.64)_100%)] p-3">
                <Textarea
                  value={orderNote}
                  onChange={(event) => setOrderNote(event.target.value)}
                  placeholder="Sipariş notu yazın..."
                  disabled={isFormDisabled}
                  className="min-h-[60px] rounded-[14px] border-cyan-100/16 bg-black/16 text-sm font-semibold text-white placeholder:text-cyan-50/42 focus-visible:ring-cyan-200/40"
                />
              </div>

              {showShippingAndTransferControls ? <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Truck className="h-4 w-4 text-emerald-300" />
                  <p className="text-sm font-black uppercase tracking-[0.08em] text-white">Gönderme Şekli</p>
                </div>
                <div className="grid gap-2 rounded-[18px] border border-emerald-300/25 bg-[linear-gradient(135deg,rgba(7,23,29,0.92)_0%,rgba(5,37,28,0.92)_100%)] p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] md:grid-cols-3">
                  {SHIPPING_METHODS.map((option) => {
                    const Icon = option.icon;
                    const active = shippingMethod === option.value;

                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setShippingMethod(option.value)}
                        disabled={isFormDisabled}
                        aria-pressed={active}
                        className={cn(
                          "group flex min-h-16 items-center gap-2.5 rounded-[14px] border p-2.5 text-left transition duration-200 disabled:cursor-not-allowed disabled:opacity-60",
                          option.tone === "emerald" &&
                            (active
                              ? "border-emerald-200 bg-[radial-gradient(circle_at_18%_18%,rgba(187,247,208,0.3)_0%,transparent_34%),linear-gradient(135deg,rgba(16,185,129,0.96)_0%,rgba(3,92,64,0.98)_100%)] text-white shadow-[0_16px_32px_-22px_rgba(16,185,129,0.9)]"
                              : "border-emerald-300/18 bg-emerald-500/8 text-emerald-100/82 hover:border-emerald-200/70 hover:bg-emerald-500/18"),
                          option.tone === "sky" &&
                            (active
                              ? "border-sky-200 bg-[radial-gradient(circle_at_18%_18%,rgba(186,230,253,0.3)_0%,transparent_34%),linear-gradient(135deg,rgba(14,165,233,0.96)_0%,rgba(7,89,133,0.98)_100%)] text-white shadow-[0_16px_32px_-22px_rgba(14,165,233,0.9)]"
                              : "border-sky-300/18 bg-sky-500/8 text-sky-100/82 hover:border-sky-200/70 hover:bg-sky-500/18"),
                          option.tone === "violet" &&
                            (active
                              ? "border-fuchsia-200 bg-[radial-gradient(circle_at_18%_18%,rgba(245,208,254,0.3)_0%,transparent_34%),linear-gradient(135deg,rgba(192,38,211,0.94)_0%,rgba(91,33,182,0.98)_100%)] text-white shadow-[0_16px_32px_-22px_rgba(192,38,211,0.86)]"
                              : "border-fuchsia-300/18 bg-fuchsia-500/8 text-fuchsia-100/82 hover:border-fuchsia-200/70 hover:bg-fuchsia-500/18")
                        )}
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/12 ring-1 ring-white/16">
                          <Icon className="h-4.5 w-4.5" />
                        </span>
                        <span className="min-w-0 text-sm font-black leading-tight">{option.label}</span>
                        {active ? <CheckCircle2 className="ml-auto h-4.5 w-4.5 shrink-0" /> : null}
                      </button>
                    );
                  })}
                </div>
                {shippingMethod === "kargo" ? (
                  <div className="mt-2 rounded-[16px] border border-emerald-200/20 bg-black/12 p-2">
                    <p className="px-1 pb-2 text-xs font-black uppercase tracking-[0.08em] text-emerald-100/75">
                      Kargonun düşeceği depo
                    </p>
                    <div className="grid gap-2 sm:grid-cols-3">
                      {cargoWarehouseOptions.map((warehouse) => {
                        const key = warehouseOptionKey(warehouse);
                        const active = key === effectiveSelectedShippingWarehouseKey;

                        return (
                          <button
                            key={`cargo-target-${key}`}
                            type="button"
                            onClick={() => setSelectedShippingWarehouseKey(key)}
                            disabled={isFormDisabled || !warehouse.is_active}
                            aria-pressed={active}
                            className={cn(
                              "rounded-[14px] border px-3 py-2 text-left text-xs font-black transition disabled:cursor-not-allowed disabled:opacity-50",
                              active
                                ? "border-[#ffff00] bg-[#ffff00] text-slate-950 shadow-[0_14px_26px_-18px_rgba(255,255,0,0.95)]"
                                : "border-white/10 bg-white/8 text-emerald-50/82 hover:border-[#ffff00]/80 hover:bg-[#ffff00]/20"
                            )}
                          >
                            <span className="block truncate">{warehouse.warehouse_name}</span>
                            <span className={cn("mt-1 block text-[10px]", active ? "text-slate-800" : "text-emerald-50/55")}>
                              Kod: {warehouse.warehouse_code ?? "-"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {cargoWarehouseRequired ? (
                      <p className="mt-2 rounded-xl border border-red-300/35 bg-red-500/12 px-3 py-2 text-xs font-bold text-red-100">
                        Kargo siparişi için Erzurum, Trabzon veya Samsun depolarından birini seçin.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div> : null}

              {showShippingAndTransferControls && shouldShowShippingFeeNotice ? (
                <div className="rounded-[18px] border border-amber-300/45 bg-[radial-gradient(circle_at_8%_16%,rgba(251,191,36,0.24)_0%,transparent_34%),linear-gradient(135deg,rgba(83,53,12,0.68)_0%,rgba(12,23,33,0.92)_100%)] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]">
                  <div className="flex items-start gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-300/18 text-amber-100 ring-1 ring-amber-200/25">
                      <Truck className="h-5 w-5" />
                    </span>
                    <div>
	                      <p className="text-sm font-black text-amber-100">
	                        {selectedShippingMethod?.label} için nakliye bedeli yansıtıldı
	                      </p>
	                      <p className="mt-1 text-sm font-semibold leading-6 text-amber-50/82">
	                        {shippingMethod === "kargo" ? `${formatTryAmount(shippingRuleAmounts.cargoLimit, displayCurrency)} altındaki kargo siparişlerinde` : "Otobüs gönderimlerinde"}
	                        {" "}
	                        <strong className="font-black text-amber-100">{formatTryAmount(shippingFeeAmount, displayCurrency)}</strong>
	                        {" "}
	                        olarak sipariş özetine eklendi.
	                      </p>
                    </div>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <Card className="dashboard-panel-card h-full overflow-hidden">
          <CardContent className="grid min-w-0 gap-4 p-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:items-stretch 2xl:gap-5 2xl:p-5">
            <div className="order-2 min-w-0 lg:order-2">
              <StepTitle step={summaryStepNumber} title="Sipariş Özeti" />
              <div className="mt-5 space-y-3">
                {hasMixedVatSummaryModes ? (
                  <>
                    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 text-base">
                      <span className="text-[var(--muted-foreground)]">Ara Toplam</span>
                      <span className="h-px bg-[var(--brand-border)]" />
                      <strong>{formatTryAmount(mixedVatTotals.base, displayCurrency)}</strong>
                    </div>
                    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 text-base">
                      <span className="text-[var(--muted-foreground)]">Satır Bazlı KDV</span>
                      <span className="h-px bg-[var(--brand-border)]" />
                      <strong>{formatTryAmount(mixedVatTotals.tax, displayCurrency)}</strong>
                    </div>
                  </>
                ) : effectiveVatSummaryMode === "detailed" ? (
                  <>
                    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 text-base">
                      <span className="text-[var(--muted-foreground)]">Ara Toplam</span>
                      <span className="h-px bg-[var(--brand-border)]" />
                      <strong>{formatTryAmount(subtotal, displayCurrency)}</strong>
                    </div>
	                    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 text-base">
	                      <span className="text-[var(--muted-foreground)]">KDV (%20)</span>
	                      <span className="h-px bg-[var(--brand-border)]" />
	                      <strong>{formatTryAmount(vatTotal, displayCurrency)}</strong>
	                    </div>
	                  </>
	                ) : null}
                {!hasMixedVatSummaryModes && effectiveVatSummaryMode === "excluded" ? (
                  <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 text-base">
                    <span className="text-[var(--muted-foreground)]">KDV</span>
                    <span className="h-px bg-[var(--brand-border)]" />
                    <strong>KDV Yok</strong>
                  </div>
                ) : null}
                {shippingFeeAmount > 0 ? (
                  <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 text-base">
                    <span className="text-amber-100">Ulaşım / Nakliye</span>
                    <span className="h-px bg-amber-300/30" />
                    <strong className="text-amber-100">{formatTryAmount(shippingFeeAmount, displayCurrency)}</strong>
                  </div>
                ) : null}
	                <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 pt-3 text-lg">
	                  <span className="font-black text-[var(--foreground)]">Genel Toplam</span>
                  <span className="h-px bg-[var(--brand-border)]" />
                  <strong className="text-2xl text-emerald-300 2xl:text-3xl">{formatTryAmount(selectedPayableTotal, displayCurrency)}</strong>
                </div>
              </div>
            </div>

            <div className="order-1 flex min-w-0 max-w-full flex-col gap-3 overflow-hidden border-b border-[var(--brand-border)] pb-4 lg:order-1 lg:h-full lg:border-b-0 lg:border-r lg:pb-0 lg:pr-5">
              {compactWarehouseTransferPanel}
              <div
                className={cn(
                  "cart-submit-panel grid min-w-0 max-w-full flex-1 items-stretch gap-2 overflow-hidden",
                  selectedCustomer && shouldShowSaleTypeSelector && allowedVatSummaryModes.length > 0
                    ? "grid-cols-[3rem_minmax(0,1fr)] sm:grid-cols-[4rem_minmax(0,1fr)]"
                    : "grid-cols-1"
                )}
              >
                {selectedCustomer && shouldShowSaleTypeSelector && allowedVatSummaryModes.length > 0 ? (
                  <div className="grid min-h-[7rem] min-w-0 grid-rows-[auto_1fr] overflow-hidden rounded-[14px] border border-emerald-300/25 bg-[linear-gradient(135deg,rgba(7,23,29,0.92)_0%,rgba(5,37,28,0.92)_100%)] p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] sm:min-h-[8.5rem] lg:min-h-[13.25rem] 2xl:min-h-[14rem]">
                    <span className="px-0.5 pb-1 text-center text-[8px] font-black uppercase leading-none tracking-[0.08em] text-emerald-100/70">
                      Satış
                    </span>
                    <div className="grid min-h-0 gap-1">
                      {allowedVatSummaryModes.map((mode) => {
                        const isSelected = selectedProductIds.length === 0 && vatSummaryMode === mode;
                        const codeParts = CHECKOUT_SUMMARY_MODES[mode].code.split("-");
                        const toneClass =
                          mode === "detailed"
                            ? isSelected
                              ? "border-emerald-200 bg-[radial-gradient(circle_at_26%_20%,rgba(187,247,208,0.34)_0%,transparent_34%),linear-gradient(135deg,rgba(16,185,129,0.96)_0%,rgba(3,92,64,0.98)_100%)] text-white shadow-[0_16px_32px_-20px_rgba(16,185,129,0.9)]"
                              : "border-emerald-300/18 bg-emerald-500/8 text-emerald-100/80 hover:border-emerald-200/70 hover:bg-emerald-500/18"
                            : mode === "excluded"
                              ? isSelected
                                ? "border-sky-200 bg-[radial-gradient(circle_at_26%_20%,rgba(186,230,253,0.34)_0%,transparent_34%),linear-gradient(135deg,rgba(14,165,233,0.96)_0%,rgba(7,89,133,0.98)_100%)] text-white shadow-[0_16px_32px_-20px_rgba(14,165,233,0.9)]"
                                : "border-sky-300/18 bg-sky-500/8 text-sky-100/80 hover:border-sky-200/70 hover:bg-sky-500/18"
                              : isSelected
                                ? "border-fuchsia-200 bg-[radial-gradient(circle_at_26%_20%,rgba(245,208,254,0.34)_0%,transparent_34%),linear-gradient(135deg,rgba(192,38,211,0.94)_0%,rgba(91,33,182,0.98)_100%)] text-white shadow-[0_16px_32px_-20px_rgba(192,38,211,0.86)]"
                                : "border-fuchsia-300/18 bg-fuchsia-500/8 text-fuchsia-100/80 hover:border-fuchsia-200/70 hover:bg-fuchsia-500/18";

                        return (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => handleVatSummaryModeSelect(mode)}
                            aria-label={`${CHECKOUT_SUMMARY_MODES[mode].label} özet görünümü`}
                            aria-pressed={isSelected}
                            className={cn(
                              "group flex min-h-0 min-w-0 items-center justify-center rounded-[10px] border text-[13px] font-black leading-none transition duration-200",
                              toneClass
                            )}
                          >
                            <span className="grid h-9 w-8 place-items-center rounded-full bg-white/14 py-1 ring-1 ring-white/18 sm:h-11 sm:w-9">
                              <span>{codeParts[0]}</span>
                              <span>{codeParts[1]}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                <Button
                  type="button"
                  className={cn(
                    "h-full min-h-[7rem] w-full max-w-full rounded-[18px] border border-red-300/45 !bg-[radial-gradient(circle_at_18%_18%,rgba(254,202,202,0.3)_0%,transparent_34%),linear-gradient(135deg,rgba(239,68,68,0.98)_0%,rgba(153,27,27,1)_100%)] px-3 text-lg font-black uppercase leading-none tracking-[0.03em] !text-white shadow-[0_22px_38px_-24px_rgba(239,68,68,0.95),inset_0_1px_0_rgba(255,255,255,0.22)] hover:!bg-[radial-gradient(circle_at_18%_18%,rgba(254,202,202,0.36)_0%,transparent_34%),linear-gradient(135deg,rgba(248,113,113,1)_0%,rgba(185,28,28,1)_100%)] sm:min-h-[8.5rem] sm:text-xl lg:min-h-[13.25rem] 2xl:min-h-[14rem] 2xl:text-2xl"
                  )}
                  disabled={isCheckoutDisabled}
                  onClick={() => void (async () => {
                    if (shippingFeeAmount > 0 && !shippingFeeConfirmed) {
                      setShippingFeeConfirmOpen(true);
                      return;
                    }

                    const isDepotTransferSubmit = canManageWarehouseTransfer && depotTransferRequest && !!selectedWarehouse;
                    const checkoutProductIds = selectedProductIds.length > 0 ? selectedProductIds : items.map((item) => item.product_id);

                    try {
                      await createOrderFromCart({
                        note: checkoutNote,
                        checkoutSummaryMode: isDepotTransferSubmit ? "excluded" : effectiveVatSummaryMode,
                        itemCheckoutSummaryModes: Object.fromEntries(
                          checkoutProductIds.map((productId) => [productId, isDepotTransferSubmit ? "excluded" : effectiveVatSummaryModeForProduct(productId)])
                        ),
                        checkoutGrandTotal: isDepotTransferSubmit ? undefined : Number(selectedPayableTotal.toFixed(2)),
                        shippingFeeAmount: isDepotTransferSubmit ? 0 : Number(shippingFeeAmount.toFixed(2)),
                        selectedProductIds: checkoutProductIds,
                        paymentMethod: shouldHidePaymentArea
                          ? "current_account"
                          : isCombinedPayment
                            ? selectedCombinedPayment.key
                            : selectedPayment.key,
                        salesPriceType: shouldHidePaymentArea
                          ? undefined
                          : isCombinedPayment
                            ? selectedCombinedPayment.key
                            : undefined,
                        warehouseTransferRequest: isDepotTransferSubmit,
                        shippingTargetWarehouseCode: !isDepotTransferSubmit && shippingMethod === "kargo" ? (selectedShippingWarehouse?.warehouse_code ?? null) : null,
                        shippingTargetWarehouseName: !isDepotTransferSubmit && shippingMethod === "kargo" ? (selectedShippingWarehouse?.warehouse_name ?? null) : null,
                        transferTargetWarehouseCode: canManageWarehouseTransfer && depotTransferRequest ? (selectedWarehouse?.warehouse_code ?? null) : null,
                        transferTargetWarehouseName: canManageWarehouseTransfer && depotTransferRequest ? (selectedWarehouse?.warehouse_name ?? null) : null,
                      });
                    } catch (error) {
                      if (isLogoEInvoiceDetailedOnlyError(error)) {
                        setVatSummaryMode("detailed");
                        setItemVatSummaryModes({});
                        toast.error(LOGO_E_INVOICE_DETAILED_ONLY_MESSAGE);
                      }

                      return;
                    }

                    if (isWarehouseUser) {
                      router.replace("/warehouse");
                    }

                    setSelectedProductIds([]);
                  })()}
                >
                  {mutating ? <Loader2 className="h-9 w-9 animate-spin" /> : <PackageCheck className="h-9 w-9" />}
                  {!canCheckout ? "Yetki Yok" : mutating ? "İşleniyor..." : "Gönder"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {deleteDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-[24px] border border-red-300/30 bg-[radial-gradient(circle_at_16%_14%,rgba(248,113,113,0.24)_0%,transparent_34%),linear-gradient(145deg,rgba(16,28,31,0.98)_0%,rgba(8,19,22,0.98)_100%)] p-5 text-center shadow-[0_30px_80px_rgba(0,0,0,0.46)]">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-red-300/35 bg-red-500/12 text-red-200">
              <Trash2 className="h-6 w-6" />
            </div>
            <h3 className="mt-4 text-xl font-black text-white">
              {deleteDialog === "all" ? "Tüm sepet silinsin mi?" : "Seçilen ürünler silinsin mi?"}
            </h3>
            <p className="mt-2 text-sm font-semibold leading-6 text-white/68">
              {deleteDialog === "all"
                ? "Sepetteki tüm ürünleri silmek istediğine emin misin?"
                : `${selectedProductIds.length} seçili ürünü silmek istediğine emin misin?`}
            </p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-11 rounded-xl border-white/15 bg-white/6 font-black text-white hover:bg-white/10"
                disabled={mutating}
                onClick={() => setDeleteDialog(null)}
              >
                Vazgeç
              </Button>
              <Button
                type="button"
                className="h-11 rounded-xl border border-red-300/40 bg-[linear-gradient(135deg,#ff5a5f_0%,#e11d2e_48%,#8f1118_100%)] font-black text-white shadow-[0_16px_30px_rgba(225,29,46,0.28)] hover:brightness-110"
                disabled={mutating}
                onClick={() => void confirmDeleteItems()}
              >
                {mutating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Evet
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {shippingFeeConfirmOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/72 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg overflow-hidden rounded-[30px] border border-[#ffff00]/55 bg-[radial-gradient(circle_at_18%_16%,rgba(255,255,0,0.3)_0%,transparent_34%),linear-gradient(145deg,rgba(13,34,26,0.98)_0%,rgba(6,17,14,0.99)_100%)] p-6 text-center shadow-[0_34px_90px_-42px_rgba(255,255,0,0.9)]">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[22px] border border-[#ffff00]/60 bg-[#ffff00] text-slate-950 shadow-[0_18px_34px_-20px_rgba(255,255,0,0.95)]">
              {shippingMethod === "otobus" ? <Bus className="h-8 w-8" /> : <Truck className="h-8 w-8" />}
            </div>
            <p className="mt-5 text-xs font-black uppercase tracking-[0.3em] text-[#ffff00]">Ulaşım Bedeli Onayı</p>
            <h3 className="mt-2 text-2xl font-black text-white">
              Sipariş toplamına {formatTryAmount(shippingFeeAmount, displayCurrency)} eklenecek
            </h3>
            <p className="mx-auto mt-3 max-w-md text-sm font-semibold leading-6 text-emerald-50/72">
              Seçtiğin gönderim şekli için kargo / otobüs bedeli sipariş toplamına dahil edilecek. Devam etmek istiyor musun?
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <Button
                type="button"
                variant="outline"
                className="h-12 rounded-2xl border-white/15 bg-white/6 font-black text-white hover:bg-white/10"
                onClick={() => setShippingFeeConfirmOpen(false)}
              >
                Vazgeç
              </Button>
              <Button
                type="button"
                className="h-12 rounded-2xl border border-[#ffff00]/60 bg-[#ffff00] font-black text-slate-950 shadow-[0_18px_30px_-18px_rgba(255,255,0,0.9)] hover:bg-[#ffff00] hover:brightness-105"
                onClick={() => {
                  setShippingFeeConfirmed(true);
                  setShippingFeeConfirmOpen(false);
                }}
              >
                Devam Et
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
