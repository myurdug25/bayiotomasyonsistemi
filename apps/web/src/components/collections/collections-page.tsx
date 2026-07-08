"use client";

import Link from "next/link";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Banknote,
  CreditCard,
  Factory,
  FileText,
  ImagePlus,
  Landmark,
  Loader2,
  MessageCircle,
  Pencil,
  Printer,
  RefreshCcw,
  Save,
  Send,
  Trash2,
  UserRound,
  Wallet,
  X,
} from "lucide-react";

import { useSession } from "@/components/auth/session-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  ApiClientError,
  type CustomerCollectionsResponse,
  type CollectionRecord,
  type PosSessionDto,
  type FinanceDefinitionDto,
  createCustomerCollection,
  deleteCustomerCollection,
  getCurrentPosSession,
  listCustomerCollections,
  listFinanceDefinitions,
  createFinanceDefinition,
  sendCustomerCollections,
  updateCustomerCollection,
  listCustomers,
  type CustomerListItem,
} from "@/lib/api";
import { notifyPosDayEndRefresh } from "@/lib/pos-day-end-events";
import { cn } from "@/lib/utils";

const METHODS = ["cash", "transfer", "check", "cc", "factory_cc"] as const;

type FormMethodType = (typeof METHODS)[number];
type MethodType = FormMethodType | "note" | "invoice";
type FactoryPosType = string;
type PosBankType = string;
type CheckImageDraft = {
  id: string;
  name: string;
  type: string;
  data: string;
};
type CollectionImagePreview = {
  id: string;
  name: string;
  type: string;
  data: string;
  checkNo?: string;
};

type CollectionReferenceFields = NonNullable<CollectionRecord["reference_fields"]>;
type CheckDraftItem = {
  id: string;
  amount: string;
  date: string;
  bankName: string;
  checkNo: string;
  dueDate: string;
  valorDays: string;
  images: CheckImageDraft[];
  note: string;
};

const METHOD_LABELS: Record<FormMethodType | MethodType, string> = {
  cash: "Nakit",
  transfer: "Havale/EFT",
  check: "Çek / Senet",
  note: "Çek / Senet",
  cc: "Fiziksel Pos",
  factory_cc: "Fabrika Kart Çekimi",
  invoice: "Fatura",
};

const METHOD_STYLES: Record<FormMethodType, { active: string; idle: string }> = {
  cash: {
    active: "border-emerald-300/70 bg-emerald-300/14 text-emerald-100 shadow-[0_18px_34px_-30px_rgba(52,211,153,0.7)]",
    idle: "border-white/10 bg-white/[0.035] text-slate-300 hover:border-emerald-300/35 hover:bg-emerald-300/8 hover:text-emerald-100",
  },
  transfer: {
    active: "border-sky-300/70 bg-sky-300/14 text-sky-100 shadow-[0_18px_34px_-30px_rgba(56,189,248,0.7)]",
    idle: "border-white/10 bg-white/[0.035] text-slate-300 hover:border-sky-300/35 hover:bg-sky-300/8 hover:text-sky-100",
  },
  check: {
    active: "border-amber-300/70 bg-amber-300/14 text-amber-100 shadow-[0_18px_34px_-30px_rgba(251,191,36,0.7)]",
    idle: "border-white/10 bg-white/[0.035] text-slate-300 hover:border-amber-300/35 hover:bg-amber-300/8 hover:text-amber-100",
  },
  cc: {
    active: "border-rose-300/70 bg-rose-300/14 text-rose-100 shadow-[0_18px_34px_-30px_rgba(251,113,133,0.7)]",
    idle: "border-white/10 bg-white/[0.035] text-slate-300 hover:border-rose-300/35 hover:bg-rose-300/8 hover:text-rose-100",
  },
  factory_cc: {
    active: "border-orange-300/70 bg-orange-300/14 text-orange-100 shadow-[0_18px_34px_-30px_rgba(251,146,60,0.7)]",
    idle: "border-white/10 bg-white/[0.035] text-slate-300 hover:border-orange-300/35 hover:bg-orange-300/8 hover:text-orange-100",
  },
};

const COLLECTION_FIELD_LABELS: Record<string, string> = {
  method: "Yöntem",
  amount: "Tutar",
  date: "Tarih",
  reference_no: "Referans No",
  "reference_fields.bank_name": "Banka",
  "reference_fields.check_no": "Çek / Senet No",
  "reference_fields.due_date": "Vade Tarihi",
  "reference_fields.valor_days": "Valör Hesabı",
  "reference_fields.image_data": "Resim",
  "reference_fields.note_no": "Çek / Senet No",
  "reference_fields.card_holder": "Kart Sahibi",
  "reference_fields.masked_pan": "Kart No (Son 4 Hane)",
  "reference_fields.auth_code": "Onay Kodu",
  "reference_fields.pos_bank": "Pos Seçimi",
  "reference_fields.factory_pos_account": "Cari Pos Seçimi",
};

const STANDARD_VALOR_DAY_LIMIT = 60;

function decimalSeparatorForAmount(value: string): "," | "." | null {
  const lastComma = value.lastIndexOf(",");
  const lastDot = value.lastIndexOf(".");

  if (lastComma !== -1 && lastDot !== -1) {
    return lastComma > lastDot ? "," : ".";
  }

  if (lastComma !== -1) {
    return ",";
  }

  if (lastDot === -1) {
    return null;
  }

  const fraction = value.slice(lastDot + 1).replace(/\D/g, "");

  return fraction.length <= 2 ? "." : null;
}

function toAmount(value: string): number {
  const cleaned = value.replace(/[^\d,.]/g, "");
  const decimalSeparator = decimalSeparatorForAmount(cleaned);
  const normalized = decimalSeparator
    ? `${cleaned.slice(0, cleaned.lastIndexOf(decimalSeparator)).replace(/\D/g, "") || "0"}.${cleaned
        .slice(cleaned.lastIndexOf(decimalSeparator) + 1)
        .replace(/\D/g, "")}`
    : cleaned.replace(/\D/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toApiAmount(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value !== "string") {
    return 0;
  }

  const direct = Number(value);
  if (Number.isFinite(direct)) {
    return direct;
  }

  return toAmount(value);
}

function formatAmountInput(value: string): string {
  const normalized = value.replace(/[^\d,.]/g, "");
  const decimalSeparator = decimalSeparatorForAmount(normalized);
  const separatorIndex = decimalSeparator ? normalized.lastIndexOf(decimalSeparator) : -1;
  const integerRaw = separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex);
  const decimalRaw = separatorIndex === -1 ? "" : normalized.slice(separatorIndex + 1).replace(/\D/g, "");
  const integerDigits = integerRaw.replace(/[^\d]/g, "");
  const formattedInteger = integerDigits ? Number(integerDigits).toLocaleString("tr-TR") : "";

  if (separatorIndex !== -1) {
    return `${formattedInteger},${decimalRaw.slice(0, 2)}`;
  }

  return formattedInteger;
}

function getDayDifference(startDateValue: string, endDateValue: string): number | null {
  const [startYear, startMonth, startDay] = startDateValue.split("-").map(Number);
  const [endYear, endMonth, endDay] = endDateValue.split("-").map(Number);
  if (!startYear || !startMonth || !startDay || !endYear || !endMonth || !endDay) {
    return null;
  }

  const start = new Date(startYear, startMonth - 1, startDay);
  const end = new Date(endYear, endMonth - 1, endDay);
  const diff = Math.round((end.getTime() - start.getTime()) / 86_400_000);

  return diff >= 0 ? diff : null;
}

