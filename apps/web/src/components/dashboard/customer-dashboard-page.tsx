"use client";

import Link from "next/link";
import Image from "next/image";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  BookOpen,
  Box,
  CarFront,
  ClipboardList,
  CreditCard,
  Droplets,
  Fuel,
  Headphones,
  MapPin,
  Megaphone,
  PackageSearch,
  RefreshCcw,
  Ship,
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
  const { selectedCustomer, user } = useSession();
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
  const batumScopeValues = [
    user?.branch_code,
    user?.branch_name,
    user?.username,
    selectedCustomer?.branch_code,
    selectedCustomer?.branch_name,
    selectedCustomer?.code,
    selectedCustomer?.title,
  ];
  const isBatumDashboard = batumScopeValues.some((value) =>
    String(value ?? "").toLocaleUpperCase("tr-TR").includes("BATUM")
  ) || selectedCustomer?.code?.trim().startsWith("120-00-") === true;
  const heroImage = isBatumDashboard
    ? "/brand/powersa-filter-showcase/batum/batum-coast.jpg"
    : "/brand/powersa-customer-banner/banner-main-warehouse-shelves.webp";
  const heroAlt = isBatumDashboard ? "Batum sahili ve şehir operasyon görünümü" : "PowerSA depo rafları";
  const heroTitle = isBatumDashboard ? "Batum operasyonlarınız tek ekranda" : "Filtre siparişleriniz tek ekranda";
  const heroCopy = isBatumDashboard
    ? "Gürcistan, Karadeniz, otomotiv ve lojistik süreçlerinizi Batum şubesine özel panelden takip edin."
    : "Stok, fiyat ve sipariş süreçlerinizi hızlıca yönetin.";
  const heroBrands = isBatumDashboard
    ? ["🇬🇪 BATUM ŞUBESİ", "KARADENİZ", "OTOMOTİV", "LOJİSTİK"]
    : ["POWERSA", "MANN", "ŞAMPİYON", "RIXENBERG"];

  if (isBatumDashboard) {
    const batumShowcaseCards = [
      {
        eyebrow: "01",
        title: "Batum Bulvarı",
        copy: "Karadeniz kıyısındaki operasyon merkezimiz.",
        href: "/dashboard",
        image: "/brand/powersa-filter-showcase/batum/batum-night.jpg",
        alt: "Batum Bulvarı gece görünümü",
        icon: MapPin,
        className: "xl:col-span-3",
      },
      {
        eyebrow: "02",
        title: "Otomotiv & Yedek Parça",
        copy: "Güvenilir ürünler, güçlü otomotiv çözümleri.",
        href: "/search",
        image: "/brand/powersa-garage.png",
        alt: "PowerSA otomotiv ve filtre ürünleri",
        icon: CarFront,
        className: "xl:col-span-3",
      },
      {
        eyebrow: "03",
        title: "Karadeniz Lojistiği",
        copy: "Batum limanından bölgeye uzanan hızlı tedarik hattı.",
        href: "/orders",
        image: "/brand/powersa-filter-showcase/batum/batum-skyline.jpg",
        alt: "Batum sahili ve lojistik hattı",
        icon: Ship,
        className: "xl:col-span-3",
      },
      {
        eyebrow: "04",
        title: "PowerSA Ürünleri",
        copy: "Filtre teknolojisini kaliteyle buluşturan ürün ailesi.",
        href: "/catalogs",
        image: "/brand/powersa-filter-showcase/optimized/featured-1.jpg",
        alt: "PowerSA filtre ürünleri",
        icon: PackageSearch,
        className: "xl:col-span-3",
      },
    ];

    const batumPowerSaGallery = [
      {
        title: "PowerSA Batum Bayi",
        copy: "Gürcistan'daki satış ve operasyon noktamız.",
        image: "/brand/powersa-filter-showcase/batum/batum-powersa-bayi.webp",
        alt: "PowerSA Filter Batum bayi binası",
        imageClassName: "object-cover object-center",
        className: "md:col-span-2 xl:col-span-4",
      },
      {
        title: "Batum Sokaklarında",
        copy: "PowerSA, Batum şehir yaşamının içinde.",
        image: "/brand/powersa-filter-showcase/batum/batum-powersa-street.webp",
        alt: "Batum sokağında PowerSA ürünü",
        imageClassName: "object-cover object-bottom",
        className: "xl:col-span-2",
      },
      {
        title: "Yola Hazır",
        copy: "Bakım ve filtre çözümleri her yolculukta yanınızda.",
        image: "/brand/powersa-filter-showcase/batum/batum-powersa-trunk.webp",
        alt: "Batum sahilinde otomobil bagajında PowerSA ürünü",
        imageClassName: "object-cover object-center",
        className: "xl:col-span-3",
      },
      {
        title: "Batum Hatırası",
        copy: "Karadeniz kıyısında PowerSA deneyimi.",
        image: "/brand/powersa-filter-showcase/batum/batum-powersa-couple.webp",
        alt: "Batum sahilinde PowerSA ürünüyle ziyaretçiler",
        imageClassName: "object-cover object-center",
        className: "xl:col-span-3",
      },
      {
        title: "Otomotiv Enerjisi",
        copy: "PowerSA ile şehrin ritmine uyum sağlayın.",
        image: "/brand/powersa-filter-showcase/batum/batum-powersa-night-drive.webp",
        alt: "PowerSA maskotu otomobil ile gece sürüşünde",
        imageClassName: "object-cover object-center",
        className: "xl:col-span-3",
      },
      {
        title: "PowerSA Yol Arkadaşınız",
        copy: "Güçlü otomotiv çözümleri Batum bayisinde.",
        image: "/brand/powersa-filter-showcase/batum/batum-powersa-mascot-car.webp",
        alt: "PowerSA maskotu yeşil otomobil ile",
        imageClassName: "object-contain object-center",
        className: "xl:col-span-3",
      },
    ];

    const batumQuickLinks = [
      { href: "/search", title: "Ürün Kataloğu", copy: "Tüm ürünleri keşfedin", icon: BookOpen },
      { href: "/search", title: "Hızlı Satış", copy: "Ürün koduyla hızlı ekleyin", icon: Zap },
      { href: "/ledger", title: "Cari Hesap", copy: "Hesap ve hareketleri yönetin", icon: CreditCard },
      { href: "/orders", title: "Siparişlerim", copy: "Siparişlerinizi görüntüleyin", icon: ClipboardList },
      { href: "/notes", title: "Destek Merkezi", copy: "Yardım ve destek alın", icon: Headphones },
    ];

    return (
      <div className="mx-auto w-full max-w-[1480px] space-y-4 pb-2 text-slate-100">
        <section className="relative isolate min-h-[430px] overflow-hidden rounded-[28px] border border-amber-300/35 bg-[#07130f] shadow-[0_32px_90px_-50px_rgba(245,158,11,0.5)]">
          <Image
            src="/brand/powersa-filter-showcase/batum/batum-coast.jpg"
            alt="Batum sahili ve PowerSA operasyon merkezi"
            fill
            priority
            quality={88}
            sizes="(max-width: 768px) 100vw, 1480px"
            className="object-cover object-center saturate-[1.08] contrast-[1.08]"
          />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,#06140f_0%,rgba(6,20,15,0.96)_31%,rgba(4,14,18,0.42)_63%,rgba(2,8,12,0.24)_100%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.04)_45%,rgba(2,10,8,0.76)_100%)]" />
          <div className="absolute -left-16 top-12 h-72 w-72 rounded-full bg-emerald-400/10 blur-3xl" />
          <div className="absolute right-6 top-5 h-56 w-56 rounded-full bg-amber-300/10 blur-3xl" />

          <div className="relative z-10 flex min-h-[430px] flex-col justify-between gap-8 p-6 sm:p-9 lg:p-12">
            <div className="max-w-[690px]">
              <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-amber-200/40 bg-[#07140f]/72 px-4 py-2 text-[11px] font-black uppercase tracking-[0.18em] text-amber-100 shadow-lg backdrop-blur-md">
                <MapPin className="h-4 w-4 text-amber-300" />
                <span className="text-base leading-none">🇬🇪</span>
                Gürcistan · Batum Şubesi
              </div>
              <h1 className="max-w-[650px] text-[clamp(3.15rem,6.2vw,6.5rem)] font-black uppercase leading-[0.84] tracking-[-0.065em] text-white [text-shadow:0_14px_38px_rgba(0,0,0,0.58)]">
                Batum
              </h1>
              <p className="mt-2 text-[clamp(1.65rem,3vw,3.2rem)] font-black uppercase leading-none tracking-[-0.035em] text-amber-300 [text-shadow:0_10px_28px_rgba(0,0,0,0.55)]">
                Operasyon Merkezi
              </p>
              <p className="mt-5 max-w-[620px] text-base font-bold leading-7 text-slate-200 sm:text-lg">
                Karadeniz&apos;in kalbinde otomotiv, yedek parça ve lojistik.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Button asChild className="h-12 rounded-[13px] bg-emerald-400 px-6 text-sm font-black text-slate-950 shadow-[0_18px_45px_-24px_rgba(52,211,153,0.9)] hover:bg-emerald-300">
                <Link href="/search">
                  Ürünleri Keşfet <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button asChild variant="outline" className="h-12 rounded-[13px] border-white/20 bg-black/30 px-6 text-sm font-black text-white backdrop-blur-md hover:bg-white/15 hover:text-white">
                <Link href="/orders">
                  Siparişlerim <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button asChild variant="outline" className="h-12 rounded-[13px] border-amber-200/35 bg-amber-200/15 px-6 text-sm font-black text-amber-50 backdrop-blur-md hover:bg-amber-200/25 hover:text-white">
                <Link href="/catalogs">
                  Kataloglar <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>

          <div className="pointer-events-none absolute bottom-7 right-7 hidden items-end gap-3 lg:flex">
            <div className="relative h-28 w-24 overflow-hidden rounded-[22px] border border-emerald-200/25 bg-[#0b2d22]/80 shadow-2xl backdrop-blur-lg">
              <Image src="/brand/powersa-packshot-1.png" alt="" fill sizes="96px" className="object-contain p-2.5" />
            </div>
            <div className="relative h-36 w-32 overflow-hidden rounded-[24px] border border-amber-200/35 bg-[#123629]/82 shadow-2xl backdrop-blur-lg">
              <Image src="/brand/powersa-packshot-2.png" alt="" fill sizes="128px" className="object-contain p-2.5" />
            </div>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-12">
          {batumShowcaseCards.map((card) => {
            const Icon = card.icon;

            return (
              <Link
                href={card.href}
                key={card.title}
                className={`group relative isolate min-h-[310px] overflow-hidden rounded-[24px] border border-amber-200/20 bg-[#08130f] shadow-[0_24px_65px_-48px_rgba(0,0,0,0.95)] ${card.className}`}
              >
                <Image
                  src={card.image}
                  alt={card.alt}
                  fill
                  quality={82}
                  sizes="(max-width: 768px) 100vw, 50vw"
                  className="object-cover transition duration-700 group-hover:scale-[1.045]"
                />
                <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(2,9,7,0.04)_10%,rgba(2,9,7,0.42)_50%,rgba(2,9,7,0.96)_100%)]" />
                <div className="absolute inset-x-0 bottom-0 z-10 flex items-end justify-between gap-4 p-5 sm:p-6">
                  <div className="max-w-[78%]">
                    <div className="mb-3 flex items-center gap-2 text-xs font-black tracking-[0.18em] text-amber-300">
                      <span>{card.eyebrow}</span>
                      <span className="h-px w-9 bg-amber-300/60" />
                    </div>
                    <h2 className="text-2xl font-black uppercase leading-tight tracking-[-0.025em] text-white sm:text-[1.7rem]">
                      {card.title}
                    </h2>
                    <p className="mt-2 text-sm font-semibold leading-5 text-slate-300">{card.copy}</p>
                  </div>
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-amber-200/40 bg-black/45 text-amber-200 backdrop-blur-md transition group-hover:-translate-y-1 group-hover:bg-amber-300 group-hover:text-slate-950">
                    <Icon className="h-5 w-5" />
                  </span>
                </div>
              </Link>
            );
          })}
        </section>

        <section className="overflow-hidden rounded-[28px] border border-amber-200/20 bg-[linear-gradient(145deg,rgba(7,25,18,0.98),rgba(7,18,16,0.96))] p-4 shadow-[0_28px_80px_-58px_rgba(245,158,11,0.62)] sm:p-6">
          <div className="mb-5 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
            <div>
              <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.2em] text-amber-300">
                <Sparkles className="h-4 w-4" />
                PowerSA Gürcistan
              </div>
              <h2 className="mt-2 text-2xl font-black uppercase tracking-[-0.035em] text-white sm:text-3xl">
                Batum Bayi &amp; Şehir Galerisi
              </h2>
              <p className="mt-1 text-sm font-semibold text-slate-400">
                Batum&apos;daki bayi noktamız, şehir yaşamı ve otomotiv dünyası.
              </p>
            </div>
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-emerald-300/25 bg-emerald-300/10 px-4 py-2 text-xs font-black uppercase tracking-[0.14em] text-emerald-200">
              <MapPin className="h-4 w-4" />
              Batum · Gürcistan
            </div>
          </div>

          <div className="grid auto-rows-[250px] gap-3 md:grid-cols-2 xl:grid-cols-6">
            {batumPowerSaGallery.map((item) => (
              <div
                key={item.title}
                className={`group relative isolate overflow-hidden rounded-[21px] border border-white/10 bg-[#08130f] ${item.className}`}
              >
                <Image
                  src={item.image}
                  alt={item.alt}
                  fill
                  unoptimized
                  sizes="(max-width: 768px) 100vw, 50vw"
                  className={`${item.imageClassName} transition duration-700 group-hover:scale-[1.025]`}
                />
                <div className="absolute inset-0 bg-[linear-gradient(180deg,transparent_34%,rgba(2,9,7,0.3)_58%,rgba(2,9,7,0.96)_100%)]" />
                <div className="absolute inset-x-0 bottom-0 z-10 p-4 sm:p-5">
                  <h3 className="text-lg font-black uppercase tracking-[-0.02em] text-white">{item.title}</h3>
                  <p className="mt-1 text-xs font-semibold leading-5 text-slate-300">{item.copy}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="grid overflow-hidden rounded-[22px] border border-amber-200/20 bg-[linear-gradient(135deg,rgba(6,20,15,0.96),rgba(9,26,23,0.92))] md:grid-cols-2 xl:grid-cols-5">
          {batumQuickLinks.map((item) => {
            const Icon = item.icon;

            return (
              <Link
                href={item.href}
                key={item.title}
                className="group flex min-h-[92px] items-center gap-3 border-b border-white/8 px-5 py-4 transition hover:bg-amber-200/10 md:border-r xl:border-b-0"
              >
                <Icon className="h-6 w-6 shrink-0 text-amber-300" />
                <span className="min-w-0">
                  <strong className="block text-sm font-black text-white">{item.title}</strong>
                  <span className="mt-1 block truncate text-xs font-semibold text-slate-400">{item.copy}</span>
                </span>
                <ArrowRight className="ml-auto h-4 w-4 shrink-0 text-slate-500 transition group-hover:translate-x-1 group-hover:text-amber-200" />
              </Link>
            );
          })}
        </section>

        <p className="pt-1 text-center text-xs font-semibold text-emerald-200/65">
          Designed by <strong className="text-white">NfsSoft</strong>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1480px] space-y-4 text-slate-100">
      <section
        className={`relative isolate min-h-[330px] overflow-hidden rounded-[26px] border shadow-[0_24px_70px_-54px_rgba(0,0,0,0.72)] ${
          isBatumDashboard
            ? "border-amber-200/25 bg-[radial-gradient(circle_at_78%_8%,rgba(245,158,11,0.22),transparent_30%),radial-gradient(circle_at_18%_18%,rgba(16,185,129,0.20),transparent_34%),linear-gradient(135deg,#061216_0%,#102722_48%,#281b0c_100%)]"
            : "border-slate-700/70 bg-[linear-gradient(135deg,#08111a_0%,#0f1d25_48%,#10271f_100%)]"
        }`}
      >
        <div className={`absolute inset-y-0 right-0 hidden xl:block ${isBatumDashboard ? "w-[68%]" : "w-[58%]"}`}>
          <Image
            src={heroImage}
            alt={heroAlt}
            fill
            priority
            quality={80}
            sizes="760px"
            className={`object-cover ${isBatumDashboard ? "opacity-95 saturate-[1.16] contrast-[1.05]" : "opacity-70 saturate-[0.9]"}`}
          />
          <div
            className={
              isBatumDashboard
                ? "absolute inset-0 bg-[linear-gradient(90deg,#061216_0%,rgba(6,18,22,0.82)_18%,rgba(6,18,22,0.20)_58%,rgba(6,18,22,0.48)_100%),linear-gradient(180deg,rgba(6,18,22,0.06)_0%,rgba(6,18,22,0.54)_100%)]"
                : "absolute inset-0 bg-[linear-gradient(90deg,#08111a_0%,rgba(8,17,26,0.76)_18%,rgba(8,17,26,0.12)_58%,rgba(8,17,26,0.72)_100%),linear-gradient(180deg,rgba(8,17,26,0.2)_0%,#08111a_100%)]"
            }
          />
        </div>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_20%,rgba(74,222,128,0.14),transparent_30%),radial-gradient(circle_at_78%_22%,rgba(45,212,191,0.16),transparent_28%)]" />

        <div className="relative z-10 grid min-h-[330px] gap-6 p-7 xl:grid-cols-[minmax(0,0.88fr)_minmax(420px,0.72fr)] xl:items-center xl:p-8">
          <div className="max-w-[560px] rounded-[22px] bg-[#08111a]/35 p-4 ring-1 ring-white/5 backdrop-blur-[2px] sm:p-5 xl:bg-transparent xl:p-0 xl:ring-0">
            <div className="mb-5 flex flex-wrap gap-2">
              {heroBrands.map((brand) => (
                <span
                  key={brand}
                  className={`rounded-full border px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.14em] text-slate-100 backdrop-blur-md ${
                    isBatumDashboard ? "border-amber-200/24 bg-amber-200/14" : "border-emerald-200/15 bg-emerald-50/10"
                  }`}
                >
                  {brand}
                </span>
              ))}
            </div>
            <h2 className="max-w-[520px] text-4xl font-black leading-[1.04] text-white xl:text-5xl">
              {heroTitle}
            </h2>
            <p className="mt-4 max-w-[440px] text-[15px] font-semibold leading-6 text-slate-300">
              {heroCopy}
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

          <div className="hidden min-h-[250px] items-end justify-end gap-4 xl:flex">
            {isBatumDashboard ? (
              <div className="relative flex h-[250px] w-full max-w-[500px] flex-col justify-between overflow-hidden rounded-[24px] border border-amber-200/18 bg-black/10 p-5 shadow-[0_28px_80px_-48px_rgba(245,158,11,0.45)] backdrop-blur-[2px]">
                <div className="grid max-w-[310px] gap-2">
                  {["Batum Bulvarı", "Karadeniz sahili", "Gürcistan ticaret hattı"].map((label) => (
                    <span
                      key={label}
                      className="w-fit rounded-full border border-white/18 bg-slate-950/34 px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.14em] text-white shadow-[0_10px_30px_-22px_rgba(0,0,0,0.9)] backdrop-blur-md"
                    >
                      {label}
                    </span>
                  ))}
                </div>
                <div className="ml-auto flex items-end gap-2">
                  <div className="relative h-[82px] w-[72px] rounded-[16px] border border-white/14 bg-[#113026]/72 p-2 shadow-[0_18px_44px_-30px_rgba(0,0,0,0.85)] backdrop-blur-md">
                    <Image
                      src="/brand/powersa-packshot-1.png"
                      alt="Powersa ürün imzası"
                      fill
                      sizes="72px"
                      loading="eager"
                      quality={75}
                      className="object-contain p-2"
                    />
                  </div>
                  <div className="relative h-[104px] w-[92px] rounded-[18px] border border-amber-200/20 bg-[#163629]/72 p-2 shadow-[0_20px_50px_-30px_rgba(245,158,11,0.45)] backdrop-blur-md">
                    <Image
                      src="/brand/powersa-packshot-2.png"
                      alt="Powersa ürün imzası"
                      fill
                      sizes="92px"
                      loading="eager"
                      quality={75}
                      className="object-contain p-2"
                    />
                  </div>
                </div>
              </div>
            ) : (
              <>
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
              </>
            )}
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
