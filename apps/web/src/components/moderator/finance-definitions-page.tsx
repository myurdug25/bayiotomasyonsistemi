"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bus, Loader2, PackageOpen, Plus, Save, Truck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createFinanceDefinition,
  listFinanceDefinitions,
  updateFinanceDefinition,
  type FinanceDefinitionDto,
} from "@/lib/api";

const TYPES: Array<{ value: FinanceDefinitionDto["type"]; label: string }> = [
  { value: "bank", label: "Bankalar" },
  { value: "pos_device", label: "POS Cihazları" },
  { value: "card_type", label: "Kart Tipleri" },
  { value: "factory", label: "Fabrikalar" },
  { value: "expense_category", label: "Gider Kategorileri" },
  { value: "shipping_rule", label: "Kargo / Otobüs" },
];

const emptyForm = (type: FinanceDefinitionDto["type"]) => ({
  type,
  code: "",
  name: "",
  logo_code: "",
  logo_name: "",
  sort_order: 0,
  is_active: true,
});

const SHIPPING_RULE_FIELDS = [
  {
    code: "cargo_limit",
    name: "Kargo Ücretsiz Limiti",
    description: "Sipariş toplamı bu tutara eşit veya üzerindeyse kargo ücreti eklenmez.",
    fallback: "5000",
    icon: PackageOpen,
  },
  {
    code: "cargo_fee",
    name: "Kargo Ücreti",
    description: "Sipariş toplamı kargo limitinin altındaysa eklenecek tutar.",
    fallback: "500",
    icon: Truck,
  },
  {
    code: "bus_fee",
    name: "Otobüs Ücreti",
    description: "Limit uygulanmadan her otobüs gönderimine eklenecek tutar.",
    fallback: "500",
    icon: Bus,
  },
] as const;

