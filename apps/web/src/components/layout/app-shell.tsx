"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BookOpen,
  Building2,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Clock3,
  CreditCard,
  FileText,
  FileBarChart2,
  Gauge,
  HandCoins,
  LogOut,
  NotebookPen,
  Palette,
  PackageCheck,
  PhoneCall,
  RefreshCcw,
  ReceiptText,
  Search,
  Settings,
  ShieldCheck,
  ShoppingCart,
  UserPlus,
  UserRound,
  UserRoundCog,
  Users,
  Wallet,
} from "lucide-react";

import { useSession } from "@/components/auth/session-provider";
import { useCart } from "@/components/cart/cart-provider";
import { NfsSoftCredit } from "@/components/layout/nfssoft-credit";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  getTcmbMarketRates,
  listCustomers,
  type ApiUser,
  type TcmbMarketRatesResponse,
  updateProfile,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type NavItem = {
  href: string;
  label: string;
  permissionKey?: string;
  icon: React.ComponentType<{ className?: string }>;
  emojiAsset?: string;
  tileGradient: string;
  allowedRoles?: string[];
  visibleForAll?: boolean;
  badge?: string;
  secondaryBadge?: string;
  hiddenFromSidebar?: boolean;
};

type UiTheme = "light" | "dark";

const UI_THEME_STORAGE_KEY = "powersa-ui-theme";
const UI_ACCENT_STORAGE_KEY = "powersa-ui-accent";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "powersa-sidebar-collapsed";
const SIDEBAR_ITEM_ORDER_STORAGE_PREFIX = "powersa-sidebar-item-order-v1";
const LEGACY_UI_COLOR_STORAGE_KEY = "powersa-ui-color";
const DEFAULT_UI_ACCENT = "#3f7b58";
const BLACK_UI_ACCENT = "#000000";
const DEPRECATED_YELLOW_UI_ACCENT = "#b48722";

const UI_COLOR_OPTIONS: Array<{
  value: string;
  label: string;
  previewClassName: string;
}> = [
  { value: BLACK_UI_ACCENT, label: "Siyah", previewClassName: "from-[#1c1c1c] to-[#000000]" },
  { value: "#3f7b58", label: "Yesil", previewClassName: "from-[#548d67] to-[#2a5a40]" },
  { value: "#ad564f", label: "Kirmizi", previewClassName: "from-[#c67670] to-[#77342f]" },
  { value: "#3a6f9f", label: "Mavi", previewClassName: "from-[#5d92c1] to-[#204c72]" },
];

const LEGACY_UI_COLOR_MAP: Record<string, string> = {
  green: "#3f7b58",
  amber: BLACK_UI_ACCENT,
  red: "#ad564f",
  blue: "#3a6f9f",
};

function resolveUiTheme(): UiTheme {
  return "dark";
}

function isHexColor(value: string | null | undefined): value is string {
  return /^#[0-9a-fA-F]{6}$/.test(value ?? "");
}

function normalizeUiAccent(value: string | null | undefined): string {
  if (isHexColor(value)) {
    const normalized = value.toLowerCase();
    return normalized === DEPRECATED_YELLOW_UI_ACCENT ? BLACK_UI_ACCENT : normalized;
  }

  if (value && value in LEGACY_UI_COLOR_MAP) {
    return LEGACY_UI_COLOR_MAP[value];
  }

  return DEFAULT_UI_ACCENT;
}

function initialsFromName(name: string | null | undefined): string {
  const parts = (name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) {
    return "P";
  }

  return parts
    .slice(0, 2)
    .map((part) => Array.from(part)[0]?.toLocaleUpperCase("tr-TR") ?? "")
    .join("");
}

function formatHeaderRate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const compact = value.trim().replace(/\s+/g, "");

  if (!compact) {
    return null;
  }

  const hasComma = compact.includes(",");
  const hasDot = compact.includes(".");
  let normalized = compact;

  if (hasComma && hasDot) {
    const lastComma = compact.lastIndexOf(",");
    const lastDot = compact.lastIndexOf(".");

    if (lastComma > lastDot) {
      // tr-TR style with dot thousand separators.
      normalized = compact.replace(/\./g, "").replace(",", ".");
    } else {
      // en-US style with comma thousand separators.
      normalized = compact.replace(/,/g, "");
    }
  } else if (hasComma) {
    // default comma decimal fallback (46,3557 -> 46.3557).
    normalized = compact.replace(",", ".");
  }

  const numeric = Number(normalized);

  if (!Number.isFinite(numeric)) {
    return null;
  }

  return new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(numeric);
}

function HeaderMarketRates({
  payload,
  loading,
}: {
  payload?: TcmbMarketRatesResponse;
  loading: boolean;
}) {
  const rateMap = new Map((payload?.rates ?? []).map((rate) => [rate.code, rate]));
  const rates = ["USD", "EUR"]
    .map((code) => {
      const rate = rateMap.get(code);
      const value = formatHeaderRate(rate?.forex_selling ?? rate?.forex_buying);

      return value ? { code, value } : null;
    })
    .filter((rate): rate is { code: string; value: string } => Boolean(rate));

  if (!loading && rates.length === 0) {
    return null;
  }

  return (
    <div
      className="header-market-rates"
      title={payload?.source_date ? `TCMB ${payload.source_date}` : "TCMB güncel döviz kurları"}
    >
      <Wallet className="h-4 w-4 shrink-0 text-[var(--brand-primary)]" />
      {rates.length > 0 ? (
        <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          {rates.map((rate) => (
            <span key={rate.code} className="header-rate-chip">
              <span>{rate.code}</span>
              <strong>{rate.value}</strong>
            </span>
          ))}
        </div>
      ) : (
        <span className="whitespace-nowrap text-[12px] text-[var(--muted-foreground)]">Kurlar alınıyor</span>
      )}
    </div>
  );
}

function resolveUiAccent(): string {
  if (typeof document !== "undefined") {
    const inlineAccent = document.documentElement.style.getPropertyValue("--ui-accent-base").trim();
    return normalizeUiAccent(inlineAccent);
  }

  return DEFAULT_UI_ACCENT;
}

function applyUiTheme(theme: UiTheme) {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.dataset.uiTheme = theme;

  if (typeof window !== "undefined") {
    window.localStorage.setItem(UI_THEME_STORAGE_KEY, theme);
  }
}

function applyUiAccent(accent: string) {
  if (typeof document === "undefined") {
    return;
  }

  const normalizedAccent = normalizeUiAccent(accent);
  document.documentElement.style.setProperty("--ui-accent-base", normalizedAccent);
  document.documentElement.dataset.uiColor = "custom";

  if (typeof window !== "undefined") {
    window.localStorage.setItem(UI_ACCENT_STORAGE_KEY, normalizedAccent);
  }
}

const SIDEBAR_ITEMS: NavItem[] = [
  {
    href: "/notes",
    label: "Notlar",
    permissionKey: "notes",
    icon: NotebookPen,
    tileGradient: "from-[#b7efe1] via-[#72c8b4] to-[#327a71]",
    allowedRoles: ["admin", "dealer_admin", "salesperson", "customer", "cashier", "point"],
  },
  {
    href: "/dashboard",
    label: "Ana Sayfa",
    permissionKey: "dashboard",
    icon: Gauge,
    emojiAsset: "/apple-icons/sidebar/kontrol-paneli.webp",
    tileGradient: "from-[#f0c78c] to-[#cc8b45]",
    allowedRoles: ["admin", "dealer_admin", "salesperson", "customer", "cashier", "point"],
  },
  {
    href: "/search",
    label: "Ürün Arama",
    permissionKey: "search",
    icon: Search,
    emojiAsset: "/apple-icons/sidebar/urun-arama.webp",
    tileGradient: "from-[#93c4ef] to-[#4a86c9]",
    allowedRoles: ["admin", "dealer_admin", "salesperson", "customer"],
  },
  {
    href: "/catalogs",
    label: "Kataloglar",
    permissionKey: "catalogs",
    icon: BookOpen,
    emojiAsset: "/apple-icons/sidebar/kataloglar.webp",
    tileGradient: "from-[#d5c698] to-[#a08b4b]",
    allowedRoles: ["admin", "dealer_admin", "salesperson", "customer"],
  },
  {
    href: "/cart",
    label: "Sepet",
    permissionKey: "cart",
    icon: ShoppingCart,
    emojiAsset: "/apple-icons/sidebar/sepet.webp",
    tileGradient: "from-[#f3cf93] to-[#d79d46]",
    allowedRoles: ["admin", "dealer_admin", "salesperson", "customer"],
  },
  {
    href: "/orders",
    label: "Sipariş",
    permissionKey: "orders",
    icon: ClipboardList,
    emojiAsset: "/dashboard-icons/fixed/siparisler.webp",
    tileGradient: "from-[#f7b6b2] to-[#dd7d78]",
    allowedRoles: ["admin", "dealer_admin", "salesperson", "customer"],
  },
  {
    href: "/customers",
    label: "Müşteri",
    permissionKey: "customers",
    icon: Users,
    emojiAsset: "/apple-icons/sidebar/musteri.webp",
    tileGradient: "from-[#a3a3ef] to-[#6867d8]",
    allowedRoles: ["admin", "salesperson"],
  },
  {
    href: "/customer-users",
    label: "Müşteri Kullanıcı",
    permissionKey: "customer-users",
    icon: UserRoundCog,
    emojiAsset: "/dashboard-icons/fixed/moderator.webp",
    tileGradient: "from-[#c7d2fe] to-[#6d6edc]",
    allowedRoles: ["admin", "moderator"],
  },
  {
    href: "/new-customer-card",
    label: "Yeni Cari Kart",
    permissionKey: "new-customer-card",
    icon: UserPlus,
    emojiAsset: "/dashboard-icons/fixed/yeni_cari_kart.webp",
    tileGradient: "from-[#b5d3ba] to-[#5d9370]",
    allowedRoles: ["admin", "salesperson", "point"],
  },
  {
    href: "/ledger",
    label: "Cari Hesap",
    permissionKey: "ledger",
    icon: Wallet,
    emojiAsset: "/dashboard-icons/fixed/cari_hesap.webp",
    tileGradient: "from-[#99d8ba] to-[#4f9e76]",
    allowedRoles: ["admin", "salesperson", "customer"],
  },
  {
    href: "/collections",
    label: "Tahsilat",
    permissionKey: "collections",
    icon: HandCoins,
    emojiAsset: "/dashboard-icons/fixed/tahsilat.webp",
    tileGradient: "from-[#f7e297] to-[#d0b24a]",
    allowedRoles: ["admin", "salesperson"],
  },
  {
    href: "/reports",
    label: "Raporlar",
    permissionKey: "reports",
    icon: FileBarChart2,
    emojiAsset: "/dashboard-icons/fixed/raporlar.webp",
    tileGradient: "from-[#afe8f0] to-[#66c2d6]",
    allowedRoles: ["admin", "salesperson"],
  },
  {
    href: "/returns",
    label: "İade / Arıza",
    permissionKey: "returns",
    icon: RefreshCcw,
    emojiAsset: "/dashboard-icons/fixed/iade_ariza.webp",
    tileGradient: "from-[#efb3a7] to-[#ca614f]",
    allowedRoles: ["admin", "dealer_admin", "salesperson"],
  },
  {
    href: "/pos",
    label: "Hızlı Satış",
    permissionKey: "pos",
    icon: ReceiptText,
    emojiAsset: "/dashboard-icons/fixed/hizli_satis_pos.webp",
    tileGradient: "from-[#faee56] via-[#72bf82] to-[#1f6b45]",
    allowedRoles: ["admin", "cashier", "point"],
  },
  {
    href: "/warehouse",
    label: "Depo Siparişleri",
    permissionKey: "warehouse",
    icon: ClipboardList,
    emojiAsset: "/dashboard-icons/fixed/depo.webp",
    tileGradient: "from-[#b7d3b2] to-[#5f8f64]",
    allowedRoles: ["admin", "warehouse"],
  },
  {
    href: "/moderator/users",
    label: "Moderatör",
    permissionKey: "moderator",
    icon: ShieldCheck,
    emojiAsset: "/dashboard-icons/fixed/moderator.webp",
    tileGradient: "from-[#b7d7c2] to-[#5a8a69]",
    allowedRoles: ["admin", "moderator"],
  },
  {
    href: "/mal-kabul",
    label: "Satınalma",
    permissionKey: "extra",
    icon: PackageCheck,
    emojiAsset: "/dashboard-icons/fixed/ekstra.webp",
    tileGradient: "from-[#b8d8c0] to-[#5a8f6a]",
    allowedRoles: ["admin", "dealer_admin", "salesperson"],
  },
  {
    href: "/pos/expenses",
    label: "Masraf",
    permissionKey: "pos-expenses",
    icon: ReceiptText,
    emojiAsset: "/dashboard-icons/fixed/ekstra.webp",
    tileGradient: "from-[#d0becf] to-[#897088]",
    allowedRoles: ["admin", "cashier", "point"],
  },
  {
    href: "/pos/day-end",
    label: "Gün Sonu",
    permissionKey: "pos-day-end",
    icon: FileBarChart2,
    emojiAsset: "/dashboard-icons/fixed/raporlar.webp",
    tileGradient: "from-[#8fd9d7] to-[#4da6a4]",
    allowedRoles: ["admin", "cashier", "point"],
  },
  {
    href: "/virtual-pos",
    label: "Sanal Pos",
    permissionKey: "virtual-pos",
    icon: CreditCard,
    emojiAsset: "/apple-icons/sidebar/pos.webp",
    tileGradient: "from-[#a7d8ff] to-[#3f7fbf]",
    allowedRoles: ["admin", "dealer_admin", "salesperson"],
  },
  {
    href: "/irsaliye-dokum",
    label: "İrsaliye Döküm",
    permissionKey: "delivery-notes",
    icon: FileText,
    emojiAsset: "/dashboard-icons/fixed/raporlar.webp",
    tileGradient: "from-[#b9d6e8] to-[#557f9a]",
    allowedRoles: ["admin", "dealer_admin", "cashier", "point"],
  },
];

