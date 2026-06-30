"use client";

import Link from "next/link";
import Image from "next/image";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  BookOpen,
  Box,
  ClipboardList,
  CreditCard,
  Droplets,
  Fuel,
  Megaphone,
  PackageSearch,
  RefreshCcw,
  ShoppingCart,
  Sparkles,
  Wind,
  Zap,
} from "lucide-react";

import {
  listOrders,
  type OrderListItem,
} from "@/lib/api";
import { useSession } from "@/components/auth/session-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
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

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 0,
  }).format(value);
}

const OPEN_ORDER_STATUSES = new Set(["pending", "approved", "processing", "shipped"]);

const FEATURED_CATEGORIES = [
  { label: "Hava Filtreleri", href: "/search?q=hava%20filtresi", icon: Wind },
  { label: "Yağ Filtreleri", href: "/search?q=ya%C4%9F%20filtresi", icon: Droplets },
  { label: "Yakıt Filtreleri", href: "/search?q=yak%C4%B1t%20filtresi", icon: Fuel },
  { label: "Polen Filtreleri", href: "/search?q=polen%20filtresi", icon: Box },
];

export function CustomerDashboardPage() {
  const { selectedCustomer } = useSession();
  const dateTo = useMemo(() => toDateInputValue(new Date()), []);
  const dateFrom = useMemo(() => {
    const start = new Date();
    start.setDate(start.getDate() - 90);
    return toDateInputValue(start);
  }, []);

  const dashboardQuery = useQuery({
    queryKey: ["customer-dashboard", { customerId: selectedCustomer?.id ?? null, dateFrom, dateTo }],
    queryFn: async () => {
      if (!selectedCustomer) {
        throw new Error("Müşteri seçimi gerekli.");
      }

      const orders = await listOrders({
        customer_id: selectedCustomer.id,
        date_from: dateFrom,
        date_to: dateTo,
        limit: 12,
      });

      return {
        orders,
      };
    },
    enabled: Boolean(selectedCustomer),
    staleTime: 30_000,
    refetchInterval: 15_000,
    gcTime: 1_800_000,
    refetchOnWindowFocus: false,
  });

  const recentOrders = useMemo<OrderListItem[]>(
    () => dashboardQuery.data?.orders.data ?? [],
    [dashboardQuery.data?.orders.data]
  );

  const { openOrderCount, openOrderTotal } = useMemo(() => {
    const statusBreakdown = dashboardQuery.data?.orders.summary?.status_breakdown;

    if (statusBreakdown?.length) {
      return statusBreakdown.reduce(
        (totals, item) => {
          if (!OPEN_ORDER_STATUSES.has(item.status.toLowerCase())) {
            return totals;
          }

          totals.openOrderCount += item.order_count;
          totals.openOrderTotal += toNumber(item.grand_total);
          return totals;
        },
        { openOrderCount: 0, openOrderTotal: 0 }
      );
    }

    return recentOrders.reduce(
      (totals, order) => {
        if (!OPEN_ORDER_STATUSES.has(order.status.toLowerCase())) {
          return totals;
        }

        totals.openOrderCount += 1;
        totals.openOrderTotal += toNumber(order.grand_total);
        return totals;
      },
      { openOrderCount: 0, openOrderTotal: 0 }
    );
  }, [dashboardQuery.data?.orders.summary?.status_breakdown, recentOrders]);

  const customerBalanceTotal = toNumber(selectedCustomer?.balance_summary?.total_due ?? 0);

  return (
    <div className="mx-auto w-full max-w-[1480px] space-y-4 text-slate-100">
      <section className="relative isolate min-h-[330px] overflow-hidden rounded-[26px] border border-slate-700/70 bg-[linear-gradient(135deg,#08111a_0%,#0f1d25_48%,#10271f_100%)] shadow-[0_24px_70px_-54px_rgba(0,0,0,0.72)]">
        <div className="absolute inset-y-0 right-0 hidden w-[58%] xl:block">
          <Image
            src="/brand/powersa-customer-banner/banner-main-warehouse-shelves.webp"
            alt="PowerSA depo rafları"
            fill
            priority
            quality={80}
            sizes="760px"
            className="object-cover opacity-70 saturate-[0.9]"
          />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,#08111a_0%,rgba(8,17,26,0.76)_18%,rgba(8,17,26,0.12)_58%,rgba(8,17,26,0.72)_100%),linear-gradient(180deg,rgba(8,17,26,0.2)_0%,#08111a_100%)]" />
        </div>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_20%,rgba(74,222,128,0.14),transparent_30%),radial-gradient(circle_at_78%_22%,rgba(45,212,191,0.16),transparent_28%)]" />

        <div className="relative z-10 grid min-h-[330px] gap-6 p-7 xl:grid-cols-[minmax(0,0.88fr)_minmax(420px,0.72fr)] xl:items-center xl:p-8">
          <div className="max-w-[560px] rounded-[22px] bg-[#08111a]/35 p-4 ring-1 ring-white/5 backdrop-blur-[2px] sm:p-5 xl:bg-transparent xl:p-0 xl:ring-0">
            <div className="mb-5 flex flex-wrap gap-2">
              {["POWERSA", "MANN", "ŞAMPİYON", "RIXENBERG"].map((brand) => (
                <span
                  key={brand}
                  className="rounded-full border border-emerald-200/15 bg-emerald-50/10 px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.14em] text-slate-100 backdrop-blur-md"
                >
                  {brand}
                </span>
              ))}
            </div>
            <h2 className="max-w-[520px] text-4xl font-black leading-[1.04] text-white xl:text-5xl">
              Filtre siparişleriniz tek ekranda
            </h2>
            <p className="mt-4 max-w-[440px] text-[15px] font-semibold leading-6 text-slate-300">
              Stok, fiyat ve sipariş süreçlerinizi hızlıca yönetin.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button asChild className="h-11 rounded-[12px] bg-emerald-400 px-5 text-sm font-black text-slate-950 hover:bg-emerald-300">
                <Link href="/search">
                  Ürün Kataloğu <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button
                asChild
                variant="outline"
                className="h-11 rounded-[12px] border-white/10 bg-white/5 px-5 text-sm font-black text-white hover:bg-white/10 hover:text-white"
              >
                <Link href="/orders">Siparişlerim</Link>
              </Button>
              <Button
                asChild
                variant="outline"
                className="h-11 rounded-[12px] border-amber-200/20 bg-amber-200/10 px-5 text-sm font-black text-amber-100 hover:bg-amber-200/15 hover:text-white"
              >
                <Link href="/catalogs">Marka Katalogları</Link>
              </Button>
            </div>
          </div>

          <div className="hidden min-h-[250px] items-end justify-center gap-4 xl:flex">
            <div className="relative h-[210px] w-[170px] rounded-[22px] border border-white/10 bg-[#13251f]/90 p-4 shadow-[0_24px_70px_-38px_rgba(0,0,0,0.8)] backdrop-blur-xl">
              <Image
                src="/brand/powersa-packshot-1.png"
                alt="Powersa filtre kutusu"
                fill
                sizes="170px"
                loading="eager"
                quality={80}
                className="object-contain p-4 drop-shadow-[0_28px_34px_rgba(0,0,0,0.42)]"
              />
            </div>
            <div className="relative h-[250px] w-[205px] rounded-[24px] border border-emerald-300/20 bg-[#17382d]/92 p-4 shadow-[0_28px_80px_-40px_rgba(16,185,129,0.5)] backdrop-blur-xl">
              <Image
                src="/brand/powersa-packshot-2.png"
                alt="Powersa ürün grubu"
                fill
                sizes="205px"
                loading="eager"
                quality={80}
                className="object-contain p-4 drop-shadow-[0_32px_38px_rgba(0,0,0,0.46)]"
              />
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {[
          { href: "/search", title: "Ürün Kataloğu", copy: "Stok ve fiyat ara", icon: PackageSearch, tone: "text-emerald-300 bg-emerald-300/10" },
          { href: "/catalogs", title: "Marka Katalogları", copy: "PDF ve dış kataloglar", icon: BookOpen, tone: "text-amber-300 bg-amber-300/10" },
          { href: "/orders", title: "Siparişlerim", copy: "Açık siparişleri izle", icon: ClipboardList, tone: "text-sky-300 bg-sky-300/10" },
          { href: "/ledger", title: "Cari Hesap", copy: "Hareket ve bakiye", icon: CreditCard, tone: "text-amber-300 bg-amber-300/10" },
          { href: "/search", title: "Hızlı Sipariş", copy: "Kodla hızlı ekle", icon: Zap, tone: "text-violet-300 bg-violet-300/10" },
        ].map((action) => {
          const Icon = action.icon;

          return (
            <Link
              href={action.href}
              key={action.title}
              className="group flex min-h-[118px] items-center gap-4 rounded-[18px] border border-slate-700/60 bg-[linear-gradient(180deg,rgba(20,32,43,0.78)_0%,rgba(12,22,33,0.78)_100%)] p-4 shadow-[0_18px_38px_-34px_rgba(0,0,0,0.62)] transition hover:-translate-y-0.5 hover:border-slate-500/70"
            >
              <span className={`flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[16px] ${action.tone}`}>
                <Icon className="h-6 w-6" />
              </span>
              <span className="min-w-0">
                <strong className="block text-[17px] font-black text-white">{action.title}</strong>
                <span className="mt-1 block text-sm font-semibold text-slate-400">{action.copy}</span>
              </span>
              <ArrowRight className="ml-auto h-4 w-4 shrink-0 text-slate-500 transition group-hover:translate-x-1 group-hover:text-slate-200" />
            </Link>
          );
        })}
      </section>

      {dashboardQuery.isError ? (
        <Card className="border-red-500/30 bg-red-950/30">
          <CardContent className="p-4 text-sm font-semibold text-red-200">
            {(dashboardQuery.error as Error).message}
          </CardContent>
        </Card>
      ) : null}

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Açık Sipariş", value: openOrderCount, suffix: "adet", icon: ShoppingCart, copy: "İşlem bekleyen sipariş" },
          { label: "Açık Sipariş Tutarı", value: formatCurrency(openOrderTotal), icon: Sparkles, copy: "Son 90 gün görünümü" },
          { label: "Cari Bakiye", value: formatCurrency(customerBalanceTotal), icon: CreditCard, copy: selectedCustomer?.balance_source === "logo" ? "Logo bakiyesi" : "Güncel bakiye" },
          { label: "Bekleyen İşlem", value: dashboardQuery.isLoading ? "-" : "0", suffix: "kayıt", icon: RefreshCcw, copy: "Takip gerektiren işlem" },
        ].map((item) => {
          const Icon = item.icon;

          return (
            <Card key={item.label} className="border-slate-700/55 bg-[linear-gradient(180deg,rgba(18,30,41,0.76)_0%,rgba(11,20,31,0.8)_100%)] text-slate-100 shadow-[0_18px_36px_-34px_rgba(0,0,0,0.64)]">
              <CardContent className="flex min-h-[126px] items-center gap-4 p-4">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[15px] border border-white/10 bg-white/5 text-cyan-200">
                  <Icon className="h-5 w-5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500">{item.label}</span>
                  <strong className="mt-2 block truncate text-[1.75rem] font-black leading-none text-white">
                    {dashboardQuery.isLoading && item.label !== "Cari Bakiye" ? <Skeleton className="h-8 w-20 bg-slate-700" /> : `${item.value}${item.suffix ? ` ${item.suffix}` : ""}`}
                  </strong>
                  <span className="mt-2 block text-sm font-semibold text-slate-400">{item.copy}</span>
                </span>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <section className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="border-slate-700/55 bg-[linear-gradient(180deg,rgba(18,30,41,0.72)_0%,rgba(11,20,31,0.82)_100%)] text-slate-100">
          <CardContent className="p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-xl font-black text-white">Öne Çıkan Kategoriler</h3>
                <p className="mt-1 text-sm font-semibold text-slate-400">Sık kullanılan filtre grupları</p>
              </div>
              <Button asChild variant="outline" className="h-10 rounded-[12px] border-slate-700 bg-white/5 text-slate-100 hover:bg-white/10 hover:text-white">
                <Link href="/search">Tümü <ArrowRight className="h-4 w-4" /></Link>
              </Button>
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              {FEATURED_CATEGORIES.map((category) => {
                const Icon = category.icon;

                return (
                  <Link
                    href={category.href}
                    key={category.label}
                    className="flex min-h-[118px] flex-col justify-between rounded-[16px] border border-slate-700/55 bg-slate-900/30 p-4 transition hover:border-slate-500/70 hover:bg-slate-800/45"
                  >
                    <Icon className="h-7 w-7 text-emerald-300" />
                    <span className="text-[15px] font-black text-white">{category.label}</span>
                  </Link>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-700/55 bg-[linear-gradient(180deg,rgba(18,30,41,0.72)_0%,rgba(11,20,31,0.82)_100%)] text-slate-100">
          <CardContent className="p-5">
            <div className="mb-4 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-amber-300/10 text-amber-300">
                <Megaphone className="h-5 w-5" />
              </span>
              <div>
                <h3 className="text-lg font-black text-white">Duyurular</h3>
                <p className="text-sm font-semibold text-slate-400">Güncel bilgiler</p>
              </div>
            </div>
            <div className="space-y-3">
              <Link
                href="/catalogs"
                className="group flex items-center justify-between gap-3 rounded-[14px] border border-amber-200/15 bg-amber-200/10 p-3 text-sm font-black text-amber-100 transition hover:border-amber-200/30 hover:bg-amber-200/15"
              >
                <span>Yeni katalog yayında.</span>
                <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
              </Link>
              <p className="rounded-[14px] border border-slate-700/55 bg-slate-900/30 p-3 text-sm font-semibold text-slate-300">
                Kampanyalı ürünleri katalogdan inceleyin.
              </p>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
