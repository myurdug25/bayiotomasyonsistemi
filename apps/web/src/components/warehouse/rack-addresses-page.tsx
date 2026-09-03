"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, CheckCircle2, Loader2, PackageSearch, Save, Search, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import { useSession } from "@/components/auth/session-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  listWarehouseShelves,
  updateWarehouseShelf,
  type WarehouseShelfProduct,
} from "@/lib/api";
import { cn } from "@/lib/utils";

function formatDateTime(value?: string | null) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function normalizeIdentity(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLocaleUpperCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "");
}

function resolveUserWarehouseCode(user: unknown): string {
  const record = (user ?? {}) as Record<string, unknown>;
  const identity = normalizeIdentity([
    record.username,
    record.email,
    record.name,
    record.branch_code,
    record.branch_name,
    record.region_code,
    record.region_name,
    record.logo_cashbox_code,
    record.logo_cashbox_name,
  ].filter(Boolean).join(" "));

  const cashbox = String(record.logo_cashbox_code ?? "").replace(/\D/g, "");

  if (identity.includes("TRABZON") || cashbox.startsWith("10002")) return "2";
  if (identity.includes("SAMSUN") || cashbox.startsWith("10003")) return "3";
  if (identity.includes("BATUM") || cashbox.startsWith("10004")) return "4";
  if (identity.includes("ERZURUM") || identity.includes("ERZDEPO") || cashbox.startsWith("10001")) return "1";

  return "";
}

