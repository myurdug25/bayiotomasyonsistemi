"use client";

import {
  ArrowUpRight,
  BookOpen,
} from "lucide-react";

import { cn } from "@/lib/utils";

const EXTERNAL_CATALOGS = [
  {
    title: "Mann Filter",
    href: "https://catalog.mann-filter.com/EU/tur",
    accent: "from-[#f4d94e] via-[#d2b838] to-[#846f1c]",
    text: "text-[#15180b]",
  },
  {
    title: "Şampiyon",
    href: "https://www.sampiyonfilter.com.tr/katalog",
    accent: "from-[#ff7b6e] via-[#c73932] to-[#6f1519]",
    text: "text-white",
  },
  {
    title: "Motoec",
    href: "http://www.motoec.com/Catalog.aspx",
    accent: "from-[#80d8ff] via-[#2f92cb] to-[#164b77]",
    text: "text-white",
  },
  {
    title: "Rixenberg",
    href: "http://catalog.rixenberg.com/tr/anasayfa.html",
    accent: "from-[#8f969f] via-[#3e4650] to-[#12161b]",
    text: "text-white",
  },
  {
    title: "Donaldson",
    href: "https://shop.donaldson.com/store/tr-tr/home?_requestid=7669047",
    accent: "from-[#bed7f3] via-[#6d95c0] to-[#334d6a]",
    text: "text-white",
  },
  {
    title: "Autoloft",
    href: "https://autoloft.com.tr/urunlerimiz/",
    accent: "from-[#c7f9cc] via-[#4caf50] to-[#1b5e20]",
    text: "text-white",
  },
  {
    title: "Delsa Filtre",
    href: "https://delsafiltre.com/FiltreNew.aspx",
    accent: "from-[#ffe082] via-[#ff9800] to-[#8a4b00]",
    text: "text-white",
  },
  {
    title: "SCT Filter",
    href: "https://sct-catalogue.de/?tab=vehicle",
    accent: "from-[#ffcc80] via-[#f57c00] to-[#7a2f00]",
    text: "text-white",
  },
  {
    title: "Ferra Filter",
    href: "https://www.ferrafilter.com/products.php",
    accent: "from-[#a7f3d0] via-[#059669] to-[#064e3b]",
    text: "text-white",
  },
  {
    title: "Baldwin Filters",
    href: "https://www.baldwinfilters.com/us/en/cross-reference-result-page.html",
    accent: "from-[#ef4444] via-[#b91c1c] to-[#4c0519]",
    text: "text-white",
  },
  {
    title: "Sakura Filter",
    href: "https://www.sakurafilter.com/products",
    accent: "from-[#f9a8d4] via-[#db2777] to-[#831843]",
    text: "text-white",
  },
  {
    title: "Asas Filter",
    href: "https://asasfilter.com/",
    accent: "from-[#d9f99d] via-[#65a30d] to-[#365314]",
    text: "text-white",
  },
  {
    title: "Bosch",
    href: "https://www.boschaftermarket.com/tr/tr/urunler/product-search.html",
    accent: "from-[#fca5a5] via-[#dc2626] to-[#7f1d1d]",
    text: "text-white",
  },
  {
    title: "Gold Filtre",
    href: "https://www.goldfilter.com.tr/caprazreferans.asp",
    accent: "from-[#fde68a] via-[#d97706] to-[#78350f]",
    text: "text-white",
  },
  {
    title: "Fleetguard",
    href: "https://www.fleetguard.com/",
    accent: "from-[#f0b36c] via-[#c67724] to-[#6b360e]",
    text: "text-white",
  },
  {
    title: "Barem Filtre",
    href: "https://www.baremmakina.com.tr/index.php",
    accent: "from-[#e5e7eb] via-[#6b7280] to-[#111827]",
    text: "text-white",
  },
  {
    title: "Fil Filter",
    href: "https://catalog.filfilter.com.tr/tr",
    accent: "from-[#86efac] via-[#16a34a] to-[#14532d]",
    text: "text-white",
  },
  {
    title: "Hengst",
    href: "https://catalog.hengst.com/tr/online-kataloga/arama/?catalog=tr",
    accent: "from-[#93c5fd] via-[#2563eb] to-[#1e3a8a]",
    text: "text-white",
  },
  {
    title: "Mahle",
    href: "https://web.tecalliance.net/mahle-catalog/en/home?sessionTargetCountry=GB&sessionArticleCountry=GB",
    accent: "from-[#bfdbfe] via-[#3b82f6] to-[#1d4ed8]",
    text: "text-white",
  },
  {
    title: "Wind",
    href: "https://windcatalog.com/FiltreNew.aspx",
    accent: "from-[#bae6fd] via-[#0284c7] to-[#075985]",
    text: "text-white",
  },
  {
    title: "Sure Filter",
    href: "https://www.surefilter.com/products",
    accent: "from-[#ccfbf1] via-[#14b8a6] to-[#134e4a]",
    text: "text-white",
  },
] as const;

export function CatalogsPage() {
  return (
    <div className="mx-auto w-full max-w-[1480px] space-y-4 text-slate-100">
      <section id="marka-kataloglari" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {EXTERNAL_CATALOGS.map((catalog) => (
          <a
            key={catalog.title}
            href={catalog.href}
            target="_blank"
            rel="noreferrer"
            className={cn(
              "group relative flex min-h-[158px] overflow-hidden rounded-[24px] border border-white/10 bg-gradient-to-br p-5 shadow-[0_22px_48px_-36px_rgba(0,0,0,0.72)] transition hover:-translate-y-1 hover:border-white/30",
              catalog.accent,
              catalog.text
            )}
          >
            <span className="absolute inset-x-0 top-0 h-px bg-white/45" />
            <span className="absolute -right-10 -top-12 h-36 w-36 rounded-full bg-white/18 blur-2xl transition group-hover:scale-125" />
            <span className="relative z-10 flex h-full w-full flex-col justify-between">
              <span className="flex items-center justify-between gap-3">
                <span className="flex h-13 w-13 items-center justify-center rounded-[18px] border border-white/20 bg-white/18 backdrop-blur">
                  <BookOpen className="h-6 w-6" />
                </span>
                <ArrowUpRight className="h-6 w-6 opacity-75 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100" />
              </span>
              <span>
                <strong className="block text-[1.65rem] font-black leading-none tracking-tight">{catalog.title}</strong>
                <span className="mt-3 inline-flex rounded-full border border-white/20 bg-white/16 px-3 py-1 text-xs font-black uppercase tracking-[0.1em]">
                  Kataloğu Aç
                </span>
              </span>
            </span>
          </a>
        ))}
      </section>
    </div>
  );
}
