"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  PlusCircle,
  ReceiptText,
  RefreshCcw,
  ArrowLeft,
  Pencil,
  Send,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { useSession } from "@/components/auth/session-provider";
import {
  createPosExpense,
  getCurrentPosSession,
  listPosExpenses,
  listFinanceDefinitions,
  openPosSession,
  type FinanceDefinitionDto,
  type PosExpenseDto,
} from "@/lib/api";
import { notifyPosDayEndRefresh } from "@/lib/pos-day-end-events";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const BATUM_CURRENCY_LABEL = "GEL";
const DEFAULT_CURRENCY_LABEL = "TL";

const BATUM_EXPENSE_ACCOUNTS = [
  ["196-00-001", "MAAŞ-AVANS NATA"],
  ["196-00-002", "MAAŞ-AVANS GIGA"],
  ["397-00-001", "KASA SAYIM VE TESLİM FAZLALARI BATUM"],
  ["612-00-001", "CARİLERDEN DÜŞÜLEN İSKONTOLAR BATUM"],
  ["760-00-001", "FC-025-FC TOYOTA PRIUS BAKIM-YIKAMA-SERVİS"],
  ["760-00-003", "FC-025-FC TOYOTA PRIUS YAKIT GİDERİ"],
  ["760-00-005", "FC-010-FC PORCHE BAKIM-YIKAMA-SERVİS-CEZA"],
  ["760-00-006", "FC-010-FC PORCHE YAKIT GİDERİ"],
  ["760-00-004", "PAZARLAMA YOL GİDERLERİ BATUM"],
  ["770-00-001", "ELEKTRİK GİDERİ BATUM"],
  ["770-00-002", "SU GİDERİ BATUM"],
  ["770-00-003", "TELEFON GİDERİ BATUM"],
  ["770-00-004", "SSK GİDERİ BATUM"],
  ["770-00-005", "İNTERNET-WINN GİDERİ BATUM"],
  ["770-00-009", "TEMİZLİK GİDERİ BATUM"],
  ["770-00-012", "DOĞALGAZ GİDERİ BATUM"],
  ["770-00-013", "KİRA GİDERİ BATUM"],
  ["770-00-014", "İŞYERİ BAKIM TAMİR GİDERİ BATUM"],
  ["770-00-019", "NAKLİYECİ GİDERİ BATUM"],
  ["770-00-021", "MUHASEBECİ GİDERİ BATUM"],
  ["770-00-024", "BATUM GÜMRÜK GİDERLERİ"],
  ["770-00-018", "BANKA MASRAF KESİNTİLERİ"],
] as const;

const BATUM_BANK_EXPENSE_ACCOUNTS = [
  ["108-00-001", "BANK OF GEORGIA BATUM"],
  ["108-00-002", "TBC BANK BATUM"],
] as const;

const expenseSchema = z.object({
  amount: z.number().gt(0),
  categoryId: z.number().int().optional(),
  note: z.string().max(255).optional(),
});

type ExpenseFormValues = z.infer<typeof expenseSchema>;
type ExpenseCategoryOption = Pick<FinanceDefinitionDto, "code" | "name" | "logo_code" | "logo_name"> & {
  id: number;
  sort_order?: number | null;
};

type ExpenseDraft = {
  id: string;
  categoryId: number;
  categoryCode: string;
  categoryName: string;
  logoCode: string;
  logoName: string;
  amount: number;
  note: string;
  createdAt: string;
  paymentSourceType?: "cash" | "bank";
  paymentSourceCode?: string | null;
  paymentSourceName?: string | null;
  paymentSourceLogoCode?: string | null;
  bankExpenseMode?: boolean;
  bankExpenseAccountCode?: string | null;
  bankExpenseAccountName?: string | null;
  operationKind?: "expense" | "cash_to_bank";
};

type BatumBankOption = {
  code: string;
  name: string;
  logoCode: string;
  logoName: string;
};

function formatCurrency(value: number | string, currencyLabel = DEFAULT_CURRENCY_LABEL): string {
  const amount = typeof value === "number" ? value : Number(value);

  return Number.isFinite(amount)
    ? `${currencyLabel} ${amount.toLocaleString("tr-TR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`
    : "-";
}

function formatMoneyInput(value: string): string {
  const digits = value.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  const padded = (digits || "0").padStart(3, "0");
  return `${Number(padded.slice(0, -2)).toLocaleString("tr-TR")},${padded.slice(-2)}`;
}

