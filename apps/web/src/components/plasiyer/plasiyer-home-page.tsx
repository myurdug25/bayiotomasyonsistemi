"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarDays,
  Loader2,
  PackagePlus,
} from "lucide-react";

import {
  getCatalogNewProducts,
  getReportOrderBalances,
  listCustomerCollections,
  listCustomerLedger,
  listOrders,
  type ProductSearchItem,
} from "@/lib/api";
import { useSession } from "@/components/auth/session-provider";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getSummary(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) {
    return null;
  }

  return isRecord(payload.summary) ? payload.summary : null;
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.replace(/\./g, "").replace(",", ".").replace(/[^0-9.-]/g, "");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function formatCompactTry(value: number): string {
  const absolute = Math.abs(value);

  if (absolute >= 1_000_000) {
    return `₺${(value / 1_000_000).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} Mn`;
  }

  if (absolute >= 1_000) {
    return `₺${(value / 1_000).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} B`;
  }

  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatProductPrice(value: string | null): string {
  const price = toNumber(value);

  if (price <= 0) {
    return "-";
  }

  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 2,
  }).format(price);
}

function formatProductDate(value?: string): string {
  if (!value) {
    return "Yeni";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Yeni";
  }

  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "short",
  }).format(date);
}

function selectedCustomerBalance(selectedCustomer: ReturnType<typeof useSession>["selectedCustomer"]): number {
  const fromSummary = selectedCustomer?.balance_summary?.total_due;
  if (fromSummary !== undefined) {
    return toNumber(fromSummary);
  }

  const logoFinancials = selectedCustomer?.meta?.integrations;
  if (
    logoFinancials &&
    typeof logoFinancials === "object" &&
    "logo" in logoFinancials &&
    logoFinancials.logo &&
    typeof logoFinancials.logo === "object" &&
    "financials" in logoFinancials.logo
  ) {
    const financials = logoFinancials.logo.financials as Record<string, unknown>;
    return toNumber(financials.total_due);
  }

  return 0;
}

