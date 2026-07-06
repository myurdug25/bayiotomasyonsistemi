"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  Users,
  UserPlus,
} from "lucide-react";
import { toast } from "sonner";

import { useSession } from "@/components/auth/session-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  createCustomerCardRequest,
  listCustomerCardSalespeople,
} from "@/lib/api";

type CustomerKind = "person" | "company";
type FormState = {
  company_name: string;
  contact_name: string;
  phone: string;
  email: string;
  salesperson_user_id: string;
  customer_kind: CustomerKind;
  logo_authorization_code: string;
  city: string;
  district: string;
  tax_office: string;
  tax_number: string;
  address: string;
  note: string;
};

const SHELL_CARD_CLASSNAME =
  "overflow-hidden bg-[linear-gradient(180deg,var(--surface)_0%,var(--surface-soft)_100%)] shadow-[0_18px_34px_-28px_rgba(33,52,22,0.28)]";
const SOFT_PANEL_CLASSNAME =
  "rounded-2xl bg-[linear-gradient(180deg,var(--surface)_0%,var(--surface-soft)_100%)] shadow-[0_12px_24px_-22px_rgba(0,0,0,0.14)]";
const FIELD_CLASSNAME =
  "border-[var(--brand-border)] bg-[var(--surface)] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)]";

function createInitialForm(user?: { name?: string | null; email?: string | null; phone?: string | null } | null): FormState {
  return {
    company_name: "",
    contact_name: user?.name ?? "",
    phone: user?.phone ?? "",
    email: user?.email ?? "",
    salesperson_user_id: "",
    customer_kind: "company",
    logo_authorization_code: "",
    city: "",
    district: "",
    tax_office: "",
    tax_number: "",
    address: "",
    note: "",
  };
}

const CUSTOMER_KIND_OPTIONS: Array<{ value: CustomerKind; label: string }> = [
  { value: "company", label: "Tüzel" },
  { value: "person", label: "Şahıs" },
];

const LOGO_AUTHORIZATION_CODE_OPTIONS = ["A", "D", "K"];

function logoECollectionPreview(): string {
  return `e ( yeni cari - ${new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date())} )`;
}