const MODERATOR_SECTION_ITEMS: NavItem[] = [
  {
    href: "/notes",
    label: "Notlar",
    icon: NotebookPen,
    tileGradient: "from-[#b7efe1] via-[#72c8b4] to-[#327a71]",
    allowedRoles: ["admin", "moderator"],
  },
  {
    href: "/pos/expenses",
    label: "POS Masraf",
    permissionKey: "pos-expenses",
    icon: ReceiptText,
    emojiAsset: "/dashboard-icons/fixed/ekstra.webp",
    tileGradient: "from-[#d0becf] to-[#897088]",
    allowedRoles: ["admin"],
  },
  {
    href: "/pos/day-end",
    label: "POS Gün Sonu",
    permissionKey: "pos-day-end",
    icon: FileBarChart2,
    emojiAsset: "/dashboard-icons/fixed/raporlar.webp",
    tileGradient: "from-[#8fd9d7] to-[#4da6a4]",
    allowedRoles: ["admin"],
  },
  {
    href: "/moderator/users/new",
    label: "Kullanıcı Oluştur",
    permissionKey: "moderator",
    icon: UserPlus,
    emojiAsset: "/dashboard-icons/fixed/moderator.webp",
    tileGradient: "from-[#b7d7c2] to-[#5a8a69]",
    allowedRoles: ["admin", "moderator"],
  },
  {
    href: "/moderator/customers/new",
    label: "Cari Oluştur",
    permissionKey: "moderator",
    icon: Building2,
    emojiAsset: "/dashboard-icons/fixed/yeni_cari_kart.webp",
    tileGradient: "from-[#b5d3ba] to-[#5d9370]",
    allowedRoles: ["admin", "moderator"],
  },
  {
    href: "/moderator/users",
    label: "Kullanıcı Yönetimi",
    permissionKey: "moderator",
    icon: Users,
    emojiAsset: "/dashboard-icons/fixed/moderator.webp",
    tileGradient: "from-[#9fc8af] to-[#48765a]",
    allowedRoles: ["admin", "moderator"],
  },
  {
    href: "/moderator/customers",
    label: "Cari Yönetimi",
    permissionKey: "moderator",
    icon: ShieldCheck,
    emojiAsset: "/dashboard-icons/fixed/cari_hesap.webp",
    tileGradient: "from-[#d7d0b7] to-[#9d8a54]",
    allowedRoles: ["admin", "moderator"],
  },
];

const ADMIN_SIDEBAR_LABEL_OVERRIDES: Record<string, string> = {
  "/customers": "Müşteriler",
  "/orders": "Siparişler",
  "/warehouse": "Depo",
  "/pos": "Hızlı Satış",
};

const DASHBOARD_TOP_DOCK_ORDER = [
  "/dashboard",
  "/customers",
  "/customer-users",
  "/search",
  "/collections",
  "/cart",
  "/orders",
  "/ledger",
];

const SIDEBAR_PRIORITY_ORDER = [
  "/dashboard",
  "/customers",
  "/search",
  "/notes",
  "/collections",
  "/cart",
  "/orders",
  "/ledger",
  "/new-customer-card",
  "/returns",
  "/pos",
  "/warehouse",
  "/moderator",
  "/mal-kabul",
  "/reports",
  "/pos/expenses",
  "/pos/day-end",
  "/virtual-pos",
  "/catalogs",
  "/irsaliye-dokum",
];

function sortNavItemsByPriority(items: NavItem[]) {
  const indexByHref = new Map(SIDEBAR_PRIORITY_ORDER.map((href, index) => [href, index]));

  return [...items].sort((left, right) => {
    const leftIndex = indexByHref.get(left.href) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = indexByHref.get(right.href) ?? Number.MAX_SAFE_INTEGER;

    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }

    return left.label.localeCompare(right.label, "tr");
  });
}

function sortNavItemsForPath(items: NavItem[], pathname: string) {
  const sortedItems = sortNavItemsByPriority(items);

  if (!pathname.startsWith("/pos")) {
    return sortedItems;
  }

  return sortedItems.sort((left, right) => {
    if (left.href === "/pos" && right.href !== "/pos") {
      return -1;
    }

    if (right.href === "/pos" && left.href !== "/pos") {
      return 1;
    }

    return 0;
  });
}

const MODERATOR_PRIORITY_ORDER = [
  "/notes",
  "/pos/expenses",
  "/pos/day-end",
  "/moderator/users/new",
  "/moderator/users",
  "/moderator/customers/new",
  "/moderator/customers",
];

function sortModeratorNavItemsByPriority(items: NavItem[]) {
  const indexByHref = new Map(MODERATOR_PRIORITY_ORDER.map((href, index) => [href, index]));

  return [...items].sort((left, right) => {
    const leftIndex = indexByHref.get(left.href) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = indexByHref.get(right.href) ?? Number.MAX_SAFE_INTEGER;

    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }

    return left.label.localeCompare(right.label, "tr");
  });
}

function readSidebarItemOrder(storageKey: string): string[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((href): href is string => typeof href === "string" && href !== "") : [];
  } catch {
    return [];
  }
}

function writeSidebarItemOrder(storageKey: string, order: string[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(storageKey, JSON.stringify(order));
}

function sidebarOrderStorageKey(userId: number | string | null | undefined, section: string): string {
  return `${SIDEBAR_ITEM_ORDER_STORAGE_PREFIX}:${userId ?? "guest"}:${section}`;
}

function applyStoredSidebarOrder(items: NavItem[], order: string[]): NavItem[] {
  if (order.length === 0 || items.length < 2) {
    return items;
  }

  const indexByHref = new Map(order.map((href, index) => [href, index]));
  const originalIndexByHref = new Map(items.map((item, index) => [item.href, index]));

  return [...items].sort((left, right) => {
    const leftIndex = indexByHref.get(left.href);
    const rightIndex = indexByHref.get(right.href);

    if (leftIndex !== undefined && rightIndex !== undefined) {
      return leftIndex - rightIndex;
    }

    if (leftIndex !== undefined) {
      return -1;
    }

    if (rightIndex !== undefined) {
      return 1;
    }

    return (originalIndexByHref.get(left.href) ?? 0) - (originalIndexByHref.get(right.href) ?? 0);
  });
}

function moveSidebarItem(order: string[], visibleHrefs: string[], draggedHref: string, targetHref: string): string[] {
  if (draggedHref === targetHref || !visibleHrefs.includes(draggedHref) || !visibleHrefs.includes(targetHref)) {
    return order;
  }

  const visibleHrefSet = new Set(visibleHrefs);
  const knownOrder = order.filter((href) => visibleHrefSet.has(href));

  for (const href of visibleHrefs) {
    if (!knownOrder.includes(href)) {
      knownOrder.push(href);
    }
  }

  const fromIndex = knownOrder.indexOf(draggedHref);
  const toIndex = knownOrder.indexOf(targetHref);

  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return order;
  }

  const nextVisibleOrder = [...knownOrder];
  const [moved] = nextVisibleOrder.splice(fromIndex, 1);
  nextVisibleOrder.splice(toIndex, 0, moved);

  const hiddenStoredHrefs = order.filter((href) => !visibleHrefSet.has(href));
  return [...nextVisibleOrder, ...hiddenStoredHrefs];
}

function splitNavHref(href: string): { path: string; hash: string } {
  const [path, rawHash] = href.split("#");

  return {
    path,
    hash: rawHash ? `#${rawHash}` : "",
  };
}

function isNavItemActive(pathname: string, currentHash: string, item: NavItem) {
  const { path, hash } = splitNavHref(item.href);

  if (hash) {
    return pathname === path && currentHash === hash;
  }

  return pathname === path || pathname.startsWith(`${path}/`);
}

function isWarehouseOnlyRole(roleSlugs: string[]) {
  return (
    roleSlugs.includes("warehouse") &&
    !roleSlugs.includes("admin") &&
    !roleSlugs.includes("dealer_admin") &&
    !roleSlugs.includes("salesperson")
  );
}

function isDealerAdminPanelRole(roleSlugs: string[]) {
  return (
    roleSlugs.includes("dealer_admin") &&
    !roleSlugs.includes("admin") &&
    !roleSlugs.includes("salesperson")
  );
}

function isPosOnlyRole(roleSlugs: string[]) {
  return (
    (roleSlugs.includes("point") || roleSlugs.includes("cashier")) &&
    !roleSlugs.includes("admin") &&
    !roleSlugs.includes("dealer_admin") &&
    !roleSlugs.includes("salesperson") &&
    !roleSlugs.includes("warehouse")
  );
}

function isModeratorOnlyRole(roleSlugs: string[]) {
  return (
    roleSlugs.includes("moderator") &&
    !roleSlugs.includes("admin") &&
    !roleSlugs.includes("dealer_admin") &&
    !roleSlugs.includes("salesperson") &&
    !roleSlugs.includes("warehouse") &&
    !roleSlugs.includes("point") &&
    !roleSlugs.includes("cashier")
  );
}

