"use client";

import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  Building2,
  CarFront,
  CreditCard,
  DatabaseZap,
  HandCoins,
  MapPin,
  PackageSearch,
  ReceiptText,
  Search,
  Ship,
  Sparkles,
  UserRound,
  Wallet,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { useSession } from "@/components/auth/session-provider";
import { Button } from "@/components/ui/button";
import { getCurrentPosSession, getPosDayEndReport, type PosDayEndReport, type PosLogoSyncSummary } from "@/lib/api";
import { cn } from "@/lib/utils";

const BRANCH_ACTIONS = [
  {
    title: "Hızlı Satış",
    copy: "Point satış ekranı",
    href: "/pos",
    icon: ReceiptText,
    className: "border-emerald-300/25 bg-emerald-300/12 text-emerald-100",
  },
  {
    title: "Müşteri",
    copy: "{branch} carilerini seç",
    href: "/customers",
    icon: UserRound,
    className: "border-violet-300/25 bg-violet-300/12 text-violet-100",
  },
  {
    title: "Ürün Arama",
    copy: "Stok ve fiyat kontrolü",
    href: "/search",
    icon: Search,
    className: "border-sky-300/25 bg-sky-300/12 text-sky-100",
  },
  {
    title: "Tahsilat",
    copy: "{branch} tahsilatı gir",
    href: "/collections",
    icon: HandCoins,
    className: "border-amber-300/25 bg-amber-300/12 text-amber-100",
  },
  {
    title: "Cari Hesap",
    copy: "Hareket ve bakiye",
    href: "/ledger",
    icon: CreditCard,
    className: "border-cyan-300/25 bg-cyan-300/12 text-cyan-100",
  },
  {
    title: "Masraf",
    copy: "{branch} kasa masrafı",
    href: "/pos/expenses",
    icon: Wallet,
    className: "border-blue-300/25 bg-blue-300/12 text-blue-100",
  },
  {
    title: "Gün Sonu",
    copy: "Kasa gün sonu",
    href: "/pos/day-end",
    icon: Building2,
    className: "border-orange-300/25 bg-orange-300/12 text-orange-100",
  },
  {
    title: "Kataloglar",
    copy: "Marka katalogları",
    href: "/catalogs",
    icon: BookOpen,
    className: "border-teal-300/25 bg-teal-300/12 text-teal-100",
  },
] as const;

const BATUM_VISUAL_TAGS = [
  { title: "Karadeniz", copy: "Sahil operasyonu", className: "border-emerald-200/24 bg-emerald-300/14 text-emerald-50" },
  { title: "Gürcistan", copy: "Batum ticaret hattı", className: "border-red-200/24 bg-red-300/14 text-red-50" },
  { title: "Otomotiv", copy: "Yedek parça lojistiği", className: "border-amber-200/28 bg-amber-300/14 text-amber-50" },
] as const;

const BATUM_GALLERY_IMAGES = [
  {
    src: "/brand/powersa-filter-showcase/batum/batum-coast.jpg",
    alt: "Batum sahil hattı ve şehir görünümü",
    label: "Batum sahili",
  },
  {
    src: "/brand/powersa-filter-showcase/batum/batum-skyline.jpg",
    alt: "Batum şehir silüeti",
    label: "Şehir silüeti",
  },
  {
    src: "/brand/powersa-filter-showcase/batum/batum-night.jpg",
    alt: "Batum gece şehir ışıkları",
    label: "Gece rotası",
  },
] as const;

const TRABZON_VISUAL_TAGS = [
  { title: "Karadeniz", copy: "Trabzon ticaret hattı", className: "border-sky-200/24 bg-sky-300/14 text-sky-50" },
  { title: "Sümela", copy: "Şehrin güçlü mirası", className: "border-amber-200/24 bg-amber-300/14 text-amber-50" },
  { title: "Otomotiv", copy: "Bölgesel hızlı tedarik", className: "border-emerald-200/24 bg-emerald-300/14 text-emerald-50" },
] as const;

