"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  CheckCircle2,
  Loader2,
  MapPin,
  PhoneCall,
  ShieldCheck,
  Sparkles,
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
import { districtsForProvince, TURKEY_PROVINCES } from "@/lib/turkey-locations";

type CustomerKind = "person" | "company";
type FormState = {
  company_name: string;
  contact_name: string;
  phone: string;
  email: string;
  salesperson_user_id: string;
  customer_kind: CustomerKind;
  logo_special_code: string;
  logo_authorization_code: string;
  city: string;
  district: string;
  tax_office: string;
  tax_number: string;
  address: string;
  note: string;
};

const SHELL_CARD_CLASSNAME =
  "new-customer-shell overflow-hidden rounded-[28px] border border-emerald-300/20 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.18),transparent_36%),linear-gradient(145deg,rgba(7,22,16,0.96)_0%,rgba(10,31,22,0.94)_48%,rgba(20,22,12,0.92)_100%)] shadow-[0_28px_70px_-52px_rgba(16,185,129,0.75)]";
const SOFT_PANEL_CLASSNAME =
  "new-customer-section rounded-[22px] border border-white/10 bg-white/[0.035] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_18px_38px_-34px_rgba(0,0,0,0.72)] backdrop-blur";
const FIELD_CLASSNAME =
  "new-customer-field h-11 rounded-[14px] border-emerald-300/20 bg-[#07170f]/70 text-[var(--foreground)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] placeholder:text-[var(--muted-foreground)] focus-visible:ring-2 focus-visible:ring-emerald-300/20";
const SELECT_FIELD_CLASSNAME = `${FIELD_CLASSNAME} new-customer-select`;
const SECTION_TITLE_CLASSNAME = "new-customer-section-title text-[11px] font-black uppercase tracking-[0.18em] text-emerald-200/85";
const FIELD_LABEL_CLASSNAME = "new-customer-label text-xs font-black uppercase tracking-[0.12em] text-emerald-100/75";
const SELECT_CONTENT_CLASSNAME = "new-customer-select-content";

function createInitialForm(user?: { name?: string | null; email?: string | null; phone?: string | null } | null): FormState {
  return {
    company_name: "",
    contact_name: user?.name ?? "",
    phone: "",
    email: user?.email ?? "",
    salesperson_user_id: "",
    customer_kind: "company",
    logo_special_code: "F1",
    logo_authorization_code: "",
    city: "",
    district: "",
    tax_office: "",
    tax_number: "",
    address: "",
    note: "",
  };
}

function digitsOnly(value: string, maxLength: number) {
  return value.replace(/\D/g, "").slice(0, maxLength);
}

function isValidPhone(value: string) {
  return /^05\d{9}$/.test(digitsOnly(value, 11));
}

function isValidTc(value: string) {
  return /^\d{11}$/.test(digitsOnly(value, 11));
}

const CUSTOMER_KIND_OPTIONS: Array<{ value: CustomerKind; label: string }> = [
  { value: "company", label: "Tüzel" },
  { value: "person", label: "Şahıs" },
];

const LOGO_AUTHORIZATION_CODE_OPTIONS = ["A", "D", "K"];
const LOGO_SPECIAL_CODE_OPTIONS = ["F1", "F2", "F3"];

function logoECollectionPreview(): string {
  return `e ( yeni cari - ${new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date())} )`;
}