function canAccessNavItem(item: NavItem, roleSlugs: string[], menuPermissions: Set<string>) {
  if (item.visibleForAll) {
    return true;
  }

  if (item.permissionKey === "customer-users" && (roleSlugs.includes("admin") || roleSlugs.includes("moderator"))) {
    return true;
  }

  if (item.permissionKey === "dashboard" && isPosOnlyRole(roleSlugs)) {
    return true;
  }

  if (roleSlugs.includes("admin")) {
    return item.allowedRoles === undefined || item.allowedRoles.includes("admin");
  }

  if (menuPermissions.size > 0 && item.permissionKey !== undefined) {
    return menuPermissions.has(item.permissionKey);
  }

  return item.allowedRoles === undefined || item.allowedRoles.some((role) => roleSlugs.includes(role));
}

function requiresCustomerSelection(roleSlugs: string[]) {
  return roleSlugs.includes("salesperson");
}

function resolvePanelTitle(roleSlugs: string[]) {
  if (isWarehouseOnlyRole(roleSlugs)) {
    return "Depo";
  }

  if (isModeratorOnlyRole(roleSlugs)) {
    return "Moderatör";
  }

  if (roleSlugs.includes("salesperson")) {
    return "Plasiyer";
  }

  if (isPosOnlyRole(roleSlugs)) {
    return "Point";
  }

  if (roleSlugs.includes("admin")) {
    return "Admin";
  }

  if (isDealerAdminPanelRole(roleSlugs)) {
    return "Bayi";
  }

  return "Müşteri";
}

function normalizeAccessPath(pathname: string) {
  if (pathname === "/satinalma" || pathname.startsWith("/satinalma/")) {
    return pathname.replace(/^\/satinalma/, "/mal-kabul");
  }

  return pathname;
}

function normalizeHeaderBranchLabel(value: string | null | undefined): string {
  const trimmed = value?.trim();

  if (!trimmed) {
    return "Point";
  }

  return trimmed
    .toLocaleLowerCase("tr-TR")
    .replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase("tr-TR"));
}

function formatPointBranchHeaderLabel(value: string | null | undefined): string {
  const branchLabel = normalizeHeaderBranchLabel(value);
  const normalized = branchLabel.toLocaleUpperCase("tr-TR");

  if (normalized === "POINT") {
    return "Point Şubesi";
  }

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

function isPathAllowed(pathname: string, items: NavItem[]) {
  const accessPath = normalizeAccessPath(pathname);

  return items.some((item) => {
    const { path } = splitNavHref(item.href);

    return accessPath === path || accessPath.startsWith(`${path}/`);
  });
}

function getPageMeta(
  pathname: string,
  roleSlugs: string[],
  selectedCustomer?: { code?: string | null; title?: string | null; branch_code?: string | null; branch_name?: string | null } | null,
  user?: Pick<ApiUser, "branch_code" | "branch_name"> | null
): { title: string; subtitle: string } {
  if (pathname.startsWith("/pos/expenses")) {
    return { title: "Masraf", subtitle: "Point masraf kayıt ekranı" };
  }

  if (pathname.startsWith("/pos/day-end")) {
    return { title: "POS Gün Sonu", subtitle: "Kasa açılış, kapanış ve gün sonu özeti" };
  }

  if (pathname.startsWith("/dashboard")) {
    const selectedCustomerName = selectedCustomer?.title?.trim();
    const selectedCustomerCode = selectedCustomer?.code?.trim();
    const dashboardCustomerTitle =
      selectedCustomerName && selectedCustomerCode
        ? `Cari Kodu: ${selectedCustomerCode} · Cari İsim: ${selectedCustomerName}`
        : selectedCustomerName
          ? `Cari İsim: ${selectedCustomerName}`
          : selectedCustomerCode
            ? `Cari Kodu: ${selectedCustomerCode}`
            : "Ana Sayfa";

    if (isPosOnlyRole(roleSlugs)) {
      const branchLabel = normalizeHeaderBranchLabel(
        user?.branch_name ?? user?.branch_code ?? selectedCustomer?.branch_name ?? selectedCustomer?.branch_code
      );

      return { title: `${branchLabel} Şubesi`, subtitle: "Point bayi ana sayfası" };
    }

    if (roleSlugs.includes("salesperson")) {
      return { title: dashboardCustomerTitle, subtitle: "" };
    }

    if (isDealerAdminPanelRole(roleSlugs)) {
      return { title: dashboardCustomerTitle, subtitle: "" };
    }

    return { title: dashboardCustomerTitle, subtitle: "" };
  }

  if (pathname.startsWith("/moderator")) {
    if (pathname.startsWith("/moderator/users/new")) {
      return { title: "Kullanıcı Oluştur", subtitle: "Yeni kullanıcı ve menü erişimlerini belirle" };
    }

    if (pathname === "/moderator/users" || pathname.startsWith("/moderator/users/")) {
      return { title: "Kullanıcı Yönetimi", subtitle: "Kullanıcı, rol, şifre ve aktivasyon yönetimi" };
    }

    if (pathname.startsWith("/moderator/customers/new")) {
      return { title: "Cari Oluştur", subtitle: "Yeni cari aç ve ilk plasiyer atamasını yap" };
    }

    if (pathname === "/moderator/customers" || pathname.startsWith("/moderator/customers/")) {
      return { title: "Cari Yönetimi", subtitle: "Cari düzenle, plasiyer ata ve durum yönet" };
    }

    return { title: "Moderatör", subtitle: "Kullanıcı, cari ve plasiyer atama yönetimi" };
  }

  if (pathname.startsWith("/plasiyer")) {
    return { title: "Plasiyer", subtitle: "Müşteri seçimi, ürün arama ve sipariş akışı" };
  }

  if (pathname.startsWith("/customers")) {
    return roleSlugs.includes("salesperson")
      ? { title: "Cari Seçimi", subtitle: "Plasiyer için müşteri bağlamı seçin" }
      : { title: "Müşteri Seçimi", subtitle: "Cari filtreleme ve seçim ekranı" };
  }

  if (pathname.startsWith("/customer-users")) {
    return { title: "Müşteri Kullanıcı", subtitle: "Carilere müşteri paneli girişi aç" };
  }

  if (pathname.startsWith("/search")) {
    return { title: "", subtitle: "" };
  }

  if (pathname.startsWith("/catalogs")) {
    return { title: "Kataloglar", subtitle: "Marka katalogları ve öne çıkan ürün koleksiyonları" };
  }

  if (pathname.startsWith("/mal-kabul")) {
    return { title: "Satınalma / Mal Kabul", subtitle: "Gelen ürün, irsaliye ve kabul kontrol ekranı" };
  }

  if (pathname.startsWith("/extra")) {
    return { title: "Satınalma / Mal Kabul", subtitle: "Gelen ürün, irsaliye ve kabul kontrol ekranı" };
  }

  if (pathname.startsWith("/new-customer-card")) {
    return { title: "Yeni Cari Kart", subtitle: "Yeni müşteri başvurusu ve takip ekranı" };
  }

  if (pathname.startsWith("/cart")) {
    if (roleSlugs.includes("salesperson")) {
      return { title: "Sepet", subtitle: "" };
    }

    if (isDealerAdminPanelRole(roleSlugs)) {
      return { title: "Sepetim", subtitle: "" };
    }

    return { title: "Sepet", subtitle: "" };
  }

  if (pathname.startsWith("/orders")) {
    if (roleSlugs.includes("salesperson")) {
      return { title: "Siparişler", subtitle: "Plasiyer sipariş listesi ve durum takibi" };
    }

    if (isDealerAdminPanelRole(roleSlugs)) {
      return { title: "Siparişlerim", subtitle: "Aktif ve geçmiş sipariş kayıtlarınız" };
    }

    return { title: "Siparişler", subtitle: "Sipariş listesi ve durum takibi" };
  }

  if (pathname.startsWith("/returns")) {
    return { title: "İade / Arıza", subtitle: "İade, hasar ve arıza taleplerini yönetin" };
  }

  if (pathname.startsWith("/ledger")) {
    return { title: "Cari Hesap", subtitle: "Ekstre, bakiye ve hareket kayıtları" };
  }

  if (pathname.startsWith("/warehouse/shipments/new")) {
    return { title: "Sevkiyat Oluştur", subtitle: "Siparişten yeni sevkiyat başlat" };
  }

  if (pathname.startsWith("/warehouse/shipments")) {
    return { title: "Sevkiyat Detayı", subtitle: "Barkod ve sevkiyat kalem kontrolü" };
  }

  if (pathname.startsWith("/warehouse")) {
    return { title: "Depo Siparişleri", subtitle: "Onaylı siparişleri incele ve sipariş formunu yazdır" };
  }

  if (pathname.startsWith("/collections")) {
    return { title: "Tahsilat", subtitle: "Nakit, çek, senet ve kart işlemleri" };
  }

  if (pathname.startsWith("/virtual-pos")) {
    return { title: "Sanal Pos", subtitle: "Kart bilgileriyle online ödeme ekranı" };
  }

  if (pathname.startsWith("/irsaliye-dokum")) {
    return { title: "İrsaliye Döküm", subtitle: "POS irsaliye kayıtları ve yazdırma ekranı" };
  }

  if (pathname.startsWith("/reports")) {
    return { title: "Raporlar", subtitle: "Satış, bakiye ve performans raporları" };
  }

  if (pathname.startsWith("/notes")) {
    return { title: "Notlar", subtitle: "Günlük notlar, takip ve küçük görevler" };
  }

  if (pathname.startsWith("/pos")) {
    return isPosOnlyRole(roleSlugs)
      ? { title: "Hızlı Satış", subtitle: "Point bayi için hızlı satış ekranı" }
      : { title: "Hızlı Satış", subtitle: "Kompakt satış, kaydet ve yazdır ekranı" };
  }

  return { title: "Powersa B2B", subtitle: "Operasyon paneli" };
}

function SidebarAppIcon({
  label,
  emojiAsset,
  Icon,
  tileGradient,
  active,
  darkMode,
}: {
  label: string;
  emojiAsset?: string;
  Icon: React.ComponentType<{ className?: string }>;
  tileGradient: string;
  active: boolean;
  darkMode: boolean;
}) {
  const useSidebarAsset =
    emojiAsset !== undefined && (
    emojiAsset.startsWith("/apple-icons/") ||
    emojiAsset.startsWith("/sidebar/") ||
    emojiAsset.startsWith("/dashboard-icons/"));
  const renderedAsset = emojiAsset?.startsWith("/apple-icons/sidebar/")
    ? emojiAsset.replace("/apple-icons/sidebar/", "/apple-icons/sidebar-balanced/").replace(/\.webp$/, ".png")
    : emojiAsset;

  return (
    <span
      className={cn(
        "relative inline-flex items-center justify-center transition-all duration-200",
        useSidebarAsset ? "h-[100px] w-[100px]" : "h-[80px] w-[80px]",
        useSidebarAsset ? "group-hover:scale-[1.02]" : active ? "scale-[1.04]" : "group-hover:scale-[1.035]"
      )}
    >
      {useSidebarAsset ? null : (
        <span
          className={cn(
            "pointer-events-none absolute inset-[2px] rounded-[31px] bg-[linear-gradient(180deg,rgba(255,255,255,0.11)_0%,rgba(255,255,255,0.03)_18%,rgba(0,0,0,0.24)_100%)]",
            active
              ? darkMode
                ? "shadow-[0_30px_34px_-22px_rgba(0,0,0,0.9)]"
                : "shadow-[0_30px_34px_-22px_rgba(0,0,0,0.84)]"
              : darkMode
                ? "shadow-[0_22px_28px_-22px_rgba(0,0,0,0.84)]"
                : "shadow-[0_22px_28px_-22px_rgba(0,0,0,0.74)]"
          )}
        />
      )}
      <span
        className={cn(
          "relative inline-flex items-center justify-center transition-all duration-200",
          useSidebarAsset
            ? "h-[96px] w-[96px] bg-transparent"
            : "h-[72px] w-[72px] overflow-hidden rounded-[22px]",
          useSidebarAsset
            ? ""
            : cn("bg-gradient-to-br", darkMode ? "border border-white/12" : "border border-white/16", tileGradient),
          useSidebarAsset
            ? "group-hover:-translate-y-0.5"
            : active
              ? darkMode
                ? "shadow-[0_16px_18px_-14px_rgba(0,0,0,0.78),inset_0_1px_0_rgba(255,255,255,0.22)]"
                : "shadow-[0_26px_30px_-14px_rgba(0,0,0,0.78),inset_0_1px_0_rgba(255,255,255,0.28)]"
              : darkMode
                ? "shadow-[0_14px_16px_-14px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.16)] group-hover:-translate-y-0.5"
                : "shadow-[0_14px_16px_-14px_rgba(0,0,0,0.62),inset_0_1px_0_rgba(255,255,255,0.2)] group-hover:-translate-y-0.5"
        )}
      >
        {useSidebarAsset ? null : (
          <>
            <span className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_5%,rgba(255,255,255,0.58)_0%,rgba(255,255,255,0.16)_24%,rgba(255,255,255,0)_60%)]" />
            <span className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_100%,rgba(0,0,0,0.2)_0%,rgba(0,0,0,0)_48%)]" />
            <span className="pointer-events-none absolute inset-[2px] rounded-[28px] border border-white/44" />
            <span className="pointer-events-none absolute inset-x-[10px] top-[10px] h-6 rounded-full bg-white/12 blur-md" />
          </>
        )}
        {useSidebarAsset && renderedAsset ? (
          <Image
            src={renderedAsset}
            alt={`${label} ikonu`}
            width={92}
            height={92}
            className={cn(
              "relative z-[2] h-[92px] w-[92px] object-contain",
              darkMode
                ? "[filter:drop-shadow(0_12px_14px_rgba(0,0,0,0.3))]"
                : "[filter:drop-shadow(0_10px_12px_rgba(32,70,52,0.18))]"
            )}
            quality={80}
            loading="eager"
            decoding="async"
          />
        ) : emojiAsset ? (
            <Image
              src={emojiAsset}
              alt={`${label} ikonu`}
              width={62}
              height={62}
              className="relative z-[2] h-[46px] w-[46px] object-contain [filter:drop-shadow(0_10px_12px_rgba(0,0,0,0.38))_drop-shadow(0_-1px_0_rgba(255,255,255,0.2))]"
              priority={false}
            />
          ) : (
            <Icon className="relative z-[2] h-9 w-9 text-white [filter:drop-shadow(0_10px_12px_rgba(0,0,0,0.34))]" />
        )}
        {useSidebarAsset ? null : <span className="pointer-events-none absolute bottom-3 h-2.5 w-11 rounded-full bg-black/14 blur-[1px]" />}
      </span>
    </span>
  );
}