export function PlasiyerHomePage() {
  const { selectedCustomer } = useSession();

  const newProductsQuery = useQuery({
    queryKey: ["plasiyer-home", "new-products", 30],
    queryFn: () => getCatalogNewProducts({ days: 30, limit: 8 }),
    staleTime: 600_000,
    gcTime: 1_800_000,
    refetchOnWindowFocus: false,
    placeholderData: (previous) => previous,
  });

  const customerOverviewQuery = useQuery({
    queryKey: ["plasiyer-home", "customer-overview", selectedCustomer?.id ?? null],
    refetchInterval: 15_000,
    queryFn: async () => {
      if (!selectedCustomer) {
        throw new Error("Müşteri seçimi gerekli.");
      }

      const [openOrders, orders, ledger, collections] = await Promise.all([
        getReportOrderBalances({ customer_id: selectedCustomer.id, per_page: 1 }),
        listOrders({ customer_id: selectedCustomer.id, limit: 6 }),
        listCustomerLedger(selectedCustomer.id, { per_page: 6 }),
        listCustomerCollections(selectedCustomer.id, { per_page: 6 }),
      ]);

      return {
        openOrders,
        orders,
        ledger,
        collections,
      };
    },
    enabled: Boolean(selectedCustomer),
    staleTime: 300_000,
    gcTime: 1_800_000,
    refetchOnWindowFocus: false,
    placeholderData: (previous) => previous,
  });

  const openOrderSummary = useMemo(
    () => getSummary(customerOverviewQuery.data?.openOrders ?? null),
    [customerOverviewQuery.data?.openOrders]
  );

  const totalOrderCount = customerOverviewQuery.data?.orders.summary?.totals.order_count ?? 0;
  const totalOrderAmount = toNumber(customerOverviewQuery.data?.orders.summary?.totals.grand_total);
  const openOrderCount = Math.max(0, Math.round(toNumber(openOrderSummary?.open_order_count)));
  const openOrderAmount = Math.max(0, toNumber(openOrderSummary?.open_grand_total));
  const balanceTotal = selectedCustomerBalance(selectedCustomer);
  const collectionTotal = useMemo(
    () => (customerOverviewQuery.data?.collections.tabs ?? []).reduce((sum, row) => sum + toNumber(row.total_amount), 0),
    [customerOverviewQuery.data?.collections.tabs]
  );
  const ledgerMovementCount = customerOverviewQuery.data?.ledger.meta?.total ?? customerOverviewQuery.data?.ledger.data.length ?? 0;
  const newProducts = newProductsQuery.data?.data ?? [];

  const summaryCards = useMemo(
    () => [
      {
        label: "Toplam Sipariş",
        value: `${totalOrderCount}`,
        detail: totalOrderAmount > 0 ? `Hacim ${formatCompactTry(totalOrderAmount)}` : "Henüz sipariş yok",
      },
      {
        label: "Açık Sipariş",
        value: `${openOrderCount}`,
        detail: openOrderAmount > 0 ? `Açık tutar ${formatCompactTry(openOrderAmount)}` : "Açık kayıt yok",
      },
      {
        label: "Cari Bakiye",
        value: formatCompactTry(balanceTotal),
        detail: balanceTotal > 0 ? "Tahsilat bekliyor" : balanceTotal < 0 ? "Alacaklı cari" : "Bakiye dengede",
      },
      {
        label: "Tahsilat",
        value: formatCompactTry(collectionTotal),
        detail: `${ledgerMovementCount} cari hareketi`,
      },
    ],
    [balanceTotal, collectionTotal, ledgerMovementCount, openOrderAmount, openOrderCount, totalOrderAmount, totalOrderCount]
  );

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-3">
      <div className="w-full">
        <Card className="page-hero-card page-hero-card-alt overflow-hidden border-[#355d46] shadow-[0_24px_44px_-34px_rgba(8,26,17,0.82)]">
          <CardContent className="page-hero-content overflow-hidden px-4 py-3 text-white lg:px-5 lg:py-4">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_14%_28%,rgba(64,120,86,0.42)_0%,rgba(64,120,86,0)_28%),radial-gradient(circle_at_84%_18%,rgba(22,73,46,0.38)_0%,rgba(22,73,46,0)_24%),linear-gradient(90deg,rgba(7,22,15,0.3)_0%,rgba(7,22,15,0.04)_36%,rgba(7,22,15,0.24)_100%)]" />
            <div className="page-hero-orb-primary" />
            <div className="page-hero-orb-secondary" />

            <div className="relative">
              <Badge className="border border-[#f6e654]/30 bg-[#f6e654] text-[var(--brand-accent-foreground)] shadow-[0_12px_18px_-16px_rgba(246,230,84,0.9)]">
                Plasiyer Kanalı
              </Badge>

              <div className="mt-2">
                <div className="page-hero-panel-soft p-4 text-white">
                  <div className="grid gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
                    <div className="min-w-0">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0">
                          <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/70">
                            Seçili Cari Detayı
                          </p>
                          {selectedCustomer ? (
                            <>
                              <p className="mt-2 line-clamp-2 text-[22px] font-extrabold tracking-tight text-white lg:text-[24px]">
                                {selectedCustomer.title}
                              </p>
                              <p className="mt-1 text-sm font-semibold text-white/85">{selectedCustomer.code}</p>
                            </>
                          ) : (
                            <p className="mt-2 text-sm text-amber-100">Devam etmek için önce müşteri seçin.</p>
                          )}
                        </div>

                      </div>

                      {selectedCustomer ? (
                        <div className="mt-4 grid gap-2 sm:grid-cols-2">
                          <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
                            <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/65">Telefon</p>
                            <p className="mt-1 text-sm font-semibold text-white">{selectedCustomer.phone || "Tanımlı değil"}</p>
                          </div>
                          <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
                            <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/65">Konum</p>
                            <p className="mt-1 text-sm font-semibold text-white">
                              {[selectedCustomer.city, selectedCustomer.district].filter(Boolean).join(" / ") || "Tanımlı değil"}
                            </p>
                          </div>
                          <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
                            <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/65">Yetkili</p>
                            <p className="mt-1 text-sm font-semibold text-white">{selectedCustomer.contact_name || "Tanımlı değil"}</p>
                          </div>
                          <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
                            <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/65">IBAN</p>
                            <p className="mt-1 text-sm font-semibold text-white">{selectedCustomer.iban || "Tanımlı değil"}</p>
                          </div>
                        </div>
                      ) : null}
                    </div>

                    {selectedCustomer ? (
                      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                        <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
                          <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/65">Vergi Dairesi</p>
                          <p className="mt-1 text-sm font-semibold text-white">{selectedCustomer.tax_office || "Tanımlı değil"}</p>
                        </div>
                        <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
                          <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/65">Vergi No</p>
                          <p className="mt-1 text-sm font-semibold text-white">{selectedCustomer.tax_number || "Tanımlı değil"}</p>
                        </div>
                        <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 sm:col-span-2 xl:col-span-1">
                          <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/65">Adres</p>
                          <p className="mt-1 line-clamp-3 text-sm font-semibold leading-5 text-white">
                            {selectedCustomer.address || "Tanımlı değil"}
                          </p>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="border-[var(--brand-border)] bg-white shadow-sm">
        <CardHeader className="border-b border-[var(--brand-border)] pb-3">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <CardTitle className="text-lg font-extrabold text-[var(--brand-primary-strong)]">
                  Müşteri Özeti
                </CardTitle>
                <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                  {selectedCustomer
                    ? `${selectedCustomer.code} için sipariş ve bakiye özeti`
                    : "Özet için önce cari seçin."}
                </p>
              </div>
              {selectedCustomer ? (
                <span className="dashboard-quick-card-badge">{selectedCustomer.code}</span>
              ) : null}
            </div>

            {selectedCustomer ? (
              customerOverviewQuery.isLoading ? (
                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <div key={index} className="rounded-2xl border border-[var(--brand-border)] bg-[var(--surface-soft)] p-3">
                      <Skeleton className="h-3 w-24" />
                      <Skeleton className="mt-3 h-7 w-28" />
                      <Skeleton className="mt-2 h-3 w-32" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                  {summaryCards.map((card) => (
                    <div key={card.label} className="rounded-2xl border border-[var(--brand-border)] bg-[var(--surface-soft)] px-4 py-3">
                      <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
                        {card.label}
                      </p>
                      <p className="mt-2 text-xl font-extrabold tracking-tight text-[var(--brand-primary-strong)]">
                        {card.value}
                      </p>
                      <p className="mt-1 text-xs text-[var(--muted-foreground)]">{card.detail}</p>
                    </div>
                  ))}
                </div>
              )
            ) : (
              <div className="rounded-2xl border border-dashed border-[var(--brand-border)] bg-[var(--surface-soft)]/60 px-4 py-3 text-sm text-[var(--muted-foreground)]">
                Müşteri seçildikten sonra bu alanda sipariş ve bakiye özeti görünecek.
              </div>
            )}

            {customerOverviewQuery.isError && selectedCustomer ? (
              <div className="flex items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                <Loader2 className="h-4 w-4" />
                Müşteri özeti alınamadı. Sayfayı yenileyip tekrar deneyin.
              </div>
            ) : null}
          </div>
        </CardHeader>
      </Card>

      <Card className="border-[var(--brand-border)] bg-white shadow-sm">
        <CardHeader className="border-b border-[var(--brand-border)] pb-3">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle className="text-lg font-extrabold text-[var(--brand-primary-strong)]">
                Son 1 Ayda Açılan Ürünler
              </CardTitle>
              <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                Logo'dan son 30 günde açılan aktif ürünler
              </p>
            </div>
            <span className="dashboard-quick-card-badge">
              {newProductsQuery.isLoading ? "Yükleniyor" : `${newProducts.length} ürün`}
            </span>
          </div>
        </CardHeader>
        <CardContent className="p-4">
          {newProductsQuery.isLoading ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="rounded-2xl border border-[var(--brand-border)] bg-[var(--surface-soft)] p-4">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="mt-3 h-5 w-full" />
                  <Skeleton className="mt-2 h-4 w-2/3" />
                  <Skeleton className="mt-4 h-8 w-full" />
                </div>
              ))}
            </div>
          ) : newProductsQuery.isError ? (
            <div className="flex items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <Loader2 className="h-4 w-4" />
              Yeni ürünler alınamadı. Sayfayı yenileyip tekrar deneyin.
            </div>
          ) : newProducts.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[var(--brand-border)] bg-[var(--surface-soft)]/60 px-4 py-5 text-sm text-[var(--muted-foreground)]">
              Son 30 günde açılan yeni ürün bulunmuyor.
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {newProducts.map((product: ProductSearchItem) => (
                <div
                  key={product.id}
                  className="rounded-2xl border border-[var(--brand-border)] bg-[var(--surface-soft)] p-4 shadow-[0_14px_26px_-24px_rgba(8,26,17,0.7)]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-black uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
                        {product.sku}
                      </p>
                      <p className="mt-1 line-clamp-2 min-h-[40px] text-sm font-extrabold leading-5 text-[var(--brand-primary-strong)]">
                        {product.name}
                      </p>
                    </div>
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[#9ed7b1]/35 bg-[#e4f7dc] px-2.5 py-1 text-xs font-black text-[#173d25]">
                      <CalendarDays className="h-3.5 w-3.5" />
                      {formatProductDate(product.created_at)}
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className="rounded-full border border-[var(--brand-border)] bg-white/70 px-2.5 py-1 text-xs font-bold text-[var(--muted-foreground)]">
                      {product.brand.name || "Markasız"}
                    </span>
                    {product.oem ? (
                      <span className="rounded-full border border-[var(--brand-border)] bg-white/70 px-2.5 py-1 text-xs font-bold text-[var(--muted-foreground)]">
                        OEM {product.oem}
                      </span>
                    ) : null}
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <div className="rounded-xl border border-[var(--brand-border)] bg-white/70 px-3 py-2">
                      <p className="text-[10px] font-black uppercase tracking-[0.08em] text-[var(--muted-foreground)]">Stok</p>
                      <p className="mt-1 text-lg font-black text-[var(--brand-primary-strong)]">{product.available_total}</p>
                    </div>
                    <div className="rounded-xl border border-[var(--brand-border)] bg-white/70 px-3 py-2">
                      <p className="text-[10px] font-black uppercase tracking-[0.08em] text-[var(--muted-foreground)]">Net Fiyat</p>
                      <p className="mt-1 truncate text-sm font-black text-[var(--brand-primary-strong)]">
                        {formatProductPrice(product.net_price)}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center gap-2 text-xs font-bold text-[var(--muted-foreground)]">
                    <PackagePlus className="h-4 w-4 text-[#7bb66a]" />
                    Yeni açılan ürün
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