const TRABZON_GALLERY_IMAGES = [
  {
    src: "/brand/powersa-filter-showcase/trabzon/trabzon-meydan.webp",
    alt: "Trabzon meydanı ve PowerSA ürünleri",
    label: "Trabzon meydanı",
  },
  {
    src: "/brand/powersa-filter-showcase/trabzon/trabzon-sumela.webp",
    alt: "Sümela Manastırı ve Karadeniz doğası",
    label: "Sümela",
  },
  {
    src: "/brand/powersa-filter-showcase/trabzon/trabzon-yayla.webp",
    alt: "Trabzon yaylasında PowerSA ürünü",
    label: "Yayla rotası",
  },
] as const;

const SAMSUN_VISUAL_TAGS = [
  { title: "Karadeniz", copy: "Samsun lojistik hattı", className: "border-cyan-200/24 bg-cyan-300/14 text-cyan-50" },
  { title: "Bandırma", copy: "Şehrin simge rotası", className: "border-red-200/24 bg-red-300/14 text-red-50" },
  { title: "PowerSA", copy: "Samsun şube merkezi", className: "border-amber-200/28 bg-amber-300/14 text-amber-50" },
] as const;

const SAMSUN_GALLERY_IMAGES = [
  {
    src: "/brand/powersa-filter-showcase/samsun/samsun-powersa-sube.webp",
    alt: "PowerSA Samsun şube vitrini",
    label: "PowerSA Samsun",
  },
  {
    src: "/brand/powersa-filter-showcase/samsun/samsun-onur-aniti.webp",
    alt: "Samsun Onur Anıtı ve PowerSA ürünü",
    label: "Onur Anıtı",
  },
  {
    src: "/brand/powersa-filter-showcase/samsun/samsun-bandirma-vapuru.webp",
    alt: "Bandırma Vapuru ve PowerSA ürünleri",
    label: "Bandırma Vapuru",
  },
] as const;

const DEFAULT_BRANCH_GALLERY_IMAGES = [
  {
    src: "/brand/powersa-filter-showcase/optimized/branch-erzurum.jpg",
    alt: "Powersa Erzurum şube görünümü",
    label: "Erzurum merkez",
  },
  {
    src: "/brand/powersa-filter-showcase/optimized/branch-trabzon.jpg",
    alt: "Powersa Trabzon şube görünümü",
    label: "Trabzon şube",
  },
  {
    src: "/brand/powersa-filter-showcase/optimized/branch-samsun.jpg",
    alt: "Powersa Samsun şube görünümü",
    label: "Samsun şube",
  },
] as const;

const DEFAULT_BRANCH_VISUAL_TAGS = [
  { title: "Şube", copy: "Canlı operasyon", className: "border-emerald-200/18 bg-emerald-300/10 text-emerald-50" },
  { title: "Stok", copy: "Logo bağlantılı", className: "border-sky-200/18 bg-sky-300/10 text-sky-50" },
  { title: "Kasa", copy: "Gün sonu takip", className: "border-amber-200/18 bg-amber-300/10 text-amber-50" },
] as const;

function normalizeBranchLabel(value: string | null | undefined): string {
  const trimmed = value?.trim();

  if (!trimmed) {
    return "Şube";
  }

  return trimmed
    .toLocaleLowerCase("tr-TR")
    .replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase("tr-TR"));
}

function formatBranchDisplayName(branchLabel: string): string {
  const normalized = branchLabel.toLocaleUpperCase("tr-TR");

  if (normalized.includes("ŞUBE")) {
    return branchLabel;
  }

  if (normalized.includes("BATUM")) {
    return `${branchLabel} Şubesi`;
  }

  if (normalized.includes("MERKEZ")) {
    return `${branchLabel} Şubesi`;
  }

  return `${branchLabel} Merkez Şubesi`;
}