function SidebarMenu({
  pathname,
  currentHash,
  items,
  panelTitle,
  darkMode,
  dashboardRoute,
  homeHref,
  collapsed,
  onToggleCollapsed,
  onReorderItems,
  reorderEnabled,
  onLogout,
}: {
  pathname: string;
  currentHash: string;
  items: NavItem[];
  panelTitle: string;
  darkMode: boolean;
  dashboardRoute: boolean;
  homeHref: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onReorderItems: (draggedHref: string, targetHref: string) => void;
  reorderEnabled: boolean;
  onLogout: () => void;
}) {
  const lightDashboardSidebar = dashboardRoute && !darkMode;
  const [draggingHref, setDraggingHref] = useState<string | null>(null);
  const dragMovedRef = useRef(false);

  return (
    <div
      className={cn(
        "app-sidebar relative flex h-full flex-col overflow-hidden border-r-0 border-transparent",
        dashboardRoute && "app-sidebar-dashboard",
        lightDashboardSidebar && "app-sidebar-light"
      )}
    >
      <div className="app-sidebar-brand-zone px-4 pb-7 pt-4">
        <button
          type="button"
          className={cn(
            "absolute right-3 top-3 z-30 inline-flex h-8 w-8 items-center justify-center rounded-lg border text-[var(--sidebar-foreground)] transition hover:bg-[color-mix(in_oklab,var(--sidebar-primary)_24%,transparent)] hover:text-white",
            lightDashboardSidebar
              ? "border-[color-mix(in_oklab,var(--brand-border)_80%,transparent)] bg-white/70 text-[var(--brand-primary-strong)]"
              : "border-white/10 bg-black/12"
          )}
          aria-label={collapsed ? "Sidebar aç" : "Sidebar kapat"}
          title={collapsed ? "Sidebar aç" : "Sidebar kapat"}
          onClick={onToggleCollapsed}
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
        <Link
          href={homeHref}
          className="app-sidebar-brand-link mx-auto flex w-full max-w-[11.25rem] flex-col items-center justify-center rounded-[22px] px-2 py-2 transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sidebar-ring)]/70"
          title="Ana sayfaya dön"
        >
            <Image
              src="/brand/logotransparan-clean.png"
              alt="Güçsa Powersa Filter Logo"
              width={910}
              height={883}
              sizes="180px"
              className={cn(
                "h-auto w-full object-contain",
                darkMode
                ? "drop-shadow-[0_18px_22px_rgba(35,68,50,0.18)]"
                : "drop-shadow-[0_18px_24px_rgba(4,12,8,0.34)]"
            )}
            priority
          />
        </Link>
      </div>

      <div className="app-sidebar-nav-region min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-4 pt-5">
        <div className="mb-3 mt-2">
          <div className="app-sidebar-nav-grid grid grid-cols-[repeat(2,92px)] justify-center gap-x-4 gap-y-2.5">
            {items.map((item) => {
              const active = isNavItemActive(pathname, currentHash, item);
              const dragging = draggingHref === item.href;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={item.label}
                  draggable={reorderEnabled}
                  onDragStart={(event) => {
                    if (!reorderEnabled) {
                      return;
                    }

                    setDraggingHref(item.href);
                    dragMovedRef.current = false;
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", item.href);
                  }}
                  onDragOver={(event) => {
                    if (!reorderEnabled) {
                      return;
                    }

                    event.preventDefault();
                    const draggedHref = draggingHref ?? event.dataTransfer.getData("text/plain");

                    if (draggedHref && draggedHref !== item.href) {
                      dragMovedRef.current = true;
                      event.dataTransfer.dropEffect = "move";
                      onReorderItems(draggedHref, item.href);
                    }
                  }}
                  onDrop={(event) => {
                    if (!reorderEnabled) {
                      return;
                    }

                    event.preventDefault();
                    const draggedHref = draggingHref ?? event.dataTransfer.getData("text/plain");

                    if (draggedHref) {
                      onReorderItems(draggedHref, item.href);
                    }

                    setDraggingHref(null);
                  }}
                  onDragEnd={() => {
                    if (!reorderEnabled) {
                      return;
                    }

                    setDraggingHref(null);
                    window.setTimeout(() => {
                      dragMovedRef.current = false;
                    }, 0);
                  }}
                  onClick={(event) => {
                    if (dragMovedRef.current) {
                      event.preventDefault();
                    }
                  }}
                  className={cn(
                      "app-sidebar-nav-link group relative flex min-h-[112px] w-[92px] select-none flex-col items-center justify-start gap-0.5 rounded-[18px] outline-none transition-all duration-200 [-webkit-tap-highlight-color:transparent] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-accent)] focus-visible:ring-offset-2",
                      lightDashboardSidebar ? "focus-visible:ring-offset-[#eef4f0]" : "focus-visible:ring-offset-[#0d3024]",
                      dragging && "scale-95 opacity-55"
                  )}
                >
                  <span
                    className={cn(
                      "relative inline-flex h-[82px] w-[82px] items-center justify-center rounded-[20px] transition-all duration-200",
                      "group-hover:-translate-y-0.5"
                    )}
                  >
                    <SidebarAppIcon label={item.label} emojiAsset={item.emojiAsset} Icon={item.icon} tileGradient={item.tileGradient} active={active} darkMode={darkMode || dashboardRoute} />

                    {item.badge ? (
                      <span className="absolute -right-1 -top-1 z-20 inline-flex min-w-5 items-center justify-center rounded-full border border-[#fbf3a2] bg-[var(--brand-accent)] px-1.5 py-0.5 text-[10px] font-extrabold text-[#4b4617] shadow-[0_4px_8px_-6px_rgba(0,0,0,0.8)]">
                        {item.badge}
                      </span>
                    ) : null}
                    {item.secondaryBadge ? (
                      <span className="absolute -left-1 -top-1 z-20 inline-flex min-w-5 items-center justify-center rounded-full border border-cyan-100/80 bg-cyan-300 px-1.5 py-0.5 text-[10px] font-extrabold text-[#0b2631] shadow-[0_4px_8px_-6px_rgba(0,0,0,0.8)]">
                        {item.secondaryBadge}
                      </span>
                    ) : null}
                  </span>
                  <span className="-mt-1 flex h-2 items-center justify-center">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full transition-all duration-200",
                        active
                          ? lightDashboardSidebar
                            ? "bg-[#1f6b45] shadow-[0_0_10px_rgba(31,107,69,0.44)]"
                            : "bg-[var(--brand-primary)] shadow-[0_0_12px_color-mix(in_oklab,var(--brand-primary)_70%,transparent)]"
                          : "bg-transparent"
                      )}
                    />
                  </span>
                  <span
                    className={cn(
                      "app-sidebar-nav-label line-clamp-2 flex h-[30px] w-full items-center justify-center text-center text-[12px] font-extrabold leading-[1.08] tracking-normal transition-colors duration-200",
                      "relative z-10 px-0",
                      lightDashboardSidebar
                        ? active
                          ? "text-[#17392c]"
                          : "text-[#4e6a5d] group-hover:text-[#17392c]"
                        : active
                          ? "text-[#f8faf8]"
                          : "text-[#d8e7dd] group-hover:text-white"
                    )}
                  >
                    {item.label}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      <div className="app-sidebar-system px-3 pb-16 pt-1.5">
        <div className="mb-2 px-1">
          <p className={cn("text-[10px] font-extrabold uppercase tracking-[0.14em]", lightDashboardSidebar ? "text-[var(--muted-foreground)]" : "text-[color-mix(in_oklab,var(--sidebar-foreground)_72%,var(--sidebar-primary))]")}>
            Sistem
          </p>
        </div>
        <div
          className={cn(
            "rounded-[18px] px-3 py-2.5",
            dashboardRoute
              ? "border border-[var(--brand-border)] bg-[linear-gradient(180deg,var(--surface)_0%,var(--surface-soft)_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
            : lightDashboardSidebar
              ? "border border-[var(--brand-border)] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--surface)_96%,white)_0%,color-mix(in_oklab,var(--surface-soft)_92%,white)_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.78)]"
              : "border border-[color-mix(in_oklab,var(--sidebar-border)_64%,white)] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--sidebar)_92%,black)_0%,color-mix(in_oklab,var(--sidebar-accent)_92%,black)_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
          )}
        >
          <p className={cn("text-[11px] font-semibold", lightDashboardSidebar ? "text-[var(--brand-primary-strong)]" : "text-[var(--sidebar-foreground)]")}>Powersa B2B v1.0.0</p>
          <p className={cn("mt-0.5 text-[11px]", lightDashboardSidebar ? "text-[var(--muted-foreground)]" : "text-[color-mix(in_oklab,var(--sidebar-foreground)_72%,var(--sidebar-primary))]")}>Sistem çevrimiçi</p>
        </div>
        <Link
          href={homeHref}
          title="Ana sayfaya dön"
          className={cn(
            "mt-2 block rounded-[18px] px-3 py-2.5 transition hover:-translate-y-0.5 hover:border-[var(--brand-primary)]",
            dashboardRoute
              ? "border border-[var(--brand-border)] bg-[linear-gradient(180deg,var(--surface)_0%,var(--surface-soft)_100%)] shadow-[0_20px_28px_-24px_rgba(0,0,0,0.32),inset_0_1px_0_rgba(255,255,255,0.06)]"
            : lightDashboardSidebar
              ? "border border-[var(--brand-border)] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--surface-soft)_94%,white)_0%,color-mix(in_oklab,var(--background)_90%,white)_100%)] shadow-[0_20px_28px_-24px_rgba(15,23,42,0.16),inset_0_1px_0_rgba(255,255,255,0.72)]"
              : "border border-[color-mix(in_oklab,var(--sidebar-border)_64%,white)] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--sidebar-accent)_84%,black)_0%,color-mix(in_oklab,var(--sidebar)_94%,black)_100%)] shadow-[0_20px_28px_-20px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,255,255,0.05)]"
          )}
        >
          <p className={cn("text-[11px] font-extrabold uppercase tracking-[0.14em]", lightDashboardSidebar ? "text-[var(--brand-primary-strong)]" : "text-[var(--sidebar-foreground)]")}>Powersa B2B</p>
          <p className={cn("mt-1 text-[18px] font-extrabold leading-6 tracking-tight", lightDashboardSidebar ? "text-[var(--foreground)]" : "text-white")}>{panelTitle}</p>
          <p className={cn("mt-1.5 text-[12px] leading-[1.3]", lightDashboardSidebar ? "text-[var(--muted-foreground)]" : "text-[color-mix(in_oklab,var(--sidebar-foreground)_78%,var(--sidebar-primary))]")}>Ana sayfaya dön</p>
        </Link>
        <button
          type="button"
          onClick={onLogout}
          className={cn(
            "mt-2 flex w-full items-center justify-center gap-2 rounded-[18px] border px-3 py-3 text-[13px] font-extrabold transition hover:-translate-y-0.5",
            lightDashboardSidebar
              ? "border-red-200 bg-red-50 text-red-700 hover:border-red-300 hover:bg-red-100"
              : "border-red-300/20 bg-[linear-gradient(180deg,rgba(127,29,29,0.52)_0%,rgba(69,10,10,0.55)_100%)] text-red-100 shadow-[0_20px_28px_-22px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,255,255,0.05)] hover:border-red-200/40 hover:text-white"
          )}
          aria-label="Çıkış yap"
          title="Çıkış yap"
        >
          <LogOut className="h-4 w-4" />
          Çıkış Yap
        </button>
      </div>
    </div>
  );
}

function DashboardTopDockIcon({
  item,
  active,
}: {
  item: NavItem;
  active: boolean;
}) {
  return (
    <Link
      href={item.href}
      title={item.label}
      className="group flex min-w-[116px] flex-col items-center justify-start gap-2 rounded-[22px] px-2 py-1 outline-none transition focus-visible:ring-2 focus-visible:ring-[#8ddf9c]"
    >
      <span
        className={cn(
          "relative inline-flex h-[82px] w-[82px] items-center justify-center transition duration-200",
          active ? "scale-[1.04]" : "group-hover:-translate-y-0.5 group-hover:scale-[1.02]"
        )}
      >
        <span
          className={cn(
            "absolute inset-[8px] rounded-[22px] bg-[#08160f] shadow-[0_18px_34px_-24px_rgba(0,0,0,0.95)]",
            active ? "ring-1 ring-[#7be891]/70" : "ring-1 ring-white/10 group-hover:ring-[#7be891]/38"
          )}
        />
        <span className="absolute inset-[6px] rounded-[24px] bg-[radial-gradient(circle_at_50%_4%,rgba(255,255,255,0.34)_0%,rgba(255,255,255,0.06)_34%,rgba(255,255,255,0)_70%)]" />
        {/* Yeni sidebar ikonları kendi cam kutusuyla geldiği için direkt yüklenir. */}
        <Image
          src={item.emojiAsset ?? "/images/sidebar/default-icon.png"}
          alt={`${item.label} ikonu`}
          width={72}
          height={72}
          className="relative z-[2] h-[72px] w-[72px] object-contain drop-shadow-[0_16px_18px_rgba(0,0,0,0.5)]"
          loading="eager"
          decoding="async"
        />
      </span>
      <span
        className={cn(
          "line-clamp-1 text-center text-[14px] font-extrabold leading-none",
          active ? "text-white" : "text-[#dfe9e1] group-hover:text-white"
        )}
      >
        {item.label}
      </span>
    </Link>
  );
}

function ColorThemePicker({
  accent,
  onSelect,
}: {
  accent: string;
  onSelect: (accent: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = UI_COLOR_OPTIONS.find((option) => option.value === accent) ?? null;

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative z-[90]">
      <div className="header-icon-button flex h-10 overflow-hidden rounded-2xl border border-[var(--brand-border)] bg-[var(--surface)] text-[var(--brand-primary-strong)] shadow-sm">
        <button
          type="button"
          aria-label="Tema rengini değiştir"
          title="Tema rengi"
          className="flex h-full items-center gap-2 px-3 transition hover:bg-[var(--surface-soft)]"
          onClick={() => setOpen((current) => !current)}
        >
          <Palette className="h-4 w-4" />
          <span className="h-2.5 w-2.5 rounded-full border border-black/10" style={{ backgroundColor: accent }} />
        </button>
      </div>

      {open ? (
        <div
          className={cn(
            "absolute right-0 top-full z-[100] mt-2 w-[190px] rounded-2xl border p-2 shadow-[0_18px_40px_-24px_rgba(0,0,0,0.52)] backdrop-blur",
            "border-[var(--brand-border)] bg-[color-mix(in_oklab,var(--surface)_92%,transparent)]"
          )}
        >
          <div className="rounded-xl border border-[var(--brand-border)] bg-[var(--surface-soft)] px-3 py-2.5">
            <p className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-[var(--brand-primary)]">Tema Rengi</p>
            <div className="mt-2 flex items-center gap-3">
              <span
                className="h-10 w-10 rounded-xl border border-black/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.28)]"
                style={{
                  background: `linear-gradient(135deg, color-mix(in oklab, ${accent} 76%, white) 0%, ${accent} 100%)`,
                }}
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-[var(--brand-primary-strong)]">{selectedOption?.label ?? "Ozel Renk"}</p>
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
                  {accent.toUpperCase()}
                </p>
              </div>
            </div>
          </div>

          <div className="mt-2 grid grid-cols-4 gap-2">
            {UI_COLOR_OPTIONS.map((option) => {
              const active = option.value === accent;

              return (
                <button
                  key={option.value}
                  type="button"
                  className={cn(
                    "h-12 rounded-xl border bg-gradient-to-br transition-all",
                    active
                      ? "scale-[1.03] border-[var(--brand-primary)] shadow-[0_14px_22px_-18px_rgba(0,0,0,0.42)]"
                      : "border-[var(--brand-border)] hover:-translate-y-0.5 hover:border-[var(--brand-primary)]",
                    option.previewClassName
                  )}
                  onClick={() => {
                    onSelect(option.value);
                    setOpen(false);
                  }}
                  aria-label={option.label}
                  title={option.label}
                >
                  <span className="sr-only">{option.label}</span>
                  {active ? <Check className="mx-auto h-4 w-4 text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.4)]" /> : null}
                </button>
              );
            })}
          </div>

          <label className="mt-2 flex items-center justify-between rounded-xl border border-[var(--brand-border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold text-[var(--brand-primary-strong)]">
            Ozel Renk
            <input
              type="color"
              value={accent}
              onChange={(event) => onSelect(event.target.value)}
              className="h-9 w-12 cursor-pointer rounded-md border border-[var(--brand-border)] bg-transparent"
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}

type ProfileFormState = {
  username: string;
  avatarUrl: string | null;
  currentPassword: string;
  newPassword: string;
};

function ProfileEditDialog({
  open,
  user,
  saving,
  form,
  onOpenChange,
  onFormChange,
  onAvatarChange,
  onSubmit,
}: {
  open: boolean;
  user: ApiUser | null;
  saving: boolean;
  form: ProfileFormState;
  onOpenChange: (open: boolean) => void;
  onFormChange: (patch: Partial<ProfileFormState>) => void;
  onAvatarChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Profil Düzenle</DialogTitle>
          <DialogDescription>Profil resmi, kullanıcı adı ve şifre bilgilerini güncelleyin.</DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="flex items-center gap-4 rounded-2xl border border-[var(--brand-border)] bg-[var(--surface-soft)] p-4">
            <span
              className={cn(
                "inline-flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl border border-white/60 bg-[linear-gradient(135deg,var(--brand-primary)_0%,var(--brand-accent)_100%)] bg-cover bg-center text-xl font-black text-white",
                form.avatarUrl && "text-transparent"
              )}
              style={form.avatarUrl ? { backgroundImage: `url(${form.avatarUrl})` } : undefined}
            >
              {initialsFromName(user?.name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-black text-[var(--brand-primary-strong)]">{user?.name ?? "Kullanıcı"}</p>
              <p className="mt-1 text-xs font-semibold text-[var(--muted-foreground)]">PNG/JPG/WebP profil resmi ekleyebilirsiniz.</p>
              <Input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={onAvatarChange}
                className="mt-3 h-10 cursor-pointer bg-[var(--surface)] text-sm"
              />
            </div>
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Kullanıcı Adı</span>
            <Input
              type="text"
              value={form.username}
              onChange={(event) => onFormChange({ username: event.target.value })}
              placeholder="plasiyer.ahmet"
              autoComplete="username"
              required
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Şifre</span>
            <Input
              type="password"
              value={form.currentPassword}
              onChange={(event) => onFormChange({ currentPassword: event.target.value })}
              placeholder="Mevcut şifre"
              autoComplete="current-password"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Yeni Şifre</span>
            <Input
              type="password"
              value={form.newPassword}
              onChange={(event) => onFormChange({ newPassword: event.target.value })}
              placeholder="Yeni şifre"
              autoComplete="new-password"
            />
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Vazgeç
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Kaydediliyor..." : "Kaydet"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { status, user, selectedCustomer, logout, refresh, clearCustomer } = useSession();
  const { cartData } = useCart();
  const [uiTheme, setUiTheme] = useState<UiTheme>("dark");
  const [uiAccent, setUiAccent] = useState<string>(DEFAULT_UI_ACCENT);
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileForm, setProfileForm] = useState<ProfileFormState>({
    username: "",
    avatarUrl: null,
    currentPassword: "",
    newPassword: "",
  });
  const [sidebarItemOrder, setSidebarItemOrder] = useState<string[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () =>
      typeof window !== "undefined" &&
      window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1"
  );
  const roleSlugs = useMemo(() => (Array.isArray(user?.roles) ? user.roles.map((role) => role.slug) : []), [user?.roles]);
  const sidebarOrderSection = pathname.startsWith("/moderator") ? "moderator" : "main";
  const sidebarOrderKey = useMemo(
    () => sidebarOrderStorageKey(user?.id, sidebarOrderSection),
    [sidebarOrderSection, user?.id]
  );
  const menuPermissionSet = useMemo(() => new Set(user?.menu_permissions ?? []), [user?.menu_permissions]);
  const warehouseOnlyRole = useMemo(() => isWarehouseOnlyRole(roleSlugs), [roleSlugs]);
  const dealerAdminPanelRole = useMemo(() => isDealerAdminPanelRole(roleSlugs), [roleSlugs]);
  const posOnlyRole = useMemo(() => isPosOnlyRole(roleSlugs), [roleSlugs]);
  const moderatorOnlyRole = useMemo(() => isModeratorOnlyRole(roleSlugs), [roleSlugs]);
  const warehouseStandaloneMode = useMemo(
    () => warehouseOnlyRole && (menuPermissionSet.size === 0 || (menuPermissionSet.size === 1 && menuPermissionSet.has("warehouse"))),
    [menuPermissionSet, warehouseOnlyRole]
  );
  const moderatorStandaloneMode = useMemo(
    () =>
      moderatorOnlyRole &&
      (menuPermissionSet.size === 0 ||
        Array.from(menuPermissionSet).every((permission) => permission === "moderator" || permission === "customer-users")),
    [menuPermissionSet, moderatorOnlyRole]
  );
  const customerSelectionRequired = useMemo(() => requiresCustomerSelection(roleSlugs), [roleSlugs]);
  const panelTitle = useMemo(() => resolvePanelTitle(roleSlugs), [roleSlugs]);
  const showCustomerCountBadge = useMemo(
    () => roleSlugs.includes("admin") || roleSlugs.includes("salesperson"),
    [roleSlugs]
  );
  const customerCountQuery = useQuery({
    queryKey: ["customers", "count"],
    queryFn: () => listCustomers({ limit: 1, source_system: "logo", summary: "count" }),
    enabled: Boolean(user) && showCustomerCountBadge,
    staleTime: 60_000,
  });
  const marketRatesQuery = useQuery({
    queryKey: ["market-rates", "tcmb"],
    queryFn: getTcmbMarketRates,
    enabled: Boolean(user),
    staleTime: 5 * 60_000,
    refetchInterval: 15 * 60_000,
    retry: 1,
  });
  const cartLineCount = cartData?.totals.line_count ?? 0;
  const cartDistinctLineCount = cartData?.items.length ?? 0;
  const cartBadge = cartLineCount > 0 ? String(cartLineCount) : undefined;
  const cartSecondaryBadge = cartDistinctLineCount > 0 ? String(cartDistinctLineCount) : undefined;
  useEffect(() => {
    setSidebarItemOrder(readSidebarItemOrder(sidebarOrderKey));
  }, [sidebarOrderKey]);
  const accessibleNavItems = useMemo(
    () => {
      const isSalesperson = roleSlugs.includes("salesperson");
      const customerBadge = customerCountQuery.data?.total_count;
      const isModeratorRoute = pathname.startsWith("/moderator");
      const sourceItems = isModeratorRoute ? MODERATOR_SECTION_ITEMS : SIDEBAR_ITEMS;

      const items = sourceItems
        .filter((item) => canAccessNavItem(item, roleSlugs, menuPermissionSet))
        .map((item) => {
          const label = isSalesperson
            ? item.href === "/dashboard"
              ? "Ana Sayfa"
              : item.href === "/search"
                ? "Arama"
                : item.href === "/customers"
                  ? "Cari Seç"
                  : item.href === "/orders"
                    ? "Siparişler"
                    : item.label
            : dealerAdminPanelRole && item.href === "/dashboard"
              ? "Ana Sayfa"
              : dealerAdminPanelRole && item.href === "/search"
                ? "Ürünler"
                : dealerAdminPanelRole && item.href === "/cart"
                  ? "Sepetim"
                  : dealerAdminPanelRole && item.href === "/orders"
                    ? "Siparişlerim"
                    : item.label;

          const posOnlyLabel =
            posOnlyRole && item.href === "/pos"
              ? "Hızlı Satış"
              : label;

          if (item.href === "/customers") {
            return {
              ...item,
              label: posOnlyLabel,
              badge: customerBadge !== undefined ? String(customerBadge) : item.badge,
            };
          }

          if (item.href === "/cart") {
            return {
              ...item,
              label: posOnlyLabel,
              badge: cartBadge,
              secondaryBadge: cartSecondaryBadge,
            };
          }

          return {
            ...item,
            label: posOnlyLabel,
          };
        });

      const scopedItems = items;

      if (posOnlyRole) {
        return scopedItems;
      }

      return isModeratorRoute ? sortModeratorNavItemsByPriority(scopedItems) : sortNavItemsForPath(scopedItems, pathname);
    },
    [cartBadge, cartSecondaryBadge, customerCountQuery.data?.total_count, dealerAdminPanelRole, menuPermissionSet, pathname, posOnlyRole, roleSlugs]
  );
  const sidebarItems = useMemo(
    () => accessibleNavItems.filter((item) => !item.hiddenFromSidebar),
    [accessibleNavItems]
  );
  const baseDashboardSidebarItems = useMemo(() => {
    if (!roleSlugs.includes("admin")) {
      return sidebarItems;
    }

    return sortNavItemsForPath(
      SIDEBAR_ITEMS
        .filter((item) => !item.hiddenFromSidebar)
        .filter((item) => item.allowedRoles === undefined || item.allowedRoles.includes("admin"))
        .map((item) => ({
        ...item,
        label: ADMIN_SIDEBAR_LABEL_OVERRIDES[item.href] ?? item.label,
        badge: item.href === "/cart" ? cartBadge : undefined,
        secondaryBadge: item.href === "/cart" ? cartSecondaryBadge : undefined,
      })),
      pathname
    );
  }, [cartBadge, cartSecondaryBadge, pathname, roleSlugs, sidebarItems]);
  const dashboardSidebarItems = useMemo(
    () => applyStoredSidebarOrder(baseDashboardSidebarItems, sidebarItemOrder),
    [baseDashboardSidebarItems, sidebarItemOrder]
  );
  const sidebarReorderEnabled = dashboardSidebarItems.length > 1;
  const handleSidebarItemsReorder = useCallback(
    (draggedHref: string, targetHref: string) => {
      const visibleHrefs = baseDashboardSidebarItems.map((item) => item.href);

      setSidebarItemOrder((currentOrder) => {
        const nextOrder = moveSidebarItem(currentOrder, visibleHrefs, draggedHref, targetHref);

        if (nextOrder === currentOrder) {
          return currentOrder;
        }

        writeSidebarItemOrder(sidebarOrderKey, nextOrder);
        return nextOrder;
      });
    },
    [baseDashboardSidebarItems, sidebarOrderKey]
  );
  const dashboardTopDockItems = useMemo(() => {
    const itemsByHref = new Map(dashboardSidebarItems.map((item) => [item.href, item]));
    const primaryItems = DASHBOARD_TOP_DOCK_ORDER
      .map((href) => itemsByHref.get(href))
      .filter((item): item is NavItem => Boolean(item));

    return primaryItems.length > 0 ? primaryItems : dashboardSidebarItems;
  }, [dashboardSidebarItems]);
  const fallbackPath = useMemo(() => {
    if (pathname === "/moderator") {
      return "/moderator/users";
    }

    if (warehouseStandaloneMode) {
      return "/warehouse";
    }

    if (posOnlyRole) {
      return "/pos";
    }

    if (moderatorStandaloneMode) {
      return "/moderator/users";
    }

    if (menuPermissionSet.size > 0 && !roleSlugs.includes("admin")) {
      return sidebarItems[0]?.href ?? "/dashboard";
    }

    if (dealerAdminPanelRole) {
      return "/dashboard";
    }

    return sidebarItems[0]?.href ?? "/dashboard";
  }, [dealerAdminPanelRole, menuPermissionSet, moderatorStandaloneMode, pathname, posOnlyRole, roleSlugs, sidebarItems, warehouseStandaloneMode]);
  const isCustomerRoute = pathname === "/customers" || pathname.startsWith("/customers/");
  const isNotesRoute = pathname === "/notes" || pathname.startsWith("/notes/");
  const isWarehouseRoute = pathname === "/warehouse" || pathname.startsWith("/warehouse/");
  const showCustomerContext =
    !warehouseStandaloneMode &&
    !moderatorStandaloneMode &&
    !(pathname === "/moderator" || pathname.startsWith("/moderator/")) &&
    (!posOnlyRole || isCustomerRoute || Boolean(selectedCustomer));
  const isSalesperson = roleSlugs.includes("salesperson");
  const showSalespersonCustomerSelectionOnly = isSalesperson && isCustomerRoute;
  const usePointStandaloneShell = false;
  const pointOnlyShell = usePointStandaloneShell && posOnlyRole;
  const pointQuickSalesShell = pointOnlyShell && pathname === "/pos";
  const posDayEndStandaloneShell = pathname.startsWith("/pos/day-end");

  const [now, setNow] = useState<Date>(() => new Date());
  const [currentHash, setCurrentHash] = useState("");

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const nextTheme = resolveUiTheme();
    const nextAccent = resolveUiAccent();
    const storedAccent =
      typeof window !== "undefined"
        ? normalizeUiAccent(
            window.localStorage.getItem(UI_ACCENT_STORAGE_KEY) ??
              window.localStorage.getItem(LEGACY_UI_COLOR_STORAGE_KEY)
          )
        : nextAccent;
    const frame = window.requestAnimationFrame(() => {
      setUiTheme(nextTheme);
      setUiAccent(storedAccent);
    });
    applyUiTheme(nextTheme);
    applyUiAccent(storedAccent);

    return () => window.cancelAnimationFrame(frame);
  }, []);

  const toggleSidebar = () => {
    setSidebarCollapsed((current) => {
      const next = !current;

      if (typeof window !== "undefined") {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, next ? "1" : "0");
      }

      return next;
    });
  };

  useEffect(() => {
    const syncHash = () => setCurrentHash(window.location.hash);

    syncHash();
    window.addEventListener("hashchange", syncHash);

    return () => window.removeEventListener("hashchange", syncHash);
  }, [pathname]);

  useEffect(() => {
    if (!profileDialogOpen || !user) {
      return;
    }

    setProfileForm({
      username: user.username,
      avatarUrl: user.avatar_url ?? null,
      currentPassword: "",
      newPassword: "",
    });
  }, [profileDialogOpen, user]);

  useEffect(() => {
    if (!user || status !== "authenticated") {
      return;
    }

    if (warehouseStandaloneMode && !isWarehouseRoute && !pathname.startsWith("/notes")) {
      router.replace("/warehouse");
      return;
    }

    if (posOnlyRole && !pathname.startsWith("/notes") && !isPathAllowed(pathname, accessibleNavItems)) {
      router.replace("/pos");
      return;
    }

    if (moderatorStandaloneMode && !pathname.startsWith("/moderator") && !pathname.startsWith("/notes")) {
      router.replace("/moderator/users");
      return;
    }

    if (customerSelectionRequired && !selectedCustomer && !isCustomerRoute && !isNotesRoute) {
      const next = pathname ? `?next=${encodeURIComponent(pathname)}` : "";
      router.replace(`/customers${next}`);
      return;
    }

    if (!isPathAllowed(pathname, accessibleNavItems)) {
      router.replace(fallbackPath);
    }
  }, [
    customerSelectionRequired,
    fallbackPath,
    pathname,
    router,
    selectedCustomer,
    status,
    accessibleNavItems,
    user,
    isCustomerRoute,
    isNotesRoute,
    isWarehouseRoute,
    posOnlyRole,
    moderatorStandaloneMode,
    warehouseStandaloneMode,
  ]);

  const loginRedirectHref = useMemo(() => {
    const next = pathname ? `&next=${encodeURIComponent(pathname)}` : "";
    return `/login?v=20260605-login-fast${next}`;
  }, [pathname]);

  useEffect(() => {
    if (status !== "guest") {
      return;
    }

    router.replace(loginRedirectHref);
  }, [loginRedirectHref, router, status]);

  const pageMeta = useMemo(() => getPageMeta(pathname, roleSlugs, selectedCustomer, user), [pathname, roleSlugs, selectedCustomer, user]);
  const isDashboardRoute = pathname.startsWith("/dashboard");
  const isSearchRoute = pathname.startsWith("/search");
  const hidePointPosPageHeader = posOnlyRole && pathname === "/pos";
  const showPageTitle = !isDashboardRoute && !isCustomerRoute && Boolean(pageMeta.title || pageMeta.subtitle);
  const isAdminDashboardRoute = isDashboardRoute && roleSlugs.includes("admin");
  const isDarkMode = uiTheme === "dark";
  const currentHeaderItem = useMemo(
    () =>
      dashboardSidebarItems.find((item) => isNavItemActive(pathname, currentHash, item)) ??
      dashboardSidebarItems.find((item) => pathname.startsWith(item.href)),
    [currentHash, dashboardSidebarItems, pathname]
  );
  const HeaderIcon = currentHeaderItem?.icon ?? Gauge;
  const dashboardCustomerCode = selectedCustomer?.code?.trim() || "-";
  const dashboardCustomerTitle = selectedCustomer?.title?.trim() || "Müşteri seçilmedi";
  const dashboardCustomerDisplayTitle = selectedCustomer
    ? dashboardCustomerTitle.toLocaleUpperCase("tr-TR")
    : dashboardCustomerTitle;
  const pointBranchHeaderLabel = formatPointBranchHeaderLabel(user?.branch_name ?? user?.branch_code);
  const showPointBranchHeaderProfile = posOnlyRole && !isAdminDashboardRoute;
  const currentUserName = user?.name?.trim() || "Kullanıcı";
  const currentUserDisplayName = currentUserName.toLocaleUpperCase("tr-TR");
  const currentUserPhone = user?.phone?.trim() || "Telefon yok";
  const userAvatarStyle: CSSProperties | undefined = user?.avatar_url
    ? { backgroundImage: `url(${user.avatar_url})` }
    : undefined;
  const shellHomeHref = useMemo(() => {
    if (roleSlugs.includes("admin") || menuPermissionSet.has("dashboard")) {
      return "/dashboard";
    }

    return fallbackPath;
  }, [fallbackPath, menuPermissionSet, roleSlugs]);

  const dateTimeLabel = useMemo(
    () =>
      new Intl.DateTimeFormat("tr-TR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(now),
    [now]
  );

  const updateUiAccent = (nextAccent: string) => {
    const normalizedAccent = normalizeUiAccent(nextAccent);
    setUiAccent(normalizedAccent);
    applyUiAccent(normalizedAccent);
  };

  const updateProfileForm = (patch: Partial<ProfileFormState>) => {
    setProfileForm((current) => ({ ...current, ...patch }));
  };

  const handleProfileAvatarChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (!file.type.startsWith("image/")) {
      toast.error("Profil resmi için geçerli bir görsel seçin.");
      return;
    }

    if (file.size > 512 * 1024) {
      toast.error("Profil resmi en fazla 512 KB olmalı.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        updateProfileForm({ avatarUrl: reader.result });
      }
    };
    reader.onerror = () => toast.error("Profil resmi okunamadı.");
    reader.readAsDataURL(file);
  };

  const handleProfileSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!user) {
      return;
    }

    if (profileForm.newPassword && profileForm.newPassword.length < 6) {
      toast.error("Yeni şifre en az 6 karakter olmalı.");
      return;
    }

    setProfileSaving(true);

    try {
      await updateProfile({
        username: profileForm.username.trim(),
        avatar_url: profileForm.avatarUrl,
        current_password: profileForm.currentPassword,
        new_password: profileForm.newPassword,
      });
      await refresh();
      setProfileDialogOpen(false);
      toast.success("Profil güncellendi.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Profil güncellenemedi.");
    } finally {
      setProfileSaving(false);
    }
  };

  const shellStyle = useMemo(
    () => ({ "--ui-accent-base": uiAccent } as CSSProperties),
    [uiAccent]
  );
  const isRedirectingForCustomerSelection = Boolean(
    status === "authenticated" && user && customerSelectionRequired && !selectedCustomer && !isCustomerRoute
  );
  const dashboardExperimentStyle = useMemo(
    () =>
      ({
        ...shellStyle,
        "--muted-foreground": "#9caf9f",
        "--brand-primary": "#8fdda0",
        "--brand-primary-strong": "#f1f7f2",
        "--brand-primary-soft": "#0d2418",
        "--brand-accent": "#8fdda0",
        "--brand-accent-foreground": "#06100b",
        "--brand-accent-soft": "#10291b",
        "--brand-border": "#17392b",
        "--surface": "#061510",
        "--surface-soft": "#092018",
        "--background": "#020908",
        "--foreground": "#edf5ee",
        "--card": "#071711",
        "--card-foreground": "#edf5ee",
        "--popover": "#071711",
        "--popover-foreground": "#edf5ee",
        "--primary": "#8fdda0",
        "--primary-foreground": "#06100b",
        "--secondary": "#092018",
        "--secondary-foreground": "#edf5ee",
        "--muted": "#092018",
        "--accent": "#0d271b",
        "--accent-foreground": "#edf5ee",
        "--border": "#17392b",
        "--input": "#17392b",
        "--ring": "#8fdda0",
      }) as CSSProperties,
    [shellStyle]
  );
  const useExperimentalDashboardShell = false;

  if (isRedirectingForCustomerSelection) {
    return (
      <div className="app-shell-root min-h-screen bg-[var(--background)] text-[var(--foreground)]" style={shellStyle}>
        <main className="flex min-h-screen items-center justify-center px-4 text-center text-sm font-semibold text-[var(--muted-foreground)]">
          Müşteri seçimi açılıyor...
        </main>
      </div>
    );
  }

  if (status === "guest") {
    return (
      <div className="app-shell-root min-h-screen bg-[var(--background)] text-[var(--foreground)]" style={shellStyle}>
        <main className="flex min-h-screen items-center justify-center px-4 text-center text-sm font-semibold text-[var(--muted-foreground)]">
          Giriş ekranı açılıyor...
        </main>
      </div>
    );
  }

  if (useExperimentalDashboardShell) {
    return (
      <div
        className="min-h-screen bg-[#020908] text-[#edf5ee]"
        style={dashboardExperimentStyle}
      >
        <div className="mx-auto flex min-h-screen w-full max-w-[1600px] flex-col gap-3 px-4 py-4">
          <nav className="rounded-[18px] border border-[#17392b] bg-[radial-gradient(circle_at_50%_0%,rgba(105,230,131,0.1)_0%,rgba(105,230,131,0)_42%),linear-gradient(180deg,rgba(7,24,18,0.94)_0%,rgba(3,13,11,0.96)_100%)] px-5 py-4 shadow-[0_26px_60px_-50px_rgba(0,0,0,0.92),inset_0_1px_0_rgba(255,255,255,0.06)]">
            <div className="-mx-2 overflow-x-auto px-2 pb-1">
              <div className="mx-auto flex w-max min-w-full justify-start gap-5 sm:justify-center">
                {dashboardTopDockItems.map((item) => (
                  <DashboardTopDockIcon
                    key={item.href}
                    item={item}
                    active={isNavItemActive(pathname, currentHash, item)}
                  />
                ))}
              </div>
            </div>
          </nav>

          <div className="flex flex-wrap items-center gap-3 rounded-[18px] border border-[#17392b] bg-[linear-gradient(180deg,rgba(8,25,19,0.94)_0%,rgba(3,14,12,0.96)_100%)] px-4 py-3 shadow-[0_24px_54px_-48px_rgba(0,0,0,0.92),inset_0_1px_0_rgba(255,255,255,0.05)]">
            <Link
              href={dashboardSidebarItems.some((item) => item.href === "/customers") ? "/customers" : "#"}
              className="inline-flex h-12 min-w-[238px] items-center justify-between gap-3 rounded-[14px] border border-[#1b3f31] bg-[#06130f] px-4 text-sm font-bold text-[#e8f1e9] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] transition hover:border-[#68d37c]/60"
            >
              <span className="inline-flex min-w-0 items-center gap-3">
                <UserRound className="h-5 w-5 shrink-0 text-[#69dc7f]" />
                <span className="truncate">
                  {selectedCustomer ? `${selectedCustomer.code} · ${selectedCustomer.title}` : "Müşteri seçimi"}
                </span>
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 text-[#e8f1e9]" />
            </Link>

            <div className="inline-flex h-12 items-center gap-3 rounded-[14px] border border-[#1b3f31] bg-[#06130f] px-4 text-sm font-bold text-[#e8f1e9] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
              <Clock3 className="h-5 w-5 text-[#e8f1e9]" />
              {dateTimeLabel}
              <span className="h-2.5 w-2.5 rounded-full bg-[#58d66d] shadow-[0_0_14px_rgba(88,214,109,0.8)]" />
            </div>

            <Link
              href={dashboardSidebarItems.some((item) => item.href === "/mal-kabul") ? "/mal-kabul" : "#"}
              className="ml-auto inline-flex h-12 items-center gap-3 rounded-[14px] border border-[#1b3f31] bg-[#06130f] px-5 text-sm font-bold text-[#e8f1e9] transition hover:bg-[#0b2118] hover:text-white"
            >
              <Settings className="h-5 w-5" />
              Ayarlar
            </Link>

            <Button
              variant="outline"
              size="icon"
              aria-label="Oturumu kapat"
              title="Oturumu kapat"
              className="h-12 w-12 shrink-0 rounded-[14px] border-[#1b3f31] bg-[#06130f] p-0 text-[#e8f1e9] hover:bg-[#0b2118] hover:text-white"
              onClick={() => {
                void logout().then(() => router.replace("/login?v=20260605-login-fast"));
              }}
            >
              <LogOut className="h-5 w-5" />
            </Button>
          </div>

          <main className="min-h-0 flex-1">{children}</main>

          <NfsSoftCredit dark className="pb-1 text-[12px] text-[#789287]" />
        </div>
      </div>
    );
  }

  if (showSalespersonCustomerSelectionOnly) {
    return (
      <div className="app-shell-root min-h-screen bg-[var(--background)] text-[var(--foreground)]" style={shellStyle}>
        <main className="min-h-screen px-3 py-3 lg:px-6 lg:py-4">
          <div className="mx-auto w-full max-w-[1840px]">
            {children}
            <NfsSoftCredit className="mt-6 pb-2" />
          </div>
        </main>
      </div>
    );
  }

  if (pointQuickSalesShell) {
    return (
      <div className="app-shell-root min-h-screen bg-[#06130e] text-[#eef8ef]" style={shellStyle}>
        <main className="min-h-screen p-2 sm:p-3 lg:p-4">
          {children}
          <NfsSoftCredit dark className="mt-4 pb-2 text-[#9eb0a3]" />
        </main>
      </div>
    );
  }

  if (pointOnlyShell) {
    return (
      <div className="app-shell-root min-h-screen bg-[#06130e] text-[#eef8ef]" style={shellStyle}>
        <main className="min-h-screen p-2 sm:p-3 lg:p-4">
          <div
            className="point-sale-screen min-h-[calc(100vh-32px)] rounded-[28px] border border-[#1e4333] bg-[#071a12] p-3 text-[#eef8ef] shadow-[0_30px_90px_-54px_rgba(0,0,0,0.9)] sm:p-4"
            data-point-theme="light"
          >
            {children}
          </div>
          <NfsSoftCredit dark className="mt-4 pb-2 text-[#9eb0a3]" />
        </main>
      </div>
    );
  }

  if (posDayEndStandaloneShell) {
    return (
      <div className="app-shell-root min-h-screen !bg-[#121a15] !text-[#f4f8f5]" style={shellStyle}>
        <main className="min-h-screen p-0">
          <div className="w-full">
            {children}
            <NfsSoftCredit dark className="px-3 pb-2 text-[#9eaca1]" />
          </div>
        </main>
      </div>
    );
  }

  return (
      <div
        className={cn(
          "app-shell-root min-h-screen bg-[var(--background)] text-[var(--foreground)]",
          isDashboardRoute ? "dashboard-shell font-medium" : ""
        )}
        style={shellStyle}
      >
      <div className={cn("app-layout-frame flex min-h-screen w-full overflow-x-clip", isDashboardRoute ? "bg-transparent" : "bg-[var(--background)]")}>
        <aside
          data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}
          className={cn(
            "app-sidebar-aside relative z-20 hidden shrink-0 overflow-hidden transition-[width] duration-200 lg:block",
            sidebarCollapsed ? "w-[60px]" : "w-[220px] 2xl:w-[256px]"
          )}
        >
          {sidebarCollapsed ? (
            <div className={cn("app-sidebar h-full", isDashboardRoute && "app-sidebar-dashboard", isDashboardRoute && !isDarkMode && "app-sidebar-light")}>
              <button
                type="button"
                className={cn(
                  "absolute left-3 top-3 z-30 inline-flex h-8 w-8 items-center justify-center rounded-lg border text-[var(--sidebar-foreground)] transition hover:bg-[color-mix(in_oklab,var(--sidebar-primary)_24%,transparent)] hover:text-white",
                  isDashboardRoute && !isDarkMode
                    ? "border-[color-mix(in_oklab,var(--brand-border)_80%,transparent)] bg-white/70 text-[var(--brand-primary-strong)]"
                    : "border-white/10 bg-black/12"
                )}
                aria-label="Sidebar aç"
                title="Sidebar aç"
                onClick={toggleSidebar}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <SidebarMenu
              pathname={pathname}
              currentHash={currentHash}
              items={dashboardSidebarItems}
              panelTitle={panelTitle}
              darkMode={isDarkMode}
              dashboardRoute={isDashboardRoute}
              homeHref={shellHomeHref}
              collapsed={sidebarCollapsed}
              onToggleCollapsed={toggleSidebar}
              onReorderItems={handleSidebarItemsReorder}
              reorderEnabled={sidebarReorderEnabled}
              onLogout={() => {
                void logout().then(() => router.replace("/login?v=20260605-login-fast"));
              }}
            />
          )}
        </aside>

        <div className="app-content-region relative z-10 flex min-h-screen min-w-0 flex-1 flex-col">
          <header className={cn("page-shell-header sticky top-0 z-[70] px-4 pt-4 lg:px-6 xl:px-8", hidePointPosPageHeader && "hidden")}>
            <div
              className={cn(
                "dashboard-top-header-card grid grid-cols-1 gap-3 rounded-[18px] px-4 py-3 xl:grid-cols-[minmax(220px,1fr)_minmax(0,auto)_minmax(0,max-content)] xl:items-center xl:gap-4 xl:px-5",
                isCustomerRoute && "customers-header-card",
                isDashboardRoute && !isAdminDashboardRoute && "py-2.5 xl:px-4",
                isSearchRoute && "customers-header-card"
              )}
            >
              <div
                className={cn(
                  "header-title-area flex min-w-0 items-center gap-3 px-0 py-0",
                  !showPageTitle && !isDashboardRoute && "hidden"
                )}
              >
                {showPageTitle ? (
                  <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] border border-[var(--brand-border)] bg-[var(--brand-primary-soft)] text-[var(--brand-primary)] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
                    <HeaderIcon className="h-6 w-6" />
                  </span>
                ) : null}
                {isAdminDashboardRoute ? (
                  <div className="min-w-0">
                    <div className="flex min-h-[58px] min-w-[260px] items-center gap-3 px-1 py-1">
                      <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[15px] bg-[var(--brand-primary)] text-white">
                        <ShieldCheck className="h-5 w-5" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[1.55rem] font-black leading-tight text-[var(--brand-primary-strong)] lg:text-[1.8rem]">
                          Yönetim Paneli
                        </span>
                        <span className="mt-1 block max-w-[420px] truncate text-[13px] font-semibold leading-none text-[var(--muted-foreground)]">
                          Operasyon ve finans görünümü
                        </span>
                      </span>
                    </div>
                  </div>
                ) : isDashboardRoute ? (
                  <div className="min-w-0">
                    <div className="flex min-h-[48px] max-w-full items-center gap-3 px-1 py-0.5">
                      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] border border-[var(--brand-border)] bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]">
                        <UserRound className="h-5 w-5" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[11px] font-black uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                          {dashboardCustomerCode}
                        </span>
                        <span className="block truncate text-[1.15rem] font-black leading-tight text-[var(--brand-primary-strong)] lg:text-[1.3rem]">
                          {dashboardCustomerTitle}
                        </span>
                      </span>
                    </div>
                  </div>
                ) : showPageTitle ? (
                  <div className="min-w-0">
                    <h1 className="truncate text-[1.45rem] font-black leading-none tracking-tight text-[var(--brand-primary-strong)] lg:text-[1.65rem]">
                      {pageMeta.title}
                    </h1>
                    {pageMeta.subtitle ? (
                      <p className="mt-1 truncate text-[0.92rem] font-medium text-[var(--muted-foreground)]">
                        {pageMeta.subtitle}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="dashboard-header-center">
                {!showCustomerContext || isDashboardRoute ? (
                  <>
                    <HeaderMarketRates payload={marketRatesQuery.data} loading={marketRatesQuery.isLoading} />
                    {isDashboardRoute ? (
                      <div className="header-date-pill">
                        <span className="system-online-dot h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_14px_rgba(74,222,128,0.58)]" />
                        <span className="min-w-0">
                          <span className="block text-[12px] font-black text-[var(--brand-primary-strong)]">Sistem Durumu</span>
                          <span className="system-online-text block text-[12px] font-black text-emerald-400">Çevrimiçi</span>
                        </span>
                      </div>
                    ) : (
                      <div className="header-date-pill">
                        <Clock3 className="h-4 w-4 shrink-0 text-[var(--brand-primary)]" />
                        <p>{dateTimeLabel}</p>
                      </div>
                    )}
                  </>
                ) : null}
                {showCustomerContext && !isDashboardRoute ? (
                  <div className={cn("header-selected-customer flex items-center gap-3", selectedCustomer && "header-selected-customer-active")}>
                    <UserRound className="h-5 w-5 shrink-0 text-emerald-100/90" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[10px] font-black uppercase tracking-[0.12em] text-emerald-100/75">
                        Seçili Cari
                      </span>
                      <p className="header-selected-customer-name">
                        {selectedCustomer ? dashboardCustomerDisplayTitle : "Müşteri seçilmedi"}
                      </p>
                      {selectedCustomer ? <span className="header-selected-customer-code">{dashboardCustomerCode}</span> : null}
                    </span>
                    {selectedCustomer && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          void clearCustomer();
                        }}
                        className="ml-2 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-red-500/20 px-2.5 text-xs font-bold text-red-200 transition-colors hover:bg-red-500/40"
                        title="Müşteriden Çık"
                      >
                        <LogOut className="h-3.5 w-3.5" />
                        <span>Çıkış</span>
                      </button>
                    )}
                  </div>
                ) : null}
              </div>

              <div className="dashboard-header-actions">
                {showPointBranchHeaderProfile ? (
                  <div className="dashboard-header-profile">
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,var(--brand-primary)_0%,var(--brand-accent)_100%)] text-[12px] font-black text-white">
                      {initialsFromName(pointBranchHeaderLabel)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[10px] font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                        Şube
                      </span>
                      <span className="dashboard-header-profile-name">
                        {pointBranchHeaderLabel.toLocaleUpperCase("tr-TR")}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1 text-[12px] font-bold leading-none text-[var(--brand-primary)]">
                        Point B2B
                      </span>
                    </span>
                  </div>
                ) : !isAdminDashboardRoute && user ? (
                  <div className="dashboard-header-profile">
                    <span
                      className={cn(
                        "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,var(--brand-primary)_0%,var(--brand-accent)_100%)] bg-cover bg-center text-[12px] font-black text-white",
                        user.avatar_url && "text-transparent"
                      )}
                      style={userAvatarStyle}
                      aria-label={`${currentUserName} profil resmi`}
                    >
                      {initialsFromName(currentUserName)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[10px] font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                        {panelTitle}
                      </span>
                      <span className="dashboard-header-profile-name">
                        {currentUserDisplayName}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1 text-[12px] font-bold leading-none text-[var(--brand-primary)]">
                        <PhoneCall className="h-3 w-3 shrink-0" />
                        <span className="truncate">{currentUserPhone}</span>
                      </span>
                    </span>
                  </div>
                ) : null}
                {isDashboardRoute && !isAdminDashboardRoute ? null : (
                  <ColorThemePicker
                    accent={uiAccent}
                    onSelect={updateUiAccent}
                  />
                )}
                {isAdminDashboardRoute ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label="Profil düzenle"
                    title="Profil düzenle"
                    className="dashboard-header-profile-edit header-profile-icon-button h-11 w-11 shrink-0 overflow-hidden rounded-full bg-cover bg-center px-0 text-[var(--brand-primary-strong)] hover:text-[var(--brand-primary-strong)]"
                    style={userAvatarStyle}
                    onClick={() => setProfileDialogOpen(true)}
                  >
                    {user?.avatar_url ? null : <span className="text-[12px] font-black">{initialsFromName(user?.name)}</span>}
                    <span className="sr-only">Profil Düzenle</span>
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Oturumu kapat"
                  title="Oturumu kapat"
                  className={cn(
                    "header-logout-button h-10 shrink-0 gap-2 rounded-[14px] px-3 text-[var(--brand-primary-strong)] hover:text-[var(--brand-primary-strong)]",
                    isDashboardRoute && "lg:h-10 lg:rounded-[14px]"
                  )}
                  onClick={() => {
                    void logout().then(() => router.replace("/login?v=20260605-login-fast"));
                  }}
                >
                  <LogOut className="h-4 w-4" />
                  <span className="text-[13px] font-extrabold">Çıkış Yap</span>
                </Button>
              </div>
            </div>

            <div className={cn("mt-2 px-0 py-0 lg:hidden", sidebarCollapsed && "hidden")}>
              <div className="flex gap-2 overflow-x-auto">
                {dashboardSidebarItems.map((item) => {
                  const Icon = item.icon;
                  const active = isNavItemActive(pathname, currentHash, item);

                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        "flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 py-2 text-xs font-semibold",
                        active
                          ? "border-[var(--brand-primary)] bg-[var(--brand-primary)] text-[var(--primary-foreground)]"
                          : "border-[var(--brand-border)] bg-[var(--surface)] text-[var(--brand-primary-strong)]"
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          </header>

          <main className={cn("page-shell-main flex-1 px-4 py-3 lg:px-6 lg:py-4", isDashboardRoute && "text-[0.98rem]")}>
            {children}
            <NfsSoftCredit className="mt-6 pb-2" />
          </main>
        </div>
      </div>
      <ProfileEditDialog
        open={profileDialogOpen}
        user={user}
        saving={profileSaving}
        form={profileForm}
        onOpenChange={setProfileDialogOpen}
        onFormChange={updateProfileForm}
        onAvatarChange={handleProfileAvatarChange}
        onSubmit={handleProfileSubmit}
      />
    </div>
  );
}