export function FinanceDefinitionsPage() {
  const queryClient = useQueryClient();
  const [type, setType] = useState<FinanceDefinitionDto["type"]>("bank");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm(type));
  const [shippingValues, setShippingValues] = useState<Record<string, string>>({
    cargo_limit: "5000",
    cargo_fee: "500",
    bus_fee: "500",
  });
  const query = useQuery({
    queryKey: ["finance-definitions", "admin"],
    queryFn: () => listFinanceDefinitions(undefined, true),
  });
  const rows = useMemo(
    () => (query.data?.data ?? []).filter((item) => item.type === type),
    [query.data?.data, type]
  );

  useEffect(() => {
    if (!query.data?.data) return;

    const shippingRows = query.data.data.filter((item) => item.type === "shipping_rule");
    setShippingValues(
      Object.fromEntries(
        SHIPPING_RULE_FIELDS.map((field) => {
          const row = shippingRows.find((item) => item.code.trim().toLocaleLowerCase("tr-TR") === field.code);
          return [field.code, row?.logo_code?.trim() || field.fallback];
        })
      )
    );
  }, [query.data?.data]);

  const mutation = useMutation({
    mutationFn: async () => {
      const payload = {
        type: form.type,
        code: form.code.trim(),
        name: form.name.trim(),
        logo_code: form.logo_code.trim() || null,
        logo_name: form.logo_name.trim() || null,
        meta: null,
        sort_order: Number(form.sort_order) || 0,
        is_active: form.is_active,
      };
      return editingId
        ? updateFinanceDefinition(editingId, payload)
        : createFinanceDefinition(payload);
    },
    onSuccess: async () => {
      toast.success("Finans tanımı kaydedildi.");
      setEditingId(null);
      setForm(emptyForm(type));
      await queryClient.invalidateQueries({ queryKey: ["finance-definitions"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Kayıt başarısız"),
  });

  const shippingRulesMutation = useMutation({
    mutationFn: async () => {
      const currentRows = (query.data?.data ?? []).filter((item) => item.type === "shipping_rule");

      return Promise.all(
        SHIPPING_RULE_FIELDS.map((field, index) => {
          const numericValue = Number(String(shippingValues[field.code] ?? "").replace(",", "."));
          if (!Number.isFinite(numericValue) || numericValue < 0) {
            throw new Error(`${field.name} için geçerli bir tutar girin.`);
          }

          const existing = currentRows.find(
            (item) => item.code.trim().toLocaleLowerCase("tr-TR") === field.code
          );
          const payload = {
            type: "shipping_rule" as const,
            code: field.code,
            name: field.name,
            logo_code: numericValue.toFixed(2),
            logo_name: field.description,
            meta: {
              amount: numericValue,
              rule_kind: field.code,
            },
            sort_order: (index + 1) * 10,
            is_active: true,
          };

          return existing
            ? updateFinanceDefinition(existing.id, payload)
            : createFinanceDefinition(payload);
        })
      );
    },
    onSuccess: async () => {
      toast.success("Kargo ve otobüs kuralları ayrı ayrı kaydedildi.");
      await queryClient.invalidateQueries({ queryKey: ["finance-definitions"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Ücret ayarları kaydedilemedi."),
  });

  const selectType = (nextType: FinanceDefinitionDto["type"]) => {
    setType(nextType);
    setEditingId(null);
    setForm(emptyForm(nextType));
  };

  const edit = (row: FinanceDefinitionDto) => {
    setEditingId(row.id);
    setForm({
      type: row.type,
      code: row.code,
      name: row.name,
      logo_code: row.logo_code ?? "",
      logo_name: row.logo_name ?? "",
      sort_order: row.sort_order,
      is_active: row.is_active,
    });
  };

  return (
    <div className="space-y-5">
      <div className="rounded-[22px] border border-[var(--brand-border)] bg-[var(--surface)] p-5">
        <h1 className="text-2xl font-black">Finans Tanımları</h1>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">
          Logo banka, fabrika cari, gider hesabı ve kargo/otobüs ücret tanımlarını yönetin.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {TYPES.map((item) => (
            <Button
              key={item.value}
              type="button"
              variant={type === item.value ? "default" : "outline"}
              onClick={() => selectType(item.value)}
            >
              {item.label}
            </Button>
          ))}
        </div>
      </div>

      {type === "shipping_rule" ? (
        <div className="rounded-[22px] border border-[var(--brand-border)] bg-[var(--surface)] p-5">
          <div className="mb-5">
            <h2 className="text-xl font-black">Kargo ve Otobüs Ücretleri</h2>
            <p className="mt-1 text-sm text-[var(--muted-foreground)]">
              Otobüs ücreti limitsiz uygulanır. Kargo ücreti yalnızca sipariş toplamı kargo limitinin altındaysa eklenir.
            </p>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            {SHIPPING_RULE_FIELDS.map((field) => {
              const Icon = field.icon;
              return (
                <label
                  key={field.code}
                  className="rounded-[18px] border border-amber-300/25 bg-[linear-gradient(145deg,rgba(251,191,36,0.12),rgba(6,30,24,0.76))] p-4"
                >
                  <span className="flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-300/15 text-amber-200">
                      <Icon className="h-5 w-5" />
                    </span>
                    <span>
                      <strong className="block text-sm">{field.name}</strong>
                      <small className="text-[10px] uppercase tracking-wider text-amber-100/55">{field.code}</small>
                    </span>
                  </span>
                  <Input
                    className="mt-4 text-lg font-black"
                    type="number"
                    min={0}
                    step="0.01"
                    value={shippingValues[field.code] ?? ""}
                    onChange={(event) =>
                      setShippingValues((current) => ({ ...current, [field.code]: event.target.value }))
                    }
                  />
                  <span className="mt-3 block text-xs leading-relaxed text-[var(--muted-foreground)]">
                    {field.description}
                  </span>
                </label>
              );
            })}
          </div>
          <Button
            type="button"
            className="mt-5 w-full"
            disabled={shippingRulesMutation.isPending}
            onClick={() => shippingRulesMutation.mutate()}
          >
            {shippingRulesMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Ücret Kurallarını Kaydet
          </Button>
        </div>
      ) : (
      <div className="grid gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
        <form
          className="space-y-3 rounded-[22px] border border-[var(--brand-border)] bg-[var(--surface)] p-5"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <h2 className="font-black">{editingId ? "Tanımı Düzenle" : "Yeni Tanım"}</h2>
          <Input placeholder="B2B kodu" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required />
          <Input placeholder="Görünen ad" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <Input placeholder="Logo kodu" value={form.logo_code} onChange={(e) => setForm({ ...form, logo_code: e.target.value })} />
          <Input placeholder="Logo adı" value={form.logo_name} onChange={(e) => setForm({ ...form, logo_name: e.target.value })} />
          <Input type="number" min={0} placeholder="Sıra" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })} />
          <label className="flex items-center gap-2 text-sm font-bold">
            <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
            Aktif
          </label>
          <Button className="w-full" disabled={mutation.isPending}>
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : editingId ? <Save className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            Kaydet
          </Button>
        </form>

        <div className="overflow-hidden rounded-[22px] border border-[var(--brand-border)] bg-[var(--surface)]">
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              className="grid w-full gap-2 border-b border-[var(--brand-border)] px-5 py-4 text-left hover:bg-[var(--surface-soft)] md:grid-cols-[1fr_1fr_120px]"
              onClick={() => edit(row)}
            >
              <span><strong>{row.name}</strong><small className="block text-[var(--muted-foreground)]">{row.code}</small></span>
              <span className="text-sm">{row.logo_code || "Logo kodu yok"}<small className="block text-[var(--muted-foreground)]">{row.logo_name}</small></span>
              <span className={row.is_active ? "text-emerald-500" : "text-red-400"}>{row.is_active ? "Aktif" : "Pasif"}</span>
            </button>
          ))}
          {!query.isLoading && rows.length === 0 ? <p className="p-5 text-sm">Kayıt yok.</p> : null}
        </div>
      </div>
      )}
    </div>
  );
}
