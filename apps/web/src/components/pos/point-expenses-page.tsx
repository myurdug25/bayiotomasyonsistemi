"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  Banknote,
  Building2,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  MapPin,
  PlusCircle,
  ReceiptText,
  RefreshCcw,
  Wallet,
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
import { cn } from "@/lib/utils";

const DEFAULT_POINT_EXPENSE_CATEGORY = "Masraf";
const BATUM_CURRENCY_LABEL = "GEL";
const DEFAULT_CURRENCY_LABEL = "TL";

const expenseSchema = z.object({
  amount: z.number().gt(0),
  categoryId: z.number().int().positive().optional(),
  note: z.string().max(255).optional(),
});

type ExpenseFormValues = z.infer<typeof expenseSchema>;

function formatCurrency(value: number | string, currencyLabel = DEFAULT_CURRENCY_LABEL): string {
  const amount = typeof value === "number" ? value : Number(value);

  return Number.isFinite(amount)
    ? `${currencyLabel} ${amount.toLocaleString("tr-TR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`
    : "-";
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

function expenseSyncTone(expense: PosExpenseDto): string {
  if (expense.source_system === "logo") {
    return "border-[#72bf82]/50 text-[#b8f7b5]";
  }

  if (expense.logo_sync_status === "failed") {
    return "border-[#f87171]/50 text-[#f87171]";
  }

  if (expense.logo_sync_status === "synced") {
    return "border-[#72bf82]/50 text-[#b8f7b5]";
  }

  return "border-[#faee56]/50 text-[#faee56]";
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
  const signals = isElevatedUser ? userSignals : [...userSignals, ...cashboxSignals];
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

function sessionScopeLabel(session: PosExpenseDto["cashbox"] | null | undefined, branchLabel: string): string {
  if (!session) {
    return `${branchLabel} kasası hazırlanıyor`;
  }

  const code = session.code?.trim();
  const name = session.name?.trim();
  if (code && name) {
    return `${code} / ${name}`;
  }

  return code || name || `${branchLabel} point kasası`;
}

function ExpenseStat({
  label,
  value,
  detail,
  icon,
  tone = "default",
}: {
  label: string;
  value: string | number;
  detail?: string;
  icon: ReactNode;
  tone?: "default" | "accent" | "yellow";
}) {
  return (
    <div
      className={cn(
        "point-admin-stat rounded-[18px] border p-4",
        tone === "yellow" && "border-[#9d8f36]/60 bg-[linear-gradient(135deg,rgba(250,238,86,0.2)_0%,rgba(26,42,25,0.92)_100%)]",
        tone === "accent" && "border-[#4d805d]/70 bg-[linear-gradient(135deg,rgba(74,128,87,0.28)_0%,rgba(8,24,17,0.94)_100%)]"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-black uppercase tracking-[0.13em] text-[var(--point-muted-strong)]">{label}</p>
          <p className="mt-2 truncate text-2xl font-black text-[var(--point-text)]">{value}</p>
          {detail ? <p className="mt-1 truncate text-xs font-semibold text-[var(--point-muted)]">{detail}</p> : null}
        </div>
        <span className="point-section-icon flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] border">
          {icon}
        </span>
      </div>
    </div>
  );
}

export function PointExpensesPage() {
  const pointSessionBootstrapAttemptedRef = useRef(false);
  const { user } = useSession();

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
    queryKey: ["finance-definitions", "expense_category"],
    queryFn: () => listFinanceDefinitions("expense_category"),
    enabled: isSalesperson,
  });
  const expenseCategories = useMemo<FinanceDefinitionDto[]>(
    () => definitionsQuery.data?.data ?? [],
    [definitionsQuery.data?.data]
  );
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
  const scopeLabel = sessionScopeLabel(currentCashbox, expenseScope.branchLabel);

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
    if (isSalesperson && !selectedCategoryId && expenseCategories[0]) {
      form.setValue("categoryId", expenseCategories[0].id);
    }
  }, [expenseCategories, form, isSalesperson, selectedCategoryId]);

  const expensesQuery = useQuery({
    queryKey: ["pos", "expenses", currentSession?.id ?? null, currentCashbox?.id ?? null],
    queryFn: () =>
      listPosExpenses({
        pos_session_id: currentSession?.id,
        cashbox_id: currentCashbox?.id ?? undefined,
        limit: 20,
      }),
    enabled: isSalesperson || Boolean(currentSession?.id),
    refetchInterval: 20_000,
  });

  const createExpenseMutation = useMutation({
    mutationFn: createPosExpense,
    onSuccess: async () => {
      toast.success("Masraf kaydedildi.");
      form.reset({
        amount: 0,
        note: "",
      });
      await expensesQuery.refetch();
      notifyPosDayEndRefresh("expense", currentSession?.id ?? null);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Masraf kaydı başarısız";
      toast.error(message);
    },
  });

  const recentExpenses = useMemo<PosExpenseDto[]>(() => expensesQuery.data?.data ?? [], [expensesQuery.data?.data]);
  const expenseTotal = useMemo(
    () => recentExpenses.reduce((sum, expense) => sum + Number(expense.amount ?? 0), 0),
    [recentExpenses]
  );
  const lastExpense = recentExpenses[0] ?? null;
  const todayExpenseCount = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return recentExpenses.filter((expense) => (expense.expense_date || expense.created_at).slice(0, 10) === today).length;
  }, [recentExpenses]);

  const submit = form.handleSubmit(async (values) => {
    if (!isSalesperson && !currentSession) {
      toast.error("Açık POS oturumu hazırlanamadı.");
      return;
    }

    await createExpenseMutation.mutateAsync({
      pos_session_id: currentSession?.id,
      finance_definition_id: isSalesperson ? values.categoryId : undefined,
      amount: values.amount,
      category: isSalesperson
        ? expenseCategories.find((item) => item.id === values.categoryId)?.code ?? ""
        : DEFAULT_POINT_EXPENSE_CATEGORY,
      note: values.note?.trim() || undefined,
      meta: {
        scope: expenseScope.scopeKey,
        cashbox_code: currentSession?.cashbox.code ?? null,
        cashbox_name: currentSession?.cashbox.name ?? null,
      },
    });
  });

  const busy = (!isSalesperson && currentSessionQuery.isFetching) || expensesQuery.isFetching || openSessionMutation.isPending;

  return (
    <div className="point-admin-page">
      <div className="space-y-4">
        <section className="point-admin-hero overflow-hidden rounded-[18px] border p-4 shadow-[0_28px_70px_-54px_rgba(0,0,0,0.95)]">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_330px]">
            <div className="flex min-w-0 items-start gap-4">
              <span className="point-page-icon flex h-14 w-14 shrink-0 items-center justify-center rounded-[14px] border">
                <ReceiptText className="h-7 w-7" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs font-black uppercase tracking-[0.12em]",
                      currentSession || isSalesperson
                        ? "border-[#6fb878]/60 bg-[#1f6b45]/30 text-[#d8f5d9]"
                        : "border-[#faee56]/45 bg-[#3b3719]/50 text-[#faee56]"
                    )}
                  >
                    {isSalesperson ? "Plasiyer Gideri" : currentSession ? "Oturum Hazır" : "Oturum Hazırlanıyor"}
                  </span>
                  {currentSession ? (
                    <span className="rounded-full border border-[#faee56]/45 bg-[#3b3719]/50 px-3 py-1 text-xs font-black uppercase tracking-[0.12em] text-[#faee56]">
                      #{currentSession.id}
                    </span>
                  ) : null}
                </div>
                <h1 className="mt-3 text-3xl font-black tracking-tight text-[var(--point-text)] xl:text-4xl">{expenseScope.branchLabel} Masraf</h1>
                <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-[var(--point-muted-strong)]">
                  Açık {expenseScope.branchLabel} point kasasına masraf ekleyin, gün sonu toplamını ve Logo aktarım durumunu aynı ekranda takip edin.
                </p>
                {currentSession ? (
                  <div className="mt-4 flex flex-wrap gap-2 text-xs font-black text-[var(--point-muted-strong)]">
                    <span className="inline-flex items-center gap-2 rounded-full border border-[var(--point-border)] bg-[var(--point-control)] px-3 py-2">
                      <MapPin className="h-3.5 w-3.5" />
                      {expenseScope.branchLabel} kapsamı
                    </span>
                    <span className="inline-flex items-center gap-2 rounded-full border border-[var(--point-border)] bg-[var(--point-control)] px-3 py-2">
                      <Building2 className="h-3.5 w-3.5" />
                      {scopeLabel}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="point-admin-soft rounded-[16px] border p-4">
              <p className="text-[11px] font-black uppercase tracking-[0.13em] text-[var(--point-muted-strong)]">{expenseScope.branchLabel} Masraf Toplamı</p>
              <p className="mt-2 truncate text-3xl font-black text-[#faee56]">{formatCurrency(expenseTotal, expenseScope.currencyLabel)}</p>
              <p className="mt-2 flex items-center gap-2 text-xs font-bold text-[var(--point-muted)]">
                <Clock className="h-4 w-4" />
                Gün sonu ile dinamik güncellenir.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="point-secondary-button h-11 rounded-[14px] font-black"
                  disabled={busy}
                  onClick={() => {
                    void currentSessionQuery.refetch();
                    void expensesQuery.refetch();
                  }}
                >
                  <RefreshCcw className="h-4 w-4" /> Yenile
                </Button>
                <Button asChild className="point-yellow-action-button h-11 rounded-[14px] font-black">
                  <Link href="/pos">
                    <Wallet className="h-4 w-4" /> Satış
                  </Link>
                </Button>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-3 md:grid-cols-3">
          <ExpenseStat
            label="Oturum"
            value={currentSession ? `#${currentSession.id}` : "Hazırlanıyor"}
            detail={scopeLabel}
            icon={<Wallet className="h-5 w-5" />}
            tone="accent"
          />
          <ExpenseStat
            label="Masraf Toplamı"
            value={formatCurrency(expenseTotal, expenseScope.currencyLabel)}
            detail={`Sadece ${expenseScope.branchLabel} kasa oturumu`}
            icon={<Banknote className="h-5 w-5" />}
            tone="yellow"
          />
          <ExpenseStat
            label="Bugün"
            value={todayExpenseCount}
            detail={lastExpense ? `Son kayıt ${formatDate(lastExpense.expense_date || lastExpense.created_at)}` : "Henüz kayıt yok"}
            icon={<FileText className="h-5 w-5" />}
          />
        </section>

        {!currentSession && !isSalesperson ? (
          <section className="point-admin-panel rounded-[22px] border p-5">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-lg font-black text-[var(--point-text)]">{expenseScope.branchLabel} masraf ekranı için point oturumu hazırlanıyor.</p>
                <p className="mt-1 text-sm font-semibold text-[var(--point-muted)]">Oturum hazırlandığında yalnızca bu kasaya masraf girişi aktif olur.</p>
              </div>
              <Button asChild className="point-yellow-action-button h-12 rounded-[14px] px-5 font-black">
                <Link href="/pos">Hızlı Satışa Dön</Link>
              </Button>
            </div>
          </section>
        ) : (
          <div className="grid gap-4 xl:grid-cols-[minmax(360px,0.86fr)_minmax(0,1.14fr)]">
            <section className="point-admin-panel rounded-[18px] border p-4 shadow-[0_20px_45px_-35px_rgba(0,0,0,0.7)]">
              <div className="mb-4 flex items-center gap-3">
                <span className="point-section-icon flex h-11 w-11 items-center justify-center rounded-[12px] border">
                  <PlusCircle className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.13em] text-[var(--point-muted-strong)]">{expenseScope.branchLabel} Masraf Kaydı</p>
                  <h2 className="text-xl font-black text-[var(--point-text)]">Yeni masraf</h2>
                </div>
              </div>

              <form className="space-y-4" onSubmit={submit}>
                {isSalesperson ? (
                  <div>
                    <span className="mb-2 block text-sm font-black text-[var(--point-muted-strong)]">Gider Kategorisi</span>
                    <div className="grid gap-2 sm:grid-cols-3">
                      {expenseCategories.map((category) => (
                        <Button
                          key={category.id}
                          type="button"
                          variant={selectedCategoryId === category.id ? "default" : "outline"}
                          className="h-12 rounded-[12px] font-black"
                          onClick={() => form.setValue("categoryId", category.id, { shouldValidate: true })}
                        >
                          {category.name}
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <label className="block">
                  <span className="mb-2 block text-sm font-black text-[var(--point-muted-strong)]">Tutar ({expenseScope.currencyLabel})</span>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    {...form.register("amount", { valueAsNumber: true })}
                    disabled={createExpenseMutation.isPending}
                    className="h-16 rounded-[14px] text-3xl font-black"
                  />
                </label>

                <label className="block">
                  <span className="mb-2 block text-sm font-black text-[var(--point-muted-strong)]">Açıklama</span>
                  <Input
                    placeholder={`${expenseScope.branchLabel} masraf notu`}
                    {...form.register("note")}
                    disabled={createExpenseMutation.isPending}
                    className="h-14 rounded-[14px] text-base font-semibold"
                  />
                </label>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="point-admin-soft rounded-[14px] border p-3">
                    <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[var(--point-muted)]">Kategori</p>
                    <p className="mt-1 text-lg font-black text-[var(--point-text)]">
                      {isSalesperson
                        ? expenseCategories.find((item) => item.id === selectedCategoryId)?.name ?? "Seçiniz"
                        : DEFAULT_POINT_EXPENSE_CATEGORY}
                    </p>
                  </div>
                  <div className="point-admin-soft rounded-[14px] border p-3">
                    <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[var(--point-muted)]">Kasa</p>
                    <p className="mt-1 truncate text-lg font-black text-[var(--point-text)]">
                      {isSalesperson ? user?.name ?? "Plasiyer" : currentSession?.cashbox.code ?? expenseScope.branchLabel}
                    </p>
                  </div>
                </div>

                <Button type="submit" className="point-yellow-action-button h-16 w-full rounded-[14px] text-xl font-black" disabled={createExpenseMutation.isPending}>
                  {createExpenseMutation.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <ReceiptText className="h-5 w-5" />}
                  Masraf Kaydet
                </Button>
              </form>
            </section>

            <section className="point-admin-panel rounded-[18px] border p-4 shadow-[0_20px_45px_-35px_rgba(0,0,0,0.7)]">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.13em] text-[var(--point-muted-strong)]">{expenseScope.branchLabel} Masrafları</p>
                  <h2 className="text-xl font-black text-[var(--point-text)]">Kasa hareketleri</h2>
                </div>
                <span className="rounded-full border border-[#faee56]/45 bg-[#3b3719]/50 px-3 py-1 text-xs font-black text-[#faee56]">
                  {recentExpenses.length} kayıt
                </span>
              </div>

              <div className="space-y-3">
                {expensesQuery.isLoading ? (
                  Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-20 w-full rounded-[16px]" />)
                ) : recentExpenses.length > 0 ? (
                  recentExpenses.map((expense) => (
                    <div key={expense.id} className="point-admin-soft rounded-[14px] border px-4 py-3">
                      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_130px] md:items-center">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-black text-[var(--point-text)]">{expense.category}</p>
                            <span
                              className={cn(
                                "rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em]",
                                expenseSyncTone(expense)
                              )}
                            >
                              {expenseSyncLabel(expense)}
                            </span>
                          </div>
                          <p className="mt-1 truncate text-xs font-semibold text-[var(--point-muted)]">{expense.note?.trim() || "Açıklama yok"}</p>
                          <p className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-[var(--point-muted)]">
                            {expense.source_system === "logo" || expense.logo_sync_status === "synced" ? (
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            ) : (
                              <Clock className="h-3.5 w-3.5" />
                            )}
                            {formatDate(expense.expense_date || expense.created_at)}
                          </p>
                        </div>
                        <div className="rounded-[12px] border border-[#faee56]/30 bg-[#3b3719]/40 px-3 py-2 text-right">
                          <p className="whitespace-nowrap text-lg font-black text-[#faee56]">{formatCurrency(expense.amount, expense.currency === "GEL" ? BATUM_CURRENCY_LABEL : DEFAULT_CURRENCY_LABEL)}</p>
                          <p className="mt-1 text-[10px] font-black uppercase tracking-[0.1em] text-[var(--point-muted)]">{expense.currency === "GEL" ? "Batum" : expenseScope.branchLabel}</p>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="rounded-[16px] border border-[var(--point-border)] bg-[var(--point-control)] p-4 text-sm font-semibold text-[var(--point-muted)]">
                    Bu oturum için masraf girilmedi.
                  </p>
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