function formatLedgerDate(value: string): string {
  const normalizedValue = typeof value === "string" ? value : "";
  const parsed = new Date(normalizedValue);
  if (Number.isNaN(parsed.getTime())) {
    return normalizedValue || "-";
  }

  return parsed.toLocaleDateString("tr-TR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatAmount(value: string | number, currency: string): string {
  const amount = toApiAmount(value);
  const safeCurrency = typeof currency === "string" && currency.trim() ? currency.trim() : "TRY";
  const normalizedCurrency = safeCurrency.toUpperCase();
  const label = normalizedCurrency === "TRY" ? "₺" : normalizedCurrency === "GEL" ? "GEL" : safeCurrency;
  return `${label} ${amount.toLocaleString("tr-TR", {
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function getPosBankValue(value?: string | number | null): PosBankType {
  return String(value ?? "").trim();
}

function getPosBankLabel(value?: string | number | null): string {
  return String(value ?? "");
}

function normalizeOptionText(value?: string | number | null): string {
  return String(value ?? "").trim();
}

function containsBlockedForeignBankTerm(definition: FinanceDefinitionDto): boolean {
  const payload = definition.meta?.integrations && typeof definition.meta.integrations === "object"
    ? (definition.meta.integrations as Record<string, unknown>).logo
    : null;
  const logoPayload = payload && typeof payload === "object"
    ? (payload as Record<string, unknown>).payload
    : null;
  const haystack = [
    definition.code,
    definition.name,
    definition.logo_code,
    definition.logo_name,
    logoPayload ? JSON.stringify(logoPayload) : "",
  ]
    .join(" ")
    .toLocaleLowerCase("tr-TR");

  return ["batum", "georgia", "gürcistan", "gurcistan", "yurtdışı", "yurtdisi", "tbc"].some((term) =>
    haystack.includes(term)
  );
}

function financeDefinitionLabel(definition: FinanceDefinitionDto): string {
  const name = normalizeOptionText(definition.logo_name) || normalizeOptionText(definition.name);
  const code = normalizeOptionText(definition.logo_code) || normalizeOptionText(definition.code);

  if (name && name !== code) {
    return name;
  }

  return name || code;
}

function getCollectionClientValidationMessage(input: {
  method: FormMethodType;
  amount: string;
  date: string;
  bankName: string;
  checkNo: string;
  dueDate: string;
  checkValorDays: string;
  posBank: PosBankType;
  factoryPos: FactoryPosType;
}): string | null {
  if (!Number.isFinite(toAmount(input.amount)) || toAmount(input.amount) <= 0) {
    return "Tutar 0'dan büyük olmalı.";
  }

  if (!input.date) {
    return "Tarih zorunlu.";
  }

  if (input.method === "check") {
    if (!input.bankName.trim()) {
      return "Çek / Senet için banka adı zorunlu.";
    }
    if (!input.checkNo.trim()) {
      return "Çek / Senet için numara zorunlu.";
    }
    if (!input.dueDate) {
      return "Çek / Senet için vade tarihi zorunlu.";
    }
    if (!input.checkValorDays.trim()) {
      return "Çek / Senet için valör hesabı zorunlu.";
    }
    const valorDays = Number(input.checkValorDays);
    if (!Number.isInteger(valorDays) || valorDays < 0) {
      return "Valör hesabı 0 veya daha büyük olmalı.";
    }
  }

  if (input.method === "cc" || input.method === "factory_cc") {
    if (input.method === "cc" && !input.posBank) {
      return "Fiziksel Pos için pos seçimi zorunlu.";
    }
    if (input.method === "factory_cc" && !input.factoryPos) {
      return "Fabrika Kart Çekimi için cari pos seçimi zorunlu.";
    }
  }

  return null;
}

function getCollectionApiErrorMessage(error: unknown): string {
  if (!(error instanceof ApiClientError)) {
    return error instanceof Error ? error.message : "Tahsilat kaydedilemedi";
  }

  const validationEntry = error.payload?.errors
    ? Object.entries(error.payload.errors).find(([, messages]) => Array.isArray(messages) && messages.length > 0)
    : null;

  if (!validationEntry) {
    return error.message || "Tahsilat kaydedilemedi";
  }

  const [field, messages] = validationEntry;
  const label = COLLECTION_FIELD_LABELS[field] ?? field;
  const rawMessage = Array.isArray(messages) ? messages[0] ?? error.message : error.message;

  if (rawMessage === "validation.required") {
    return `${label} zorunlu.`;
  }

  if (rawMessage === "validation.date") {
    return `${label} geçerli bir tarih olmalı.`;
  }

  if (rawMessage === "validation.numeric") {
    return `${label} sayısal olmalı.`;
  }

  if (rawMessage.startsWith("validation.gt")) {
    return `${label} 0'dan büyük olmalı.`;
  }

  return rawMessage || `${label} alanında hata var.`;
}

function getCollectionSendErrorMessage(error: unknown): string {
  if (!(error instanceof ApiClientError)) {
    return error instanceof Error ? error.message : "Tahsilat gönderilemedi";
  }

  const validationEntry = error.payload?.errors
    ? Object.entries(error.payload.errors).find(([, messages]) => Array.isArray(messages) && messages.length > 0)
    : null;

  if (!validationEntry) {
    return error.message || "Tahsilat gönderilemedi";
  }

  return Array.isArray(validationEntry[1]) ? validationEntry[1][0] ?? error.message ?? "Tahsilat gönderilemedi" : error.message ?? "Tahsilat gönderilemedi";
}

function canSendCollection(row: CollectionRecord): boolean {
  if (row.method === "invoice" || row.record_type === "invoice") {
    return false;
  }

  return row.source_system === "b2b" && !["pending", "reviewing", "synced"].includes(row.sync_status ?? "draft");
}

function getCollectionStatusLabel(row: CollectionRecord): string {
  if (row.method === "invoice" || row.record_type === "invoice") {
    return "Fatura";
  }

  if (row.sync_status === "synced") {
    return "Gönderildi";
  }

  if (row.sync_status === "pending") {
    return "Logo'ya Gönderiliyor";
  }

  if (row.sync_status === "reviewing") {
    return "Müdür Onayında";
  }

  if (row.sync_status === "failed") {
    return "Hatalı";
  }

  return "Kaydedildi";
}

function buildCombinedCheckReferenceFields(items: CheckDraftItem[]): Record<string, string | number | boolean> {
  const maxValorDays = Math.max(...items.map((item) => Number(item.valorDays || 0)));
  const totalValorDays = items.reduce((total, item) => total + Number(item.valorDays || 0), 0);
  const latestDueDate = items
    .map((item) => item.dueDate)
    .sort((left, right) => right.localeCompare(left))[0];
  const bankNames = Array.from(new Set(items.map((item) => item.bankName).filter(Boolean)));
  const checkNumbers = items.map((item) => item.checkNo).filter(Boolean);
  const images = items.flatMap((item) =>
    item.images.map(({ name, type, data }) => ({
      check_no: item.checkNo,
      name,
      type,
      data,
    }))
  );
  const fields: Record<string, string | number | boolean> = {
    bank_name: bankNames.length === 1 ? bankNames[0] : "Çoklu Banka",
    check_no: items.length === 1 ? checkNumbers[0] : `${items.length} Çek / Senet`,
    due_date: latestDueDate,
    valor_days: maxValorDays,
    total_valor_days: totalValorDays,
    check_count: items.length,
    check_items_json: JSON.stringify(
      items.map((item) => ({
        amount: toAmount(item.amount),
        bank_name: item.bankName,
        check_no: item.checkNo,
        due_date: item.dueDate,
        valor_days: Number(item.valorDays || 0),
        image_count: item.images.length,
      }))
    ),
  };

  if (maxValorDays > STANDARD_VALOR_DAY_LIMIT) {
    fields.requires_manager_approval = true;
    fields.manager_approval_reason = "valor_limit_exceeded";
  }

  if (images.length > 0) {
    const [firstImage] = images;
    fields.image_data = firstImage.data;
    fields.image_name = firstImage.name;
    fields.image_type = firstImage.type;
    fields.images_json = JSON.stringify(images);
  }

  return fields;
}

function getCollectionImagePreviews(row: CollectionRecord): CollectionImagePreview[] {
  const fields = getCollectionReferenceFields(row);
  const imagesJson = typeof fields.images_json === "string" ? fields.images_json : "";
  const previews: CollectionImagePreview[] = [];

  if (imagesJson.trim()) {
    try {
      const parsed = JSON.parse(imagesJson) as unknown;
      const imageList = Array.isArray(parsed) ? parsed : [];

      imageList.forEach((image, index) => {
        if (!image || typeof image !== "object") {
          return;
        }

        const typedImage = image as Partial<CollectionImagePreview> & { check_no?: string };
        if (typeof typedImage.data !== "string" || !typedImage.data) {
          return;
        }

        previews.push({
          id: `${row.id}-${index}-${typedImage.name ?? "image"}`,
          name: typeof typedImage.name === "string" && typedImage.name ? typedImage.name : `Çek / senet resmi ${index + 1}`,
          type: typeof typedImage.type === "string" && typedImage.type ? typedImage.type : "image/*",
          data: typedImage.data,
          checkNo: typeof typedImage.check_no === "string" ? typedImage.check_no : undefined,
        });
      });
    } catch {
      // Broken legacy JSON should not break the collections screen.
    }
  }

  if (previews.length === 0 && typeof fields.image_data === "string" && fields.image_data) {
    previews.push({
      id: `${row.id}-single-image`,
      name: typeof fields.image_name === "string" && fields.image_name ? fields.image_name : "Çek / senet resmi",
      type: typeof fields.image_type === "string" && fields.image_type ? fields.image_type : "image/*",
      data: fields.image_data,
      checkNo: typeof fields.check_no === "string" ? fields.check_no : undefined,
    });
  }

  return previews;
}

function getCollectionReferenceFields(row: CollectionRecord): CollectionReferenceFields {
  const fields = row.reference_fields;

  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return {};
  }

  return fields;
}

function getCollectionDisplayNote(row: CollectionRecord): string {
  const note = (row.note ?? "").trim();
  const referenceNo = (row.reference_no ?? "").trim();

  if (!note) {
    return "";
  }

  if (referenceNo && note.startsWith(referenceNo)) {
    return note.slice(referenceNo.length).replace(/^[\s·:-]+/, "").trim();
  }

  return note;
}

