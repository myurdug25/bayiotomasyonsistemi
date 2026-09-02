"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Eye, EyeOff, KeyRound, Loader2, Percent, Search, UserPlus, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  ApiClientError,
  createCustomerUser,
  listCustomerUsers,
  type CustomerUserFeaturePermissionOption,
  type CustomerUserPermissionOption,
  type CustomerUserRecord,
  type CustomerBrandDiscount,
} from "@/lib/api";

const DEFAULT_CUSTOMER_MENUS = ["dashboard", "search", "catalogs", "cart", "orders", "ledger"];
const BLOCKED_CUSTOMER_USER_NAMES = new Set([
  "BATUM DEPO (SIPARIS)",
  "BATUM PERAKENDE KREDI KARTI SATIS",
  "BATUM PERAKENDE NAKIT SATIS",
  "ERZURUM POINT KREDI KARTI SATIS",
  "ERZURUM POINT NAKIT SATIS",
  "SAMSUN DEPO KREDI KARTI SATIS",
  "SAMSUN DEPO NAKIT SATIS",
  "SAMSUN DEPO (SIPARIS)",
  "TRABZON DEPO (SIPARIS)",
  "TRABZON POINT PERAKENDE KREDI KARTI SATIS",
  "TRABZON POINT PERAKENDE NAKIT SATIS",
  "ERZURUM DEPO",
]);

function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    const firstError = Object.values(error.payload?.errors ?? {})[0]?.[0];
    return firstError ?? error.payload?.message ?? error.message;
  }

  return error instanceof Error ? error.message : "İşlem tamamlanamadı.";
}

function randomPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let value = "";

  for (let index = 0; index < 8; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  return value;
}

function toggleValue(values: string[], key: string): string[] {
  return values.includes(key) ? values.filter((value) => value !== key) : [...values, key];
}

function normalizeBlockedCustomerName(value: string): string {
  return value
    .trim()
    .toLocaleUpperCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/İ/g, "I")
    .replace(/Ş/g, "S")
    .replace(/Ğ/g, "G")
    .replace(/Ü/g, "U")
    .replace(/Ö/g, "O")
    .replace(/Ç/g, "C")
    .replace(/\s+/g, " ");
}

function isBlockedCustomerUser(customer: CustomerUserRecord): boolean {
  return BLOCKED_CUSTOMER_USER_NAMES.has(normalizeBlockedCustomerName(customer.name));
}

function formatDiscount(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? `%${parsed.toLocaleString("tr-TR", { maximumFractionDigits: 2 })}` : "-";
}

function featureDefaultsForMenus(
  menuKeys: string[],
  featureOptions: CustomerUserFeaturePermissionOption[]
): string[] {
  const menuSet = new Set(menuKeys);
  return featureOptions
    .filter((feature) => menuSet.has(feature.menu_key))
    .map((feature) => feature.key);
}