export function NewCustomerCardPage() {
  const queryClient = useQueryClient();
  const { user, selectCustomer } = useSession();
  const roleSlugs = user?.roles.map((role) => role.slug) ?? [];
  const isSalesperson = roleSlugs.includes("salesperson");
  const [form, setForm] = useState<FormState>(() => createInitialForm(user));

  const salespeopleQuery = useQuery({
    queryKey: ["customer-card-salespeople"],
    queryFn: () => listCustomerCardSalespeople(),
    enabled: Boolean(user),
    staleTime: 5 * 60_000,
  });

  const createMutation = useMutation({
    mutationFn: createCustomerCardRequest,
    onSuccess: async (response) => {
      const customerCode = response.customer?.code;
      const logoQueued = response.customer?.logo_queue_status === "queued";

      setForm(createInitialForm(user));
      await queryClient.invalidateQueries({ queryKey: ["customers"] });

      if (response.customer?.id) {
        try {
          await selectCustomer(response.customer.id);
          toast.success(
            customerCode
              ? logoQueued
                ? `Cari oluşturuldu, seçildi ve Logo kuyruğuna alındı: ${customerCode}`
                : `Cari oluşturuldu ve seçildi: ${customerCode}`
              : "Yeni cari oluşturuldu ve seçildi."
          );

          return;
        } catch {
          toast.warning(
            customerCode
              ? `Cari oluşturuldu ama otomatik seçilemedi: ${customerCode}`
              : "Yeni cari oluşturuldu ama otomatik seçilemedi."
          );

          return;
        }
      }

      toast.success(
        customerCode
          ? logoQueued
            ? `Cari oluşturuldu ve Logo kuyruğuna alındı: ${customerCode}`
            : `Cari oluşturuldu: ${customerCode}`
          : "Yeni cari kart kaydedildi."
      );
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Başvuru kaydedilemedi.");
    },
  });

  const salespersonOptions = useMemo(() => salespeopleQuery.data?.data ?? [], [salespeopleQuery.data?.data]);
  const isCompanyCustomer = form.customer_kind === "company";
  const eCollectionPreview = useMemo(() => logoECollectionPreview(), []);
  const ownSalesperson = useMemo(
    () => salespersonOptions.find((salesperson) => salesperson.id === user?.id) ?? salespersonOptions[0] ?? null,
    [salespersonOptions, user?.id]
  );
  const selectedSalespersonId = isSalesperson
    ? String(ownSalesperson?.id ?? user?.id ?? "")
    : form.salesperson_user_id;

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function handleSubmit() {
    if (!form.company_name.trim() || !form.phone.trim() || !form.city.trim() || !form.address.trim()) {
      toast.error("Cari ismi, telefon, il ve adres alanları zorunlu.");
      return;
    }

    if (isCompanyCustomer && (!form.tax_office.trim() || !form.tax_number.trim())) {
      toast.error("Tüzel cari için vergi dairesi ve vergi no zorunlu.");
      return;
    }

    if (!selectedSalespersonId.trim()) {
      toast.error("Plasiyer seçimi zorunlu.");
      return;
    }

    createMutation.mutate({
      salesperson_user_id: Number(selectedSalespersonId),
      company_name: form.company_name.trim(),
      contact_name: form.contact_name.trim() || form.company_name.trim(),
      phone: form.phone.trim(),
      email: form.email.trim() || undefined,
      customer_kind: form.customer_kind,
      logo_authorization_code: form.logo_authorization_code.trim() || undefined,
      auto_convert: true,
      city: form.city.trim(),
      district: form.district.trim() || undefined,
      tax_office: form.tax_office.trim() || undefined,
      tax_number: form.tax_number.trim() || undefined,
      address: form.address.trim() || undefined,
      note: form.note.trim() || undefined,
    });
  }

  return (
    <div className="space-y-4">
      <Card className={SHELL_CARD_CLASSNAME}>
        <CardContent className="p-4 sm:p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-[var(--brand-border)] bg-[var(--surface-soft)] text-[var(--brand-primary)]">
              <UserPlus className="h-6 w-6" />
            </div>
            <h2 className="text-2xl font-extrabold tracking-tight text-[var(--brand-primary-strong)]">Yeni Cari Oluştur</h2>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div className="space-y-2">
              <label className="text-sm font-bold text-[var(--brand-primary-strong)]">Cari İsmi</label>
              <Input
                className={FIELD_CLASSNAME}
                value={form.company_name}
                onChange={(event) => updateField("company_name", event.target.value)}
                placeholder="Cari adı"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-bold text-[var(--brand-primary-strong)]">Şahıs / Tüzel</label>
              <Select value={form.customer_kind} onValueChange={(value) => updateField("customer_kind", value as CustomerKind)}>
                <SelectTrigger className={FIELD_CLASSNAME}>
                  <SelectValue placeholder="Cari tipi seç" />
                </SelectTrigger>
                <SelectContent>
                  {CUSTOMER_KIND_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-bold text-[var(--brand-primary-strong)]">Telefon</label>
              <Input
                className={FIELD_CLASSNAME}
                value={form.phone}
                onChange={(event) => updateField("phone", event.target.value)}
                placeholder="05xx xxx xx xx"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-bold text-[var(--brand-primary-strong)]">Mail</label>
              <Input
                className={FIELD_CLASSNAME}
                value={form.email}
                onChange={(event) => updateField("email", event.target.value)}
                placeholder="mail zorunlu değil"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-bold text-[var(--brand-primary-strong)]">İl</label>
              <Input
                className={FIELD_CLASSNAME}
                value={form.city}
                onChange={(event) => updateField("city", event.target.value)}
                placeholder="İl"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-bold text-[var(--brand-primary-strong)]">İlçe</label>
              <Input
                className={FIELD_CLASSNAME}
                value={form.district}
                onChange={(event) => updateField("district", event.target.value)}
                placeholder="İlçe"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-bold text-[var(--brand-primary-strong)]">Plasiyer</label>
              <Select
                value={selectedSalespersonId}
                onValueChange={(value) => updateField("salesperson_user_id", value)}
                disabled={isSalesperson || salespeopleQuery.isLoading}
              >
                <SelectTrigger className={FIELD_CLASSNAME}>
                  <SelectValue placeholder={salespeopleQuery.isLoading ? "Plasiyerler yükleniyor" : "Plasiyer seç"} />
                </SelectTrigger>
                <SelectContent>
                  {salespersonOptions.map((salesperson) => (
                    <SelectItem key={salesperson.id} value={String(salesperson.id)}>
                      {salesperson.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-bold text-[var(--brand-primary-strong)]">Özel Kodu</label>
              <Input className={FIELD_CLASSNAME + " font-bold"} value="F1" readOnly />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-bold text-[var(--brand-primary-strong)]">Yetki Kodu</label>
              <Select value={form.logo_authorization_code || "none"} onValueChange={(value) => updateField("logo_authorization_code", value === "none" ? "" : value)}>
                <SelectTrigger className={FIELD_CLASSNAME}>
                  <SelectValue placeholder="Yetki kodu seç" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Boş</SelectItem>
                  {LOGO_AUTHORIZATION_CODE_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {isCompanyCustomer ? (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-bold text-[var(--brand-primary-strong)]">Vergi Dairesi</label>
                  <Input
                    className={FIELD_CLASSNAME}
                    value={form.tax_office}
                    onChange={(event) => updateField("tax_office", event.target.value)}
                    placeholder="Vergi dairesi"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-bold text-[var(--brand-primary-strong)]">Vergi No</label>
                  <Input
                    className={FIELD_CLASSNAME}
                    value={form.tax_number}
                    onChange={(event) => updateField("tax_number", event.target.value)}
                    placeholder="10 haneli vergi no"
                  />
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <label className="text-sm font-bold text-[var(--brand-primary-strong)]">T.C. Kimlik No</label>
                <Input
                  className={FIELD_CLASSNAME}
                  value={form.tax_number}
                  onChange={(event) => updateField("tax_number", event.target.value)}
                  placeholder="11 haneli T.C. kimlik no"
                />
              </div>
            )}
            <div className="space-y-2 md:col-span-2 xl:col-span-3">
              <label className="text-sm font-bold text-[var(--brand-primary-strong)]">Adres</label>
              <Textarea
                className={FIELD_CLASSNAME + " min-h-[96px]"}
                value={form.address}
                onChange={(event) => updateField("address", event.target.value)}
                placeholder="Açık adres"
              />
            </div>
            <div className={SOFT_PANEL_CLASSNAME + " grid gap-3 p-4 md:col-span-2 md:grid-cols-2 xl:col-span-3"}>
              <p className="flex items-center gap-2 text-sm font-bold text-[var(--brand-primary-strong)]">
                <Users className="h-4 w-4" />
                Logo E-Tahsilat
              </p>
              <div className="rounded-xl bg-[var(--surface)] px-3 py-2 text-sm font-black text-[var(--brand-primary-strong)] shadow-[0_10px_18px_-20px_rgba(0,0,0,0.12)]">
                {eCollectionPreview}
              </div>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              className="border-[var(--brand-border)] bg-[var(--surface)]"
              onClick={() => setForm(createInitialForm(user))}
              disabled={createMutation.isPending}
            >
              Temizle
            </Button>
            <Button
              className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#d8df72_100%)] px-6 text-[var(--primary-foreground)] hover:opacity-95"
              onClick={handleSubmit}
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
              Cari Oluştur
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