function MethodIcon({ method }: { method: MethodType }) {
  if (method === "cash") {
    return <Banknote className="h-6 w-6" />;
  }
  if (method === "transfer") {
    return <Landmark className="h-6 w-6" />;
  }
  if (method === "check") {
    return <FileText className="h-6 w-6" />;
  }
  if (method === "note") {
    return <FileText className="h-6 w-6" />;
  }
  if (method === "invoice") {
    return <FileText className="h-6 w-6" />;
  }
  if (method === "factory_cc") {
    return <Factory className="h-6 w-6" />;
  }
  return <CreditCard className="h-6 w-6" />;
}

function FormMethodIcon({ method }: { method: FormMethodType }) {
  if (method === "factory_cc") {
    return <Factory className="h-6 w-6" />;
  }

  return <MethodIcon method={method} />;
}

function getCollectionMethodLabel(row: CollectionRecord): string {
  if (row.method === "invoice" || row.record_type === "invoice") {
    return "Fatura";
  }

  const fields = getCollectionReferenceFields(row);

  if (row.method === "cc" && fields.collection_channel === "factory") {
    return "Fabrika Kart Çekimi";
  }

  return METHOD_LABELS[row.method] ?? "Tahsilat";
}

function getFormMethodFromCollection(row: CollectionRecord): FormMethodType {
  const fields = getCollectionReferenceFields(row);

  if (row.method === "cc" && fields.collection_channel === "factory") {
    return "factory_cc";
  }

  if (row.method === "note") {
    return "check";
  }

  if (METHODS.includes(row.method as FormMethodType)) {
    return row.method as FormMethodType;
  }

  return "cash";
}

function getInputDate(value: string): string {
  return value.includes("T") ? value.slice(0, 10) : value;
}

function isEditableCollection(row: CollectionRecord): boolean {
  if (row.record_type === "invoice" || row.method === "invoice") {
    return false;
  }

  if (row.source_system !== "b2b") {
    return false;
  }

  return !["pending", "reviewing"].includes(row.sync_status ?? "draft");
}

function cleanReferenceFields(fields: CollectionRecord["reference_fields"] | undefined) {
  const cleaned: Record<string, string | number | boolean> = {};

  const safeFields = fields && typeof fields === "object" && !Array.isArray(fields) ? fields : {};

  Object.entries(safeFields).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      cleaned[key] = value;
    }
  });

  return cleaned;
}

