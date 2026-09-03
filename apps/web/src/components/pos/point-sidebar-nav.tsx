"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ClipboardCheck,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  ShoppingCart,
} from "lucide-react";

import { useSession } from "@/components/auth/session-provider";
import { cn } from "@/lib/utils";

const POINT_NAV_ITEMS = [
  {
    href: "/pos",
    label: "Hızlı Satış",
    permissionKey: "pos",
    icon: ShoppingCart,
    quickSaleIcon: "/assets/powersa-filter-icons/webp/hizli-satis-cart.webp",
  },
  {
    href: "/pos/day-end",
    label: "Gün Sonu",
    permissionKey: "pos-day-end",
    icon: ClipboardCheck,
    quickSaleIcon: "/assets/powersa-filter-icons/webp/hizli-satis-cart.webp",
  },
] as const;

const POINT_SIDEBAR_COLLAPSED_STORAGE_KEY = "powersa-point-sidebar-collapsed";

type PointSidebarNavProps = {
  iconVariant?: "default" | "quick-sale";
};

export function PointSidebarNav({ iconVariant = "default" }: PointSidebarNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useSession();
  const useQuickSaleIcons = iconVariant === "quick-sale";
  const roleSlugs = user?.roles.map((role) => role.slug) ?? [];
  const menuPermissions = user?.menu_permissions ?? [];
  const isAdmin = roleSlugs.includes("admin");
  const visibleItems = POINT_NAV_ITEMS.filter((item) => isAdmin || menuPermissions.includes(item.permissionKey));
  const [collapsed, setCollapsed] = useState(
    () =>
      typeof window !== "undefined" &&
      window.localStorage.getItem(POINT_SIDEBAR_COLLAPSED_STORAGE_KEY) === "1"
  );
  const handleLogout = useCallback(async () => {
    router.replace("/login?v=20260605-login-fast");
    await logout();
  }, [logout, router]);

  useEffect(() => {
    document.documentElement.dataset.pointSidebarCollapsed = collapsed ? "true" : "false";

    return () => {
      document.documentElement.dataset.pointSidebarCollapsed = "false";
    };
  }, [collapsed]);

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;

      if (typeof window !== "undefined") {
        window.localStorage.setItem(POINT_SIDEBAR_COLLAPSED_STORAGE_KEY, next ? "1" : "0");
      }

      document.documentElement.dataset.pointSidebarCollapsed = next ? "true" : "false";

      return next;
    });
  };

  return (
    <aside
      className={cn(
        "point-sale-sidebar mb-4 rounded-[24px] border border-[#1f4332] bg-[linear-gradient(180deg,#081b13_0%,#06150f_100%)] p-5 text-white shadow-[0_28px_80px_-56px_rgba(0,0,0,0.95)] transition-[width,padding] duration-200 xl:sticky xl:top-4 xl:mb-0 xl:h-[calc(100vh-32px)]",
        collapsed && "point-sale-sidebar-collapsed px-2"
      )}
      data-collapsed={collapsed ? "true" : "false"}
    >
      <div className="flex h-full flex-col">
        <button
          type="button"
          onClick={toggleCollapsed}
          className={cn(
            "mb-3 flex h-11 items-center justify-center gap-2 rounded-[14px] border border-[#31513d] bg-[#10271c] text-sm font-black text-[#dce6de] transition hover:border-[#7bd875]/70 hover:bg-[#173b29] hover:text-white",
            collapsed ? "mx-auto w-11" : "w-full"
          )}
          aria-label={collapsed ? "Sidebar aç" : "Sidebar kapat"}
          title={collapsed ? "Sidebar aç" : "Sidebar kapat"}
        >
          {collapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
          {collapsed ? null : <span>Sidebar</span>}
        </button>

        <Link
          href="/pos"
          className={cn(
            "point-sale-logo point-sale-logo-transparent flex items-center justify-center rounded-[18px] border border-transparent px-2 py-2 transition-all",
            collapsed ? "h-[72px]" : "h-[126px]"
          )}
        >
          <span className={cn("point-sale-brand-light flex h-full w-full flex-col items-center justify-center gap-2", collapsed && "hidden")}>
            <Image
              src="/brand/logotransparan-clean.png"
              alt="Güçsa Powersa Filter Logo"
              width={910}
              height={883}
              sizes="180px"
              className="h-full w-full object-contain"
              priority
            />
          </span>
          <span className="point-sale-brand-dark h-full w-full">
            <Image
              src="/brand/logotransparan-clean.png"
              alt="Güçsa Powersa Filter Logo"
              width={910}
              height={883}
              sizes="180px"
              className={cn("h-full w-full object-contain drop-shadow-[0_18px_24px_rgba(0,0,0,0.16)]", collapsed && "scale-125")}
              priority
            />
          </span>
        </Link>

        <div className="mt-5 h-px bg-[#244332]" />

        <nav className="mt-6 space-y-3">
          {visibleItems.map((item) => {
            const Icon = item.icon;
            const active =
              item.href === "/pos"
                ? pathname === item.href
                : pathname === item.href || pathname.startsWith(`${item.href}/`);

            return (
              <Link
                key={`${item.href}-${item.label}`}
                href={item.href}
                data-active={active ? "true" : undefined}
                className={cn(
                  "point-sale-nav-item group grid items-center rounded-[16px] px-2 text-[15px] font-black transition",
                  collapsed
                    ? "h-[66px] grid-cols-1 justify-items-center px-0"
                    : useQuickSaleIcons ? "h-[74px] grid-cols-[66px_1fr] gap-4" : "h-[66px] grid-cols-[56px_1fr] gap-4",
                  active
                    ? "border border-[#3b8a50] bg-[linear-gradient(135deg,rgba(42,119,58,0.92)_0%,rgba(16,49,31,0.92)_100%)] text-[#dfffe4] shadow-[0_0_28px_rgba(78,200,95,0.22)]"
                    : "border border-transparent text-[#dce6de] hover:border-[#2c563e] hover:bg-[#10271c]"
                )}
              >
                <span
                  className={cn(
                    "point-sale-nav-icon flex items-center justify-center transition",
                    useQuickSaleIcons && "point-sale-nav-icon-image",
                    useQuickSaleIcons
                      ? "h-[64px] w-[64px]"
                      : "h-[52px] w-[52px] rounded-[12px] border shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
                    !useQuickSaleIcons && active
                      ? "border-[#7adb72]/50 bg-[linear-gradient(145deg,#2e7245_0%,#143824_100%)] text-white"
                      : !useQuickSaleIcons
                        ? "border-[#31513d] bg-[linear-gradient(145deg,#1b3526_0%,#0e2419_100%)] text-[#dce6de] group-hover:text-white"
                        : ""
                  )}
                >
                  {useQuickSaleIcons ? (
                    <>
                      <Image
                        src={item.quickSaleIcon}
                        alt=""
                        width={64}
                        height={64}
                        className="point-sale-nav-image h-[64px] w-[64px] scale-125 object-contain drop-shadow-[0_12px_20px_rgba(0,0,0,0.45)] transition group-hover:scale-[1.32]"
                      />
                      <Icon className="point-sale-nav-glyph h-7 w-7" />
                    </>
                  ) : (
                    <Icon className="point-sale-nav-glyph h-7 w-7" />
                  )}
                </span>
                {collapsed ? null : <span className="point-sale-nav-label">{item.label}</span>}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto pt-8">
          <button
            type="button"
            onClick={() => {
              void handleLogout();
            }}
            className={cn(
              "flex h-14 items-center justify-center rounded-[16px] border border-[#61352f] bg-[linear-gradient(135deg,#3d1814_0%,#1c0d0b_100%)] text-sm font-black text-[#ffe4df] shadow-[0_18px_32px_-28px_rgba(0,0,0,0.9)] transition hover:border-[#ef8f80]/70 hover:bg-[#4b1f19] hover:text-white",
              collapsed ? "mx-auto w-12" : "w-full gap-3 px-4"
            )}
            aria-label="Çıkış yap"
            title="Çıkış yap"
          >
            <LogOut className="h-5 w-5" />
            {collapsed ? null : <span>Çıkış</span>}
          </button>
        </div>
      </div>
    </aside>
  );
}