function getBranchProfile(branchLabel: string) {
  const normalized = branchLabel.toLocaleUpperCase("tr-TR");
  const branchDisplayName = formatBranchDisplayName(branchLabel);

  if (normalized.includes("BATUM")) {
    return {
      location: "Batum / Gürcistan",
      headline: "Batum Operasyon Merkezi",
      copy: "Karadeniz sahili, Gürcistan ticaret hattı ve otomotiv lojistiği bu panelde tek merkezden yönetilir.",
      images: BATUM_GALLERY_IMAGES,
      tags: BATUM_VISUAL_TAGS,
    };
  }

  if (normalized.includes("TRABZON")) {
    return {
      location: "Trabzon / Karadeniz",
      headline: "Trabzon Operasyon Merkezi",
      copy: "Karadeniz ticareti, bölgesel otomotiv tedariki ve hızlı satış operasyonları Trabzon şubesinde buluşur.",
      images: TRABZON_GALLERY_IMAGES,
      tags: TRABZON_VISUAL_TAGS,
    };
  }

  if (normalized.includes("SAMSUN")) {
    return {
      location: "Samsun / Karadeniz",
      headline: "Samsun Operasyon Merkezi",
      copy: "PowerSA Samsun şubesi, Karadeniz lojistik hattını hızlı satış ve güçlü stok operasyonuyla destekler.",
      images: SAMSUN_GALLERY_IMAGES,
      tags: SAMSUN_VISUAL_TAGS,
    };
  }

  const branchImage = normalized.includes("TRABZON")
    ? DEFAULT_BRANCH_GALLERY_IMAGES[1]
    : normalized.includes("SAMSUN")
      ? DEFAULT_BRANCH_GALLERY_IMAGES[2]
      : DEFAULT_BRANCH_GALLERY_IMAGES[0];
  const secondaryImages = DEFAULT_BRANCH_GALLERY_IMAGES.filter((image) => image.src !== branchImage.src).slice(0, 2);

  return {
    location: `${branchLabel} / Türkiye`,
    headline: `${branchDisplayName} operasyon merkezi`,
    copy: "Satış, cari, tahsilat, kasa ve gün sonu akışları şube kullanıcısına göre çalışır.",
    images: [branchImage, ...secondaryImages],
    tags: DEFAULT_BRANCH_VISUAL_TAGS,
  };
}

function formatCustomerLine(customer: ReturnType<typeof useSession>["selectedCustomer"]): string {
  if (!customer) {
    return "Henüz cari seçilmedi";
  }

  return `${customer.code} · ${customer.title}`;
}

function formatMoney(value: string | number | null | undefined, currency = "TL"): string {
  const amount = Number(value ?? 0);

  return `${currency} ${new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0)}`;
}

function syncTotal(summary: PosLogoSyncSummary | null | undefined, key: keyof PosLogoSyncSummary): number {
  return Number(summary?.[key] ?? 0);
}

function syncLabel(report: PosDayEndReport | null | undefined): string {
  if (!report) {
    return "Canlı rapor bekleniyor";
  }

  const sync = report.logo_sync;
  const failed = syncTotal(sync?.sales, "failed") + syncTotal(sync?.expenses, "failed") + syncTotal(sync?.collections, "failed");
  const pending =
    syncTotal(sync?.sales, "queued") +
    syncTotal(sync?.sales, "processing") +
    syncTotal(sync?.expenses, "queued") +
    syncTotal(sync?.expenses, "processing") +
    syncTotal(sync?.collections, "queued") +
    syncTotal(sync?.collections, "processing");

  if (failed > 0) {
    return `${failed} Logo kaydı hata bekliyor`;
  }

  if (pending > 0) {
    return `${pending} Logo kaydı sırada`;
  }

  return "Logo yazma kuyruğu temiz";
}