function normalizeWhatsAppPhone(phone?: string | null): string {
  const digits = (phone ?? "").replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  if (digits.startsWith("00")) {
    return digits.slice(2);
  }

  if (digits.length === 10 && digits.startsWith("5")) {
    return `90${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("0")) {
    return `90${digits.slice(1)}`;
  }

  return digits;
}

function AddBankModal({ onAdd }: { onAdd: () => void }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!code || !name) return;
    setSaving(true);
    try {
      await createFinanceDefinition({
        type: "bank",
        code,
        name,
        is_active: true,
      });
      setOpen(false);
      setCode("");
      setName("");
      onAdd();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Banka eklenemedi");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-6 px-2 text-xs">+ Ekle</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Banka Ekle (Havale / EFT)</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Logo Banka Kodu</label>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Örn: AKBANK-01" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Banka Adı</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Örn: Akbank A.Ş." />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>İptal</Button>
          <Button onClick={handleSave} disabled={saving || !code || !name}>Kaydet</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddFactoryPosModal({ onAdd }: { onAdd: () => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<CustomerListItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (search.trim().length < 3) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void listCustomers({ q: search.trim(), limit: 5 })
        .then((res) => {
          if (!cancelled) setResults(res.data);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [search]);

  const handleSelectCustomer = (customer: CustomerListItem) => {
    setCode(customer.code);
    setName(customer.title);
    setSearch("");
    setResults([]);
  };

  const handleSave = async () => {
    if (!code || !name) return;
    setSaving(true);
    try {
      await createFinanceDefinition({
        type: "factory",
        code,
        name,
        is_active: true,
      });
      setOpen(false);
      setCode("");
      setName("");
      setSearch("");
      onAdd();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Cari Pos eklenemedi");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-6 px-2 text-xs">+ Ekle</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cari Pos Ekle (Fabrika)</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2 relative">
            <label className="text-sm font-medium text-amber-500">Cari Hesap Ara</label>
            <Input 
              value={search} 
              onChange={(e) => setSearch(e.target.value)} 
              placeholder="Min. 3 karakter giriniz..." 
              className="border-amber-500/50 focus-visible:ring-amber-500/20"
            />
            {searching && (
              <div className="absolute right-3 top-[34px]">
                <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
              </div>
            )}
            {results.length > 0 && (
              <div className="absolute z-10 w-full mt-1 max-h-48 overflow-auto rounded-md border border-white/10 bg-[var(--surface-soft)] p-1 shadow-xl">
                {results.map((customer) => (
                  <button
                    key={customer.id}
                    type="button"
                    onClick={() => handleSelectCustomer(customer)}
                    className="flex w-full flex-col items-start rounded-sm px-3 py-2 text-left text-sm hover:bg-[var(--brand-primary-soft)] hover:text-[var(--brand-primary)]"
                  >
                    <span className="font-bold">{customer.code}</span>
                    <span className="truncate text-xs text-[var(--muted-foreground)]">{customer.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Logo Cari Kodu</label>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Örn: 120-61-031" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Cari Unvanı</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Örn: Fabrika Cari" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>İptal</Button>
          <Button onClick={handleSave} disabled={saving || !code || !name}>Kaydet</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CollectionsPage() {
  const { selectedCustomer, user } = useSession();
  const collectionReceiptCaptureRef = useRef<HTMLDivElement | null>(null);
  const roleSlugs = useMemo(
    () => (Array.isArray(user?.roles) ? user.roles.map((role) => role.slug) : []),
    [user?.roles]
  );
  const isPointUser = roleSlugs.includes("point");
  const isAdminUser = roleSlugs.includes("admin");
  const visibleMethods = useMemo(
    () => METHODS.filter((value) => !isPointUser || (value !== "check" && value !== "factory_cc")),
    [isPointUser]
  );

  const [page, setPage] = useState(1);

  const [listLoading, setListLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sendingCollections, setSendingCollections] = useState(false);
  const [sharingReceiptScreenshot, setSharingReceiptScreenshot] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<CustomerCollectionsResponse | null>(null);
  const [editingCollection, setEditingCollection] = useState<CollectionRecord | null>(null);
  const [deletingCollectionId, setDeletingCollectionId] = useState<number | null>(null);
  const [currentPointSession, setCurrentPointSession] = useState<PosSessionDto | null>(null);
  const [financeDefinitions, setFinanceDefinitions] = useState<FinanceDefinitionDto[]>([]);

  const [method, setMethod] = useState<FormMethodType>("cash");
  const [amount, setAmount] = useState("0");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");

  const [bankName, setBankName] = useState("");
  const [checkNo, setCheckNo] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [checkValorDays, setCheckValorDays] = useState("");
  const [posBank, setPosBank] = useState<PosBankType>("");
  const [factoryPos, setFactoryPos] = useState<FactoryPosType>("");
  const [checkDraftItems, setCheckDraftItems] = useState<CheckDraftItem[]>([]);
  const [previewImage, setPreviewImage] = useState<CollectionImagePreview | null>(null);
  const [receiptActionsUnlocked, setReceiptActionsUnlocked] = useState(false);

  const fetchList = (targetPage = page, silent = false) => {
    if (!selectedCustomer) {
      setPayload(null);
      setPage(1);
      return;
    }

    if (!silent) {
      setListLoading(true);
      setError(null);
    }

    void listCustomerCollections(selectedCustomer.id, {
      per_page: 30,
      page: targetPage,
    })
      .then((response) => {
        setPayload({
          ...response,
          data: Array.isArray(response.data) ? response.data : [],
          tabs: Array.isArray(response.tabs) ? response.tabs : [],
        });
        setPage(targetPage);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Tahsilat listesi alınamadı"))
      .finally(() => {
        if (!silent) {
          setListLoading(false);
        }
      });
  };

  useEffect(() => {
    setReceiptActionsUnlocked(false);
    fetchList(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomer?.id]);

  useEffect(() => {
    handleRefreshFinanceDefinitions();
  }, []);

  const handleRefreshFinanceDefinitions = () => {
    void listFinanceDefinitions()
      .then((response) => setFinanceDefinitions(response.data))
      .catch((err) => setError(err instanceof Error ? err.message : "Finans tanımları alınamadı"));
  };

  useEffect(() => {
    const hasPendingLogoWrite = (Array.isArray(payload?.data) ? payload.data : []).some(
      (row) => row.source_system === "b2b" && row.sync_status === "pending"
    );
    if (!selectedCustomer || !hasPendingLogoWrite) {
      return;
    }

    const timer = window.setInterval(() => fetchList(page, true), 1500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, payload?.data, selectedCustomer?.id]);

  useEffect(() => {
    if (isPointUser && (method === "check" || method === "factory_cc")) {
      setMethod("cash");
    }
  }, [isPointUser, method]);

  const bankOptions = useMemo(
    () => financeDefinitions
      .filter((item) => item.type === "bank" && item.is_active && !containsBlockedForeignBankTerm(item))
      .map((item) => ({ value: item.code, label: financeDefinitionLabel(item) })),
    [financeDefinitions]
  );
  const factoryOptions = useMemo(
    () => financeDefinitions
      .filter((item) => item.type === "factory" && item.is_active)
      .map((item) => ({ value: item.code, label: financeDefinitionLabel(item) }))
      .filter((item) => item.label.trim().length > 0),
    [financeDefinitions]
  );

  useEffect(() => {
    if (bankOptions.length > 0 && !bankOptions.some((option) => option.value === posBank)) {
      setPosBank(bankOptions[0].value);
    }
  }, [bankOptions, posBank]);

  useEffect(() => {
    let cancelled = false;

    if (!isPointUser) {
      setCurrentPointSession(null);
      return () => {
        cancelled = true;
      };
    }

    void getCurrentPosSession()
      .then((response) => {
        if (!cancelled) {
          setCurrentPointSession(response.data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCurrentPointSession(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isPointUser]);

  const referenceFields = useMemo(() => {
    const fields: Record<string, string | number | boolean> = {};

    if (method === "check") {
      fields.bank_name = bankName;
      fields.check_no = checkNo;
      fields.due_date = dueDate;
      fields.valor_days = Number(checkValorDays);
      if (Number(checkValorDays) > STANDARD_VALOR_DAY_LIMIT) {
        fields.requires_manager_approval = "1";
        fields.manager_approval_reason = "valor_limit_exceeded";
      }
    }

    if (method === "transfer") {
      fields.bank_code = posBank;
      fields.bank_name = bankOptions.find((option) => option.value === posBank)?.label ?? posBank;
    }

    if (method === "factory_cc") {
      fields.collection_channel = "factory";
      fields.factory_pos_account = factoryPos;
    }

    if (method === "cc") {
      fields.pos_bank = posBank;
    }

    return fields;
  }, [
    method,
    bankName,
    checkNo,
    dueDate,
    checkValorDays,
    posBank,
    factoryPos,
    bankOptions,
  ]);

  const isListDisabled = listLoading || saving || sendingCollections || deletingCollectionId !== null || !selectedCustomer;
  const isFormDisabled = saving || listLoading || sendingCollections || deletingCollectionId !== null || !selectedCustomer;
  const rawRows = useMemo(() => (Array.isArray(payload?.data) ? payload.data : []), [payload?.data]);
  const displayRows = useMemo(
    () => rawRows.filter((row) => row.sync_status !== "synced"),
    [rawRows]
  );
  const sendableRows = useMemo(() => displayRows.filter(canSendCollection), [displayRows]);
  const collectionReceiptTotal = useMemo(
    () => displayRows.reduce((total, row) => total + toApiAmount(row.amount), 0),
    [displayRows]
  );
  const collectionGrandTotal = useMemo(
    () =>
      (Array.isArray(payload?.tabs) ? payload.tabs : [])
        .filter((tab) => tab.method !== "invoice")
        .reduce((total, tab) => total + toApiAmount(tab.total_amount), 0),
    [payload?.tabs]
  );
  const collectionReceiptText = useMemo(() => {
    if (!selectedCustomer || displayRows.length === 0) {
      return "";
    }

    const rows = displayRows.map((row, index) => {
      const fields = getCollectionReferenceFields(row);
      const referenceText = row.reference_no ? ` - Ref: ${row.reference_no}` : "";
      const transferBankText =
        row.method === "transfer" && fields.bank_name
          ? ` - Banka: ${fields.bank_name}`
          : "";
      const physicalPosBankText =
        row.method === "cc" && fields.collection_channel !== "factory" && fields.pos_bank
          ? ` - Banka: ${getPosBankLabel(String(fields.pos_bank))}`
          : "";
      const noteText = row.note ? ` - ${row.note}` : "";

      return `${index + 1}. ${formatLedgerDate(row.date)} - ${getCollectionMethodLabel(row)} - ${formatAmount(String(row.amount), String(row.currency))}${referenceText}${transferBankText}${physicalPosBankText}${noteText}`;
    });

    return [
      "POWERSA TAHSİLAT MAKBUZU",
      `Cari: ${selectedCustomer.title}`,
      `Cari Kodu: ${selectedCustomer.code}`,
      `Tarih: ${new Date().toLocaleString("tr-TR")}`,
      "",
      ...rows,
      "",
      `Toplam: ${formatAmount(collectionReceiptTotal, displayRows[0]?.currency ?? "TRY")}`,
    ].join("\n");
  }, [collectionReceiptTotal, displayRows, selectedCustomer]);
  const checkValorNeedsManagerApproval =
    method === "check" && checkValorDays.trim() !== "" && Number(checkValorDays) > STANDARD_VALOR_DAY_LIMIT;
  const checkDraftTotal = useMemo(
    () => checkDraftItems.reduce((total, item) => total + toAmount(item.amount), 0),
    [checkDraftItems]
  );
  const checkDraftValorTotal = useMemo(
    () => checkDraftItems.reduce((total, item) => total + Number(item.valorDays || 0), 0),
    [checkDraftItems]
  );
  const checkDraftMissingImages = useMemo(
    () => checkDraftItems.some((item) => item.images.length === 0),
    [checkDraftItems]
  );
  const customerDebtBalance = selectedCustomer?.balance_summary?.total_due ?? "0";
  const customerDebtCurrency = selectedCustomer?.balance_summary?.currency ?? "TRY";
  const customerDebtAmount = toApiAmount(customerDebtBalance);
  const customerDebtStatus =
    customerDebtAmount > 0 ? "Borçlu" : customerDebtAmount < 0 ? "Alacaklı" : "Dengede";
  const collectionSummaryCurrency = displayRows[0]?.currency ?? customerDebtCurrency;
  const balanceSourceLabel = selectedCustomer?.balance_source === "logo" ? "Logo bakiyesi" : "B2B bakiyesi";
  const canUseReceiptActions = displayRows.length > 0 && (receiptActionsUnlocked || sendableRows.length === 0);
  const hasQueuedCollectionRows = displayRows.some((row) => row.source_system === "b2b" && row.sync_status === "pending");
  const sendActionLabel = sendingCollections
    ? "Gönderiliyor..."
    : sendableRows.length > 0
      ? "Gönder"
      : hasQueuedCollectionRows
        ? "İşleniyor"
        : "Gönder";

  const shellCardClassName =
    "dashboard-panel-card overflow-hidden border-white/10 bg-[linear-gradient(180deg,rgba(15,29,38,0.78)_0%,rgba(9,19,28,0.86)_100%)] shadow-[0_18px_34px_-28px_rgba(0,0,0,0.48)]";
  const fieldClassName =
    "h-14 rounded-[14px] border-white/10 bg-white/[0.035] text-base font-bold text-slate-100 placeholder:text-slate-500 focus-visible:border-emerald-300/40";
  const fieldShellClassName =
    "min-w-0 space-y-1";
  const fieldLabelClassName =
    "block text-[11px] font-black uppercase tracking-[0.11em] text-slate-500";

  const buildPointCollectionMeta = () => {
    if (!isPointUser || !currentPointSession) {
      return undefined;
    }

    return {
      source: "point_collection",
      pos_session_id: currentPointSession.id,
      cashbox_id: currentPointSession.cashbox.id ?? null,
    };
  };

  const refreshPointDayEnd = () => {
    if (!isPointUser) {
      return;
    }

    notifyPosDayEndRefresh("collection", currentPointSession?.id ?? null);
  };

  const resetCollectionForm = () => {
    setAmount("0");
    setDate(new Date().toISOString().slice(0, 10));
    setNote("");
    setBankName("");
    setCheckNo("");
    setDueDate("");
    setCheckValorDays("");
    setPosBank(bankOptions[0]?.value ?? "");
    setFactoryPos(factoryOptions[0]?.value ?? "");
  };

  const cancelCollectionEdit = () => {
    setEditingCollection(null);
    resetCollectionForm();
  };

  const startCollectionEdit = (row: CollectionRecord) => {
    if (!isEditableCollection(row)) {
      setError("Bu tahsilat Logo gönderim durumundan dolayı düzenlenemez.");
      return;
    }

    const nextMethod = getFormMethodFromCollection(row);
    const fields = getCollectionReferenceFields(row);

    setError(null);
    setEditingCollection(row);
    setMethod(nextMethod);
    setAmount(formatAmountInput(String(row.amount).replace(".", ",")));
    setDate(getInputDate(row.date));
    setNote(row.note ?? "");
    setBankName(String(fields.bank_name ?? ""));
    setCheckNo(String(fields.check_no ?? fields.note_no ?? row.reference_no ?? ""));
    setDueDate(String(fields.due_date ?? ""));
    setCheckValorDays(String(fields.valor_days ?? ""));
    setPosBank(getPosBankValue(String(fields.pos_bank ?? fields.bank_code ?? "")));
    setFactoryPos(String(fields.factory_pos_account ?? factoryOptions[0]?.value ?? ""));
    setCheckDraftItems([]);
  };

  const resetCheckDraftForm = () => {
    setAmount("0");
    setNote("");
    setBankName("");
    setCheckNo("");
    setDueDate("");
    setCheckValorDays("");
  };

  const updateCheckDueDate = (value: string) => {
    setDueDate(value);
    const diff = getDayDifference(date, value);
    setCheckValorDays(diff === null ? "" : String(diff));
  };

  const addCheckDraftItem = () => {
    const validationMessage = getCollectionClientValidationMessage({
      method: "check",
      amount,
      date,
      bankName,
      checkNo,
      dueDate,
      checkValorDays,
      posBank,
      factoryPos,
    });

    if (validationMessage) {
      setError(validationMessage);
      return;
    }

    setError(null);
    setCheckDraftItems((current) => [
      ...current,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        amount,
        date,
        bankName,
        checkNo,
        dueDate,
        valorDays: checkValorDays,
        images: [],
        note,
      },
    ]);
    resetCheckDraftForm();
  };

  const removeCheckDraftItem = (id: string) => {
    setCheckDraftItems((current) => current.filter((item) => item.id !== id));
  };

  const readCheckImageFiles = (fileList: FileList | null) => {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) {
      return Promise.resolve([] as CheckImageDraft[]);
    }

    return Promise.all(
      files.map(
        (file) =>
          new Promise<CheckImageDraft>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
              resolve({
                id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
                name: file.name,
                type: file.type,
                data: typeof reader.result === "string" ? reader.result : "",
              });
            };
            reader.readAsDataURL(file);
          })
      )
    );
  };

  const addImagesToCheckDraftItem = (id: string, fileList: FileList | null) => {
    void readCheckImageFiles(fileList).then((images) => {
      if (images.length === 0) {
        return;
      }

      setCheckDraftItems((current) =>
        current.map((item) => (item.id === id ? { ...item, images: [...item.images, ...images] } : item))
      );
    });
  };

  const addImagesToLatestCheckDraftItem = (fileList: FileList | null) => {
    const latestItem = checkDraftItems.at(-1);
    if (!latestItem) {
      setError("Önce çek / senet satırını tamamlayın, ardından resim ekleyin.");
      return;
    }

    addImagesToCheckDraftItem(latestItem.id, fileList);
  };

  const handleCheckEntryKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || isFormDisabled) {
      return;
    }

    event.preventDefault();
    addCheckDraftItem();
  };

  const submitCollection = () => {
    if (!selectedCustomer) {
      return;
    }

    if (method === "check" && !editingCollection) {
      addCheckDraftItem();
      return;
    }

    setError(null);

    const validationMessage = getCollectionClientValidationMessage({
      method,
      amount,
      date,
      bankName,
      checkNo,
      dueDate,
      checkValorDays,
      posBank,
      factoryPos,
    });

    if (validationMessage) {
      setError(validationMessage);
      return;
    }

    setSaving(true);

    const baseReferenceFields =
      editingCollection && getFormMethodFromCollection(editingCollection) === method
        ? cleanReferenceFields(editingCollection.reference_fields)
        : {};
    const submitReferenceFields = {
      ...baseReferenceFields,
      ...referenceFields,
    };
    const submitPayload = {
      method: method === "factory_cc" ? "cc" as const : method,
      amount: toAmount(amount),
      currency: customerDebtCurrency,
      date,
      reference_fields: Object.keys(submitReferenceFields).length ? submitReferenceFields : undefined,
      meta: buildPointCollectionMeta(),
    };

    if (editingCollection) {
      void updateCustomerCollection(selectedCustomer.id, editingCollection.id, submitPayload)
        .then(() => {
          setReceiptActionsUnlocked(false);
          setEditingCollection(null);
          resetCollectionForm();
          fetchList(page);
          refreshPointDayEnd();
        })
        .catch((err) => setError(getCollectionApiErrorMessage(err)))
        .finally(() => setSaving(false));
      return;
    }

    void createCustomerCollection(selectedCustomer.id, submitPayload)
      .then(() => {
        setReceiptActionsUnlocked(false);
        resetCollectionForm();
        setPage(1);
        fetchList(1);
        refreshPointDayEnd();
      })
      .catch((err) => setError(getCollectionApiErrorMessage(err)))
      .finally(() => setSaving(false));
  };

  const submitCheckDraftItems = () => {
    if (!selectedCustomer) {
      return;
    }

    if (checkDraftItems.length === 0) {
      setError("Önce en az bir çek / senet tamamlayın.");
      return;
    }

    if (checkDraftMissingImages) {
      setError("Çek / senet tahsilatı göndermek için her satıra en az bir resim ekleyin.");
      return;
    }

    setSaving(true);
    setError(null);

    void createCustomerCollection(selectedCustomer.id, {
      method: "check",
      amount: checkDraftTotal,
      currency: customerDebtCurrency,
      date: checkDraftItems[0]?.date ?? date,
      note: note || checkDraftItems.find((item) => item.note.trim())?.note || undefined,
      reference_fields: buildCombinedCheckReferenceFields(checkDraftItems),
      meta: buildPointCollectionMeta(),
    })
      .then(() => {
        setReceiptActionsUnlocked(false);
        setCheckDraftItems([]);
        resetCheckDraftForm();
        setPage(1);
        fetchList(1);
        refreshPointDayEnd();
      })
      .catch((err) => setError(getCollectionApiErrorMessage(err)))
      .finally(() => setSaving(false));
  };

  const sendCollections = () => {
    if (!selectedCustomer) {
      return;
    }

    const collectionIds = sendableRows.map((row) => row.id);
    if (collectionIds.length === 0) {
      setError("Gönderilecek uygun tahsilat bulunamadı.");
      return;
    }

    setError(null);
    setSendingCollections(true);

    void sendCustomerCollections(selectedCustomer.id, collectionIds)
      .then(() => {
        setReceiptActionsUnlocked(true);
        fetchList(page);
      })
      .catch((err) => setError(getCollectionSendErrorMessage(err)))
      .finally(() => setSendingCollections(false));
  };

  const deleteCollection = (row: CollectionRecord) => {
    if (!selectedCustomer || !isEditableCollection(row)) {
      setError("Bu tahsilat Logo gönderim durumundan dolayı silinemez.");
      return;
    }

    const confirmed = window.confirm(`${getCollectionMethodLabel(row)} tahsilatını silmek istiyor musunuz?`);
    if (!confirmed) {
      return;
    }

    setError(null);
    setDeletingCollectionId(row.id);

    void deleteCustomerCollection(selectedCustomer.id, row.id)
      .then(() => {
        if (editingCollection?.id === row.id) {
          setEditingCollection(null);
          resetCollectionForm();
        }
        setReceiptActionsUnlocked(false);
        fetchList(page);
        refreshPointDayEnd();
      })
      .catch((err) => setError(getCollectionApiErrorMessage(err)))
      .finally(() => setDeletingCollectionId(null));
  };

  const printCollections = () => {
    window.print();
  };

  const openWhatsappReceiptText = (popup?: Window | null) => {
    if (!collectionReceiptText) {
      return;
    }

    const phone = normalizeWhatsAppPhone(selectedCustomer?.phone);
    const url = phone
      ? `https://wa.me/${phone}?text=${encodeURIComponent(collectionReceiptText)}`
      : `https://wa.me/?text=${encodeURIComponent(collectionReceiptText)}`;

    if (popup) {
      popup.location.href = url;
      popup.opener = null;
      return;
    }

    const whatsappPopup = window.open(url, "_blank");

    if (!whatsappPopup) {
      setError("WhatsApp penceresi açılamadı. Tarayıcı popup iznini kontrol edin.");
      return;
    }

    whatsappPopup.opener = null;
  };

  const downloadReceiptScreenshot = (blob: Blob) => {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const customerCode = selectedCustomer?.code.replace(/[^\w-]+/g, "-") || "cari";
    link.href = objectUrl;
    link.download = `powersa-son-tahsilat-${customerCode}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 20_000);
  };

  const sendCollectionReceiptWhatsapp = () => {
    if (!collectionReceiptText || sharingReceiptScreenshot) {
      return;
    }

    const popup = window.open("", "_blank");
    setError(null);
    setSharingReceiptScreenshot(true);

    void (async () => {
      const element = collectionReceiptCaptureRef.current;
      if (!element) {
        throw new Error("Son tahsilat alanı bulunamadı.");
      }

      const { default: html2canvas } = await import("html2canvas");
      const canvas = await html2canvas(element, {
        backgroundColor: "#08121b",
        logging: false,
        scale: Math.min(window.devicePixelRatio || 1, 2),
        useCORS: true,
      });
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => {
          if (value) {
            resolve(value);
            return;
          }
          reject(new Error("Ekran görüntüsü oluşturulamadı."));
        }, "image/png");
      });
      const file = new File([blob], `powersa-son-tahsilat-${selectedCustomer?.code || "cari"}.png`, {
        type: "image/png",
      });
      const sharePayload = {
        files: [file],
        text: collectionReceiptText,
        title: "Powersa Son Tahsilat",
      };
      const canShareImage =
        typeof navigator.share === "function" &&
        typeof navigator.canShare === "function" &&
        navigator.canShare({ files: [file] });

      if (canShareImage) {
        popup?.close();
        await navigator.share(sharePayload);
        return;
      }

      downloadReceiptScreenshot(blob);
      openWhatsappReceiptText(popup);
      setError("Son tahsilat ekran görüntüsü indirildi. WhatsApp açıldığında PNG dosyasını sohbete ekleyin.");
    })()
      .catch((err) => {
        popup?.close();
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        setError(err instanceof Error ? err.message : "Son tahsilat ekran görüntüsü hazırlanamadı.");
      })
      .finally(() => setSharingReceiptScreenshot(false));
  };

  return (
    <>
    <div className="admin-collections-page">
      <div className="grid gap-4 xl:grid-cols-[minmax(520px,0.92fr)_minmax(520px,1fr)] xl:items-start">
        <Card className={cn(shellCardClassName, "xl:sticky xl:top-[116px]")}>
          <CardContent className="space-y-5 p-5 lg:p-6">
            {editingCollection ? (
              <div className="flex items-center justify-between gap-3 rounded-[14px] border border-amber-300/30 bg-amber-300/10 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-black text-amber-100">Tahsilat düzenleniyor</p>
                  <p className="mt-0.5 truncate text-xs font-bold text-amber-100/75">
                    {getCollectionMethodLabel(editingCollection)} · {formatAmount(editingCollection.amount, editingCollection.currency)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 rounded-[12px] border-amber-200/40 bg-transparent px-3 text-xs font-black text-amber-100 hover:bg-amber-200/10 hover:text-amber-50"
                  onClick={cancelCollectionEdit}
                  disabled={isFormDisabled}
                >
                  <X className="h-4 w-4" />
                  Vazgeç
                </Button>
              </div>
            ) : null}

            <div className="space-y-2">
              <label className={fieldLabelClassName}>Ödeme Yöntemi</label>
              <div className={cn("grid grid-cols-2 gap-3", isPointUser ? "md:grid-cols-3" : "md:grid-cols-5")}>
                {visibleMethods.map((value) => (
                  <button
                    key={value}
                    type="button"
                    disabled={isFormDisabled}
                    onClick={() => setMethod(value)}
                    className={cn(
                      "flex min-h-[82px] flex-col items-center justify-center gap-2 rounded-[16px] border px-2 text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-60",
                      method === value
                        ? METHOD_STYLES[value].active
                        : METHOD_STYLES[value].idle
                    )}
                  >
                    <FormMethodIcon method={value} />
                    {METHOD_LABELS[value]}
                  </button>
                ))}
              </div>
            </div>

            {method === "transfer" ? (
              <div className="space-y-2">
                <label className={fieldLabelClassName}>Banka</label>
                <div className="grid grid-cols-2 gap-3">
                  {bankOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      disabled={isFormDisabled}
                      onClick={() => setPosBank(option.value)}
                      className={cn(
                        "flex min-h-[62px] items-center justify-center gap-2 rounded-[16px] border px-4 text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-60",
                        posBank === option.value
                          ? "border-sky-300/70 bg-sky-300/14 text-sky-100 shadow-[0_18px_34px_-30px_rgba(56,189,248,0.7)]"
                          : "border-white/10 bg-white/[0.035] text-slate-300 hover:border-sky-300/35 hover:bg-sky-300/8 hover:text-sky-100"
                      )}
                    >
                      <Landmark className="h-5 w-5" />
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {method !== "check" ? (
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-[minmax(0,1.15fr)_190px]">
                  <div className="space-y-1">
                    <label className="block text-xs font-black uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
                      Tutar
                    </label>
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={amount}
                      disabled={isFormDisabled}
                      onChange={(event) => setAmount(formatAmountInput(event.target.value))}
                      placeholder="0,00"
                      className="h-16 rounded-[14px] border-[var(--brand-border)] bg-[var(--surface-soft)] text-3xl font-black text-[var(--brand-primary-strong)] placeholder:text-[var(--muted-foreground)]"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-xs font-black uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
                      Tarih
                    </label>
                    <Input
                      type="date"
                      value={date}
                      readOnly
                      aria-readonly="true"
                      disabled={isFormDisabled}
                      className="h-16 cursor-not-allowed rounded-[14px] border-[var(--brand-border)] bg-[var(--surface-soft)] text-base font-black text-[var(--brand-primary-strong)]"
                    />
                  </div>
                </div>
              </div>
            ) : null}

            <div className="grid gap-3 md:grid-cols-2" onKeyDown={method === "check" ? handleCheckEntryKeyDown : undefined}>
              {method === "check" ? (
                <>
                  <div className="flex min-h-14 items-center justify-between gap-3 rounded-[14px] border border-amber-300/30 bg-amber-300/10 px-4 md:col-span-2">
                    <span className="text-[11px] font-black uppercase tracking-[0.11em] text-amber-200">
                      Valör Hesabı
                    </span>
                    <span className="text-lg font-black text-amber-100">
                      {checkValorDays ? `${checkValorDays} Gün` : "-"}
                    </span>
                  </div>
                  <div className={fieldShellClassName}>
                    <label className={fieldLabelClassName}>
                      Tutar
                    </label>
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={amount}
                      disabled={isFormDisabled}
                      onChange={(event) => setAmount(formatAmountInput(event.target.value))}
                      placeholder="0,00"
                      className={fieldClassName}
                    />
                  </div>
                  <div className={fieldShellClassName}>
                    <label className={fieldLabelClassName}>
                      Vade Tarihi
                    </label>
                    <Input
                      type="date"
                      value={dueDate}
                      disabled={isFormDisabled}
                      onChange={(event) => updateCheckDueDate(event.target.value)}
                      className={fieldClassName}
                    />
                  </div>
                  <div className={fieldShellClassName}>
                    <label className={fieldLabelClassName}>
                      Banka Adı
                    </label>
                    <Input
                      value={bankName}
                      disabled={isFormDisabled}
                      onChange={(event) => setBankName(event.target.value)}
                      placeholder=""
                      className={fieldClassName}
                    />
                  </div>
                  <div className={fieldShellClassName}>
                    <label className={fieldLabelClassName}>
                      Çek / Senet No
                    </label>
                    <Input
                      value={checkNo}
                      disabled={isFormDisabled}
                      onChange={(event) => setCheckNo(event.target.value)}
                      placeholder=""
                      className={fieldClassName}
                    />
                  </div>
                  <div className="md:col-span-2">
                    {checkValorNeedsManagerApproval ? (
                      <p className="rounded-[12px] border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-xs font-semibold text-amber-200">
                        60 günü aşan valör müdür onayına gönderilir.
                      </p>
                    ) : null}
                  </div>
                </>
              ) : null}

              {method === "cc" || method === "factory_cc" ? (
                <>
                  <div className={cn(fieldShellClassName, "md:col-span-2")}>
                    <label className={cn(fieldLabelClassName, "flex items-center justify-between")}>
                      <span>{method === "factory_cc" ? "Cari Pos Seçimi" : "Banka"}</span>
                      {isAdminUser && method === "factory_cc" ? (
                        <AddFactoryPosModal onAdd={handleRefreshFinanceDefinitions} />
                      ) : isAdminUser ? (
                        <AddBankModal onAdd={handleRefreshFinanceDefinitions} />
                      ) : null}
                    </label>
                    <Select
                      value={method === "factory_cc" ? factoryPos : posBank}
                      onValueChange={(value) => {
                        if (method === "factory_cc") {
                          setFactoryPos(value as FactoryPosType);
                          return;
                        }
                        setPosBank(value as PosBankType);
                      }}
                      disabled={isFormDisabled}
                    >
                      <SelectTrigger className={fieldClassName}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(method === "factory_cc" ? factoryOptions : bankOptions).map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {method === "cc" ? (
                    <p className="rounded-[14px] border border-rose-300/20 bg-rose-300/[0.06] px-4 py-3 text-xs font-bold text-rose-100">
                      Fiziksel POS tahsilatında sadece banka seçimi Logo sistemine gönderilir.
                    </p>
                  ) : null}
                </>
              ) : null}

              {method === "cash" ? (
                <div className={cn(fieldShellClassName, "md:col-span-2")}>
                  <label className={fieldLabelClassName}>
                    Açıklama
                  </label>
                  <Textarea
                    value={editingCollection?.note ?? note}
                    onChange={(event) => setNote(event.target.value)}
                    disabled={isFormDisabled}
                    placeholder="Nakit tahsilat açıklaması"
                    className={cn(fieldClassName, "h-auto min-h-[58px] py-2")}
                  />
                </div>
              ) : null}
            </div>

            {method === "check" ? (
              <div className="space-y-2 rounded-[14px] border border-amber-300/18 bg-amber-300/[0.035] p-2.5">
                <div className="flex items-center justify-between gap-3 px-0.5">
                  <p className="text-[13px] font-black text-amber-100">Tamamlanan Çek / Senetler</p>
                  <p className="whitespace-nowrap text-[13px] font-black text-amber-100">{formatAmount(checkDraftTotal, customerDebtCurrency)}</p>
                </div>
                <label
                  className={cn(
                    "flex min-h-[42px] cursor-pointer items-center justify-between gap-3 rounded-[12px] border border-dashed px-3 py-2 text-xs font-black transition",
                    checkDraftItems.length > 0 && !isFormDisabled
                      ? "border-red-300/35 bg-red-400/10 text-red-100 hover:border-red-200/60 hover:bg-red-400/15"
                      : "cursor-not-allowed border-white/10 bg-white/[0.025] text-slate-500"
                  )}
                >
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <ImagePlus className="h-3.5 w-3.5 shrink-0" />
                    <span className="whitespace-nowrap">
                      {checkDraftItems.length > 0 ? "Resim yükle" : "Resim alanı hazır"}
                    </span>
                  </span>
                  <span className="whitespace-nowrap text-[11px] text-[var(--muted-foreground)]">
                    {checkDraftItems.length > 0 ? "Son satıra" : "Önce satır ekleyin"}
                  </span>
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    disabled={isFormDisabled || checkDraftItems.length === 0}
                    onChange={(event) => {
                      addImagesToLatestCheckDraftItem(event.target.files);
                      event.target.value = "";
                    }}
                    className="sr-only"
                  />
                </label>
                {checkDraftItems.length === 0 ? (
                  <p className="rounded-[12px] border border-dashed border-amber-300/20 px-3 py-3 text-center text-xs font-semibold text-[var(--muted-foreground)]">
                    Henüz tamamlanan çek / senet yok.
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-[12px] border border-white/10">
                    <table className="min-w-[640px] w-full border-collapse text-left text-xs">
                      <thead className="bg-white/[0.055] text-[9px] font-black uppercase tracking-[0.08em] text-slate-400">
                        <tr>
                          <th className="px-2.5 py-2">Vade</th>
                          <th className="px-2.5 py-2">No</th>
                          <th className="px-2.5 py-2">Banka</th>
                          <th className="px-2.5 py-2 text-right">Tutar</th>
                          <th className="px-2.5 py-2">Valör</th>
                          <th className="px-2.5 py-2">Resim</th>
                          <th className="px-2.5 py-2 text-right">İşlem</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/10">
                        {checkDraftItems.map((item) => {
                          const needsApproval = Number(item.valorDays) > STANDARD_VALOR_DAY_LIMIT;
                          const missingImage = item.images.length === 0;

                          return (
                            <tr
                              key={item.id}
                              className={cn(
                                "bg-white/[0.025] text-slate-200",
                                missingImage && "bg-red-500/[0.055] ring-1 ring-inset ring-red-300/15"
                              )}
                            >
                              <td className="whitespace-nowrap px-2.5 py-2 font-bold">{formatLedgerDate(item.dueDate)}</td>
                              <td className="whitespace-nowrap px-2.5 py-2 font-bold">{item.checkNo}</td>
                              <td className="whitespace-nowrap px-2.5 py-2 text-slate-300">{item.bankName}</td>
                              <td className="whitespace-nowrap px-2.5 py-2 text-right font-black text-slate-100">
                                {formatAmount(item.amount, customerDebtCurrency)}
                              </td>
                              <td className="whitespace-nowrap px-2.5 py-2 text-slate-300">{item.valorDays} gün</td>
                              <td className="whitespace-nowrap px-2.5 py-2">
                                <label
                                  className={cn(
                                    "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[10px] border px-2.5 text-[11px] font-black shadow-lg transition hover:-translate-y-0.5",
                                    missingImage
                                      ? "border-red-200/70 bg-red-300 text-red-950 shadow-red-950/25 hover:bg-red-200"
                                      : "border-emerald-200/50 bg-emerald-300 text-emerald-950 shadow-emerald-950/20 hover:bg-emerald-200"
                                  )}
                                >
                                  <ImagePlus className="h-3.5 w-3.5" />
                                  Resim
                                  <input
                                    type="file"
                                    accept="image/*"
                                    multiple
                                    disabled={isFormDisabled}
                                    onChange={(event) => {
                                      addImagesToCheckDraftItem(item.id, event.target.files);
                                      event.target.value = "";
                                    }}
                                    className="sr-only"
                                  />
                                </label>
                                <span
                                  className={cn(
                                    "ml-1.5 text-[11px] font-bold",
                                    missingImage ? "text-red-200" : "text-slate-400"
                                  )}
                                >
                                  {item.images.length > 0 ? `${item.images.length}` : "Zorunlu"}
                                </span>
                                {needsApproval ? (
                                  <span className="ml-1.5 rounded-full border border-amber-300/40 bg-amber-300/10 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-[0.06em] text-amber-200">
                                    Onay
                                  </span>
                                ) : null}
                              </td>
                              <td className="whitespace-nowrap px-2.5 py-1.5 text-right">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  className="h-8 rounded-[9px] px-2 text-[11px] font-black text-red-200 hover:bg-red-300/10 hover:text-red-100"
                                  disabled={isFormDisabled}
                                  onClick={() => removeCheckDraftItem(item.id)}
                                >
                                  Sil
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot className="border-t border-white/10 bg-white/[0.045]">
                        <tr>
                          <td className="px-2.5 py-2 text-[10px] font-black uppercase tracking-[0.08em] text-slate-400" colSpan={3}>
                            Toplam
                          </td>
                          <td className="whitespace-nowrap px-2.5 py-2 text-right font-black text-amber-100">
                            {formatAmount(checkDraftTotal, customerDebtCurrency)}
                          </td>
                          <td className="whitespace-nowrap px-2.5 py-2 text-center font-black text-amber-100">
                            {checkDraftValorTotal} gün
                          </td>
                          <td className="px-2.5 py-2" colSpan={2} />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
                {checkDraftItems.length > 0 && checkDraftMissingImages ? (
                  <p className="rounded-[12px] border border-red-300/25 bg-red-500/10 px-3 py-2 text-sm font-black text-red-100">
                    Resim eklenmeyen çek / senet satırı gönderilemez.
                  </p>
                ) : null}
              </div>
            ) : null}

            {error ? (
              <p className="rounded-[14px] border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-600">
                {error}
              </p>
            ) : null}

            <Button
              className={cn(
                "admin-danger-action h-12 w-full rounded-[14px] text-sm font-black",
                checkValorNeedsManagerApproval && "from-amber-300 to-amber-600"
              )}
              disabled={isFormDisabled}
              onClick={method === "check" && checkDraftItems.length > 0 ? submitCheckDraftItems : submitCollection}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {saving
                ? "Kaydediliyor..."
                : editingCollection
                  ? "Tahsilatı Güncelle"
                  : method === "check"
                    ? checkDraftItems.length > 0
                      ? "Çek / Senetleri Gönder"
                      : "Çek / Senet Ekle"
                    : checkValorNeedsManagerApproval
                      ? "Müdüre Onaya Gönder"
                      : "Tahsilatı Kaydet"}
            </Button>
          </CardContent>
        </Card>

        <Card className={shellCardClassName}>
          <CardContent className="space-y-4 p-5 lg:p-6">
            <div
              ref={collectionReceiptCaptureRef}
              className="space-y-4 rounded-[20px] bg-[rgba(8,18,27,0.96)]"
            >
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-12 w-12 items-center justify-center rounded-[15px] border border-[var(--brand-border)] bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]">
                    <Wallet className="h-5 w-5" />
                  </span>
                  <p className="text-2xl font-black leading-tight text-[var(--brand-primary-strong)]">Son Tahsilatlar</p>
                </div>
                <Button
                  className="h-12 rounded-[12px]"
                  variant="outline"
                  disabled={isListDisabled}
                  onClick={() => {
                    setPage(1);
                    fetchList(1);
                  }}
                >
                  {listLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                  Yenile
                </Button>
              </div>

              {listLoading && !payload ? (
                <div className="space-y-3">
                  {Array.from({ length: 5 }).map((_, index) => (
                    <Skeleton key={`collection-list-skeleton-${index}`} className="h-20 w-full rounded-[18px]" />
                  ))}
                </div>
              ) : !selectedCustomer ? (
                <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-[18px] border border-dashed border-[var(--brand-border)] bg-[var(--surface-soft)] p-6 text-center">
                  <UserRound className="h-10 w-10 text-[var(--brand-primary)]" />
                  <p className="text-2xl font-black text-[var(--brand-primary-strong)]">Müşteri seç</p>
                  <Button asChild className="rounded-[12px]">
                    <Link href="/customers">Müşteriler</Link>
                  </Button>
                </div>
              ) : displayRows.length === 0 ? (
                <div className="flex min-h-[180px] items-center justify-center rounded-[18px] bg-[var(--surface-soft)] p-6 text-center">
                  <p className="text-2xl font-black text-[var(--brand-primary-strong)]">Kayıt yok</p>
                </div>
              ) : (
                <div className="max-h-[680px] space-y-2 overflow-y-auto pr-1">
                  {displayRows.map((row) => {
                    const editable = isEditableCollection(row);
                    const isDeleting = deletingCollectionId === row.id;
                    const referenceFields = getCollectionReferenceFields(row);
                    const imagePreviews = getCollectionImagePreviews(row);
                    const primaryImage = imagePreviews[0] ?? null;
                    const displayNote = getCollectionDisplayNote(row);

                    return (
                      <div
                        key={row.id}
                        className="flex flex-col gap-3 rounded-[16px] border border-[var(--brand-border)] bg-[var(--surface)] p-3 shadow-[0_14px_28px_-26px_rgba(0,0,0,0.2)] transition-colors hover:border-[var(--brand-primary)]/50 hover:bg-[color-mix(in_oklab,var(--brand-primary)_7%,var(--surface))] sm:flex-row sm:items-center"
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-4">
                          {primaryImage ? (
                            <button
                              type="button"
                              onClick={() => setPreviewImage(primaryImage)}
                              className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-[14px] border border-amber-200/35 bg-white/[0.04] shadow-[0_12px_26px_-20px_rgba(0,0,0,0.85)] transition hover:-translate-y-0.5 hover:border-amber-100/80"
                              title={primaryImage.checkNo ? `${primaryImage.checkNo} · ${primaryImage.name}` : primaryImage.name}
                            >
                              <img
                                src={primaryImage.data}
                                alt={primaryImage.name}
                                className="h-full w-full object-cover transition group-hover:scale-105"
                              />
                              {imagePreviews.length > 1 ? (
                                <span className="absolute bottom-1 right-1 rounded-full bg-black/70 px-1.5 py-0.5 text-[9px] font-black text-white">
                                  +{imagePreviews.length - 1}
                                </span>
                              ) : null}
                            </button>
                          ) : (
                            <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] border border-[var(--brand-border)] bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]">
                              {row.method === "cc" && referenceFields.collection_channel === "factory" ? (
                                <Factory className="h-6 w-6" />
                              ) : (
                                <MethodIcon method={row.method} />
                              )}
                            </span>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-base font-black text-[var(--brand-primary-strong)]">{getCollectionMethodLabel(row)}</p>
                              <span
                                className={cn(
                                  "rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.08em]",
                                  row.sync_status === "synced"
                                    ? "border-emerald-300/40 bg-emerald-300/10 text-emerald-200"
                                    : row.sync_status === "pending"
                                      ? "border-sky-300/40 bg-sky-300/10 text-sky-200"
                                      : row.sync_status === "reviewing"
                                        ? "border-amber-300/40 bg-amber-300/10 text-amber-200"
                                        : row.sync_status === "failed"
                                          ? "border-red-300/40 bg-red-300/10 text-red-200"
                                          : "border-amber-300/40 bg-amber-300/10 text-amber-200"
                                )}
                              >
                                {getCollectionStatusLabel(row)}
                              </span>
                            </div>
                            <p className="mt-1 truncate text-sm font-semibold text-[var(--muted-foreground)]">
                              {formatLedgerDate(row.date)}
                              {row.reference_no ? ` · ${row.reference_no}` : ""}
                            </p>
                            {row.method === "cc" && referenceFields.collection_channel === "factory" ? (
                              <p className="mt-1 truncate text-sm font-semibold text-orange-200">
                                Fabrika kart çekimi
                              </p>
                            ) : null}
                            {row.method === "transfer" && referenceFields.bank_name ? (
                              <p className="mt-1 truncate text-sm font-semibold text-sky-200">
                                Banka: {String(referenceFields.bank_name)}
                              </p>
                            ) : null}
                            {row.method === "cc" &&
                            referenceFields.collection_channel !== "factory" &&
                            referenceFields.pos_bank ? (
                              <p className="mt-1 truncate text-sm font-semibold text-rose-200">
                                Banka: {bankOptions.find((option) => option.value === referenceFields.pos_bank)?.label ?? getPosBankLabel(String(referenceFields.pos_bank))}
                              </p>
                            ) : null}
                            {displayNote ? (
                              <p className="mt-1 max-w-[42rem] text-sm leading-snug text-[var(--muted-foreground)]">
                                {displayNote}
                              </p>
                            ) : null}
                            {row.sync_status === "failed" && row.sync_error ? (
                              <p className="mt-1 line-clamp-2 text-xs font-semibold text-red-300">{row.sync_error}</p>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center justify-between gap-3 sm:flex-col sm:items-end">
                          <p className="text-right text-xl font-black text-[var(--brand-primary-strong)]">
                            {formatAmount(String(row.amount), String(row.currency))}
                          </p>
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              className="h-9 rounded-[10px] px-3 text-xs font-black"
                              disabled={!editable || isListDisabled}
                              onClick={() => startCollectionEdit(row)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              Düzenle
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              className="h-9 rounded-[10px] border-red-300/35 px-3 text-xs font-black text-red-200 hover:bg-red-300/10 hover:text-red-100"
                              disabled={!editable || isListDisabled}
                              onClick={() => deleteCollection(row)}
                            >
                              {isDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                              Sil
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {selectedCustomer && payload ? (
                <div className="grid gap-2 rounded-[16px] border border-[var(--brand-border)] bg-[linear-gradient(180deg,rgba(13,27,36,0.92)_0%,rgba(8,18,27,0.96)_100%)] p-2 shadow-[0_18px_34px_-30px_rgba(0,0,0,0.55)] md:grid-cols-3">
                  {[
                    { label: "Cari Bakiye", value: formatAmount(customerDebtAmount, customerDebtCurrency), tone: "text-[var(--brand-primary-strong)]", sub: customerDebtStatus },
                    { label: "İşlem Toplamı", value: formatAmount(collectionGrandTotal, collectionSummaryCurrency), tone: "text-emerald-100", sub: `${displayRows.length} kayıt` },
                    { label: "Güncel Bakiye", value: formatAmount(currentDebtAfterCollections, customerDebtCurrency), tone: "text-amber-100", sub: balanceSourceLabel },
                  ].map((card) => (
                    <div
                      key={card.label}
                      className="grid min-h-[58px] grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-1 rounded-[12px] border border-white/10 bg-white/[0.035] px-3 py-2"
                    >
                      <span className="whitespace-nowrap text-[9px] font-black uppercase tracking-[0.06em] text-slate-500">{card.label}</span>
                      <strong className={cn("justify-self-end whitespace-nowrap text-xl font-black leading-none", card.tone)}>{card.value}</strong>
                      <span className="col-span-2 whitespace-nowrap text-[10px] font-black uppercase tracking-[0.05em] text-[var(--muted-foreground)]">{card.sub}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            {selectedCustomer && displayRows.length > 0 ? (
              <div
                className={cn(
                  "grid gap-2 rounded-[16px] border border-[var(--brand-border)] bg-[var(--surface)] p-3",
                  "sm:grid-cols-[minmax(0,0.9fr)_minmax(0,0.75fr)_minmax(0,1.05fr)]"
                )}
              >
                <Button
                  type="button"
                  disabled={isListDisabled || displayRows.length === 0 || sharingReceiptScreenshot || !canUseReceiptActions}
                  onClick={sendCollectionReceiptWhatsapp}
                  className="h-11 rounded-[12px] bg-emerald-500 text-sm font-black text-white hover:bg-emerald-400 disabled:border disabled:border-white/10 disabled:bg-white/[0.04] disabled:text-slate-500"
                >
                  {sharingReceiptScreenshot ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}
                  {sharingReceiptScreenshot ? "Görsel Hazırlanıyor..." : "WhatsApp"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={listLoading || !canUseReceiptActions}
                  onClick={printCollections}
                  className="h-11 rounded-[12px]"
                >
                  <Printer className="h-4 w-4" />
                  Yazdır
                </Button>
                <Button
                  type="button"
                  disabled={isListDisabled || sendableRows.length === 0}
                  onClick={sendCollections}
                  className="admin-danger-action h-11 w-full rounded-[12px] text-sm font-black disabled:border disabled:border-white/10 disabled:bg-white/[0.04] disabled:text-slate-500"
                >
                  {sendingCollections ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {sendActionLabel}
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
    <Dialog open={previewImage !== null} onOpenChange={(open) => !open && setPreviewImage(null)}>
      <DialogContent className="max-w-4xl border-white/10 bg-[rgba(9,18,27,0.98)] p-0 text-slate-100">
        <DialogHeader className="flex flex-row items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div className="min-w-0">
            <DialogTitle className="truncate text-base font-black text-amber-100">
              {previewImage?.checkNo ? `Çek / Senet Resmi · ${previewImage.checkNo}` : "Çek / Senet Resmi"}
            </DialogTitle>
            {previewImage?.name ? (
              <p className="mt-1 truncate text-xs font-semibold text-slate-400">{previewImage.name}</p>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            className="h-9 w-9 rounded-full p-0 text-slate-300 hover:bg-white/10 hover:text-white"
            onClick={() => setPreviewImage(null)}
          >
            <X className="h-4 w-4" />
          </Button>
        </DialogHeader>
        <div className="max-h-[78vh] overflow-auto p-3">
          {previewImage ? (
            <img
              src={previewImage.data}
              alt={previewImage.name}
              className="mx-auto max-h-[74vh] w-auto max-w-full rounded-[14px] border border-white/10 object-contain shadow-[0_24px_60px_-34px_rgba(0,0,0,0.9)]"
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}