export function CustomerUsersPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerUserRecord | null>(null);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [menuPermissions, setMenuPermissions] = useState<string[]>(DEFAULT_CUSTOMER_MENUS);
  const [featurePermissions, setFeaturePermissions] = useState<string[]>([]);
  const [specialDiscountRate, setSpecialDiscountRate] = useState("");
  const [allowedBrandIds, setAllowedBrandIds] = useState<number[]>([]);
  const [brandDiscounts, setBrandDiscounts] = useState<CustomerBrandDiscount[]>([]);

  const customerUsersQuery = useQuery({
    queryKey: ["customer-users", deferredSearch],
    queryFn: () =>
      listCustomerUsers({
        q: deferredSearch || undefined,
        limit: 80,
      }),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const rows = useMemo(() => customerUsersQuery.data?.data ?? [], [customerUsersQuery.data?.data]);
  const menuPermissionOptions = useMemo(
    () => customerUsersQuery.data?.menu_permissions ?? [],
    [customerUsersQuery.data?.menu_permissions]
  );
  const featurePermissionOptions = useMemo(
    () => customerUsersQuery.data?.feature_permissions ?? [],
    [customerUsersQuery.data?.feature_permissions]
  );
  const defaultMenuPermissions = customerUsersQuery.data?.default_menu_permissions ?? DEFAULT_CUSTOMER_MENUS;
  const brandOptions = customerUsersQuery.data?.brands ?? [];
  const menuLabelByKey = useMemo(() => {
    const labels = new Map<string, string>();
    menuPermissionOptions.forEach((permission) => labels.set(permission.key, permission.label));
    return labels;
  }, [menuPermissionOptions]);
  const featureGroups = useMemo(() => {
    return menuPermissionOptions
      .map((menu) => ({
        menu,
        features: featurePermissionOptions.filter((feature) => feature.menu_key === menu.key),
      }))
      .filter((group) => group.features.length > 0);
  }, [featurePermissionOptions, menuPermissionOptions]);
  const totalCount = customerUsersQuery.data?.total_count ?? 0;
  const listedCount = rows.length;
  const selectedCustomerHasUser = Boolean(selectedCustomer?.user);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedCustomer) {
        throw new Error("Cari seçilmedi.");
      }

      const nextPassword = password.trim() || (selectedCustomer.user ? "" : randomPassword());

      return createCustomerUser(selectedCustomer.id, {
        password: nextPassword || undefined,
        is_active: true,
        menu_permissions: menuPermissions,
        feature_permissions: featurePermissions,
        special_discount_rate: specialDiscountRate.trim() !== "" ? Number(specialDiscountRate.replace(",", ".")) : null,
        allowed_brand_ids: allowedBrandIds,
        brand_discounts: brandDiscounts.map((row) => ({
          brand_id: row.brand_id,
          discount_1: Number(String(row.discount_1 ?? 0).replace(",", ".")) || 0,
          discount_2: Number(String(row.discount_2 ?? 0).replace(",", ".")) || 0,
          discount_3: Number(String(row.discount_3 ?? 0).replace(",", ".")) || 0,
        })),
      });
    },
    onSuccess: async (response) => {
      toast.success(`${response.data.code} için müşteri kullanıcısı hazır.`);
      setSelectedCustomer(null);
      setPassword("");
      setShowPassword(false);
      setMenuPermissions(defaultMenuPermissions);
      setFeaturePermissions(featureDefaultsForMenus(defaultMenuPermissions, featurePermissionOptions));
      setSpecialDiscountRate("");
      setAllowedBrandIds([]);
      setBrandDiscounts([]);
      await queryClient.invalidateQueries({ queryKey: ["customer-users"] });
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  const openModal = (customer: CustomerUserRecord) => {
    const nextMenuPermissions = customer.user
      ? customer.user.menu_permissions ?? []
      : defaultMenuPermissions;

    setSelectedCustomer(customer);
    setPassword("");
    setShowPassword(false);
    setMenuPermissions(nextMenuPermissions);
    setFeaturePermissions(
      customer.user
        ? customer.user.feature_permissions ?? []
        : featureDefaultsForMenus(nextMenuPermissions, featurePermissionOptions)
    );
    setSpecialDiscountRate(customer.special_discount_rate ?? "");
    setAllowedBrandIds(customer.allowed_brand_ids ?? brandOptions.map((brand) => brand.id));
    setBrandDiscounts(customer.brand_discounts ?? []);
  };

  const submit = () => {
    const trimmedPassword = password.trim();

    if (selectedCustomerHasUser && trimmedPassword !== "" && trimmedPassword.length < 6) {
      toast.error("Şifre en az 6 karakter olmalı.");
      return;
    }

    const discountValue = specialDiscountRate.trim() !== "" ? Number(specialDiscountRate.replace(",", ".")) : null;
    if (discountValue !== null && (!Number.isFinite(discountValue) || discountValue < 0 || discountValue > 100)) {
      toast.error("İskonto oranı 0 ile 100 arasında olmalı.");
      return;
    }

    createMutation.mutate();
  };

  const toggleMenuPermission = (permission: CustomerUserPermissionOption) => {
    setMenuPermissions((current) => {
      const next = toggleValue(current, permission.key);
      const enabled = next.includes(permission.key);

      setFeaturePermissions((currentFeatures) => {
        const optionKeys = featurePermissionOptions
          .filter((feature) => feature.menu_key === permission.key)
          .map((feature) => feature.key);

        if (!enabled) {
          return currentFeatures.filter((feature) => !optionKeys.includes(feature));
        }

        return Array.from(new Set([...currentFeatures, ...optionKeys]));
      });

      return next;
    });
  };

  return (
    <div className="customer-users-page mx-auto flex w-full max-w-[1480px] flex-col gap-4 text-[var(--foreground)]">
      <section className="dashboard-panel-card rounded-[18px] p-4 lg:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-2xl font-black tracking-normal text-[var(--foreground)]">Müşteri Kullanıcı</h2>
            <p className="mt-1 text-sm font-semibold text-[var(--muted-foreground)]">
              {listedCount} / {totalCount} cari listeleniyor
            </p>
          </div>

          <div className="relative w-full lg:max-w-[420px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Cari kodu veya isim ara"
              className="admin-dashboard-input h-11 rounded-xl pl-10 text-sm font-semibold"
            />
          </div>
        </div>
      </section>

      <section className="customer-users-list dashboard-panel-card overflow-hidden rounded-[18px]">
        <div className="customer-users-list-head grid grid-cols-[minmax(120px,190px)_minmax(240px,1fr)_130px_150px_170px] border-b border-[var(--brand-border)] bg-[var(--brand-primary)] px-4 py-3 text-xs font-black uppercase tracking-[0.12em] text-[var(--primary-foreground)]">
          <span>Cari Kodu</span>
          <span>Cari İsmi</span>
          <span>İskonto</span>
          <span>Kampanya</span>
          <span className="text-right">İşlem</span>
        </div>

        <div className="divide-y divide-[var(--brand-border)]">
          {customerUsersQuery.isLoading ? (
            <div className="flex min-h-[220px] items-center justify-center text-sm font-semibold text-[var(--muted-foreground)]">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Cariler yükleniyor...
            </div>
          ) : rows.length === 0 ? (
            <div className="flex min-h-[220px] flex-col items-center justify-center px-4 text-center">
              <XCircle className="h-9 w-9 text-[var(--muted-foreground)]" />
              <p className="mt-3 text-base font-black text-[var(--foreground)]">Cari bulunamadı</p>
              <p className="mt-1 text-sm font-semibold text-[var(--muted-foreground)]">Arama değerini kontrol edin.</p>
            </div>
          ) : (
            rows.map((customer) => {
              const blockedCustomerUser = isBlockedCustomerUser(customer);

              return (
              <div
                key={customer.id}
                className="customer-user-row grid min-h-[64px] grid-cols-[minmax(120px,190px)_minmax(240px,1fr)_130px_150px_170px] items-center gap-3 px-4 py-3 text-sm"
              >
                <span className="truncate font-black text-[var(--foreground)]">{customer.code}</span>
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-[var(--foreground)]">{customer.name}</span>
                  {blockedCustomerUser ? (
                    <span className="mt-1 inline-flex rounded-full border border-slate-400/30 bg-slate-500/14 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
                      İşlem carisi - kullanıcı açılamaz
                    </span>
                  ) : null}
                </span>
                <span className="font-black text-emerald-200">{formatDiscount(customer.special_discount_rate)}</span>
                <span className="w-fit rounded-full border border-emerald-300/35 bg-emerald-400/12 px-2.5 py-1 text-xs font-black text-emerald-200">
                  {customer.user?.feature_permissions?.includes("search.campaigns") ?? true ? "Açık" : "Kapalı"}
                </span>
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    disabled={blockedCustomerUser}
                    title={blockedCustomerUser ? "Bu cari işlem/satış/depo carisi olduğu için müşteri kullanıcısı açılamaz." : undefined}
                    className="h-9 rounded-xl px-3 font-black disabled:cursor-not-allowed disabled:border-slate-400/25 disabled:bg-slate-600/22 disabled:text-[var(--muted-foreground)] disabled:shadow-none"
                    onClick={() => openModal(customer)}
                  >
                    {blockedCustomerUser ? <XCircle className="h-4 w-4" /> : customer.user ? <KeyRound className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />}
                    {blockedCustomerUser ? "İptal" : customer.user ? "Düzenle" : "Aç"}
                  </Button>
                </div>
              </div>
              );
            })
          )}
        </div>
      </section>

      <Dialog open={Boolean(selectedCustomer)} onOpenChange={(open) => !open && setSelectedCustomer(null)}>
        <DialogContent className="max-h-[92vh] max-w-[980px] overflow-y-auto rounded-[18px] border-[var(--brand-border)] bg-[var(--surface)] p-5">
          <DialogHeader>
            <DialogTitle className="text-xl font-black">Müşteri Girişi</DialogTitle>
            <DialogDescription>
              {selectedCustomer ? `${selectedCustomer.code} · ${selectedCustomer.name}` : ""}
            </DialogDescription>
          </DialogHeader>

          {selectedCustomer ? (
            <div className="space-y-5">
              <div className="grid gap-4 lg:grid-cols-[1fr_1fr_180px]">
                <div className="grid gap-2">
                <label className="text-sm font-black text-[var(--foreground)]" htmlFor="customer-username">
                  Kullanıcı Adı
                </label>
                <Input
                  id="customer-username"
                  value={selectedCustomer.username}
                  readOnly
                  className="admin-dashboard-input h-11 rounded-xl font-black"
                />
              </div>

                <div className="grid gap-2">
                <label className="text-sm font-black text-[var(--foreground)]" htmlFor="customer-password">
                  Şifre
                </label>
                <div className="flex gap-2">
                  <div className="relative min-w-0 flex-1">
                    <Input
                      id="customer-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      type={showPassword ? "text" : "password"}
                      placeholder={selectedCustomerHasUser ? "Boş kalırsa değişmez" : "En az 6 karakter"}
                      className="admin-dashboard-input h-11 rounded-xl pr-11 font-semibold"
                    />
                    <button
                      type="button"
                      className="absolute right-2 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-[var(--muted-foreground)] hover:bg-[var(--brand-accent-soft)]"
                      onClick={() => setShowPassword((value) => !value)}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <Button type="button" variant="outline" className="h-11 rounded-xl font-black" onClick={() => setPassword(randomPassword())}>
                    Üret
                  </Button>
                </div>
              </div>

                <div className="grid gap-2">
                  <label className="text-sm font-black text-[var(--foreground)]" htmlFor="customer-discount">
                    Müşteri İskontosu
                  </label>
                  <div className="relative">
                    <Input
                      id="customer-discount"
                      value={specialDiscountRate}
                      onChange={(event) => setSpecialDiscountRate(event.target.value)}
                      inputMode="decimal"
                      placeholder="0"
                      className="admin-dashboard-input h-11 rounded-xl pr-10 font-black"
                    />
                    <Percent className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
                  </div>
                </div>
              </div>

              {selectedCustomerHasUser ? (
                <div className="flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-sm font-bold text-emerald-200">
                  <CheckCircle2 className="h-4 w-4" />
                  Mevcut kullanıcı: {selectedCustomer?.user?.username}
                </div>
              ) : null}

              <div className="grid gap-3">
                <div>
                  <h3 className="text-sm font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Sayfalar</h3>
                  <p className="mt-1 text-xs font-semibold text-[var(--muted-foreground)]">
                    Seçili olan sayfalar müşteri panelinde görünür.
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {menuPermissionOptions.map((permission) => {
                    const checked = menuPermissions.includes(permission.key);

                    return (
                      <Button
                        key={permission.key}
                        type="button"
                        variant={checked ? "default" : "outline"}
                        className="h-11 justify-start rounded-xl px-3 text-left text-xs font-black"
                        onClick={() => toggleMenuPermission(permission)}
                      >
                        {checked ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                        <span className="truncate">{permission.label}</span>
                      </Button>
                    );
                  })}
                </div>
              </div>

              <div className="grid gap-3">
                <div>
                  <h3 className="text-sm font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Sayfa Özellikleri</h3>
                  <p className="mt-1 text-xs font-semibold text-[var(--muted-foreground)]">
                    Sayfa kapalıysa içindeki özellikler de kapanır.
                  </p>
                </div>
                <div className="grid gap-3 lg:grid-cols-2">
                  {featureGroups.map((group) => {
                    const menuEnabled = menuPermissions.includes(group.menu.key);

                    return (
                      <div key={group.menu.key} className="rounded-2xl border border-[var(--brand-border)] bg-[var(--surface-soft)] p-3">
                        <div className="mb-3 flex items-center justify-between gap-2">
                          <strong className="truncate text-sm font-black text-[var(--foreground)]">
                            {menuLabelByKey.get(group.menu.key) ?? group.menu.label}
                          </strong>
                          <span className="text-[11px] font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                            {menuEnabled ? "Açık" : "Kapalı"}
                          </span>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {group.features.map((feature) => {
                            const checked = menuEnabled && featurePermissions.includes(feature.key);

                            return (
                              <Button
                                key={feature.key}
                                type="button"
                                variant={checked ? "default" : "outline"}
                                disabled={!menuEnabled}
                                className="h-10 justify-start rounded-xl px-3 text-left text-xs font-black disabled:opacity-45"
                                onClick={() => setFeaturePermissions((current) => toggleValue(current, feature.key))}
                              >
                                {checked ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                                <span className="truncate">{feature.label}</span>
                              </Button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="grid gap-3">
                <div>
                  <h3 className="text-sm font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                    Marka Görünürlüğü ve İskontolar
                  </h3>
                  <p className="mt-1 text-xs font-semibold text-[var(--muted-foreground)]">
                    İşaretli markalar görünür; üç iskonto sırasıyla zincir halinde uygulanır.
                  </p>
                </div>
                <div className="overflow-hidden rounded-2xl border border-[var(--brand-border)]">
                  <div className="grid grid-cols-[minmax(160px,1fr)_repeat(3,90px)] gap-2 bg-[var(--surface-soft)] px-3 py-2 text-xs font-black">
                    <span>Marka</span><span>İskonto-1</span><span>İskonto-2</span><span>İskonto-3</span>
                  </div>
                  <div className="max-h-72 divide-y divide-[var(--brand-border)] overflow-y-auto">
                    {brandOptions.map((brand) => {
                      const visible = allowedBrandIds.includes(brand.id);
                      const discounts = brandDiscounts.find((row) => row.brand_id === brand.id) ?? {
                        brand_id: brand.id,
                        discount_1: 0,
                        discount_2: 0,
                        discount_3: 0,
                      };
                      const setDiscount = (key: "discount_1" | "discount_2" | "discount_3", value: string) => {
                        setBrandDiscounts((current) => [
                          ...current.filter((row) => row.brand_id !== brand.id),
                          { ...discounts, [key]: value },
                        ]);
                      };

                      return (
                        <div key={brand.id} className="grid grid-cols-[minmax(160px,1fr)_repeat(3,90px)] items-center gap-2 px-3 py-2">
                          <button
                            type="button"
                            className="flex items-center gap-2 text-left text-xs font-black"
                            onClick={() => setAllowedBrandIds((current) =>
                              visible ? current.filter((id) => id !== brand.id) : [...current, brand.id]
                            )}
                          >
                            {visible ? <CheckCircle2 className="h-4 w-4 text-emerald-300" /> : <XCircle className="h-4 w-4 text-rose-300" />}
                            <span className="truncate">{brand.name}</span>
                          </button>
                          {(["discount_1", "discount_2", "discount_3"] as const).map((key) => (
                            <Input
                              key={key}
                              inputMode="decimal"
                              value={String(discounts[key] ?? 0)}
                              disabled={!visible}
                              onChange={(event) => setDiscount(key, event.target.value)}
                              className="h-9 rounded-lg text-center text-xs font-black"
                            />
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" className="rounded-xl" onClick={() => setSelectedCustomer(null)}>
              Kapat
            </Button>
            <Button type="button" className="rounded-xl font-black" disabled={createMutation.isPending} onClick={submit}>
              {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              Kaydet
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