export function RackAddressesPage() {
  const queryClient = useQueryClient();
  const { user } = useSession();
  const roleSlugs = useMemo(() => user?.roles.map((role) => role.slug) ?? [], [user?.roles]);
  const isAdminUser = roleSlugs.includes("admin") || roleSlugs.includes("dealer_admin");
  const forcedWarehouseCode = useMemo(() => (isAdminUser ? "" : resolveUserWarehouseCode(user)), [isAdminUser, user]);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [warehouseCode, setWarehouseCode] = useState("");
  const [includeEquivalents, setIncludeEquivalents] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  // Admin depo seçebilir; normal kullanıcıda request her zaman kendi şube deposuna kilitlenir.
  const requestedWarehouseCode = isAdminUser ? warehouseCode.trim() : forcedWarehouseCode;

  const shelvesQuery = useQuery({
    queryKey: ["warehouse-rack-addresses", user?.id ?? null, deferredQuery.trim(), requestedWarehouseCode, includeEquivalents],
    queryFn: () =>
      listWarehouseShelves({
        q: deferredQuery.trim() || undefined,
        warehouse_code: requestedWarehouseCode || undefined,
        include_equivalents: includeEquivalents ? true : undefined,
        limit: 80,
      }),
    staleTime: 20_000,
  });

  const warehouse = shelvesQuery.data?.warehouse;
  const warehouseOptions = shelvesQuery.data?.warehouses ?? (warehouse ? [warehouse] : []);
  const canChooseWarehouse = Boolean(isAdminUser && shelvesQuery.data?.can_choose_warehouse && warehouseOptions.length > 1);
  const displayWarehouse = warehouse;
  const products = useMemo(() => shelvesQuery.data?.data ?? [], [shelvesQuery.data?.data]);
  const editable = Boolean(displayWarehouse?.editable);

  const changedProducts = useMemo(
    () =>
      products.filter((product) => {
        const draft = drafts[product.id];
        return draft !== undefined && draft.trim() !== (product.shelf_address ?? "").trim();
      }),
    [drafts, products]
  );

  const updateMutation = useMutation({
    mutationFn: ({ product, shelfAddress }: { product: WarehouseShelfProduct; shelfAddress: string }) =>
      updateWarehouseShelf(product.id, {
        warehouse_code: product.warehouse_code,
        shelf_address: shelfAddress.trim() || null,
      }),
    onSuccess: async () => {
      toast.success("Raf adresi kaydedildi ve Logo kuyruğuna alındı.");
      await queryClient.invalidateQueries({ queryKey: ["warehouse-rack-addresses"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Raf adresi kaydedilemedi.");
    },
  });

  const bulkUpdateMutation = useMutation({
    mutationFn: async () => {
      const changed = changedProducts;
      for (const product of changed) {
        await updateWarehouseShelf(product.id, {
          warehouse_code: product.warehouse_code,
          shelf_address: (drafts[product.id] ?? "").trim() || null,
        });
      }

      return changed.length;
    },
    onSuccess: async (count) => {
      toast.success(`${count} raf adresi kaydedildi ve Logo kuyruğuna alındı.`);
      setDrafts({});
      await queryClient.invalidateQueries({ queryKey: ["warehouse-rack-addresses"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Toplu raf güncellemesi tamamlanamadı.");
    },
  });

  const isSaving = updateMutation.isPending || bulkUpdateMutation.isPending;
  const queryError = shelvesQuery.error instanceof Error ? shelvesQuery.error.message : null;

  return (
    <div className="rack-addresses-page mx-auto flex w-full max-w-[1680px] flex-col gap-4 text-[var(--foreground)]">
      <section className="rack-address-hero dashboard-panel-card overflow-hidden rounded-[24px] border-amber-300/20 p-0 shadow-[0_24px_70px_-48px_rgba(245,158,11,0.75)]">
        <div className="rack-hero-heading flex flex-col gap-4 border-b border-amber-300/15 bg-[radial-gradient(circle_at_8%_0%,rgba(245,158,11,0.2),transparent_34%),linear-gradient(135deg,rgba(16,47,35,0.96),rgba(19,29,24,0.96))] p-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <div className="rack-hero-icon flex h-14 w-14 items-center justify-center rounded-2xl border border-amber-200/35 bg-amber-300/15 text-amber-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.22)]">
              <Archive className="h-7 w-7" />
            </div>
            <div>
              <p className="text-xs font-black uppercase tracking-[0.22em] text-amber-100/75">Logo Raf Senkronu</p>
              <h1 className="mt-1 text-3xl font-black tracking-tight text-white">Raf Adresi Güncelle</h1>
              <p className="mt-1 text-sm font-semibold text-emerald-100/70">
                OEM, rakip kod, ürün kodu, ürün adı ve raf adresiyle arayın; değişiklikler Logo kuyruğuna alınır.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge className="rack-branch-badge rounded-full border-amber-200/40 bg-amber-300/15 px-4 py-2 text-sm font-black text-amber-100">
              {displayWarehouse?.name ?? "Depo"} · {products.length} kayıt
            </Badge>
            {editable ? (
              <Badge className="rack-permission-badge rounded-full border-emerald-200/35 bg-emerald-400/15 px-4 py-2 text-sm font-black text-emerald-100">
                Güncelleme Yetkili
              </Badge>
            ) : (
              <Badge className="rack-permission-badge rounded-full border-red-200/35 bg-red-500/15 px-4 py-2 text-sm font-black text-red-100">
                Sadece Görüntüleme
              </Badge>
            )}
          </div>
        </div>

        <div className="rack-toolbar grid gap-3 p-4 lg:grid-cols-[minmax(280px,1fr)_220px_auto_auto] lg:items-center">
          <div className="relative">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-emerald-100/55" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Ürün kodu, ürün adı, OEM, rakip kod veya raf ara..."
              className="rack-search-input h-[52px] rounded-2xl border-emerald-300/20 bg-black/25 pl-12 text-base font-bold text-white placeholder:text-emerald-100/45"
            />
          </div>

          {canChooseWarehouse ? (
            <select
              value={requestedWarehouseCode || warehouse?.code || ""}
              onChange={(event) => {
                setWarehouseCode(event.target.value);
                setDrafts({});
              }}
              className="rack-warehouse-select h-[52px] rounded-2xl border border-emerald-300/20 bg-[#061a13] px-4 text-sm font-black text-emerald-50 outline-none"
            >
              {warehouseOptions.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.name}
                </option>
              ))}
            </select>
          ) : (
            <div className="rack-warehouse-select flex h-[52px] items-center rounded-2xl border border-emerald-300/20 bg-[#061a13] px-4 text-sm font-black text-emerald-50">
              {displayWarehouse?.name ?? warehouseOptions[0]?.name ?? "DEPO"}
            </div>
          )}

          <Button
            type="button"
            variant="outline"
            className={cn(
              "rack-equivalent-toggle h-[52px] rounded-2xl border-amber-200/35 px-4 font-black",
              includeEquivalents
                ? "bg-amber-300/20 text-amber-100"
                : "bg-black/20 text-emerald-100"
            )}
            onClick={() => setIncludeEquivalents((current) => !current)}
          >
            {includeEquivalents ? "E + H Ürünler" : "Sadece E Ürünler"}
          </Button>

          <Button
            type="button"
            disabled={!editable || changedProducts.length === 0 || isSaving}
            onClick={() => bulkUpdateMutation.mutate()}
            className="rack-save-all-button h-[52px] rounded-2xl border border-[#aa0b21] bg-red-600 from-red-500 bg-[linear-gradient(135deg,#ff5156,#c60e28_58%,#990f20)] px-5 font-black text-white shadow-[0_18px_38px_-24px_rgba(198,14,40,0.78)] hover:brightness-110 disabled:!border-[#d29ca5] disabled:!bg-[#e7b9c0] disabled:!text-[#762f3a] disabled:opacity-100"
          >
            {bulkUpdateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Değişenleri Kaydet
          </Button>
        </div>
      </section>

      {queryError ? (
        <section className="dashboard-panel-card flex items-center gap-3 rounded-2xl border-red-400/30 bg-red-950/30 p-4 text-red-100">
          <ShieldAlert className="h-5 w-5" />
          <p className="font-bold">{queryError}</p>
        </section>
      ) : null}

      <section className="rack-address-table dashboard-panel-card overflow-hidden rounded-[22px]">
        <div className="rack-address-table-header hidden grid-cols-[0.85fr_1.55fr_0.72fr_1.08fr_0.78fr_0.82fr_0.82fr_1.24fr_56px] gap-3 border-b border-emerald-300/15 bg-[linear-gradient(90deg,rgba(22,163,74,0.68),rgba(16,185,129,0.26))] px-4 py-3 text-xs font-black uppercase tracking-[0.1em] text-emerald-50 xl:grid">
          <div>Ürün Kodu</div>
          <div>Ürün Adı</div>
          <div>OEM</div>
          <div>Rakip Kod</div>
          <div>Raf Adresi</div>
          <div>Son Güncelleme</div>
          <div>Güncelleyen</div>
          <div>Yeni Raf</div>
          <div className="text-right">İşlem</div>
        </div>

        <div className="rack-address-table-body divide-y divide-emerald-300/10">
          {shelvesQuery.isLoading ? (
            <div className="rack-empty-state flex h-56 flex-col items-center justify-center text-center text-sm font-bold text-emerald-100/70">
              <Loader2 className="mb-3 h-6 w-6 animate-spin" />
              Raf kayıtları yükleniyor...
            </div>
          ) : products.length === 0 ? (
            <div className="rack-empty-state flex h-56 flex-col items-center justify-center text-center text-sm font-bold text-emerald-100/70">
              <PackageSearch className="mb-3 h-8 w-8 text-emerald-100/45" />
              Kayıt bulunamadı.
            </div>
          ) : (
            products.map((product) => {
              const draftValue = drafts[product.id] ?? product.shelf_address ?? "";
              const changed = draftValue.trim() !== (product.shelf_address ?? "").trim();

              return (
                <div
                  key={product.id}
                  data-changed={changed}
                  className="rack-address-row grid grid-cols-1 gap-3 px-4 py-3 hover:bg-emerald-400/5 xl:grid-cols-[0.85fr_1.55fr_0.72fr_1.08fr_0.78fr_0.82fr_0.82fr_1.24fr_56px] xl:items-center"
                >
                  <div className="min-w-0">
                    <div className="text-[10px] font-black uppercase tracking-[0.12em] text-emerald-100/45 xl:hidden">Ürün Kodu</div>
                    <div className="rack-product-code truncate font-black text-white" title={product.product_code}>
                      {product.product_code}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="text-[10px] font-black uppercase tracking-[0.12em] text-emerald-100/45 xl:hidden">Ürün Adı</div>
                    <div className="rack-product-name truncate font-black text-white" title={product.product_name}>
                      {product.product_name}
                    </div>
                    <div className="rack-product-brand truncate text-xs font-bold uppercase tracking-wide text-emerald-100/55">{product.brand ?? "-"}</div>
                  </div>
                  <div className="rack-text-cell min-w-0 font-bold text-emerald-100/80">
                    <div className="text-[10px] font-black uppercase tracking-[0.12em] text-emerald-100/45 xl:hidden">OEM</div>
                    <span className="block truncate" title={product.oem ?? "-"}>
                      {product.oem ?? "-"}
                    </span>
                  </div>
                  <div className="rack-text-cell min-w-0 font-bold text-emerald-100/75">
                    <div className="text-[10px] font-black uppercase tracking-[0.12em] text-emerald-100/45 xl:hidden">Rakip Kod</div>
                    <span className="block truncate" title={product.competitor_codes.join(", ")}>
                      {product.competitor_codes.length > 0 ? product.competitor_codes.join(", ") : "-"}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <div className="text-[10px] font-black uppercase tracking-[0.12em] text-emerald-100/45 xl:hidden">Raf Adresi</div>
                    {product.shelf_address ? (
                      <Badge className="rack-current-address max-w-full rounded-full border-cyan-200/30 bg-cyan-400/12 text-cyan-100">
                        <span className="truncate">{product.shelf_address}</span>
                      </Badge>
                    ) : (
                      <span className="font-bold text-emerald-100/35">-</span>
                    )}
                  </div>
                  <div className="rack-text-cell min-w-0 text-xs font-bold text-emerald-100/65">
                    <div className="text-[10px] font-black uppercase tracking-[0.12em] text-emerald-100/45 xl:hidden">Son Güncelleme</div>
                    <span className="block truncate">{formatDateTime(product.shelf_updated_at)}</span>
                  </div>
                  <div className="rack-text-cell min-w-0 text-xs font-bold text-emerald-100/65">
                    <div className="text-[10px] font-black uppercase tracking-[0.12em] text-emerald-100/45 xl:hidden">Güncelleyen</div>
                    <span className="block truncate" title={product.shelf_updated_by ?? "-"}>
                      {product.shelf_updated_by ?? "-"}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <div className="text-[10px] font-black uppercase tracking-[0.12em] text-emerald-100/45 xl:hidden">Yeni Raf</div>
                    <Input
                      value={draftValue}
                      disabled={!editable || isSaving}
                      onChange={(event) => setDrafts((current) => ({ ...current, [product.id]: event.target.value }))}
                      placeholder="A26.6,A79.1"
                      className={cn(
                        "rack-new-input h-11 w-full min-w-0 rounded-xl border-emerald-300/20 bg-black/25 px-4 font-black text-white",
                        changed && "border-amber-200/70 bg-amber-300/10"
                      )}
                    />
                  </div>
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      size="icon"
                      disabled={!editable || !changed || isSaving}
                      onClick={() => updateMutation.mutate({ product, shelfAddress: draftValue })}
                      aria-label="Bu satırdaki raf adresini kaydet"
                      title="Bu satırdaki raf adresini kaydet"
                      className="rack-row-save-button h-11 w-11 shrink-0 rounded-xl border border-[#8e5e02] bg-[linear-gradient(135deg,#d39b16,#a56f05)] text-white shadow-[0_8px_18px_-14px_rgba(165,111,5,0.72)] hover:brightness-110 disabled:!border-[#c6d4cc] disabled:!bg-[#e7eeea] disabled:!text-[#5f7469] disabled:opacity-100"
                    >
                      {updateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
