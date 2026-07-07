"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  ShieldCheck,
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
import { bulkUpsertCartItems, type CartWarehouseOption } from "@/lib/api";

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
  excluded: { code: "2-O", label: "2 - O" },
  included: { code: "3-B", label: "3 - B" },
};

function warehouseOptionKey(option: CartWarehouseOption): string {
  return option.warehouse_code ?? option.warehouse_name;
}

function toAmount(value: string): number {
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatTry(value: string, currency = "TRY"): string {
  return formatTryAmount(toAmount(value), currency);
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

function formatCartDateTime(value?: string | null): string {
  if (!value) {
    return "henüz yok";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
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
  const { selectedCustomer, user } = useSession();
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<PaymentMethodKey>("current_account");
  const [selectedCombinedPaymentMethod, setSelectedCombinedPaymentMethod] = useState<CombinedPaymentKey>("bank_transfer");
  const [selectedWarehouseKey, setSelectedWarehouseKey] = useState("");
  const [quantityDrafts, setQuantityDrafts] = useState<Record<number, string>>({});
  const [vatSummaryMode, setVatSummaryMode] = useState<VatSummaryMode>("detailed");
  const [bulkUploading, setBulkUploading] = useState(false);
  const [bulkUploadResults, setBulkUploadResults] = useState<Array<{ product_code: string; quantity: number; status: string; message: string }>>([]);
  const bulkUploadInputRef = useRef<HTMLInputElement | null>(null);
  const {
    cartData,
    loading,
    mutating,
    error,
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

  useEffect(() => {
    setShippingMethod("depo_teslim");
  }, [setShippingMethod]);

  const items = useMemo(() => cartData?.items ?? [], [cartData?.items]);
  const warehouseOptions = useMemo(() => cartData?.warehouse_options ?? [], [cartData?.warehouse_options]);
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
  const logoIntegration = cartData?.logo_integration;
  const logoIntegrationReady = logoIntegration?.order_will_queue === true;
  const logoIntegrationText = logoIntegration
    ? `${logoIntegration.items_ready}/${logoIntegration.items_total} ürün hazır · son stok sync ${formatCartDateTime(logoIntegration.latest_product_synced_at)}`
    : "Logo durumu yükleniyor";
  const selectedPayment = PAYMENT_METHODS.find((method) => method.key === selectedPaymentMethod) ?? PAYMENT_METHODS[0];
  const selectedCombinedPayment = COMBINED_PAYMENT_OPTIONS.find((method) => method.key === selectedCombinedPaymentMethod) ?? COMBINED_PAYMENT_OPTIONS[0];
  const defaultWarehouseKey = useMemo(() => {
    const bestOption = warehouseOptions.find((option) => option.missing_quantity <= 0) ?? warehouseOptions[0] ?? null;
    return bestOption ? warehouseOptionKey(bestOption) : "";
  }, [warehouseOptions]);
  const effectiveSelectedWarehouseKey = warehouseOptions.some((option) => warehouseOptionKey(option) === selectedWarehouseKey)
    ? selectedWarehouseKey
    : defaultWarehouseKey;
  const selectedWarehouse =
    warehouseOptions.find((option) => warehouseOptionKey(option) === effectiveSelectedWarehouseKey) ?? null;
  const isCombinedPayment = selectedPayment.key === "cash_transfer_single";
  const selectedPaymentMultiplier = isCombinedPayment ? selectedCombinedPayment.multiplier : selectedPayment.multiplier;
  const selectedPaymentTitle = isCombinedPayment ? selectedCombinedPayment.label : selectedPayment.title;
  const selectedCheckoutSummary = CHECKOUT_SUMMARY_MODES[vatSummaryMode];
  const selectedShippingMethod = SHIPPING_METHODS.find((option) => option.value === shippingMethod);
  const isBatumBranch = useMemo(() => {
    const batumScopeValues = [
      selectedCustomer?.branch_code,
      selectedCustomer?.branch_name,
      selectedCustomer?.region_code,
      selectedCustomer?.region_name,
      selectedCustomer?.title,
      user?.branch_code,
      user?.branch_name,
      user?.region_code,
      user?.region_name,
    ];

    return batumScopeValues.some(includesBatum) || selectedCustomer?.code?.trim().startsWith("120-00-") === true;
  }, [
    selectedCustomer?.branch_code,
    selectedCustomer?.branch_name,
    selectedCustomer?.code,
    selectedCustomer?.region_code,
    selectedCustomer?.region_name,
    selectedCustomer?.title,
    user?.branch_code,
    user?.branch_name,
    user?.region_code,
    user?.region_name,
  ]);
  const noteStepNumber = isBatumBranch ? 2 : 3;
  const summaryStepNumber = isBatumBranch ? 3 : 4;
  const effectiveVatSummaryMode = isBatumBranch ? "included" : vatSummaryMode;
  const shouldShowShippingFeeNotice =
    (shippingMethod === "otobus" || shippingMethod === "kargo") && grandTotal > SHIPPING_FEE_THRESHOLD;
  const shippingFeeAmount = shouldShowShippingFeeNotice ? SHIPPING_FEE_AMOUNT : 0;
  const selectedPayableTotal = (effectiveVatSummaryMode === "excluded" ? subtotal : grandTotal) * selectedPaymentMultiplier + shippingFeeAmount;
  const isBankTransferPayment =
    Boolean(isCombinedPayment && "requiresReference" in selectedCombinedPayment && selectedCombinedPayment.requiresReference);
  const generatedTransferReference = [
    "PWR",
    selectedCustomer?.code?.trim() || selectedCustomer?.id || "CARI",
    cartData?.cart?.id ? `S${cartData.cart.id}` : "SEPET",
  ]
    .join("-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .toLocaleUpperCase("tr-TR");
  const isFormDisabled = loading || mutating || !selectedCustomer;
  const isCustomerUser = useMemo(() => user?.roles.some((role) => role.slug === "customer") ?? false, [user?.roles]);
  const featurePermissionSet = useMemo(() => new Set(user?.feature_permissions ?? []), [user?.feature_permissions]);
  const canCheckout = !isCustomerUser || featurePermissionSet.has("cart.checkout");
  const isCheckoutDisabled = mutating || loading || items.length === 0 || !selectedCustomer || !canCheckout;
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
    const paymentNoteParts = isBatumBranch
      ? []
      : [
          `Ödeme tercihi: ${selectedPaymentTitle}`,
          `Satış tipi: ${selectedCheckoutSummary.label}`,
          `Ekranda gösterilen ödeme tutarı: ${formatTryAmount(selectedPayableTotal, currency)}`,
        ];

    if (!isBatumBranch && vatSummaryMode !== "detailed") {
      paymentNoteParts.push(`Özet gösterimi: ${vatSummaryMode === "excluded" ? "KDV hariç" : "KDV dahil"}`);
    }

    if (!isBatumBranch && isBankTransferPayment) {
      paymentNoteParts.push(`Referans kodu: ${generatedTransferReference}`);
    }

    if (shippingFeeAmount > 0) {
      paymentNoteParts.push(`Ulaşım / nakliye bedeli: ${formatTryAmount(shippingFeeAmount, currency)}`);
    }

    if (!isBatumBranch && selectedWarehouse) {
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
  }, [currency, generatedTransferReference, isBankTransferPayment, isBatumBranch, orderNote, selectedCheckoutSummary.label, selectedPayableTotal, selectedPaymentTitle, selectedWarehouse, shippingFeeAmount, vatSummaryMode]);

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

      <Card className="dashboard-panel-card order-1 overflow-hidden">
        <CardContent className="space-y-3 p-3 2xl:p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <StepTitle step={1} title="Excel ile Sepete Ekle" icon={FileSpreadsheet} />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button
                type="button"
                variant="outline"
                className="admin-dashboard-ghost h-11 rounded-xl px-4 text-sm font-black"
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
                className="admin-primary-action h-11 rounded-xl px-4 text-sm font-black"
                disabled={bulkUploading || !selectedCustomer}
                onClick={() => bulkUploadInputRef.current?.click()}
              >
                {bulkUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Excel Yükle
              </Button>
            </div>
          </div>
          <p className="text-sm font-semibold text-[var(--muted-foreground)]">
            Excel formatı: <span className="font-black text-[var(--foreground)]">Ürün Kodu</span> ve{" "}
            <span className="font-black text-[var(--foreground)]">Miktar</span>. Yüklenen ürünler doğrudan seçili carinin sepetine eklenir.
          </p>
          {bulkUploadResults.length > 0 ? (
            <div className="rounded-xl border border-[var(--brand-border)] bg-[var(--surface-soft)] p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                <FileSpreadsheet className="h-4 w-4 text-[var(--brand-primary)]" />
                Toplu sepet sonucu
              </div>
              <div className="grid max-h-40 gap-1 overflow-auto text-sm font-semibold sm:grid-cols-2 lg:grid-cols-3">
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
        </CardContent>
      </Card>

      {!isBatumBranch ? (
        <Card className="dashboard-panel-card order-2 overflow-hidden">
          <CardContent className="space-y-3 p-3 2xl:p-4">
            <StepTitle step={2} title="Ödeme Şekli" />

            <div className="grid gap-2.5 md:grid-cols-2 2xl:gap-3">
              {PAYMENT_METHODS.map((method) => {
                const Icon = method.icon;
                const active = selectedPaymentMethod === method.key;
                const methodBadge = method.key === "cash_transfer_single" ? selectedCombinedPayment.badge : method.badge;
                const methodMultiplier = method.key === "cash_transfer_single" ? selectedCombinedPayment.multiplier : method.multiplier;
                const payableTotal = grandTotal * methodMultiplier + shippingFeeAmount;

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
                          {formatTryAmount(payableTotal, currency)}
                        </span>
                      </span>
                    </span>

                    {method.key === "cash_transfer_single" ? (
                      <span className="grid w-full grid-cols-3 gap-1 rounded-[12px] border border-white/10 bg-black/12 p-1">
                        {COMBINED_PAYMENT_OPTIONS.map((option) => {
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
          <StepTitle step={1} title="Ürün Listesi" />

          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={`cart-page-skeleton-${index}`} className="h-24 w-full rounded-[18px] md:h-28" />
              ))}
            </div>
          ) : null}

          {error ? <p className="text-sm text-red-400">{error}</p> : null}

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
                    {items.map((item) => (
                      <tr key={item.id} className="border-b border-[var(--brand-border)] last:border-b-0">
                        <td className="border-r border-[var(--brand-border)] px-4 py-4 text-right align-middle text-base font-black text-emerald-300">
                          {formatStock(item.available_total)}
                        </td>
                        <td className="border-r border-[var(--brand-border)] px-4 py-4 align-middle">
                          <p className="truncate text-sm font-black text-[var(--foreground)]">{item.sku}</p>
                        </td>
                        <td className="border-r border-[var(--brand-border)] px-4 py-4 align-middle">
                          <p className="line-clamp-2 text-base font-black leading-6 text-[var(--foreground)]">{item.name}</p>
                          {item.campaign_key ? (
                            <span className="mt-1 inline-flex rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-emerald-300">
                              Kampanya aktif
                            </span>
                          ) : null}
                        </td>
                        <td className="border-r border-[var(--brand-border)] px-4 py-4 align-middle">
                          <p className="truncate text-sm font-black text-[var(--foreground)]">{item.brand ?? "-"}</p>
                        </td>
                        <td className="border-r border-[var(--brand-border)] px-4 py-4 text-right align-middle text-base font-black text-[var(--foreground)]">
                          {formatTry(item.unit_net_price, item.currency)}
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
                          {formatTry(item.line_total, item.currency)}
                        </td>
                        <td className="px-3 py-4 text-center align-middle">
                          <Button type="button" variant="outline" size="icon" className="h-10 w-10 rounded-[12px] border-red-500/35 bg-red-500/5 text-red-400 hover:bg-red-500/10 hover:text-red-300" onClick={() => void removeItemByProduct(item.product_id)} disabled={isFormDisabled} aria-label="Kalemi kaldır">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="order-3 grid gap-4 xl:grid-cols-[minmax(330px,0.78fr)_minmax(430px,1.22fr)] 2xl:grid-cols-[minmax(420px,0.82fr)_minmax(520px,1.18fr)]">
        <div className="grid gap-4">
          <Card className="dashboard-panel-card overflow-hidden">
            <CardContent className="space-y-3 p-4 2xl:p-5">
              <StepTitle step={noteStepNumber} title="Sipariş Notu" icon={PencilLine} />

              <div className="rounded-[16px] border border-cyan-200/18 bg-[linear-gradient(135deg,rgba(14,116,144,0.18)_0%,rgba(6,24,32,0.64)_100%)] p-3">
                <Textarea
                  value={orderNote}
                  onChange={(event) => setOrderNote(event.target.value)}
                  placeholder="Sipariş notu yazın..."
                  disabled={isFormDisabled}
                  className="min-h-[68px] rounded-[14px] border-cyan-100/16 bg-black/16 text-sm font-semibold text-white placeholder:text-cyan-50/42 focus-visible:ring-cyan-200/40"
                />
              </div>

              <div className="space-y-2">
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
              </div>

              {!isBatumBranch ? (
                <div className="rounded-[18px] border border-emerald-300/25 bg-[radial-gradient(circle_at_8%_16%,rgba(52,211,153,0.18)_0%,transparent_34%),linear-gradient(135deg,rgba(6,48,37,0.86)_0%,rgba(6,24,32,0.96)_100%)] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-300/14 text-emerald-100 ring-1 ring-emerald-200/20">
                        <Warehouse className="h-4.5 w-4.5" />
                      </span>
                      <div>
                        <p className="text-sm font-black text-white">Depo Transfer</p>
                        <p className="text-xs font-semibold text-emerald-50/68">Hazırlanacak depo</p>
                      </div>
                    </div>
                    {selectedWarehouse ? (
                      <span className="w-fit rounded-full border border-emerald-100/20 bg-emerald-300/12 px-3 py-1 text-xs font-black text-emerald-50">
                        {selectedWarehouse.warehouse_name}
                      </span>
                    ) : null}
                  </div>

                  {warehouseOptions.length > 0 ? (
                    <div className="mt-3 grid gap-2">
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
                              "rounded-[14px] border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50",
                              active
                                ? "border-emerald-100/70 bg-[linear-gradient(135deg,rgba(52,211,153,0.94)_0%,rgba(21,128,61,0.94)_100%)] text-slate-950 shadow-[0_18px_32px_-24px_rgba(52,211,153,0.9)]"
                                : "border-white/10 bg-white/8 text-emerald-50/82 hover:border-emerald-100/35 hover:bg-white/12"
                            )}
                          >
                            <span className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-black">{warehouse.warehouse_name}</span>
                                <span className={cn("mt-1 block text-xs font-bold", active ? "text-slate-900/70" : "text-emerald-50/58")}>
                                  Kod: {warehouse.warehouse_code ?? "-"} · Kalem: {warehouse.item_count || "-"}
                                </span>
                              </span>
                              <span className="flex flex-wrap gap-2 text-xs font-black">
                                <span className={cn("rounded-[10px] px-2 py-1", active ? "bg-white/28" : "bg-black/14")}>
                                  Stok {formatStock(warehouse.available_total)}
                                </span>
                                <span
                                  className={cn(
                                    "rounded-[10px] px-2 py-1",
                                    hasEnoughStock
                                      ? active ? "bg-white/28" : "bg-emerald-300/12 text-emerald-100"
                                      : active ? "bg-amber-200/70" : "bg-amber-300/12 text-amber-100"
                                  )}
                                >
                                  {hasEnoughStock ? "Yeterli" : `Eksik ${formatStock(warehouse.missing_quantity)}`}
                                </span>
                                {active ? <CheckCircle2 className="h-5 w-5 shrink-0" /> : null}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="mt-3 rounded-[14px] border border-dashed border-emerald-100/20 bg-black/10 px-3 py-2 text-sm font-semibold text-emerald-50/70">
                      Bu sepet için depo stok kırılımı bulunamadı.
                    </div>
                  )}
                </div>
              ) : null}
              {shouldShowShippingFeeNotice ? (
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
	                        {formatTryAmount(SHIPPING_FEE_THRESHOLD, currency)} üzerindeki siparişlerde ulaşım/nakliye bedeli
	                        {" "}
	                        <strong className="font-black text-amber-100">{formatTryAmount(SHIPPING_FEE_AMOUNT, currency)}</strong>
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

        <Card className="dashboard-panel-card overflow-hidden">
          <CardContent className={cn(
            "grid gap-5 p-4 2xl:gap-6 2xl:p-6",
            isBatumBranch
              ? "lg:grid-cols-[minmax(260px,1fr)_minmax(260px,0.58fr)]"
              : "lg:grid-cols-[minmax(280px,1fr)_minmax(340px,0.86fr)]"
          )}>
            <div>
              <StepTitle step={summaryStepNumber} title="Sipariş Özeti" />
              <div className="mt-5 space-y-3">
                {!isBatumBranch && effectiveVatSummaryMode === "detailed" ? (
                  <>
                    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 text-base">
                      <span className="text-[var(--muted-foreground)]">Ara Toplam</span>
                      <span className="h-px bg-[var(--brand-border)]" />
                      <strong>{formatTryAmount(subtotal, currency)}</strong>
                    </div>
	                    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 text-base">
	                      <span className="text-[var(--muted-foreground)]">KDV (%20)</span>
	                      <span className="h-px bg-[var(--brand-border)]" />
	                      <strong>{formatTryAmount(vatTotal, currency)}</strong>
	                    </div>
	                  </>
	                ) : null}
                {!isBatumBranch && effectiveVatSummaryMode === "excluded" ? (
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
                    <strong className="text-amber-100">{formatTryAmount(shippingFeeAmount, currency)}</strong>
                  </div>
                ) : null}
	                <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 pt-3 text-lg">
	                  <span className="font-black text-[var(--foreground)]">Genel Toplam</span>
                  <span className="h-px bg-[var(--brand-border)]" />
                  <strong className="text-2xl text-emerald-300 2xl:text-3xl">{formatTryAmount(selectedPayableTotal, currency)}</strong>
                </div>
                <div
                  className={cn(
                    "rounded-[16px] border px-3 py-2 text-sm font-bold",
                    logoIntegrationReady
                      ? "border-emerald-300/35 bg-emerald-500/10 text-emerald-100"
                      : "border-amber-300/35 bg-amber-500/10 text-amber-100"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 shrink-0" />
                    <span className="font-black">{logoIntegrationReady ? "Logo Hazır" : "Logo Kontrol"}</span>
                  </div>
                  <p className="mt-1 text-xs leading-5 opacity-85">{logoIntegrationText}</p>
                </div>
              </div>
            </div>

            <div className={cn(
              "items-stretch gap-4 border-t border-[var(--brand-border)] pt-5 lg:border-l lg:border-t-0 lg:pl-7 lg:pt-0",
              isBatumBranch ? "flex min-w-0 flex-col justify-center" : "grid grid-cols-[76px_minmax(0,1fr)]"
            )}>
              {!isBatumBranch ? (
              <div className="grid gap-2 rounded-[18px] border border-emerald-300/25 bg-[linear-gradient(135deg,rgba(7,23,29,0.92)_0%,rgba(5,37,28,0.92)_100%)] p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
                <button
                  type="button"
                  onClick={() => setVatSummaryMode("detailed")}
                  aria-label="1 - F özet görünümü"
                  aria-pressed={vatSummaryMode === "detailed"}
                  className={cn(
                    "group flex min-h-16 items-center justify-center rounded-[16px] border text-base font-black transition duration-200",
                    vatSummaryMode === "detailed"
                      ? "border-emerald-200 bg-[radial-gradient(circle_at_26%_20%,rgba(187,247,208,0.34)_0%,transparent_34%),linear-gradient(135deg,rgba(16,185,129,0.96)_0%,rgba(3,92,64,0.98)_100%)] text-white shadow-[0_16px_32px_-20px_rgba(16,185,129,0.9)]"
                      : "border-emerald-300/18 bg-emerald-500/8 text-emerald-100/80 hover:border-emerald-200/70 hover:bg-emerald-500/18"
                  )}
                >
                  <span className="flex h-9 min-w-14 items-center justify-center rounded-full bg-white/14 px-2 ring-1 ring-white/18">
                    {CHECKOUT_SUMMARY_MODES.detailed.label}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setVatSummaryMode("excluded")}
                  aria-label="2 - O özet görünümü"
                  aria-pressed={vatSummaryMode === "excluded"}
                  className={cn(
                    "group flex min-h-16 items-center justify-center rounded-[16px] border text-base font-black transition duration-200",
                    vatSummaryMode === "excluded"
                      ? "border-sky-200 bg-[radial-gradient(circle_at_26%_20%,rgba(186,230,253,0.34)_0%,transparent_34%),linear-gradient(135deg,rgba(14,165,233,0.96)_0%,rgba(7,89,133,0.98)_100%)] text-white shadow-[0_16px_32px_-20px_rgba(14,165,233,0.9)]"
                      : "border-sky-300/18 bg-sky-500/8 text-sky-100/80 hover:border-sky-200/70 hover:bg-sky-500/18"
                  )}
                >
                  <span className="flex h-9 min-w-14 items-center justify-center rounded-full bg-white/14 px-2 ring-1 ring-white/18">
                    {CHECKOUT_SUMMARY_MODES.excluded.label}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setVatSummaryMode("included")}
                  aria-label="3 - B özet görünümü"
                  aria-pressed={vatSummaryMode === "included"}
                  className={cn(
                    "group flex min-h-16 items-center justify-center rounded-[16px] border text-base font-black transition duration-200",
                    vatSummaryMode === "included"
                      ? "border-fuchsia-200 bg-[radial-gradient(circle_at_26%_20%,rgba(245,208,254,0.34)_0%,transparent_34%),linear-gradient(135deg,rgba(192,38,211,0.94)_0%,rgba(91,33,182,0.98)_100%)] text-white shadow-[0_16px_32px_-20px_rgba(192,38,211,0.86)]"
                      : "border-fuchsia-300/18 bg-fuchsia-500/8 text-fuchsia-100/80 hover:border-fuchsia-200/70 hover:bg-fuchsia-500/18"
                  )}
                >
                  <span className="flex h-9 min-w-14 items-center justify-center rounded-full bg-white/14 px-2 ring-1 ring-white/18">
                    {CHECKOUT_SUMMARY_MODES.included.label}
                  </span>
                </button>
              </div>
              ) : null}
              <div className="flex min-w-0 flex-col justify-center gap-3">
                <Button
                  className={cn(
                    "w-full rounded-[18px] border border-red-300/45 !bg-[radial-gradient(circle_at_18%_18%,rgba(254,202,202,0.3)_0%,transparent_34%),linear-gradient(135deg,rgba(239,68,68,0.98)_0%,rgba(153,27,27,1)_100%)] px-4 text-2xl font-black uppercase tracking-[0.05em] !text-white shadow-[0_28px_48px_-26px_rgba(239,68,68,0.95),inset_0_1px_0_rgba(255,255,255,0.22)] hover:!bg-[radial-gradient(circle_at_18%_18%,rgba(254,202,202,0.36)_0%,transparent_34%),linear-gradient(135deg,rgba(248,113,113,1)_0%,rgba(185,28,28,1)_100%)] 2xl:text-3xl",
                    isBatumBranch ? "min-h-36" : "aspect-square min-h-44"
                  )}
                  disabled={isCheckoutDisabled}
                  onClick={() => void createOrderFromCart({
                    note: checkoutNote,
                    checkoutSummaryMode: isBatumBranch ? undefined : effectiveVatSummaryMode,
                    paymentMethod: isCombinedPayment ? selectedCombinedPayment.key : selectedPayment.key,
                    salesPriceType: selectedPaymentTitle,
                  })}
                >
                  {mutating ? <Loader2 className="h-9 w-9 animate-spin" /> : <PackageCheck className="h-9 w-9" />}
                  {!canCheckout ? "Yetki Yok" : mutating ? "İşleniyor..." : "Gönder"}
                </Button>
                <p className="flex items-center gap-2 text-sm font-semibold leading-snug text-[var(--muted-foreground)]">
                  <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-300" />
                  256-bit SSL ile korunmaktadır.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