export function PointBranchDashboardPage() {
  const { user, selectedCustomer } = useSession();
  const branchLabel = normalizeBranchLabel(user?.branch_name ?? user?.branch_code ?? selectedCustomer?.branch_name ?? selectedCustomer?.branch_code);
  const branchDisplayName = formatBranchDisplayName(branchLabel);
  const selectedCustomerLine = formatCustomerLine(selectedCustomer);
  const branchProfile = getBranchProfile(branchLabel);
  const normalizedBranch = branchLabel.toLocaleUpperCase("tr-TR");
  const isBatumBranch = normalizedBranch.includes("BATUM");
  const isTrabzonBranch = normalizedBranch.includes("TRABZON");
  const isSamsunBranch = normalizedBranch.includes("SAMSUN");
  const isCityPointBranch = isBatumBranch || isTrabzonBranch || isSamsunBranch;
  const currencyLabel = isBatumBranch ? "GEL" : "TL";

  const currentSessionQuery = useQuery({
    queryKey: ["dashboard", "point-pos-session"],
    queryFn: () => getCurrentPosSession(),
    refetchInterval: 20_000,
    staleTime: 10_000,
  });

  const currentSession = currentSessionQuery.data?.data ?? null;
  const dayEndQuery = useQuery({
    queryKey: ["dashboard", "point-day-end", currentSession?.id ?? null],
    queryFn: () => getPosDayEndReport({ pos_session_id: currentSession?.id ?? undefined }),
    enabled: Boolean(currentSession?.id),
    refetchInterval: 20_000,
    staleTime: 10_000,
  });
  const dayEndReport = dayEndQuery.data?.data ?? null;
  const liveMetrics = [
    {
      title: "Canlı Satış",
      value: dayEndReport ? formatMoney(dayEndReport.summary.grand_total, currencyLabel) : "-",
      copy: dayEndReport ? `${dayEndReport.summary.paid_count} kayıt` : currentSessionQuery.isLoading ? "Kasa okunuyor" : "Açık kasa yok",
    },
    {
      title: "Nakit Kasa",
      value: dayEndReport ? formatMoney(dayEndReport.summary.expected_cash, currencyLabel) : "-",
      copy: currentSession?.cashbox?.code ? `${currentSession.cashbox.code} / ${currentSession.cashbox.name ?? "Kasa"}` : "Kasa seçilmedi",
    },
    {
      title: "Masraf",
      value: dayEndReport ? formatMoney(dayEndReport.expenses.total_amount, currencyLabel) : "-",
      copy: dayEndReport ? `${dayEndReport.expenses.count} kayıt` : "Canlı rapor bekleniyor",
    },
    {
      title: "Logo Sync",
      value: dayEndReport
        ? String(
            syncTotal(dayEndReport.logo_sync.sales, "synced") +
              syncTotal(dayEndReport.logo_sync.expenses, "synced") +
              syncTotal(dayEndReport.logo_sync.collections, "synced")
          )
        : "-",
      copy: syncLabel(dayEndReport),
    },
  ];

  if (isTrabzonBranch || isSamsunBranch) {
    const cityProfile = isTrabzonBranch
      ? {
          city: "Trabzon",
          badge: "TR · KARADENİZ · TRABZON POINT",
          accent: "text-sky-300",
          heroImage: {
            src: "/brand/powersa-filter-showcase/trabzon/trabzon-hero-hq.webp",
            alt: "Trabzon şehir rotası ve PowerSA ürünleri",
          },
          heroPosition: "object-center",
          copy: "Karadeniz’in güçlü ticaret hattında otomotiv, hızlı satış ve bölgesel tedarik.",
          heroBorder: "border-sky-300/35",
          heroGlow: "shadow-[0_32px_90px_-50px_rgba(14,165,233,0.52)]",
          primaryButton: "bg-sky-300 hover:bg-sky-200",
          cards: [
            {
              eyebrow: "01",
              title: "Trabzon Meydanı",
              copy: "Şehrin merkezinden bölgeye uzanan hızlı operasyon.",
              href: "/dashboard",
              image: TRABZON_GALLERY_IMAGES[0],
              icon: MapPin,
            },
            {
              eyebrow: "02",
              title: "Sümela Rotası",
              copy: "Trabzon’un güçlü mirasıyla güvenilir tedarik.",
              href: "/search",
              image: TRABZON_GALLERY_IMAGES[1],
              icon: Building2,
            },
            {
              eyebrow: "03",
              title: "Yayla Lojistiği",
              copy: "Karadeniz’in her noktasına hızlı ürün akışı.",
              href: "/orders",
              image: TRABZON_GALLERY_IMAGES[2],
              icon: CarFront,
            },
            {
              eyebrow: "04",
              title: "PowerSA Ürünleri",
              copy: "Filtre teknolojisi, güçlü stok ve hızlı satış.",
              href: "/catalogs",
              image: {
                src: "/brand/powersa-filter-showcase/optimized/featured-1.jpg",
                alt: "PowerSA filtre ürünleri",
                label: "PowerSA ürünleri",
              },
              icon: PackageSearch,
            },
          ],
        }
      : {
          city: "Samsun",
          badge: "TR · KARADENİZ · SAMSUN POINT",
          accent: "text-amber-300",
          heroImage: {
            src: "/brand/powersa-filter-showcase/samsun/samsun-hero-hq.webp",
            alt: "PowerSA Samsun şubesi",
          },
          heroPosition: "object-center",
          copy: "Karadeniz’in lojistik merkezinde PowerSA şubesi, hızlı satış ve güçlü stok.",
          heroBorder: "border-amber-300/35",
          heroGlow: "shadow-[0_32px_90px_-50px_rgba(250,204,21,0.5)]",
          primaryButton: "bg-amber-300 hover:bg-amber-200",
          cards: [
            {
              eyebrow: "01",
              title: "PowerSA Samsun",
              copy: "Samsun şubemizden güçlü stok ve hızlı hizmet.",
              href: "/dashboard",
              image: SAMSUN_GALLERY_IMAGES[0],
              icon: Building2,
            },
            {
              eyebrow: "02",
              title: "Onur Anıtı",
              copy: "Şehrin simgesinden bölgeye uzanan operasyon.",
              href: "/search",
              image: SAMSUN_GALLERY_IMAGES[1],
              icon: MapPin,
            },
            {
              eyebrow: "03",
              title: "Bandırma Hattı",
              copy: "Karadeniz lojistiğinde hızlı ve güvenilir tedarik.",
              href: "/orders",
              image: SAMSUN_GALLERY_IMAGES[2],
              icon: Ship,
            },
            {
              eyebrow: "04",
              title: "PowerSA Ürünleri",
              copy: "Filtre teknolojisi, güçlü stok ve hızlı satış.",
              href: "/catalogs",
              image: {
                src: "/brand/powersa-filter-showcase/optimized/featured-1.jpg",
                alt: "PowerSA filtre ürünleri",
                label: "PowerSA ürünleri",
              },
              icon: PackageSearch,
            },
          ],
        };

    return (
      <div className="mx-auto w-full max-w-[1480px] space-y-4 pb-2 text-slate-100">
        <section
          className={cn(
            "relative isolate min-h-[430px] overflow-hidden rounded-[28px] border bg-[#07130f]",
            cityProfile.heroBorder,
            cityProfile.heroGlow
          )}
        >
          <Image
            src={cityProfile.heroImage.src}
            alt={cityProfile.heroImage.alt}
            fill
            priority
            quality={90}
            sizes="(max-width: 768px) 100vw, 1480px"
            className={cn("object-cover saturate-[1.08] contrast-[1.08]", cityProfile.heroPosition)}
          />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,#06140f_0%,rgba(6,20,15,0.97)_31%,rgba(4,14,18,0.48)_64%,rgba(2,8,12,0.18)_100%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.02)_42%,rgba(2,10,8,0.78)_100%)]" />
          <div className="absolute -left-16 top-12 h-72 w-72 rounded-full bg-emerald-400/10 blur-3xl" />

          <div className="relative z-10 flex min-h-[430px] flex-col justify-between gap-8 p-6 sm:p-9 lg:p-12">
            <div className="max-w-[700px]">
              <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-white/25 bg-[#07140f]/72 px-4 py-2 text-[11px] font-black uppercase tracking-[0.18em] text-white shadow-lg backdrop-blur-md">
                <MapPin className={cn("h-4 w-4", cityProfile.accent)} />
                {cityProfile.badge}
              </div>
              <h1 className="max-w-[680px] text-[clamp(3.15rem,6.2vw,6.5rem)] font-black uppercase leading-[0.84] tracking-[-0.065em] text-white [text-shadow:0_14px_38px_rgba(0,0,0,0.6)]">
                {cityProfile.city}
              </h1>
              <p
                className={cn(
                  "mt-2 text-[clamp(1.65rem,3vw,3.2rem)] font-black uppercase leading-none tracking-[-0.035em] [text-shadow:0_10px_28px_rgba(0,0,0,0.58)]",
                  cityProfile.accent
                )}
              >
                Operasyon Merkezi
              </p>
              <p className="mt-5 max-w-[630px] text-base font-bold leading-7 text-slate-200 sm:text-lg">
                {cityProfile.copy}
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                asChild
                className={cn(
                  "h-12 rounded-[13px] px-6 text-sm font-black text-slate-950 shadow-[0_18px_45px_-24px_rgba(52,211,153,0.9)]",
                  cityProfile.primaryButton
                )}
              >
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

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {cityProfile.cards.map((card) => {
            const Icon = card.icon;

            return (
              <Link
                href={card.href}
                key={card.title}
                className="group relative isolate min-h-[310px] overflow-hidden rounded-[24px] border border-white/15 bg-[#08130f] shadow-[0_24px_65px_-48px_rgba(0,0,0,0.95)]"
              >
                <Image
                  src={card.image.src}
                  alt={card.image.alt}
                  fill
                  quality={88}
                  sizes="(max-width: 768px) 100vw, 25vw"
                  className="object-cover transition duration-700 group-hover:scale-[1.045]"
                />
                <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(2,9,7,0.03)_8%,rgba(2,9,7,0.4)_50%,rgba(2,9,7,0.97)_100%)]" />
                <div className="absolute inset-x-0 bottom-0 z-10 flex items-end justify-between gap-4 p-5 sm:p-6">
                  <div className="max-w-[78%]">
                    <div className={cn("mb-3 flex items-center gap-2 text-xs font-black tracking-[0.18em]", cityProfile.accent)}>
                      <span>{card.eyebrow}</span>
                      <span className="h-px w-9 bg-current/60" />
                    </div>
                    <h2 className="text-2xl font-black uppercase leading-tight tracking-[-0.025em] text-white">
                      {card.title}
                    </h2>
                    <p className="mt-2 text-sm font-semibold leading-5 text-slate-300">{card.copy}</p>
                  </div>
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-white/30 bg-black/45 text-white backdrop-blur-md transition group-hover:-translate-y-1 group-hover:bg-white group-hover:text-slate-950">
                    <Icon className="h-5 w-5" />
                  </span>
                </div>
              </Link>
            );
          })}
        </section>

        <section className="grid gap-2 rounded-[22px] border border-white/10 bg-[#071612]/90 p-3 sm:grid-cols-2 lg:grid-cols-4">
          {liveMetrics.map((metric) => (
            <div key={metric.title} className="rounded-[16px] border border-white/8 bg-white/[0.035] p-3.5">
              <span className="text-[10px] font-black uppercase tracking-[0.14em] text-emerald-200">{metric.title}</span>
              <strong className="mt-1.5 block text-xl font-black text-white">{metric.value}</strong>
              <span className="mt-1 block text-[11px] font-bold leading-4 text-slate-400">{metric.copy}</span>
            </div>
          ))}
        </section>

        <section className="grid overflow-hidden rounded-[22px] border border-white/10 bg-[#071612]/90 sm:grid-cols-2 lg:grid-cols-4">
          {BRANCH_ACTIONS.map((action) => {
            const Icon = action.icon;

            return (
              <Link
                key={action.href}
                href={action.href}
                className="group flex min-h-[82px] items-center gap-3 border-b border-white/8 px-4 py-3 transition hover:bg-white/[0.06] sm:border-r"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] border border-emerald-200/15 bg-emerald-300/10 text-emerald-200">
                  <Icon className="h-5 w-5" />
                </span>
                <span className="min-w-0">
                  <strong className="block text-sm font-black text-white">{action.title}</strong>
                  <span className="mt-1 block truncate text-xs font-semibold text-slate-400">
                    {action.copy.replace("{branch}", branchDisplayName)}
                  </span>
                </span>
                <ArrowRight className="ml-auto h-4 w-4 shrink-0 text-slate-600 transition group-hover:translate-x-1 group-hover:text-white" />
              </Link>
            );
          })}
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-4 text-slate-100">
      <section
        className={cn(
          "overflow-hidden rounded-[24px] border border-emerald-300/18 bg-[linear-gradient(135deg,rgba(9,21,29,0.96)_0%,rgba(12,38,30,0.94)_56%,rgba(18,24,34,0.96)_100%)] shadow-[0_24px_70px_-58px_rgba(0,0,0,0.9)]",
          isBatumBranch &&
            "border-amber-200/25 bg-[radial-gradient(circle_at_78%_8%,rgba(245,158,11,0.20),transparent_30%),radial-gradient(circle_at_18%_12%,rgba(16,185,129,0.22),transparent_34%),linear-gradient(135deg,rgba(5,18,22,0.98)_0%,rgba(14,38,36,0.94)_52%,rgba(35,21,10,0.96)_100%)] shadow-[0_28px_84px_-58px_rgba(245,158,11,0.48)]",
          isTrabzonBranch &&
            "border-sky-200/25 bg-[radial-gradient(circle_at_82%_8%,rgba(14,165,233,0.22),transparent_31%),radial-gradient(circle_at_12%_18%,rgba(16,185,129,0.20),transparent_35%),linear-gradient(135deg,rgba(5,18,24,0.98)_0%,rgba(9,38,45,0.95)_52%,rgba(8,27,22,0.97)_100%)] shadow-[0_28px_84px_-58px_rgba(14,165,233,0.48)]",
          isSamsunBranch &&
            "border-cyan-200/25 bg-[radial-gradient(circle_at_80%_10%,rgba(34,211,238,0.20),transparent_31%),radial-gradient(circle_at_14%_14%,rgba(250,204,21,0.18),transparent_33%),linear-gradient(135deg,rgba(4,19,21,0.98)_0%,rgba(8,39,36,0.95)_52%,rgba(23,28,12,0.96)_100%)] shadow-[0_28px_84px_-58px_rgba(34,211,238,0.42)]"
        )}
      >
        <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-stretch lg:p-6">
          <div className="flex min-h-[220px] flex-col justify-between rounded-[20px] border border-white/8 bg-white/[0.035] p-5">
            <div>
              <div
                className={cn(
                  "mb-4 inline-flex items-center gap-2 rounded-full border border-emerald-200/20 bg-emerald-300/10 px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.16em] text-emerald-100",
                  isBatumBranch && "border-amber-200/30 bg-amber-200/14 text-amber-50",
                  isTrabzonBranch && "border-sky-200/30 bg-sky-200/14 text-sky-50",
                  isSamsunBranch && "border-cyan-200/30 bg-cyan-200/14 text-cyan-50"
                )}
              >
                <Sparkles className="h-3.5 w-3.5" />
                {isBatumBranch
                  ? "🇬🇪 BATUM OPERASYON MERKEZİ"
                  : isTrabzonBranch
                    ? "TRABZON · KARADENİZ OPERASYON MERKEZİ"
                    : isSamsunBranch
                      ? "SAMSUN · KARADENİZ OPERASYON MERKEZİ"
                      : "Burası bizim şubemiz"}
              </div>
              <h1 className="max-w-[720px] text-4xl font-black leading-[1.04] text-white md:text-5xl">
                {branchDisplayName}
              </h1>
              <p className="mt-3 max-w-[620px] text-base font-semibold leading-7 text-slate-300">
                Satış, müşteri, tahsilat, masraf ve gün sonu işlemlerini buradan yönetin.
              </p>
            </div>

            <div className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {liveMetrics.map((metric) => (
                <div key={metric.title} className="rounded-[16px] border border-white/8 bg-black/16 p-3">
                  <span className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.14em] text-emerald-100">
                    {metric.title === "Logo Sync" ? <DatabaseZap className="h-3.5 w-3.5" /> : null}
                    {metric.title}
                  </span>
                  <strong className="mt-2 block text-xl font-black text-white">{metric.value}</strong>
                  <span className="mt-1 block text-[11px] font-bold leading-4 text-slate-300">{metric.copy}</span>
                </div>
              ))}
            </div>

            <div className="mt-6 flex flex-wrap gap-3">
              <Button asChild className="h-12 rounded-[14px] bg-emerald-400 px-5 text-sm font-black text-slate-950 hover:bg-emerald-300">
                <Link href="/pos">Hızlı Satışa Git</Link>
              </Button>
              <Button
                asChild
                variant="outline"
                className="h-12 rounded-[14px] border-white/12 bg-white/6 px-5 text-sm font-black text-white hover:bg-white/10 hover:text-white"
              >
                <Link href="/customers">Cari Seç</Link>
              </Button>
            </div>
          </div>

          <div className="grid gap-3">
            <div className="relative overflow-hidden rounded-[20px] border border-emerald-200/15 bg-[#08131b] p-2">
              <div className="grid min-h-[248px] gap-2 sm:grid-cols-[1.35fr_0.85fr]">
                <div className="relative min-h-[248px] overflow-hidden rounded-[16px] border border-white/10 bg-slate-950">
                  <Image
                    src={branchProfile.images[0].src}
                    alt={branchProfile.images[0].alt}
                    fill
                    priority
                    sizes="(min-width: 1024px) 260px, 100vw"
                    className={cn(
                      "object-cover opacity-90",
                      isCityPointBranch && "saturate-[1.06] contrast-[1.03]"
                    )}
                  />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_12%,rgba(52,211,153,0.30),transparent_34%),linear-gradient(180deg,rgba(4,10,16,0.08)_0%,rgba(4,10,16,0.86)_100%)]" />
                  <div className="absolute left-4 top-4 rounded-full border border-white/16 bg-slate-950/60 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.18em] text-emerald-50 backdrop-blur">
                    {branchProfile.location}
                  </div>
                  <div className="absolute bottom-4 left-4 right-4">
                    <p className="text-[11px] font-black uppercase tracking-[0.18em] text-emerald-100">Şube görsel alanı</p>
                    <h2 className="mt-1 text-2xl font-black leading-tight text-white">{branchProfile.headline}</h2>
                    <p className="mt-2 max-w-[300px] text-sm font-bold leading-5 text-slate-200">
                      {branchProfile.copy}
                    </p>
                  </div>
                </div>

                <div className="grid min-h-[170px] grid-cols-2 gap-2 sm:min-h-0 sm:grid-cols-1">
                  {branchProfile.images.slice(1).map((image) => (
                    <div key={image.src} className="relative min-h-[118px] overflow-hidden rounded-[16px] border border-white/10 bg-slate-950">
                      <Image src={image.src} alt={image.alt} fill sizes="(min-width: 1024px) 150px, 50vw" className="object-cover opacity-85" />
                      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(4,10,16,0.04)_0%,rgba(4,10,16,0.72)_100%)]" />
                      <span className="absolute bottom-3 left-3 right-3 text-[11px] font-black uppercase tracking-[0.14em] text-white">
                        {image.label}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-3">
              {branchProfile.tags.map((tag) => (
                <div key={tag.title} className={cn("rounded-[16px] border p-3", tag.className)}>
                  <span className="block text-sm font-black">{tag.title}</span>
                  <span className="mt-1 block text-[11px] font-bold text-slate-300">{tag.copy}</span>
                </div>
              ))}
            </div>

            <div className="rounded-[20px] border border-white/8 bg-[#08131b]/70 p-5">
              <span className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Seçili Cari</span>
              <p className="mt-3 text-2xl font-black leading-tight text-white">{selectedCustomerLine}</p>
              <div className="mt-5 grid gap-3 text-sm font-bold text-slate-300">
                <div className="rounded-[16px] border border-white/8 bg-white/[0.035] p-4">
                  <span className="block text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">Şube</span>
                  <span className="mt-1 block text-lg font-black text-emerald-100">{branchDisplayName}</span>
                </div>
                <div className="rounded-[16px] border border-white/8 bg-white/[0.035] p-4">
                  <span className="block text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">Panel</span>
                  <span className="mt-1 block text-lg font-black text-slate-100">Point B2B</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {BRANCH_ACTIONS.map((action) => {
          const Icon = action.icon;

          return (
            <Link
              key={action.href}
              href={action.href}
              className={cn(
                "group min-h-[132px] rounded-[18px] border p-4 transition hover:-translate-y-0.5 hover:bg-white/[0.07]",
                action.className
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-[14px] border border-current/20 bg-black/18">
                  <Icon className="h-5 w-5" />
                </span>
                <PackageSearch className="h-4 w-4 opacity-0 transition group-hover:opacity-70" />
              </div>
              <h2 className="mt-5 text-xl font-black text-white">{action.title}</h2>
              <p className="mt-1 text-sm font-bold text-slate-300">{action.copy.replace("{branch}", branchDisplayName)}</p>
            </Link>
          );
        })}
      </section>
    </div>
  );
}