export function NewCustomerCardPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, selectCustomer } = useSession();
  const roleSlugs = user?.roles.map((role) => role.slug) ?? [];
  const canChooseSalesperson = roleSlugs.includes("admin") || roleSlugs.includes("dealer_admin");
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
          router.push("/search");

          return;
        } catch {
          toast.warning(
            customerCode
              ? `Cari oluşturuldu ama otomatik seçilemedi: ${customerCode}`
              : "Yeni cari oluşturuldu ama otomatik seçilemedi."
          );
          router.push("/search");

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
      router.push("/search");
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
  const selectedSalespersonId = !canChooseSalesperson
    ? String(ownSalesperson?.id ?? user?.id ?? "")
    : form.salesperson_user_id;
  const districtOptions = useMemo(() => districtsForProvince(form.city), [form.city]);

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => (key === "city" ? { ...current, city: String(value), district: "" } : { ...current, [key]: value }));
  }

  function handleSubmit() {
    if (!form.company_name.trim() || !form.phone.trim() || !form.city.trim() || !form.district.trim() || !form.address.trim()) {
      toast.error("Cari ismi, telefon, il, ilçe ve adres alanları zorunlu.");
      return;
    }

    if (!isValidPhone(form.phone)) {
      toast.error("❌ Telefon numarası hatalı");
      return;
    }

    if (isCompanyCustomer && (!form.tax_office.trim() || !form.tax_number.trim())) {
      toast.error("Tüzel cari için vergi dairesi ve vergi no zorunlu.");
      return;
    }

    if (!isCompanyCustomer && !isValidTc(form.tax_number)) {
      toast.error("❌ TC Kimlik numarası hatalı");
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
      logo_special_code: form.logo_special_code,
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
    <div className="new-customer-card-page space-y-4">
      <Card className={SHELL_CARD_CLASSNAME}>
        <CardContent className="p-0">
          <div className="new-customer-hero relative overflow-hidden border-b border-emerald-300/15 px-4 py-4 sm:px-6">
            <div className="absolute right-0 top-0 h-28 w-64 rounded-full bg-emerald-300/10 blur-3xl" />
            <div className="relative flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <div className="new-customer-hero-icon flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[18px] border border-emerald-200/25 bg-[linear-gradient(135deg,rgba(52,211,153,0.24),rgba(20,83,45,0.28))] text-emerald-100 shadow-[0_16px_32px_-24px_rgba(16,185,129,0.9)]">
                  <UserPlus className="h-6 w-6" />
                </div>
                <div className="min-w-0">
                  <div className="new-customer-eyebrow flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-amber-200" />
                    <p className="text-[11px] font-black uppercase tracking-[0.22em] text-amber-100/80">PowerSA Cari Yönetimi</p>
                  </div>
                  <h2 className="new-customer-title mt-1 truncate text-2xl font-black tracking-tight text-white sm:text-3xl">Yeni Cari Oluştur</h2>
                  <p className="new-customer-subtitle mt-1 text-sm font-semibold text-emerald-100/70">Logo uyumlu il/ilçe, plasiyer ve e-tahsilat bilgileriyle hızlı cari açılışı.</p>
                </div>
              </div>
              <div className="new-customer-badges grid grid-cols-3 gap-2 text-center text-xs font-black text-emerald-50">
                <div className="new-customer-badge new-customer-badge--logo rounded-[16px] border border-emerald-300/20 bg-emerald-300/10 px-3 py-2">
                  <CheckCircle2 className="mx-auto mb-1 h-4 w-4 text-emerald-200" />
                  Logo Hazır
                </div>
                <div className="new-customer-badge new-customer-badge--city rounded-[16px] border border-sky-300/20 bg-sky-300/10 px-3 py-2">
                  <MapPin className="mx-auto mb-1 h-4 w-4 text-sky-200" />
                  81 İl
                </div>
                <div className="new-customer-badge new-customer-badge--safe rounded-[16px] border border-amber-300/20 bg-amber-300/10 px-3 py-2">
                  <ShieldCheck className="mx-auto mb-1 h-4 w-4 text-amber-200" />
                  Güvenli
                </div>
              </div>
            </div>
          </div>

          <div className="new-customer-form-grid grid gap-4 p-4 sm:p-6 xl:grid-cols-[1.25fr_0.95fr]">
            <section className={SOFT_PANEL_CLASSNAME + " p-4"}>
              <div className="mb-4 flex items-center gap-2">
                <span className="new-customer-section-icon new-customer-section-icon--customer flex h-9 w-9 items-center justify-center rounded-[14px] bg-emerald-300/12 text-emerald-100">
                  <Building2 className="h-4 w-4" />
                </span>
                <div>
                  <p className={SECTION_TITLE_CLASSNAME}>Cari Bilgileri</p>
                  <p className="new-customer-section-copy text-xs font-semibold text-emerald-100/55">Temel bilgiler ve vergi bilgileri</p>
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1.5 md:col-span-2">
                  <label className={FIELD_LABEL_CLASSNAME}>Cari İsmi</label>
                  <Input
                    className={FIELD_CLASSNAME}
                    value={form.company_name}
                    onChange={(event) => updateField("company_name", event.target.value)}
                    placeholder="Cari adı"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className={FIELD_LABEL_CLASSNAME}>Şahıs / Tüzel</label>
                  <Select value={form.customer_kind} onValueChange={(value) => updateField("customer_kind", value as CustomerKind)}>
                    <SelectTrigger className={SELECT_FIELD_CLASSNAME}>
                      <SelectValue placeholder="Cari tipi seç" />
                    </SelectTrigger>
                    <SelectContent className={SELECT_CONTENT_CLASSNAME}>
                      {CUSTOMER_KIND_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label className={FIELD_LABEL_CLASSNAME}>Mail</label>
                  <Input
                    className={FIELD_CLASSNAME}
                    value={form.email}
                    onChange={(event) => updateField("email", event.target.value)}
                    placeholder="mail zorunlu değil"
                  />
                </div>
                {isCompanyCustomer ? (
                  <>
                    <div className="space-y-1.5">
                      <label className={FIELD_LABEL_CLASSNAME}>Vergi Dairesi</label>
                      <Input
                        className={FIELD_CLASSNAME}
                        value={form.tax_office}
                        onChange={(event) => updateField("tax_office", event.target.value)}
                        placeholder="Vergi dairesi"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className={FIELD_LABEL_CLASSNAME}>Vergi No</label>
                      <Input
                        className={FIELD_CLASSNAME}
                        value={form.tax_number}
                        onChange={(event) => updateField("tax_number", digitsOnly(event.target.value, 10))}
                        placeholder="10 haneli vergi no"
                        inputMode="numeric"
                        maxLength={10}
                      />
                    </div>
                  </>
                ) : (
                  <div className="space-y-1.5 md:col-span-2">
                    <label className={FIELD_LABEL_CLASSNAME}>T.C. Kimlik No</label>
                    <Input
                      className={FIELD_CLASSNAME}
                      value={form.tax_number}
                      onChange={(event) => updateField("tax_number", digitsOnly(event.target.value, 11))}
                      placeholder="11 haneli T.C. kimlik no"
                      inputMode="numeric"
                      maxLength={11}
                    />
                  </div>
                )}
              </div>
            </section>

            <section className={SOFT_PANEL_CLASSNAME + " p-4"}>
              <div className="mb-4 flex items-center gap-2">
                <span className="new-customer-section-icon new-customer-section-icon--location flex h-9 w-9 items-center justify-center rounded-[14px] bg-sky-300/12 text-sky-100">
                  <PhoneCall className="h-4 w-4" />
                </span>
                <div>
                  <p className={SECTION_TITLE_CLASSNAME}>İletişim / Lokasyon</p>
                  <p className="new-customer-section-copy text-xs font-semibold text-emerald-100/55">Telefon, il ve ilçe seçimi</p>
                </div>
              </div>
              <div className="grid gap-3">
                <div className="space-y-1.5">
                  <label className={FIELD_LABEL_CLASSNAME}>Telefon</label>
                  <Input
                    className={FIELD_CLASSNAME}
                    value={form.phone}
                    onChange={(event) => updateField("phone", digitsOnly(event.target.value, 11))}
                    placeholder="05xx xxx xx xx"
                    inputMode="numeric"
                    maxLength={11}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label className={FIELD_LABEL_CLASSNAME}>İl</label>
                    <Select value={form.city} onValueChange={(value) => updateField("city", value)}>
                      <SelectTrigger className={SELECT_FIELD_CLASSNAME}>
                        <SelectValue placeholder="İl seç" />
                      </SelectTrigger>
                      <SelectContent className={SELECT_CONTENT_CLASSNAME}>
                        {TURKEY_PROVINCES.map((province) => (
                          <SelectItem key={province} value={province}>
                            {province}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <label className={FIELD_LABEL_CLASSNAME}>İlçe</label>
                    <Select value={form.district} onValueChange={(value) => updateField("district", value)} disabled={!form.city}>
                      <SelectTrigger className={SELECT_FIELD_CLASSNAME}>
                        <SelectValue placeholder={form.city ? "İlçe seç" : "Önce il seç"} />
                      </SelectTrigger>
                      <SelectContent className={SELECT_CONTENT_CLASSNAME}>
                        {districtOptions.map((district) => (
                          <SelectItem key={`${form.city}-${district}`} value={district}>
                            {district}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className={FIELD_LABEL_CLASSNAME}>Adres</label>
                  <Textarea
                    className={FIELD_CLASSNAME + " min-h-[88px]"}
                    value={form.address}
                    onChange={(event) => updateField("address", event.target.value)}
                    placeholder="Açık adres"
                  />
                </div>
              </div>
            </section>

            <section className={SOFT_PANEL_CLASSNAME + " p-4 xl:col-span-2"}>
              <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-center gap-2">
                  <span className="new-customer-section-icon new-customer-section-icon--logo flex h-9 w-9 items-center justify-center rounded-[14px] bg-amber-300/12 text-amber-100">
                    <Users className="h-4 w-4" />
                  </span>
                  <div>
                    <p className={SECTION_TITLE_CLASSNAME}>Logo / Plasiyer Ayarları</p>
                    <p className="new-customer-section-copy text-xs font-semibold text-emerald-100/55">Seçilen bilgiler cari kartına ve Logo kuyruğuna taşınır</p>
                  </div>
                </div>
                <div className="new-customer-code-preview rounded-[14px] border border-amber-200/20 bg-amber-200/10 px-3 py-2 text-xs font-black text-amber-100">
                  {eCollectionPreview}
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div className="space-y-1.5 xl:col-span-2">
                  <label className={FIELD_LABEL_CLASSNAME}>Plasiyer</label>
                  <Select
                    value={selectedSalespersonId}
                    onValueChange={(value) => updateField("salesperson_user_id", value)}
                    disabled={!canChooseSalesperson || salespeopleQuery.isLoading}
                  >
                    <SelectTrigger className={SELECT_FIELD_CLASSNAME}>
                      <SelectValue placeholder={salespeopleQuery.isLoading ? "Plasiyerler yükleniyor" : "Plasiyer seç"} />
                    </SelectTrigger>
                    <SelectContent className={SELECT_CONTENT_CLASSNAME}>
                      {salespersonOptions.map((salesperson) => (
                        <SelectItem key={salesperson.id} value={String(salesperson.id)}>
                          {salesperson.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label className={FIELD_LABEL_CLASSNAME}>Özel Kodu</label>
                  <Select value={form.logo_special_code} onValueChange={(value) => updateField("logo_special_code", value)}>
                    <SelectTrigger className={SELECT_FIELD_CLASSNAME + " font-bold"}>
                      <SelectValue placeholder="Özel kod seç" />
                    </SelectTrigger>
                    <SelectContent className={SELECT_CONTENT_CLASSNAME}>
                      {LOGO_SPECIAL_CODE_OPTIONS.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label className={FIELD_LABEL_CLASSNAME}>Yetki Kodu</label>
                  <Select value={form.logo_authorization_code || "none"} onValueChange={(value) => updateField("logo_authorization_code", value === "none" ? "" : value)}>
                    <SelectTrigger className={SELECT_FIELD_CLASSNAME}>
                      <SelectValue placeholder="Yetki kodu seç" />
                    </SelectTrigger>
                    <SelectContent className={SELECT_CONTENT_CLASSNAME}>
                      <SelectItem value="none">Boş</SelectItem>
                      {LOGO_AUTHORIZATION_CODE_OPTIONS.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </section>

            <div className="new-customer-actions flex flex-wrap justify-end gap-2 xl:col-span-2">
              <Button
                variant="outline"
                className="new-customer-clear-button h-12 rounded-[16px] border-emerald-300/20 bg-white/[0.035] px-5 font-black text-emerald-50 hover:bg-white/[0.07]"
                onClick={() => setForm(createInitialForm(user))}
                disabled={createMutation.isPending}
              >
                Temizle
              </Button>
              <Button
                className="new-customer-submit-button h-12 rounded-[16px] border border-red-300/45 bg-red-600 from-red-500 bg-[linear-gradient(135deg,#ff5a5f_0%,#e11d2e_48%,#8f1118_100%)] px-7 font-black text-white shadow-[0_18px_38px_rgba(225,29,46,0.34)] hover:brightness-110"
                onClick={handleSubmit}
                disabled={createMutation.isPending}
              >
                {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                Cari Oluştur
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
