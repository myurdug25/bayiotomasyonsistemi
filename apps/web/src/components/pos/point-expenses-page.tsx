"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
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
    <div className="container py-8 md:py-12">
      <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-3xl font-black tracking-tight xl:text-4xl">Masraf Girişi</h1>
          <p className="mt-2 text-sm font-semibold text-muted-foreground">
            {isSalesperson ? "Plasiyer cüzdanınızdan masraf (bakım, pazarlama, vb.) girebilirsiniz." : "Kasa masrafı ekleyin ve takibini yapın."}
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
          {!isSalesperson && (
            <Button asChild className="h-10 rounded-xl" variant="default">
              <Link href="/pos">
                <Wallet className="mr-2 h-4 w-4" /> Satış
              </Link>
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-3 xl:grid-cols-4">
        <div className="lg:col-span-2 xl:col-span-3">
          <Card className="rounded-[20px] shadow-sm">
            <CardHeader className="bg-muted/30 pb-6 rounded-t-[20px] border-b">
              <CardTitle className="flex items-center gap-2 text-lg">
                <PlusCircle className="h-5 w-5 text-primary" /> Yeni Masraf Kaydet
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <form onSubmit={submit} className="space-y-6">
                <div>
                  <label className="mb-3 block text-sm font-bold text-foreground">Gider Türü Seçiniz</label>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
                    {isSalesperson ? (
                      expenseCategories.map((category) => (
                        <button
                          key={category.id}
                          type="button"
                          className={cn(
                            "flex h-24 flex-col items-center justify-center gap-2 rounded-[16px] border-2 bg-background p-2 transition-all hover:border-primary/40 hover:bg-muted/50",
                            selectedCategoryId === category.id && "border-primary bg-primary/5 text-primary shadow-sm ring-1 ring-primary/20"
                          )}
                          onClick={() => form.setValue("categoryId", category.id, { shouldValidate: true })}
                        >
                          <FileText className="h-6 w-6" />
                          <span className="text-center text-xs font-bold leading-tight">{category.name}</span>
                        </button>
                      ))
                    ) : (
                      <button
                        type="button"
                        className="flex h-24 flex-col items-center justify-center gap-2 rounded-[16px] border-2 border-primary bg-primary/5 p-2 text-primary shadow-sm ring-1 ring-primary/20 transition-all"
                      >
                        <FileText className="h-6 w-6" />
                        <span className="text-center text-xs font-bold leading-tight">{DEFAULT_POINT_EXPENSE_CATEGORY}</span>
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid gap-6 sm:grid-cols-2">
                  <div>
                    <label className="mb-2 block text-sm font-bold text-foreground">Tutar ({expenseScope.currencyLabel})</label>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      {...form.register("amount", { valueAsNumber: true })}
                      disabled={createExpenseMutation.isPending}
                      className="h-12 rounded-[12px] text-lg font-bold bg-background border border-input shadow-sm"
                    />
                  </div>
                  <div>
                    <label className="mb-2 block text-sm font-bold text-foreground">Tarih</label>
                    <Input
                      type="date"
                      defaultValue={new Date().toISOString().slice(0, 10)}
                      disabled={true}
                      className="h-12 rounded-[12px] text-lg font-bold text-muted-foreground opacity-100 bg-muted border border-input shadow-sm"
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-bold text-foreground">Açıklama</label>
                  <Textarea
                    placeholder="Masraf ile ilgili açıklama (Örn: Araç bakımı 34ABC12)"
                    {...form.register("note")}
                    disabled={createExpenseMutation.isPending}
                    className="min-h-[100px] resize-none rounded-[14px] text-base font-medium bg-background border border-input shadow-sm"
                  />
                </div>

                <Button type="submit" size="lg" className="h-14 w-full rounded-[14px] text-lg font-black" disabled={createExpenseMutation.isPending}>
                  {createExpenseMutation.isPending ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <ReceiptText className="mr-2 h-5 w-5" />}
                  Masrafı Kaydet
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>

        <div>
          <Card className="h-full rounded-[20px] shadow-sm">
            <CardHeader className="bg-muted/30 pb-4 rounded-t-[20px] border-b">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">Son Hareketler</CardTitle>
                <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-[10px] font-black text-primary">
                  {recentExpenses.length} kayıt
                </span>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {expensesQuery.isLoading ? (
                   Array.from({ length: 4 }).map((_, index) => <div key={index} className="p-4"><Skeleton className="h-16 w-full rounded-xl" /></div>)
                ) : recentExpenses.length > 0 ? (
                  recentExpenses.map((expense) => (
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
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
