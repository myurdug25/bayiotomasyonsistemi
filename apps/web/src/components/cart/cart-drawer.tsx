"use client";

import Link from "next/link";
import { CheckCircle2, Loader2, Minus, Plus, ShoppingCart } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { fetchCampaignProgress } from "@/lib/api";

import { useSession } from "@/components/auth/session-provider";
import { useCart } from "@/components/cart/cart-provider";
import { CampaignPanel } from "@/components/campaigns/campaign-progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const SHIPPING_METHODS = [
  { value: "kargo", label: "Kargo" },
  { value: "depo_teslim", label: "Depo Teslim" },
  { value: "kendi_arac", label: "Kendi Araç" },
];

function formatCompactTry(value: string): string {
  const parsed = Number(value.replace(",", "."));
  if (!Number.isFinite(parsed)) {
    return `${value} TRY`;
  }

  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 0,
  }).format(parsed);
}

export function CartDrawer({ darkMode = false }: { darkMode?: boolean }) {
  const { selectedCustomer } = useSession();
  const {
    open,
    setOpen,
    cartData,
    loading,
    mutating,
    error,
    shippingMethod,
    effectiveWarehouseTransfer,
    warehouseTransferRequired,
    orderNote,
    setShippingMethod,
    setWarehouseTransfer,
    setOrderNote,
    upsertQuantity,
    removeItemByProduct,
    createOrderFromCart,
  } = useCart();

  const items = cartData?.items ?? [];
  const isFormDisabled = loading || mutating || !selectedCustomer;
  const isCheckoutDisabled = mutating || loading || items.length === 0 || !selectedCustomer;
  const lineCount = cartData?.totals.line_count ?? 0;
  const grandTotal = formatCompactTry(cartData?.totals.grand_total ?? "0.00");
  const totalQuantity = items.reduce(
    (sum, item) => sum + Math.max(0, Number(item.quantity ?? item.qty ?? 0)),
    0
  );
  const hasItems = lineCount > 0;

  const campaignProgressQuery = useQuery({
    queryKey: ["campaignProgress", selectedCustomer?.id],
    queryFn: async () => {
      if (!selectedCustomer?.id) return { data: [] };
      return fetchCampaignProgress(selectedCustomer.id);
    },
    enabled: Boolean(selectedCustomer?.id) && open,
    staleTime: 60_000,
  });

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="secondary"
          className={cn(
            "group relative h-11 min-w-[154px] justify-start gap-2 rounded-[14px] border px-3 shadow-[0_14px_28px_-20px_rgba(0,0,0,0.55)] transition-all duration-200 hover:-translate-y-0.5 hover:brightness-[0.99] active:scale-[0.99] lg:min-w-[168px]",
            darkMode
              ? hasItems
                ? "border-[var(--brand-border)] bg-[linear-gradient(135deg,color-mix(in_oklab,var(--brand-primary-soft)_74%,black)_0%,color-mix(in_oklab,var(--surface)_86%,var(--brand-primary-soft))_58%,color-mix(in_oklab,var(--surface-soft)_84%,var(--brand-primary))_100%)] text-[var(--brand-primary-strong)]"
                : "border-[var(--brand-border)] bg-[linear-gradient(135deg,color-mix(in_oklab,var(--surface)_92%,black)_0%,color-mix(in_oklab,var(--surface-soft)_88%,black)_100%)] text-[var(--foreground)]"
              : hasItems
                ? "border-[var(--brand-border)] bg-[linear-gradient(135deg,color-mix(in_oklab,var(--brand-accent)_78%,white)_0%,color-mix(in_oklab,var(--brand-primary-soft)_88%,var(--brand-accent))_58%,color-mix(in_oklab,var(--brand-primary-soft)_76%,var(--brand-primary))_100%)] text-[var(--brand-primary-strong)]"
                : "border-[var(--brand-border)] bg-[linear-gradient(135deg,color-mix(in_oklab,var(--surface)_96%,white)_0%,color-mix(in_oklab,var(--surface-soft)_94%,white)_100%)] text-[var(--brand-primary-strong)]"
          )}
        >
          <span
            className={cn(
              "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] shadow-[inset_0_1px_0_rgba(255,255,255,0.65)]",
              darkMode
                ? hasItems
                  ? "bg-[color-mix(in_oklab,var(--brand-accent-soft)_48%,var(--surface))] text-[var(--brand-accent)]"
                  : "bg-[var(--surface-soft)] text-[var(--muted-foreground)]"
                : hasItems
                  ? "bg-[color-mix(in_oklab,var(--brand-accent)_88%,white)] text-[var(--brand-primary-strong)]"
                  : "bg-[var(--surface)] text-[var(--muted-foreground)]"
            )}
          >
            <ShoppingCart className="h-4 w-4" />
          </span>
          <span className="flex min-w-0 flex-1 items-center text-left leading-none">
            <span className="truncate text-[13px] font-extrabold">
              {hasItems ? `${lineCount} kalem · ${totalQuantity} adet` : "Sepet boş"}
            </span>
          </span>
          <span
            className={cn(
              "inline-flex max-w-[82px] shrink-0 items-center justify-center gap-1 rounded-[10px] border px-2 py-1 text-[11px] font-extrabold",
              darkMode
                ? hasItems
                  ? "border-[var(--brand-border)] bg-[color-mix(in_oklab,var(--brand-primary-soft)_58%,var(--surface))] text-[var(--brand-accent)]"
                  : "border-[var(--brand-border)] bg-[var(--surface-soft)] text-[var(--muted-foreground)]"
                : hasItems
                  ? "border-[var(--brand-border)] bg-[color-mix(in_oklab,var(--brand-accent)_88%,white)] text-[var(--brand-primary-strong)]"
                  : "border-[var(--brand-border)] bg-[var(--surface)] text-[var(--muted-foreground)]"
            )}
          >
            <span className="truncate">{grandTotal}</span>
          </span>
          <Badge
            className={cn(
              "absolute -right-1.5 -top-1.5 border-none px-1.5 py-0 text-[10px] shadow-[0_6px_10px_-8px_rgba(0,0,0,0.6)]",
              darkMode
                ? hasItems
                  ? "bg-[var(--brand-accent)] text-[var(--brand-accent-foreground)]"
                  : "bg-[var(--surface-soft)] text-[var(--foreground)]"
                : hasItems
                  ? "bg-[var(--brand-primary)] text-[var(--primary-foreground)]"
                  : "bg-[var(--surface-soft)] text-[var(--brand-primary-strong)]"
            )}
            variant="secondary"
          >
            {lineCount}
          </Badge>
        </Button>
      </SheetTrigger>

      <SheetContent side="right" className="flex h-full flex-col">
        <SheetHeader>
          <SheetTitle>Aktif Sepet</SheetTitle>
          <SheetDescription>
            {selectedCustomer
              ? `${selectedCustomer.code} - ${selectedCustomer.title}`
              : "Önce müşteri seçin"}
          </SheetDescription>
        </SheetHeader>

        {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}

        <Separator className="my-4" />

        <ScrollArea className="flex-1 pr-2">
          {campaignProgressQuery.data?.data && campaignProgressQuery.data.data.length > 0 && (
            <div className="mb-4">
              <CampaignPanel campaigns={campaignProgressQuery.data.data} />
            </div>
          )}

          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, index) => (
                <div
                  key={`cart-drawer-skeleton-${index}`}
                  className="rounded-xl border border-[var(--brand-border)] bg-[var(--surface)] p-3"
                >
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="mt-2 h-3 w-1/2" />
                  <div className="mt-3 flex items-center justify-between">
                    <Skeleton className="h-8 w-24" />
                    <Skeleton className="h-8 w-20" />
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {!loading && items.length === 0 ? (
            <div className="space-y-2 rounded-md border border-dashed border-[var(--brand-border)] bg-[var(--surface)]/65 p-4 text-sm text-[var(--muted-foreground)]">
              <p>Sepet boş.</p>
              <Button asChild size="sm" variant="outline" className="w-full">
                <Link href="/search" onClick={() => setOpen(false)}>
                  Ürünlere Git
                </Link>
              </Button>
            </div>
          ) : null}

          <div className="space-y-3">
            {items.map((item) => (
              <div key={item.id} className="rounded-xl border border-[var(--brand-border)] bg-[var(--surface)] p-3">
                <p className="line-clamp-1 text-sm font-semibold">{item.name}</p>
                <p className="text-xs text-[var(--muted-foreground)]">{item.sku}</p>
                {item.campaign_key ? (() => {
                  const campaign = campaignProgressQuery.data?.data?.find((c) => c.code === item.campaign_key);
                  const discountStr = campaign?.discount_percent ? ` (%${campaign.discount_percent})` : '';
                  return (
                    <span className="mt-2 inline-flex rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-emerald-300">
                      Kampanya Uygulandı{discountStr}
                    </span>
                  );
                })() : null}

                <div className="mt-3 flex items-center justify-between">
                  <div className="inline-flex items-center gap-1 rounded-md border border-[var(--brand-border)] p-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => void upsertQuantity(item.product_id, item.quantity - 1)}
                      disabled={isFormDisabled}
                    >
                      <Minus className="h-3 w-3" />
                    </Button>
                    <span className="w-7 text-center text-sm">{item.quantity}</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => void upsertQuantity(item.product_id, item.quantity + 1)}
                      disabled={isFormDisabled}
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                  </div>

                  <div className="text-right">
                    <p className="text-sm font-semibold">
                      {item.line_total} {item.currency}
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-auto p-0 text-xs text-[var(--muted-foreground)] underline-offset-2 hover:underline"
                      onClick={() => void removeItemByProduct(item.product_id)}
                      disabled={isFormDisabled}
                    >
                      kaldır
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 space-y-3 rounded-lg border border-[var(--brand-border)] bg-[var(--surface-soft)] p-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">
                Gönderme Şekli
              </label>
              <Select value={shippingMethod} onValueChange={setShippingMethod} disabled={isFormDisabled}>
                <SelectTrigger>
                  <SelectValue placeholder="Seçiniz" />
                </SelectTrigger>
                <SelectContent>
                  {SHIPPING_METHODS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={effectiveWarehouseTransfer}
                  onChange={(event) => setWarehouseTransfer(event.target.checked)}
                  disabled={isFormDisabled || warehouseTransferRequired}
                  className="h-4 w-4 rounded border-[var(--brand-border)]"
                />
                Depoya Gönder
              </label>

            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">
                Plasiyer / Müşteri Notu
              </label>
              <Textarea
                value={orderNote}
                onChange={(event) => setOrderNote(event.target.value)}
                placeholder="Sipariş notuna düşecek not..."
                disabled={isFormDisabled}
              />
            </div>
          </div>
        </ScrollArea>

        <SheetFooter>
          <div className="w-full space-y-3">
            <div className="rounded-lg border border-[var(--brand-border)] bg-[var(--surface)] p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-[var(--muted-foreground)]">Ara Toplam</span>
                <span>{cartData?.totals.subtotal ?? "0.00"} TRY</span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-[var(--muted-foreground)]">İskonto</span>
                <span>{cartData?.totals.discount_total ?? "0.00"} TRY</span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-[var(--muted-foreground)]">KDV</span>
                <span>{cartData?.totals.vat_total ?? "0.00"} TRY</span>
              </div>
              <div className="mt-2 flex items-center justify-between border-t border-[var(--brand-border)] pt-2">
                <span className="font-semibold">Genel Toplam</span>
                <span className="font-semibold">
                  {cartData?.totals.grand_total ?? "0.00"} TRY
                </span>
              </div>
            </div>

            <Button asChild variant="outline" className="w-full">
              <Link href="/cart" onClick={() => setOpen(false)}>
                Sepete Git
              </Link>
            </Button>

            <Button
              className="w-full"
              disabled={isCheckoutDisabled}
              onClick={() => void createOrderFromCart()}
            >
              {mutating ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}{" "}
              {mutating ? "Gönderiliyor..." : effectiveWarehouseTransfer ? "Depoya Gönder" : "Siparişi Gönder"}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