function parseMoneyInput(value: string): number {
  const normalized = value.replace(/\./g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function formatLogoOutboundStatus(status: string | null | undefined): string {
  if (status === "synced") {
    return "Logo işlendi";
  }

  if (status === "failed") {
    return "Logo hata";
  }

  if (status === "processing") {
    return "Logo işleniyor";
  }

  return "Logo bekliyor";
}

function expenseSyncLabel(expense: PosExpenseDto): string {
  if (expense.source_system === "logo") {
    return "Logo kaydı";
  }

  return formatLogoOutboundStatus(expense.logo_sync_status);
}

function normalizeBranchText(value: string | null | undefined): string {
  return (value ?? "").trim().toLocaleUpperCase("tr-TR");
}

function hasUserRole(user: ReturnType<typeof useSession>["user"], role: string): boolean {
  return Array.isArray(user?.roles) && user.roles.some((item) => item.slug === role);
}

function titleCaseBranch(value: string | null | undefined): string {
  const trimmed = value?.trim();

  if (!trimmed) {
    return "Point";
  }

  const knownLabels: Record<string, string> = {
    ERZURUM: "Erzurum",
    TRABZON: "Trabzon",
    SAMSUN: "Samsun",
    BATUM: "Batum",
    HIZLI: "Hızlı",
    "HİZLİ": "Hızlı",
    SATIS: "Satış",
    "SATIŞ": "Satış",
    KASASI: "Kasası",
  };

  return trimmed
    .split(/(\s+|[-/])/u)
    .map((part) => {
      if (part.trim() === "" || part === "-" || part === "/") {
        return part;
      }

      const normalized = normalizeBranchText(part);
      if (knownLabels[normalized]) {
        return knownLabels[normalized];
      }

      const lower = part.toLocaleLowerCase("tr-TR");
      return `${lower.charAt(0).toLocaleUpperCase("tr-TR")}${lower.slice(1)}`;
    })
    .join("");
}

function resolveExpenseScope(
  user: ReturnType<typeof useSession>["user"],
  cashbox: PosExpenseDto["cashbox"] | null | undefined
) {
  const userSignals = [
    user?.branch_name,
    user?.branch_code,
    user?.region_code,
  ];
  const cashboxSignals = [
    cashbox?.name,
    cashbox?.code,
  ];
  const isElevatedUser = hasUserRole(user, "admin") || hasUserRole(user, "dealer_admin");
  const isSalesperson = hasUserRole(user, "salesperson");
  const hasUserBranchSignal = userSignals.some((value) => Boolean(value?.trim()));
  const signals = isElevatedUser || isSalesperson || hasUserBranchSignal
    ? userSignals
    : [...userSignals, ...cashboxSignals];
  const isBatum = signals.some((value) => normalizeBranchText(value).includes("BATUM"));
  const branchSource = signals.find((value) => {
    const normalized = normalizeBranchText(value);
    return normalized.includes("ERZURUM") || normalized.includes("TRABZON") || normalized.includes("SAMSUN") || normalized.includes("BATUM");
  });
  const branchLabel = isBatum ? "Batum" : titleCaseBranch(branchSource ?? user?.branch_name ?? user?.branch_code);

  return {
    branchLabel,
    scopeKey: isBatum ? "batum" : normalizeBranchText(branchLabel).toLocaleLowerCase("tr-TR"),
    currencyLabel: isBatum ? BATUM_CURRENCY_LABEL : DEFAULT_CURRENCY_LABEL,
    countryLabel: isBatum ? "Gürcistan" : "Türkiye",
  };
}

function normalizeExpenseAccountCode(value: string | null | undefined): string {
  return (value ?? "").replace(/[^0-9A-ZÇĞİÖŞÜ]+/giu, "").toLocaleUpperCase("tr-TR");
}

function isBatumExpenseDefinition(definition: FinanceDefinitionDto): boolean {
  const haystack = [
    definition.code,
    definition.name,
    definition.logo_code,
    definition.logo_name,
  ].join(" ").toLocaleUpperCase("tr-TR");

  return haystack.includes("BATUM") || BATUM_EXPENSE_ACCOUNTS.some(([code]) =>
    normalizeExpenseAccountCode(definition.logo_code ?? definition.code) === normalizeExpenseAccountCode(code)
  );
}

function buildBatumExpenseOptions(definitions: FinanceDefinitionDto[]): ExpenseCategoryOption[] {
  return BATUM_EXPENSE_ACCOUNTS.map(([logoCode, logoName], index) => {
    const matchedDefinition = definitions.find((definition) =>
      normalizeExpenseAccountCode(definition.logo_code ?? definition.code) === normalizeExpenseAccountCode(logoCode)
      || normalizeExpenseAccountCode(definition.name) === normalizeExpenseAccountCode(logoName)
      || normalizeExpenseAccountCode(definition.logo_name) === normalizeExpenseAccountCode(logoName)
    );

    return {
      id: matchedDefinition?.id ?? -1 * (index + 1),
      code: matchedDefinition?.code ?? `batum_${logoCode.replace(/[^0-9]+/g, "_").replace(/^_+|_+$/g, "")}`,
      name: matchedDefinition?.name ?? logoName,
      logo_code: matchedDefinition?.logo_code ?? logoCode,
      logo_name: matchedDefinition?.logo_name ?? logoName,
      sort_order: matchedDefinition?.sort_order ?? 900 + index,
    };
  });
}

function buildBatumBankExpenseOptions(definitions: FinanceDefinitionDto[]): ExpenseCategoryOption[] {
  const mapped = definitions
    .filter(isBatumBankDefinition)
    .map((definition) => ({
      id: definition.id,
      code: definition.code,
      name: definition.logo_name ?? definition.name,
      logo_code: definition.logo_code ?? definition.code,
      logo_name: definition.logo_name ?? definition.name,
      sort_order: definition.sort_order,
    }));

  if (mapped.length > 0) {
    return mapped;
  }

  return BATUM_BANK_EXPENSE_ACCOUNTS.map(([logoCode, logoName], index) => ({
    id: -1000 - index,
    code: `batum_bank_${logoCode.replace(/[^0-9]+/g, "_").replace(/^_+|_+$/g, "")}`,
    name: logoName,
    logo_code: logoCode,
    logo_name: logoName,
    sort_order: index,
  }));
}

function isBatumBankDefinition(definition: FinanceDefinitionDto): boolean {
  const haystack = [
    definition.code,
    definition.name,
    definition.logo_code,
    definition.logo_name,
  ].join(" ").toLocaleUpperCase("tr-TR");

  return haystack.includes("BATUM") || haystack.includes("GEORGIA") || haystack.includes("TBC");
}

function buildBatumBankOptions(definitions: FinanceDefinitionDto[]): BatumBankOption[] {
  const mapped = definitions
    .filter(isBatumBankDefinition)
    .map((definition) => {
      const name = definition.logo_name ?? definition.name;
      const normalizedName = name.toLocaleUpperCase("tr-TR");
      const normalizedCode = normalizeExpenseAccountCode(definition.logo_code ?? definition.code);
      const canonicalLogoCode = normalizedName.includes("FARUK") && normalizedName.includes("GEORGIA")
        ? "05"
        : normalizedName.includes("TBC") || normalizedCode === "108000002"
        ? "04"
        : (normalizedCode === "108000001"
          || (normalizedName.includes("BANK OF GEORGIA") && !normalizedName.includes("FARUK")))
          ? "03"
          : definition.logo_code ?? definition.code;

      return {
        code: definition.code,
        name,
        logoCode: canonicalLogoCode,
        logoName: name,
      };
    });

  if (mapped.length > 0) {
    return mapped;
  }

  return [
    { code: "georgia_bank", name: "BANK OF GEORGIA BATUM", logoCode: "03", logoName: "BANK OF GEORGIA BATUM" },
    { code: "tbc_bank", name: "TBC BANK BATUM", logoCode: "04", logoName: "TBC BANK BATUM" },
  ];
}

function resolveBatumBankForExpense(
  bankOptions: BatumBankOption[],
  category: ExpenseCategoryOption
): BatumBankOption | null {
  const haystack = [category.code, category.name, category.logo_code, category.logo_name]
    .join(" ")
    .toLocaleUpperCase("tr-TR");

  const exactMatch = bankOptions.find((bank) =>
    normalizeExpenseAccountCode(bank.code) === normalizeExpenseAccountCode(category.code)
    || normalizeExpenseAccountCode(bank.logoCode) === normalizeExpenseAccountCode(category.logo_code)
    || normalizeExpenseAccountCode(bank.name) === normalizeExpenseAccountCode(category.name)
    || normalizeExpenseAccountCode(bank.logoName) === normalizeExpenseAccountCode(category.logo_name)
  );

  if (exactMatch) {
    return exactMatch;
  }

  if (haystack.includes("GEORGIA")) {
    return bankOptions.find((bank) => bank.name.toLocaleUpperCase("tr-TR").includes("GEORGIA")) ?? null;
  }

  if (haystack.includes("TBC")) {
    return bankOptions.find((bank) => bank.name.toLocaleUpperCase("tr-TR").includes("TBC")) ?? null;
  }

  return null;
}

export function PointExpensesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const pointSessionBootstrapAttemptedRef = useRef(false);
  const amountInputRef = useRef<HTMLInputElement | null>(null);
  const [amountInput, setAmountInput] = useState("0,00");
  const [drafts, setDrafts] = useState<ExpenseDraft[]>([]);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [draftsHydrated, setDraftsHydrated] = useState(false);
  const [bankExpenseMode, setBankExpenseMode] = useState(false);
  const [paymentSource, setPaymentSource] = useState("cash");
  const [recentPage, setRecentPage] = useState(1);
  const { user } = useSession();

  useEffect(() => {
    setBankExpenseMode(new URLSearchParams(window.location.search).get("mode") === "bank");
  }, []);

  const form = useForm<ExpenseFormValues>({
    resolver: zodResolver(expenseSchema),
    defaultValues: {
      amount: 0,
      categoryId: undefined,
      note: "",
    },
  });

  const currentSessionQuery = useQuery({
    queryKey: ["pos", "session", "current"],
    queryFn: () => getCurrentPosSession(),
    refetchInterval: 20_000,
    enabled: !hasUserRole(user, "salesperson"),
  });
  const isSalesperson = hasUserRole(user, "salesperson");
  const definitionsQuery = useQuery({
    queryKey: ["finance-definitions", "expense_category", user?.id ?? "guest"],
    queryFn: () => listFinanceDefinitions("expense_category"),
    enabled: Boolean(user),
  });
  const selectedCategoryId = form.watch("categoryId");

  const openSessionMutation = useMutation({
    mutationFn: openPosSession,
    onSuccess: () => {
      void currentSessionQuery.refetch();
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "POS oturumu hazırlanamadı";
      toast.error(message);
    },
  });

  const currentSession = currentSessionQuery.data?.data ?? null;
  const currentCashbox = currentSession?.cashbox ?? null;
  const expenseScope = resolveExpenseScope(user, currentCashbox);
  const batumBanksQuery = useQuery({
    queryKey: ["finance-definitions", "bank", "batum"],
    queryFn: () => listFinanceDefinitions("bank", false, "batum"),
    enabled: expenseScope.scopeKey === "batum",
    staleTime: 300_000,
  });
  const activeUserKey = user?.id ?? user?.username ?? "guest";
  const draftStorageKey = `powersa:pos-expense-drafts:${activeUserKey}:${expenseScope.scopeKey}:${bankExpenseMode ? "bank" : "general"}`;
  const expenseCategories = useMemo<ExpenseCategoryOption[]>(() => {
    const definitions = definitionsQuery.data?.data ?? [];

    if (bankExpenseMode) {
      return expenseScope.scopeKey === "batum"
        ? buildBatumBankExpenseOptions(batumBanksQuery.data?.data ?? [])
        : [];
    }

    if (expenseScope.scopeKey === "batum") {
      return buildBatumExpenseOptions(definitions);
    }

    return definitions.filter((definition) => !isBatumExpenseDefinition(definition));
  }, [bankExpenseMode, batumBanksQuery.data?.data, definitionsQuery.data?.data, expenseScope.scopeKey]);
  const batumBankOptions = useMemo(
    () => buildBatumBankOptions(batumBanksQuery.data?.data ?? []),
    [batumBanksQuery.data?.data]
  );
  const selectedPaymentSource = useMemo(
    () => batumBankOptions.find((bank) => bank.logoCode === paymentSource || bank.code === paymentSource) ?? null,
    [batumBankOptions, paymentSource]
  );

  useEffect(() => {
    if (isSalesperson) {
      return;
    }
    if (currentSession) {
      pointSessionBootstrapAttemptedRef.current = true;
      return;
    }

    if (currentSessionQuery.isFetching || openSessionMutation.isPending) {
      return;
    }

    if (pointSessionBootstrapAttemptedRef.current) {
      return;
    }

    pointSessionBootstrapAttemptedRef.current = true;
    void openSessionMutation.mutateAsync({ opening_cash: 0 });
  }, [currentSession, currentSessionQuery.isFetching, isSalesperson, openSessionMutation]);

  useEffect(() => {
    if (expenseCategories[0] && !expenseCategories.some((category) => category.id === selectedCategoryId)) {
      form.setValue("categoryId", expenseCategories[0].id);
    }
  }, [expenseCategories, form, selectedCategoryId]);

  useEffect(() => {
    if (bankExpenseMode || expenseScope.scopeKey !== "batum") {
      setPaymentSource("cash");
    }
  }, [bankExpenseMode, expenseScope.scopeKey]);

  const expensesQuery = useQuery({
    queryKey: ["pos", "expenses", activeUserKey, expenseScope.scopeKey, bankExpenseMode ? "bank" : "general", currentSession?.id ?? null, currentCashbox?.id ?? null],
    queryFn: () =>
      listPosExpenses({
        pos_session_id: currentSession?.id,
        cashbox_id: currentCashbox?.id ?? undefined,
        limit: 50,
      }),
    enabled: isSalesperson || Boolean(currentSession?.id),
    refetchInterval: 3_000,
    refetchOnMount: "always",
    staleTime: 0,
  });

  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ["pos", "expenses"] });
  }, [activeUserKey, queryClient]);

  useEffect(() => {
    setDraftsHydrated(false);
    try {
      const stored = window.localStorage.getItem(draftStorageKey);
      setDrafts(stored ? (JSON.parse(stored) as ExpenseDraft[]) : []);
    } catch {
      setDrafts([]);
    } finally {
      setDraftsHydrated(true);
    }
  }, [draftStorageKey]);

  useEffect(() => {
    if (!draftsHydrated) {
      return;
    }
    window.localStorage.setItem(draftStorageKey, JSON.stringify(drafts));
  }, [draftStorageKey, drafts, draftsHydrated]);

  const createExpenseMutation = useMutation({
    mutationFn: async (pendingDrafts: ExpenseDraft[]) => {
      const sentIds: string[] = [];
      for (const draft of pendingDrafts) {
        const isCashToBank = draft.operationKind === "cash_to_bank";
        await createPosExpense({
          pos_session_id: currentSession?.id,
          finance_definition_id: draft.categoryId > 0 ? draft.categoryId : undefined,
          amount: draft.amount,
          category: draft.categoryCode,
          logo_expense_account_code: draft.logoCode,
          logo_expense_account_name: draft.logoName,
          note: draft.note || undefined,
          meta: {
            scope: isCashToBank ? "batum-bank-transfer" : (bankExpenseMode ? "batum-bank-expense" : expenseScope.scopeKey),
            cashbox_code: currentSession?.cashbox.code ?? null,
            cashbox_name: currentSession?.cashbox.name ?? null,
            payment_source_type: draft.paymentSourceType ?? "cash",
            payment_source_code: draft.paymentSourceCode ?? null,
            payment_source_name: draft.paymentSourceName ?? null,
            payment_source_logo_code: draft.paymentSourceLogoCode ?? null,
            bank_account_code: draft.paymentSourceCode ?? null,
            bank_account_name: draft.paymentSourceName ?? null,
            bank_account_logo_code: draft.paymentSourceLogoCode ?? null,
            operation_type: isCashToBank ? "cash_to_bank" : "expense",
            bank_transfer_mode: isCashToBank,
            ...(draft.bankExpenseMode ? {
              bank_expense_mode: true,
              bank_expense_account_code: draft.bankExpenseAccountCode,
              bank_expense_account_name: draft.bankExpenseAccountName,
              target_type: "bank",
            } : isCashToBank ? {
              target_type: "bank",
            } : bankExpenseMode ? { target_type: draft.logoCode.startsWith("108-") ? "bank" : "expense_account" } : {}),
          },
        });
        sentIds.push(draft.id);
        setDrafts((current) => current.filter((item) => item.id !== draft.id));
      }
      return sentIds;
    },
    onSuccess: async (sentIds) => {
      toast.success(`${sentIds.length} masraf Logo kuyruğuna gönderildi.`);
      await expensesQuery.refetch();
      notifyPosDayEndRefresh("expense", currentSession?.id ?? null);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Masraf kaydı başarısız";
      toast.error(message);
    },
  });

  const recentExpenses = useMemo<PosExpenseDto[]>(() => expensesQuery.data?.data ?? [], [expensesQuery.data?.data]);
  const recentPageSize = 6;
  const recentPageCount = Math.max(1, Math.ceil(recentExpenses.length / recentPageSize));
  const pagedRecentExpenses = useMemo(
    () => recentExpenses.slice((recentPage - 1) * recentPageSize, recentPage * recentPageSize),
    [recentExpenses, recentPage]
  );

  useEffect(() => {
    setRecentPage(1);
  }, [activeUserKey, expenseScope.scopeKey, bankExpenseMode]);

  useEffect(() => {
    if (recentPage > recentPageCount) {
      setRecentPage(recentPageCount);
    }
  }, [recentPage, recentPageCount]);

  const submit = form.handleSubmit(async (values) => {
    if (!isSalesperson && !currentSession) {
      toast.error("Açık POS oturumu hazırlanamadı.");
      return;
    }

    const selectedCategory = expenseCategories.find((item) => item.id === values.categoryId);
    if (!selectedCategory) {
      toast.error("Lütfen Logo gider hesabı tanımlı bir gider türü seçin.");
      return;
    }

    const selectedBankForBankExpense = bankExpenseMode
      ? resolveBatumBankForExpense(batumBankOptions, selectedCategory)
      : null;
    if (bankExpenseMode && selectedBankForBankExpense === null) {
      toast.error("Banka hesabı çözümlenemedi.");
      return;
    }
    const expenseLogoCode = selectedCategory.logo_code ?? selectedCategory.code;
    const expenseLogoName = selectedCategory.logo_name ?? selectedCategory.name;
    const draftPaymentSourceType = bankExpenseMode
      ? "cash"
      : (selectedPaymentSource ? "bank" : "cash");
    const draftPaymentSource = bankExpenseMode ? selectedBankForBankExpense : selectedPaymentSource;

    const draft: ExpenseDraft = {
      id: editingDraftId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      categoryId: selectedCategory.id,
      categoryCode: selectedCategory.code,
      categoryName: selectedCategory.name,
      logoCode: expenseLogoCode,
      logoName: expenseLogoName,
      amount: values.amount,
      note: values.note?.trim() || "",
      createdAt: editingDraftId
        ? drafts.find((item) => item.id === editingDraftId)?.createdAt ?? new Date().toISOString()
        : new Date().toISOString(),
      paymentSourceType: draftPaymentSourceType,
      paymentSourceCode: draftPaymentSource?.code ?? null,
      paymentSourceName: draftPaymentSource?.name ?? null,
      paymentSourceLogoCode: draftPaymentSource?.logoCode ?? null,
      bankExpenseMode: false,
      bankExpenseAccountCode: null,
      bankExpenseAccountName: null,
      operationKind: bankExpenseMode ? "cash_to_bank" : "expense",
    };

    const wasEditing = editingDraftId !== null;
    setDrafts((current) => editingDraftId
      ? current.map((item) => item.id === editingDraftId ? draft : item)
      : [draft, ...current]);
    setEditingDraftId(null);
    form.reset({ amount: 0, categoryId: selectedCategory.id, note: "" });
    setAmountInput("0,00");
    toast.success(wasEditing ? "Masraf taslağı güncellendi." : "Masraf Son Hareketler listesine eklendi.");
  });

  const editDraft = (draft: ExpenseDraft) => {
    setEditingDraftId(draft.id);
    form.setValue("categoryId", draft.categoryId, { shouldValidate: true });
    form.setValue("amount", draft.amount, { shouldValidate: true });
    form.setValue("note", draft.note);
    if (!bankExpenseMode) {
      setPaymentSource(draft.paymentSourceType === "bank"
        ? draft.paymentSourceLogoCode ?? draft.paymentSourceCode ?? "cash"
        : "cash");
    }
    setAmountInput(formatMoneyInput(String(Math.round(draft.amount * 100))));
    window.requestAnimationFrame(() => amountInputRef.current?.focus());
  };

  const deleteDraft = (draft: ExpenseDraft) => {
    setDrafts((current) => current.filter((item) => item.id !== draft.id));
    if (editingDraftId === draft.id) {
      setEditingDraftId(null);
      form.reset({ amount: 0, categoryId: selectedCategoryId, note: "" });
      setAmountInput("0,00");
    }
    toast.success("Bekleyen hareket silindi.");
  };

  const busy = (!isSalesperson && currentSessionQuery.isFetching) || expensesQuery.isFetching || openSessionMutation.isPending;

  return (
    <div className="point-expenses-page container py-5 md:py-8">
      <div className="mb-5 flex flex-col gap-4 rounded-[26px] border border-emerald-300/20 bg-[linear-gradient(145deg,rgba(9,34,27,0.96)_0%,rgba(8,20,28,0.96)_52%,rgba(20,52,37,0.94)_100%)] p-5 text-slate-100 shadow-[0_26px_70px_-44px_rgba(16,185,129,0.65)] md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-3xl font-black tracking-tight xl:text-4xl">{bankExpenseMode ? "Banka Para Çıkışı" : "Masraf Girişi"}</h1>
          <p className="mt-2 text-sm font-semibold text-muted-foreground">
            {bankExpenseMode ? "Kasadaki nakdi seçili Batum banka hesabına aktarın." : isSalesperson ? "Plasiyer cüzdanınızdan masraf (bakım, pazarlama, vb.) girebilirsiniz." : "Kasa masrafı ekleyin ve takibini yapın."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="h-10 rounded-xl"
            disabled={busy}
            onClick={() => {
              void currentSessionQuery.refetch();
              void expensesQuery.refetch();
            }}
          >
            <RefreshCcw className="mr-2 h-4 w-4" /> Yenile
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-10 rounded-xl"
            onClick={() => router.back()}
          >
            <ArrowLeft className="mr-2 h-4 w-4" /> Geri
          </Button>
        </div>
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.55fr)_minmax(340px,0.78fr)]">
        <div>
          <Card className="w-full overflow-hidden rounded-[26px] border border-emerald-300/20 bg-[linear-gradient(145deg,rgba(10,38,30,0.98)_0%,rgba(8,22,30,0.96)_100%)] text-slate-100 shadow-[0_24px_58px_-42px_rgba(16,185,129,0.7)]">
            <CardHeader className="rounded-t-[26px] border-b border-emerald-300/15 bg-emerald-300/8 pb-5">
              <CardTitle className="flex items-center gap-2 text-lg">
                <PlusCircle className="h-5 w-5 text-primary" /> {bankExpenseMode ? "Banka Para Çıkışı Hazırla" : "Yeni Masraf Hazırla"}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-5">
              <form onSubmit={submit} className="space-y-5">
                <div>
                  <label className="mb-3 block text-sm font-bold text-foreground">{bankExpenseMode ? "Banka Hesabı Seçiniz" : "Gider Türü Seçiniz"}</label>
                  <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(170px,1fr))]">
                    {expenseCategories.length > 0 ? (
                      expenseCategories.map((category) => (
                        <button
                          key={category.id}
                          type="button"
                          className={cn(
                            "flex min-h-[92px] flex-col items-center justify-center gap-2 rounded-[18px] border border-emerald-300/15 bg-white/[0.045] p-3 text-slate-100 transition-all hover:border-emerald-300/45 hover:bg-emerald-300/10",
                            selectedCategoryId === category.id && "border-emerald-300/60 bg-emerald-300/16 text-emerald-100 shadow-[0_18px_34px_-28px_rgba(16,185,129,0.9)] ring-1 ring-emerald-300/25"
                          )}
                          onClick={() => {
                            form.setValue("categoryId", category.id, { shouldValidate: true });
                            window.requestAnimationFrame(() => {
                              amountInputRef.current?.focus();
                              amountInputRef.current?.select();
                            });
                          }}
                        >
                          <FileText className="h-6 w-6" />
                          <span className="text-center text-xs font-bold leading-tight">{category.name}</span>
                        </button>
                      ))
                    ) : (
                      <button
                        type="button"
                        className="flex h-24 flex-col items-center justify-center gap-2 rounded-[16px] border-2 border-dashed border-muted-foreground/30 bg-muted/40 p-2 text-muted-foreground transition-all"
                        disabled
                      >
                        <FileText className="h-6 w-6" />
                        <span className="text-center text-xs font-bold leading-tight">Aktif gider türü bulunamadı</span>
                      </button>
                    )}
                  </div>
                </div>

                <div className={cn(
                  "grid gap-6",
                  !bankExpenseMode && expenseScope.scopeKey === "batum" ? "sm:grid-cols-3" : "sm:grid-cols-2"
                )}>
                  <div>
                    <label className="mb-2 block text-sm font-bold text-foreground">Tutar ({expenseScope.currencyLabel})</label>
                    <Input
                      ref={amountInputRef}
                      type="text"
                      inputMode="decimal"
                      value={amountInput}
                      onChange={(event) => {
                        const formatted = formatMoneyInput(event.target.value);
                        setAmountInput(formatted);
                        form.setValue("amount", parseMoneyInput(formatted), { shouldValidate: true });
                      }}
                      onFocus={(event) => event.currentTarget.select()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey && !createExpenseMutation.isPending) {
                          event.preventDefault();
                          void submit();
                        }
                      }}
                      disabled={createExpenseMutation.isPending}
                      className="h-12 rounded-[14px] border-emerald-300/20 bg-white/[0.045] text-lg font-bold shadow-inner shadow-black/10"
                    />
                  </div>
                  <div>
                    <label className="mb-2 block text-sm font-bold text-foreground">Tarih</label>
                    <Input
                      type="date"
                      defaultValue={new Date().toISOString().slice(0, 10)}
                      disabled={true}
                      className="h-12 rounded-[14px] border-emerald-300/20 bg-white/[0.035] text-lg font-bold text-slate-300 opacity-100 shadow-inner shadow-black/10"
                    />
                  </div>
                  {!bankExpenseMode && expenseScope.scopeKey === "batum" ? (
                    <div>
                      <label className="mb-2 block text-sm font-bold text-foreground">Ödeme Kaynağı</label>
                      <select
                        value={paymentSource}
                        onChange={(event) => setPaymentSource(event.target.value)}
                        disabled={createExpenseMutation.isPending}
                        className="h-12 w-full rounded-[14px] border border-emerald-300/20 bg-[#071a14] px-4 text-base font-black text-slate-100 shadow-inner shadow-black/10 outline-none transition focus:border-emerald-300/55 focus:ring-2 focus:ring-emerald-300/20"
                      >
                        <option value="cash">Nakit</option>
                        {batumBankOptions.map((bank) => (
                          <option key={`${bank.code}-${bank.logoCode}`} value={bank.logoCode}>
                            {bank.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                </div>

                <div>
                  <label className="mb-2 block text-sm font-bold text-foreground">Açıklama</label>
                  <Textarea
                    placeholder="Masraf ile ilgili açıklama (Örn: Araç bakımı 34ABC12)"
                    {...form.register("note")}
                    disabled={createExpenseMutation.isPending}
                    className="min-h-[92px] resize-none rounded-[16px] border-emerald-300/20 bg-white/[0.045] text-base font-medium shadow-inner shadow-black/10"
                  />
                </div>

                <Button type="submit" size="lg" className="h-14 w-full rounded-[18px] bg-[linear-gradient(135deg,#ff5b5b_0%,#dc2626_48%,#991b1b_100%)] text-lg font-black text-white shadow-[0_18px_40px_-24px_rgba(239,68,68,0.95)] hover:brightness-110" disabled={createExpenseMutation.isPending}>
                  {createExpenseMutation.isPending ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <ReceiptText className="mr-2 h-5 w-5" />}
                  {editingDraftId ? "Değişikliği Kaydet →" : "Gönder →"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>

        <div>
          <Card className="flex w-full flex-col overflow-hidden rounded-[26px] border border-emerald-300/20 bg-[linear-gradient(145deg,rgba(10,38,30,0.98)_0%,rgba(8,22,30,0.96)_100%)] text-slate-100 shadow-[0_24px_58px_-42px_rgba(16,185,129,0.7)]">
            <CardHeader className="rounded-t-[26px] border-b border-emerald-300/15 bg-emerald-300/8 pb-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">Son Hareketler</CardTitle>
                <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-[10px] font-black text-primary">
                  {drafts.length} bekleyen
                </span>
              </div>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col p-0">
              <div className="divide-y divide-border">
                {drafts.length > 0 ? (
                  drafts.map((draft) => (
                    <div key={draft.id} className="p-4 transition-colors hover:bg-emerald-300/[0.06]">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-black">{draft.categoryName}</p>
                          <p className="mt-1 text-[11px] font-semibold text-muted-foreground">
                            {new Date(draft.createdAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <p className="whitespace-nowrap font-black text-amber-300">-{formatCurrency(draft.amount, expenseScope.currencyLabel)}</p>
                          <Button type="button" size="sm" variant="outline" className="h-8 rounded-lg" onClick={() => editDraft(draft)}>
                            <Pencil className="mr-1 h-3.5 w-3.5" /> Düzenle
                          </Button>
                          <Button type="button" size="sm" variant="outline" className="h-8 rounded-lg border-red-400/35 text-red-100 hover:bg-red-500/15" onClick={() => deleteDraft(draft)}>
                            <Trash2 className="mr-1 h-3.5 w-3.5" /> Sil
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="p-7 text-center text-sm font-semibold text-muted-foreground">Gönderilmeyi bekleyen masraf yok.</div>
                )}
              </div>
              <div className="border-t border-emerald-300/15 px-4 py-3 text-xs font-black uppercase tracking-[0.12em] text-muted-foreground">
                Gönderilen Son Hareketler
              </div>
              <div className="divide-y divide-border">
                {expensesQuery.isLoading ? (
                   Array.from({ length: 4 }).map((_, index) => <div key={index} className="p-4"><Skeleton className="h-16 w-full rounded-xl" /></div>)
                ) : recentExpenses.length > 0 ? (
                  pagedRecentExpenses.map((expense) => (
                    <div key={expense.id} className="p-4 transition-colors hover:bg-muted/40">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold">{expense.category}</p>
                          <p className="mt-1 line-clamp-2 text-xs font-medium text-muted-foreground">{expense.note?.trim() || "Açıklama yok"}</p>
                          <p className="mt-2 text-[11px] font-semibold text-muted-foreground">{formatDate(expense.expense_date || expense.created_at)}</p>
                        </div>
                        <div className="text-right">
                          <p className="whitespace-nowrap font-black text-destructive">
                            -{formatCurrency(expense.amount, expense.currency === "GEL" ? BATUM_CURRENCY_LABEL : DEFAULT_CURRENCY_LABEL)}
                          </p>
                          <div className="mt-1.5 flex justify-end">
                            <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold text-muted-foreground bg-background">
                              {expense.source_system === "logo" || expense.logo_sync_status === "synced" ? (
                                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                              ) : (
                                <Clock className="h-3.5 w-3.5 text-amber-500" />
                              )}
                              {expenseSyncLabel(expense)}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="p-8 text-center text-sm font-medium text-muted-foreground">
                    Kayıtlı masraf bulunamadı.
                  </div>
                )}
              </div>
              {recentExpenses.length > recentPageSize ? (
                <div className="flex items-center justify-between gap-3 border-t border-emerald-300/15 px-4 py-3 text-xs font-bold text-slate-300">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 rounded-lg"
                    disabled={recentPage <= 1}
                    onClick={() => setRecentPage((page) => Math.max(1, page - 1))}
                  >
                    Önceki
                  </Button>
                  <span>{recentPage} / {recentPageCount}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 rounded-lg"
                    disabled={recentPage >= recentPageCount}
                    onClick={() => setRecentPage((page) => Math.min(recentPageCount, page + 1))}
                  >
                    Sonraki
                  </Button>
                </div>
              ) : null}
              <div className="mt-auto border-t border-emerald-300/15 p-4">
                <Button
                  type="button"
                  size="lg"
                  className="h-14 w-full rounded-[18px] bg-[linear-gradient(135deg,#ff5b5b_0%,#dc2626_48%,#991b1b_100%)] text-lg font-black text-white hover:brightness-110"
                  disabled={drafts.length === 0 || createExpenseMutation.isPending}
                  onClick={() => createExpenseMutation.mutate(drafts)}
                >
                  {createExpenseMutation.isPending ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Send className="mr-2 h-5 w-5" />}
                  Kaydet
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
