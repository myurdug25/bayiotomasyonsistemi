"use client";

import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Eye,
  Loader2,
  RefreshCcw,
  ShoppingCart,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";

import {
  getCurrentPosSession,
  getCurrentPosSessions,
  getPosDayEndReport,
  type PosSaleType,
  type PosDayEndReport,
  type PosSessionDto,
} from "@/lib/api";
import { useSession } from "@/components/auth/session-provider";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { subscribePosDayEndRefresh } from "@/lib/pos-day-end-events";
import { cn } from "@/lib/utils";

function toMoney(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }

  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : 0;
}

type ReportTables = NonNullable<PosDayEndReport["report_tables"]>;
type SaleReportRow = ReportTables["normal_sales"][number];
type CollectionReportRow = ReportTables["cash_collections"][number];
type PanelTone = "emerald";

const emptyReportTables: ReportTables = {
  normal_sales: [],
  cash_sales: [],
  card_sales: [],
  cash_collections: [],
  card_collections: [],
  transfer_collections: [],
  check_collections: [],
  note_collections: [],
  factory_card_collections: [],
};

function compactMoney(value: string | number | null | undefined, currencyLabel = "TL"): string {
  return `${toMoney(value).toLocaleString("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currencyLabel}`;
}

function customerLabel(row: { customer_code?: string | null; customer_name?: string | null }): string {
  return row.customer_name?.trim() || row.customer_code?.trim() || "Perakende satış";
}

function saleDocumentNo(row: SaleReportRow): string {
  return row.receipt_no?.trim() || `POS-${row.id}`;
}

function collectionDocumentNo(row: CollectionReportRow): string {
  return row.reference_no?.trim() || `TAH-${row.id}`;
}

function reportTableTotal(rows: Array<{ grand_total?: string; amount?: string }>): number {
  return rows.reduce((sum, row) => sum + toMoney(row.grand_total ?? row.amount ?? 0), 0);
}

const panelToneClassNames: Record<
  PanelTone,
  {
    frame: string;
    header: string;
    tableHead: string;
    total: string;
    highlightRow: string;
    evenRow: string;
    oddRow: string;
    empty: string;
  }
> = {
  emerald: {
    frame: "border-[#32d36f]/70 !bg-[linear-gradient(180deg,rgba(12,45,27,0.98)_0%,rgba(6,26,16,0.99)_100%)] shadow-[0_0_0_1px_rgba(79,255,141,0.12),0_22px_52px_-36px_rgba(50,211,111,0.72)]",
    header: "border-[#32d36f]/70 bg-[linear-gradient(135deg,#2ee06f_0%,#138c45_52%,#075d2a_100%)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.24)]",
    tableHead: "border-[#2cc967]/45 bg-[linear-gradient(180deg,#123d25_0%,#0a2417_100%)] text-[#eaffef]",
    total: "border-[#2cc967]/45 bg-[linear-gradient(180deg,#123d25_0%,#071f13_100%)] text-white",
    highlightRow: "bg-[linear-gradient(90deg,#ddf06d_0%,#93d947_100%)] text-[#101707]",
    evenRow: "bg-[#0d2f1d] text-[#f0fff4]",
    oddRow: "bg-[#123a25] text-[#f0fff4]",
    empty: "text-[#d6ffe0]",
  },
};

function panelRowClassName(index: number, tone: PanelTone): string {
  const classes = panelToneClassNames[tone];
  return index === 0 ? classes.highlightRow : index % 2 === 0 ? classes.evenRow : classes.oddRow;
}

function PanelFrame({
  title,
  total,
  currencyLabel,
  children,
  className,
  tone = "emerald",
}: {
  title: string;
  total: string | number;
  currencyLabel: string;
  children: ReactNode;
  className?: string;
  tone?: PanelTone;
}) {
  const toneClasses = panelToneClassNames[tone];

  return (
    <section
      className={cn(
        "min-h-[280px] overflow-hidden rounded-[14px] border shadow-[0_18px_42px_-36px_rgba(0,0,0,0.78)]",
        toneClasses.frame,
        className
      )}
    >
      <div className={cn("border-b px-4 py-3 text-center text-base font-black shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]", toneClasses.header)}>
        {title}
      </div>
      <div className="flex h-[calc(100%-50px)] flex-col">
        {children}
        <div className={cn("mt-auto flex h-11 items-center justify-end border-t px-4 text-base font-black", toneClasses.total)}>
          {compactMoney(total, currencyLabel)}
        </div>
      </div>
    </section>
  );
}

function EmptyRows({ label = "Kayıt yok", tone = "emerald" }: { label?: string; tone?: PanelTone }) {
  return (
    <div className={cn("flex min-h-[120px] flex-1 items-center justify-center px-4 text-sm font-black", panelToneClassNames[tone].empty)}>
      {label}
    </div>
  );
}

function SalePanel({
  title,
  rows,
  className,
  tone,
  currencyLabel,
  onDetail,
}: {
  title: string;
  rows: SaleReportRow[];
  className?: string;
  tone: PanelTone;
  currencyLabel: string;
  onDetail: (row: SaleReportRow) => void;
}) {
  const toneClasses = panelToneClassNames[tone];

  return (
    <PanelFrame title={title} total={reportTableTotal(rows)} currencyLabel={currencyLabel} className={className} tone={tone}>
      <div className={cn("grid grid-cols-[104px_minmax(0,1fr)_118px_86px] border-b text-[12px] font-black uppercase tracking-[0.02em]", toneClasses.tableHead)}>
        <span className="truncate px-4 py-3">Belge No</span>
        <span className="truncate px-4 py-3">Firma İsmi</span>
        <span className="truncate px-4 py-3 text-right">Tutar</span>
        <span className="truncate px-4 py-3 text-center">Detay</span>
      </div>
      {rows.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {rows.map((row, index) => (
            <div
              key={`${title}-${row.id}`}
              className={cn(
                "grid grid-cols-[104px_minmax(0,1fr)_118px_86px] border-b border-white/10 text-[13px] font-extrabold",
                panelRowClassName(index, tone)
              )}
            >
              <span className="truncate px-4 py-3">{saleDocumentNo(row)}</span>
              <span className="truncate px-4 py-3 leading-snug" title={customerLabel(row)}>
                {customerLabel(row)}
              </span>
              <span className="truncate px-4 py-3 text-right tabular-nums">{compactMoney(row.grand_total, currencyLabel)}</span>
              <span className="flex items-center justify-center px-2 py-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 rounded-lg border-white/25 bg-white/10 px-2 text-[11px] font-black text-inherit hover:bg-white/20"
                  onClick={() => onDetail(row)}
                >
                  <Eye className="h-3.5 w-3.5" />
                  Detay
                </Button>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <EmptyRows tone={tone} />
      )}
    </PanelFrame>
  );
}

function CollectionPanel({ title, rows, tone, currencyLabel }: { title: string; rows: CollectionReportRow[]; tone: PanelTone; currencyLabel: string }) {
  const toneClasses = panelToneClassNames[tone];

  return (
    <PanelFrame title={title} total={reportTableTotal(rows)} currencyLabel={currencyLabel} className="min-h-[320px]" tone={tone}>
      <div className={cn("grid grid-cols-[minmax(0,1fr)_118px] border-b text-[12px] font-black uppercase tracking-[0.02em]", toneClasses.tableHead)}>
        <span className="truncate px-4 py-3">Cari İsim</span>
        <span className="truncate px-4 py-3 text-right">Tutar</span>
      </div>
      {rows.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {rows.map((row, index) => (
            <div
              key={`${title}-${row.id}`}
              className={cn(
                "grid grid-cols-[minmax(0,1fr)_118px] border-b border-white/10 text-[13px] font-extrabold",
                panelRowClassName(index, tone)
              )}
            >
              <span className="truncate px-4 py-3 leading-snug" title={`${customerLabel(row)} · ${collectionDocumentNo(row)}`}>
                {customerLabel(row)}
              </span>
              <span className="truncate px-4 py-3 text-right tabular-nums">{compactMoney(row.amount, currencyLabel)}</span>
            </div>
          ))}
        </div>
      ) : (
        <EmptyRows label="Tahsilat kaydı yok" tone={tone} />
      )}
    </PanelFrame>
  );
}

type SummaryRowTone = "neutral" | "positive" | "warning" | "expense" | "total";

function normalizeUpper(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLocaleUpperCase("tr-TR");
}

function includesBatum(value?: string | null): boolean {
  return normalizeUpper(value).includes("BATUM");
}

function getSaleContextLabel(method: PosSaleType, isBatumPointFlow: boolean): string {
  if (isBatumPointFlow) {
    if (method === "card") {
      return "BATUM PERAKENDE KREDİ KARTI SATIŞ";
    }

    return "BATUM PERAKENDE NAKİT SATIŞ";
  }

  if (method === "card") {
    return "Kredi Kartı Satış";
  }

  return "Nakit Satış";
}

function isBatumPointFlow(session: PosDayEndReport["session"] | null): boolean {
  return includesBatum(session?.cashbox?.name) || includesBatum(session?.cashbox?.code);
}

function dayEndCurrencyLabel(session: PosDayEndReport["session"] | null): string {
  return isBatumPointFlow(session) ? "GEL" : "TL";
}

function formatLocalDateInputValue(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function addDaysToDateInputValue(value: string, dayDelta: number): string {
  const [year, month, day] = value.split("-").map((part) => Number(part));

  if (!year || !month || !day) {
    return formatLocalDateInputValue();
  }

  const nextDate = new Date(year, month - 1, day + dayDelta);

  return formatLocalDateInputValue(nextDate);
}

function formatReportDateDisplay(value: string): string {
  const [year, month, day] = value.split("-").map((part) => Number(part));

  if (!year || !month || !day) {
    return new Date().toLocaleDateString("tr-TR");
  }

  return new Date(year, month - 1, day).toLocaleDateString("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function sessionBranchLabel(session: PosSessionDto): string {
  const branch =
    session.opened_by.branch_name?.trim() ||
    session.opened_by.branch_code?.trim() ||
    session.opened_by.region_name?.trim() ||
    session.opened_by.region_code?.trim();
  const cashbox = [session.cashbox.code, session.cashbox.name].filter(Boolean).join(" / ");
  const user = session.opened_by.name?.trim();

  return [branch, cashbox, user].filter(Boolean).join(" · ") || `Oturum #${session.id}`;
}

function SummaryRow({ label, value, tone = "neutral" }: { label: string; value: string; tone?: SummaryRowTone }) {
  const toneClassNames: Record<SummaryRowTone, { row: string; label: string; value: string }> = {
    neutral: {
      row: "",
      label: "text-[#dfece2]",
      value: "border-[#2f4638] bg-[#0d2017] text-[#f0f8f1]",
    },
    positive: {
      row: "",
      label: "text-[#bff7cf]",
      value: "border-[#49c879]/65 bg-[linear-gradient(180deg,#1f8b4d_0%,#136436_100%)] text-[#f3fff6]",
    },
    warning: {
      row: "rounded-[12px] border border-[#f4c400] bg-[linear-gradient(180deg,#f4d20f_0%,#d9af07_100%)] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.26),0_14px_26px_-24px_rgba(244,196,0,0.75)]",
      label: "text-[#171203]",
      value: "border-transparent bg-transparent text-[#171203] shadow-none",
    },
    expense: {
      row: "rounded-[12px] border border-[#d14d4d] bg-[linear-gradient(180deg,#5b1717_0%,#2b0a0a_100%)] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_14px_26px_-24px_rgba(209,77,77,0.7)]",
      label: "text-[#ffd9d9]",
      value: "border-transparent bg-transparent text-[#ffb4b4] shadow-none",
    },
    total: {
      row: "rounded-[12px] border border-[#55dd82] bg-[linear-gradient(180deg,#2fc765_0%,#1d9c51_100%)] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_14px_26px_-24px_rgba(47,199,101,0.75)]",
      label: "text-[#f2fff5]",
      value: "border-transparent bg-transparent text-[#061b0c] shadow-none",
    },
  };
  const toneClasses = toneClassNames[tone];
  const isBandRow = tone === "warning" || tone === "expense" || tone === "total";

  return (
    <div
      className={cn(
        isBandRow
          ? "flex min-w-0 items-center justify-between gap-4"
          : "grid grid-cols-[minmax(0,1fr)_minmax(126px,148px)] items-center gap-2",
        toneClasses.row
      )}
    >
      <span className={cn("min-w-0 truncate whitespace-nowrap text-[15px] font-black leading-tight", toneClasses.label)}>{label}</span>
      <span
        className={cn(
          "flex h-11 shrink-0 items-center justify-end rounded-[10px] border px-3 text-right text-[17px] font-black leading-none tabular-nums shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]",
          isBandRow ? "min-w-[112px] px-0" : "",
          toneClasses.value
        )}
      >
        {value}
      </span>
    </div>
  );
}

function SummarySubmitRow({
  value,
}: {
  value: string;
}) {
  return (
    <div className="rounded-[12px] border border-[#55dd82] bg-[linear-gradient(180deg,#2fc765_0%,#1d9c51_100%)] px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_14px_26px_-24px_rgba(47,199,101,0.75)]">
      <div className="flex min-w-0 items-center justify-between gap-4">
        <span className="min-w-0 truncate whitespace-nowrap text-[15px] font-black leading-tight text-[#f2fff5]">Genel Toplam</span>
        <span className="flex h-11 min-w-[112px] shrink-0 items-center justify-end rounded-[10px] border border-transparent bg-transparent px-0 text-right text-[17px] font-black leading-none text-[#061b0c] tabular-nums shadow-none">
          {value}
        </span>
      </div>
    </div>
  );
}

function DayEndStatCard({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "neutral" | "gold" | "green" | "red";
}) {
  const toneClasses = {
    neutral: "border-[#2c4536] bg-[linear-gradient(180deg,#102219_0%,#0b1a13_100%)] text-[#f0f8f1]",
    gold: "border-[#e4c20d]/75 bg-[linear-gradient(180deg,#f2d646_0%,#c9a408_100%)] text-[#151203]",
    green: "border-[#55dd82]/70 bg-[linear-gradient(180deg,#2f9f5b_0%,#1a6e3d_100%)] text-white",
    red: "border-[#ff3b30] bg-[linear-gradient(180deg,#ff4d3d_0%,#b91216_100%)] text-white shadow-[0_0_0_1px_rgba(255,255,255,0.14),0_18px_46px_-20px_rgba(255,59,48,0.9)]",
  }[tone];

  return (
    <div className={cn("rounded-[14px] border px-4 py-3 shadow-[0_16px_36px_-32px_rgba(0,0,0,0.9)]", toneClasses)}>
      <div className="text-[11px] font-black uppercase tracking-[0.12em] opacity-75">{label}</div>
      <div className="mt-2 truncate text-[22px] font-black leading-none tabular-nums">{value}</div>
      {detail ? <div className="mt-2 truncate text-[11px] font-extrabold opacity-75">{detail}</div> : null}
    </div>
  );
}

function DayEndSaveAction({
  pending,
  disabled,
  historical,
}: {
  pending: boolean;
  disabled: boolean;
  historical: boolean;
}) {
  return (
    <div className="mt-auto border-t border-[#2f7d4d] pt-4">
      {historical ? (
        <p className="mb-3 rounded-[12px] border border-[#e4c20d]/45 bg-[#241f0a] px-3 py-2 text-xs font-black text-[#ffe77a]">
          Geçmiş tarih raporu sadece görüntülenir. Gün sonu kaydı bugünkü açık oturum için alınır.
        </p>
      ) : null}
      <Button
        type="submit"
        className="h-[58px] w-full rounded-[14px] !bg-[#0b2a18] text-lg font-black !text-white shadow-[0_18px_34px_-28px_rgba(0,0,0,0.86)] hover:!bg-[#133d25] hover:!text-white disabled:opacity-60"
        disabled={disabled}
      >
        {pending ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />}
        Kaydet
      </Button>
    </div>
  );
}

export function PosDayEndPage() {
  const router = useRouter();
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [sentDialogOpen, setSentDialogOpen] = useState(false);
  const [savingDayEnd, setSavingDayEnd] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [selectedReportDate, setSelectedReportDate] = useState(() => formatLocalDateInputValue());
  const [selectedSaleDetail, setSelectedSaleDetail] = useState<SaleReportRow | null>(null);
  const todayReportDate = formatLocalDateInputValue();
  const isSelectedReportToday = selectedReportDate === todayReportDate;
  const previousReportDate = addDaysToDateInputValue(selectedReportDate, -1);
  const selectedReportDateDisplay = formatReportDateDisplay(selectedReportDate);
  const previousReportDateDisplay = formatReportDateDisplay(previousReportDate);
  const roleSlugs = useMemo(() => user?.roles.map((role) => role.slug) ?? [], [user?.roles]);
  const hasPosMenuPermission = user?.menu_permissions?.includes("pos") ?? false;
  const canSelectSession = roleSlugs.some((role) => role === "admin" || role === "dealer_admin");
  const isPointRole =
    roleSlugs.includes("point") ||
    (hasPosMenuPermission && !roleSlugs.some((role) => role === "admin" || role === "dealer_admin" || role === "cashier"));

  const currentSessionQuery = useQuery({
    queryKey: ["pos", "session", "current"],
    queryFn: () => getCurrentPosSession(),
    enabled: !canSelectSession,
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: 15_000,
  });

  const currentSessionsQuery = useQuery({
    queryKey: ["pos", "sessions", "current", "all"],
    queryFn: () => getCurrentPosSessions(),
    enabled: canSelectSession,
    refetchInterval: 15_000,
  });

  const selectableSessions = useMemo(
    () => currentSessionsQuery.data?.data ?? [],
    [currentSessionsQuery.data?.data]
  );
  const effectiveSelectedSessionId =
    canSelectSession && selectableSessions.some((item) => String(item.id) === selectedSessionId)
      ? selectedSessionId
      : canSelectSession
        ? String(selectableSessions[0]?.id ?? "")
        : "";

  const selectedSession = canSelectSession
    ? selectableSessions.find((item) => String(item.id) === effectiveSelectedSessionId) ?? null
    : null;
  const session = canSelectSession ? selectedSession : currentSessionQuery.data?.data ?? null;

  const dayEndReportQuery = useQuery({
    queryKey: [
      "pos",
      "day-end",
      canSelectSession ? "session" : "cashbox",
      canSelectSession ? session?.id ?? null : session?.cashbox.id ?? null,
      selectedReportDate,
    ],
    queryFn: () => {
      if (!session) {
        throw new Error("No active session");
      }

      return getPosDayEndReport(
        canSelectSession
          ? { pos_session_id: session.id, date: selectedReportDate }
          : { cashbox_id: session.cashbox.id ?? undefined, date: selectedReportDate }
      );
    },
    enabled: Boolean(session && selectedReportDate),
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: 15_000,
  });

  const report = dayEndReportQuery.data?.data;

  const previousDayEndReportQuery = useQuery({
    queryKey: [
      "pos",
      "day-end",
      "previous-carry",
      canSelectSession ? session?.cashbox.id ?? session?.id ?? null : session?.cashbox.id ?? null,
      previousReportDate,
    ],
    queryFn: () => {
      if (!session) {
        throw new Error("No active session");
      }

      return getPosDayEndReport({ cashbox_id: session.cashbox.id ?? undefined, date: previousReportDate });
    },
    enabled: Boolean(session && previousReportDate),
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: 15_000,
  });

  const previousReport = previousDayEndReportQuery.data?.data;

  useEffect(() => {
    return subscribePosDayEndRefresh(() => {
      void queryClient.invalidateQueries({ queryKey: ["pos", "session", "current"] });
      void queryClient.invalidateQueries({ queryKey: ["pos", "sessions", "current", "all"] });
      void queryClient.invalidateQueries({ queryKey: ["pos", "day-end"] });
    });
  }, [queryClient]);

  const closeSessionSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!session) {
      toast.error("Açık POS oturumu yok.");
      return;
    }

    if (!isSelectedReportToday) {
      toast.error("Geçmiş tarih raporu sadece görüntülenebilir. Kaydet işlemi bugünkü açık oturum için yapılır.");
      return;
    }

    setSavingDayEnd(true);
    setSentDialogOpen(true);
    await dayEndReportQuery.refetch();
    setSavingDayEnd(false);
  };

  const busy =
    savingDayEnd ||
    currentSessionQuery.isFetching ||
    currentSessionsQuery.isFetching ||
    dayEndReportQuery.isFetching ||
    previousDayEndReportQuery.isFetching;
  const reportTables = report?.report_tables ?? emptyReportTables;
  const previousReportTables = previousReport?.report_tables ?? emptyReportTables;
  const normalSaleTotal = useMemo(() => reportTableTotal(reportTables.normal_sales), [reportTables.normal_sales]);
  const cardSaleTotal = useMemo(() => reportTableTotal(reportTables.card_sales), [reportTables.card_sales]);
  const cardCollectionTotal = useMemo(() => reportTableTotal(reportTables.card_collections), [reportTables.card_collections]);
  const transferCollectionTotal = useMemo(() => reportTableTotal(reportTables.transfer_collections ?? []), [reportTables.transfer_collections]);
  const checkCollectionTotal = useMemo(() => reportTableTotal(reportTables.check_collections ?? []), [reportTables.check_collections]);
  const noteCollectionTotal = useMemo(() => reportTableTotal(reportTables.note_collections ?? []), [reportTables.note_collections]);
  const factoryCardCollectionTotal = useMemo(() => reportTableTotal(reportTables.factory_card_collections ?? []), [reportTables.factory_card_collections]);
  const cashSaleTotal = useMemo(() => reportTableTotal(reportTables.cash_sales), [reportTables.cash_sales]);
  const cashCollectionTotal = useMemo(() => reportTableTotal(reportTables.cash_collections), [reportTables.cash_collections]);
  const previousCashSaleTotal = useMemo(() => reportTableTotal(previousReportTables.cash_sales), [previousReportTables.cash_sales]);
  const previousCashCollectionTotal = useMemo(
    () => reportTableTotal(previousReportTables.cash_collections),
    [previousReportTables.cash_collections]
  );
  const previousExpenseTotal = toMoney(previousReport?.summary.expense_total ?? 0);
  const previousCarryTotal = previousCashSaleTotal + previousCashCollectionTotal - previousExpenseTotal;
  const effectiveReportSession = report?.session ?? session;
  const isBatumFlow = isBatumPointFlow(effectiveReportSession);
  const currencyLabel = dayEndCurrencyLabel(effectiveReportSession);
  const cashSalePanelTitle = getSaleContextLabel("cash", isBatumFlow);
  const cardSalePanelTitle = getSaleContextLabel("card", isBatumFlow);
  const cardGrandTotal = normalSaleTotal + cardSaleTotal + cardCollectionTotal;
  const openingCashTotal = previousCarryTotal;
  const expenseTotal = toMoney(report?.summary.expense_total ?? 0);
  const dayEndGrandTotal = openingCashTotal + cashSaleTotal + cashCollectionTotal - expenseTotal;
  const collectionTotal = cashCollectionTotal + cardCollectionTotal;
  const salesTotal = normalSaleTotal + cashSaleTotal + cardSaleTotal;
  const selectedDateOperationalTotal = cardGrandTotal + dayEndGrandTotal;
  const cashboxLabel = session ? `${session.cashbox.code ?? "-"} / ${session.cashbox.name ?? "Tanımsız"}` : "-";
  const sessionLoading = canSelectSession ? currentSessionsQuery.isLoading : currentSessionQuery.isLoading;

  const content = (
    <div className="min-h-[calc(100vh-16px)] space-y-3 bg-[linear-gradient(180deg,#07120e_0%,#0b1712_55%,#06110d_100%)] p-3 !text-[#eef8ef]">
      <section className="flex flex-col gap-4 rounded-[16px] border border-[#24382d] bg-[linear-gradient(135deg,rgba(17,32,24,0.96)_0%,rgba(9,22,16,0.98)_100%)] px-5 py-4 shadow-[0_18px_48px_-42px_rgba(0,0,0,0.92),inset_0_1px_0_rgba(255,255,255,0.05)] lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[18px] border border-[#3c5d48] bg-[#203d2c] text-[#edf7ef] shadow-[0_18px_38px_-30px_rgba(0,0,0,0.88)]">
            <Wallet className="h-8 w-8" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-4xl font-black tracking-tight text-white">Gün Sonu Raporu</h1>
            <p className="mt-2 truncate text-sm font-bold text-slate-300">
              {session ? `Oturum #${session.id} · ${cashboxLabel} · ${new Date(session.opened_at).toLocaleString("tr-TR")}` : "Açık POS oturumu bekleniyor"}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-14 rounded-[16px] !border-[#3c5d48] !bg-[#13251b] px-4 text-sm font-black !text-[#dcebe0] hover:!bg-[#1c3928] hover:!text-white"
            onClick={() => router.back()}
          >
            <ArrowLeft className="h-4 w-4" />
            Geri
          </Button>
          {canSelectSession ? (
            <Select value={effectiveSelectedSessionId} onValueChange={setSelectedSessionId} disabled={busy || selectableSessions.length === 0}>
              <SelectTrigger className="h-14 min-w-[280px] rounded-[16px] border-[#3c5d48] bg-[#112219] px-4 text-left text-base font-black text-white shadow-[0_16px_28px_-24px_rgba(0,0,0,0.9)]">
                <SelectValue placeholder="Şube / kasa seç" />
              </SelectTrigger>
              <SelectContent>
                {selectableSessions.map((item) => (
                  <SelectItem key={item.id} value={String(item.id)}>
                    {sessionBranchLabel(item)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <div className="flex h-14 items-center gap-1 rounded-[16px] border border-[#3c5d48] bg-[#112219] p-1 shadow-[0_16px_28px_-24px_rgba(0,0,0,0.9)]">
            <Button
              type="button"
              variant="ghost"
              className="h-11 w-11 rounded-[12px] !text-[#dcebe0] hover:!bg-[#1c3928] hover:!text-white"
              onClick={() => setSelectedReportDate((value) => addDaysToDateInputValue(value, -1))}
              disabled={busy}
              aria-label="Önceki gün"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <Input
              type="date"
              value={selectedReportDate}
              onChange={(event) => setSelectedReportDate(event.target.value || todayReportDate)}
              className="h-11 w-[148px] rounded-[12px] border-[#ff3b30] bg-[#3a0909] px-3 text-center text-[14px] font-black text-white shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_0_22px_rgba(255,59,48,0.45)] [color-scheme:dark]"
              disabled={busy}
            />
            <Button
              type="button"
              variant="ghost"
              className="h-11 w-11 rounded-[12px] !text-[#dcebe0] hover:!bg-[#1c3928] hover:!text-white"
              onClick={() => setSelectedReportDate((value) => addDaysToDateInputValue(value, 1))}
              disabled={busy}
              aria-label="Sonraki gün"
            >
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
          <Button
            type="button"
            variant="outline"
            className="h-14 rounded-[16px] !border-[#e4c20d]/70 !bg-[#231f0b] px-4 text-sm font-black !text-[#ffe77a] hover:!bg-[#3a310f] hover:!text-[#fff1a3]"
            onClick={() => setSelectedReportDate(todayReportDate)}
            disabled={busy || isSelectedReportToday}
          >
            Bugün
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-14 rounded-[16px] !border-[#3c5d48] !bg-[#13251b] px-4 text-sm font-black !text-[#dcebe0] hover:!bg-[#1c3928] hover:!text-white"
            onClick={() => setSelectedReportDate(addDaysToDateInputValue(todayReportDate, -1))}
            disabled={busy}
          >
            Dün
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-14 rounded-[16px] !border-slate-500/70 !bg-slate-100 px-6 text-base font-black !text-slate-950 shadow-[0_16px_28px_-22px_rgba(0,0,0,0.9)] hover:!bg-white hover:!text-slate-950"
            onClick={() => {
              void currentSessionQuery.refetch();
              void currentSessionsQuery.refetch();
              void dayEndReportQuery.refetch();
            }}
            disabled={busy}
          >
            <RefreshCcw className="h-4 w-4" /> Yenile
          </Button>
          <Button asChild className="h-14 rounded-[16px] !bg-[#3f7b58] px-6 text-base font-black !text-white shadow-[0_18px_34px_-26px_rgba(0,0,0,0.86)] hover:!bg-[#4c8b67] hover:!text-white">
            <Link href="/pos">
              <ShoppingCart className="h-4 w-4" /> Satışa Dön
            </Link>
          </Button>
        </div>
      </section>

      {sessionLoading ? (
        <div className="grid gap-3 xl:grid-cols-4">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={`day-end-loading-${index}`} className="h-56 rounded-[8px]" />
          ))}
        </div>
      ) : null}

      {!sessionLoading && !session ? (
        <section className="rounded-[12px] border border-[#d7e5db] bg-[#111b15] p-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-lg font-black text-[#f4f8f5]">
                {canSelectSession ? "Açık şube/kasa oturumu bulunmuyor." : "Açık POS oturumu bulunmuyor."}
              </p>
              <p className="mt-1 text-sm font-semibold text-[#aebcb1]">
                {canSelectSession
                  ? "Erzurum, Trabzon, Samsun veya Batum için açık hızlı satış oturumu olduğunda buradan seçebilirsiniz."
                  : "Gün sonu almak için önce hızlı satış ekranındaki mevcut oturumla çalışın."}
              </p>
            </div>
            <Button asChild className="h-12 rounded-[12px] !bg-[#3f8b5f] px-5 font-black !text-white hover:!bg-[#4a9b6d]">
              <Link href="/pos">
                <ShoppingCart className="h-4 w-4" /> Hızlı Satışa Dön
              </Link>
            </Button>
          </div>
        </section>
      ) : null}

      {!sessionLoading && session ? (
        <>
          {dayEndReportQuery.isLoading ? (
            <div className="grid gap-3 xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, index) => (
                <Skeleton key={`day-end-skeleton-${index}`} className="h-56 rounded-[8px]" />
              ))}
            </div>
          ) : report ? (
            <>
              <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
                <DayEndStatCard
                  label="Rapor Tarihi"
                  value={selectedReportDateDisplay}
                  detail={isSelectedReportToday ? "Bugünkü açık gün sonu" : "Geçmiş tarih raporu"}
                  tone="red"
                />
                <DayEndStatCard label="Satış Toplamı" value={compactMoney(salesTotal, currencyLabel)} detail="Cari + nakit + kart" />
                <DayEndStatCard label="Tahsilat" value={compactMoney(collectionTotal, currencyLabel)} detail="Nakit + kart" />
                <DayEndStatCard label="Masraf" value={compactMoney(expenseTotal, currencyLabel)} detail="Seçili tarih" />
                <DayEndStatCard label="Dünden Devreden" value={compactMoney(previousCarryTotal, currencyLabel)} detail={previousReportDateDisplay} tone="green" />
                <DayEndStatCard label="Genel" value={compactMoney(selectedDateOperationalTotal, currencyLabel)} detail="Satış + kasa" tone="green" />
              </section>

              <section className="grid min-h-[calc(100vh-242px)] gap-3 xl:grid-cols-[1.05fr_1.15fr_1.15fr_0.9fr]">
                <SalePanel title="Cari Satış" rows={reportTables.normal_sales} tone="emerald" currencyLabel={currencyLabel} className="xl:row-span-2 xl:min-h-full" onDetail={setSelectedSaleDetail} />
                <SalePanel title={cashSalePanelTitle} rows={reportTables.cash_sales} tone="emerald" currencyLabel={currencyLabel} onDetail={setSelectedSaleDetail} />
                <SalePanel title={cardSalePanelTitle} rows={reportTables.card_sales} tone="emerald" currencyLabel={currencyLabel} onDetail={setSelectedSaleDetail} />

                <form
                  className="flex min-h-[420px] flex-col rounded-[14px] border border-[#34463a] bg-[linear-gradient(180deg,rgba(24,38,30,0.98)_0%,rgba(11,24,17,0.99)_100%)] p-4 shadow-[0_18px_42px_-36px_rgba(0,0,0,0.82)] xl:row-span-2 xl:min-h-full"
                  onSubmit={closeSessionSubmit}
                >
                  <div className="mb-3 rounded-[12px] border border-[#ff3b30] bg-[linear-gradient(180deg,#4b0c0c_0%,#210707_100%)] p-3 shadow-[0_0_28px_rgba(255,59,48,0.34)]">
                    <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.12em] text-[#a9bdb0]">
                      <CalendarDays className="h-4 w-4" />
                      Seçili Tarih
                    </div>
                    <div className="mt-2 text-3xl font-black text-white drop-shadow-[0_2px_10px_rgba(255,255,255,0.35)]">{selectedReportDateDisplay}</div>
                  </div>

                  <div className="mb-3 rounded-[12px] border border-[#49c879]/45 bg-[linear-gradient(180deg,#123321_0%,#0a1f14_100%)] p-3 shadow-[0_16px_34px_-30px_rgba(73,200,121,0.7)]">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="text-[12px] font-black uppercase tracking-[0.12em] text-[#bff7cf]">Dünden Devreden</span>
                      <span className="rounded-full border border-[#49c879]/50 bg-[#0c2818] px-3 py-1 text-xs font-black text-[#d9ffe4]">
                        {previousReportDateDisplay}
                      </span>
                    </div>
                    <div className="space-y-2">
                      <SummaryRow label="Dünkü Nakit Satış" value={compactMoney(previousCashSaleTotal, currencyLabel)} />
                      <SummaryRow label="Dünkü Nakit Tahsilat" value={compactMoney(previousCashCollectionTotal, currencyLabel)} />
                      <SummaryRow label="Dünkü Masraf" value={compactMoney(previousExpenseTotal, currencyLabel)} tone="expense" />
                      <SummaryRow label="Devreden Genel Toplam" value={compactMoney(previousCarryTotal, currencyLabel)} tone="total" />
                    </div>
                  </div>

                  <div className="space-y-2.5">
                    {[
                      ["Cari Satış", compactMoney(normalSaleTotal, currencyLabel)],
                      [cardSalePanelTitle, compactMoney(cardSaleTotal, currencyLabel)],
                      ["Kredi Kart Tahsilat", compactMoney(cardCollectionTotal, currencyLabel)],
                    ].map(([label, value]) => (
                      <SummaryRow key={label} label={label} value={value} />
                    ))}
                    <SummaryRow label="Genel Toplam" value={compactMoney(cardGrandTotal, currencyLabel)} tone="warning" />
                    <div className="space-y-2.5 border-t border-[#2f7d4d] pt-3">
                      {[
                        { label: "Dünden Devreden", value: compactMoney(openingCashTotal, currencyLabel), tone: "positive" as const },
                        { label: cashSalePanelTitle, value: compactMoney(cashSaleTotal, currencyLabel), tone: "positive" as const },
                        { label: "Nakit Tahsilat", value: compactMoney(cashCollectionTotal, currencyLabel), tone: "positive" as const },
                        { label: "Masraf", value: compactMoney(expenseTotal, currencyLabel), tone: "expense" as const },
                      ].map((row) => (
                        <SummaryRow key={row.label} label={row.label} value={row.value} tone={row.tone} />
                      ))}
                      <SummarySubmitRow value={compactMoney(dayEndGrandTotal, currencyLabel)} />
                    </div>
                  </div>

                  <DayEndSaveAction
                    pending={savingDayEnd}
                    disabled={busy || !isSelectedReportToday}
                    historical={!isSelectedReportToday}
                  />
                </form>
                <CollectionPanel title="Nakit Tahsilat" rows={reportTables.cash_collections} tone="emerald" currencyLabel={currencyLabel} />
                <CollectionPanel title="Kredi Kartı Tahsilat" rows={reportTables.card_collections} tone="emerald" currencyLabel={currencyLabel} />
              </section>
            </>
          ) : (
            <section className="rounded-[12px] border border-[#d7e5db] bg-[#111b15] p-5">
              <p className="text-sm font-black text-[#aebcb1]">Canlı özet verisi alınamadı.</p>
            </section>
          )}
        </>
      ) : null}
      <Dialog open={selectedSaleDetail !== null} onOpenChange={(open) => !open && setSelectedSaleDetail(null)}>
        <DialogContent className="max-h-[88vh] max-w-[920px] overflow-hidden rounded-[24px] border border-[#55dd82]/45 bg-[linear-gradient(180deg,#102719_0%,#07130d_100%)] text-white shadow-[0_30px_90px_-48px_rgba(0,0,0,0.95)]">
          <DialogHeader>
            <DialogTitle className="text-2xl font-black tracking-tight text-white">
              Satış Detayı · {selectedSaleDetail ? saleDocumentNo(selectedSaleDetail) : ""}
            </DialogTitle>
            <DialogDescription className="text-sm font-bold text-[#c7dccd]">
              Hangi ürün, kime, kaç adet ve hangi depodan satıldı bilgisi.
            </DialogDescription>
          </DialogHeader>
          {selectedSaleDetail ? (
            <div className="min-h-0 space-y-4 overflow-auto pr-1">
              <div className="grid gap-3 md:grid-cols-4">
                {[
                  ["Cari", customerLabel(selectedSaleDetail)],
                  ["Belge No", saleDocumentNo(selectedSaleDetail)],
                  ["Satışı Yapan", selectedSaleDetail.created_by_name ?? "-"],
                  ["Tarih", selectedSaleDetail.created_at ? new Date(selectedSaleDetail.created_at).toLocaleString("tr-TR") : "-"],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-2xl border border-white/10 bg-white/7 p-3">
                    <p className="text-[11px] font-black uppercase tracking-[0.12em] text-[#9fb6a7]">{label}</p>
                    <p className="mt-1 text-sm font-black text-white">{value}</p>
                  </div>
                ))}
              </div>
              <div className="overflow-hidden rounded-2xl border border-white/10">
                <div className="grid grid-cols-[130px_minmax(220px,1fr)_92px_118px_118px_150px] bg-[#173824] text-[11px] font-black uppercase tracking-[0.08em] text-[#dfffe6]">
                  <span className="px-3 py-3">Ürün Kodu</span>
                  <span className="px-3 py-3">Ürün Adı</span>
                  <span className="px-3 py-3 text-right">Miktar</span>
                  <span className="px-3 py-3 text-right">Birim Fiyat</span>
                  <span className="px-3 py-3 text-right">Toplam</span>
                  <span className="px-3 py-3">Depo</span>
                </div>
                <div className="max-h-[420px] overflow-auto">
                  {(selectedSaleDetail.items ?? []).length > 0 ? (
                    (selectedSaleDetail.items ?? []).map((item, index) => (
                      <div
                        key={`${item.product_code ?? "urun"}-${index}`}
                        className="grid grid-cols-[130px_minmax(220px,1fr)_92px_118px_118px_150px] border-t border-white/10 bg-[#0d2418] text-sm font-bold text-[#f1fff5]"
                      >
                        <span className="px-3 py-3 font-black">{item.product_code ?? "-"}</span>
                        <span className="px-3 py-3">{item.product_name ?? "-"}</span>
                        <span className="px-3 py-3 text-right tabular-nums">{Number(item.quantity).toLocaleString("tr-TR")}</span>
                        <span className="px-3 py-3 text-right tabular-nums">
                          {compactMoney(item.unit_price_vat_included ?? item.unit_price, currencyLabel)}
                        </span>
                        <span className="px-3 py-3 text-right tabular-nums">
                          {compactMoney(item.line_total_vat_included ?? item.line_total, currencyLabel)}
                        </span>
                        <span className="px-3 py-3">{item.warehouse_name ?? selectedSaleDetail.warehouse_name ?? "-"}</span>
                      </div>
                    ))
                  ) : (
                    <div className="px-4 py-6 text-center text-sm font-black text-[#c7dccd]">Kalem bilgisi bulunamadı.</div>
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={sentDialogOpen} onOpenChange={setSentDialogOpen}>
        <DialogContent className="max-w-[420px] rounded-[26px] border border-[#55dd82]/45 bg-[linear-gradient(180deg,#102719_0%,#07130d_100%)] text-white shadow-[0_30px_90px_-48px_rgba(0,0,0,0.95)]">
          <DialogHeader className="items-center text-center">
            <span className="mb-2 flex h-16 w-16 items-center justify-center rounded-full border border-[#55dd82]/60 bg-[#1b8d4a] text-white shadow-[0_18px_42px_-28px_rgba(85,221,130,0.8)]">
              <CheckCircle2 className="h-9 w-9" />
            </span>
            <DialogTitle className="text-3xl font-black tracking-tight text-white">Gönderildi</DialogTitle>
            <DialogDescription className="text-base font-bold text-[#c7dccd]">
              Gün sonu kaydı alındı. Kasa oturumu açık kalır.
            </DialogDescription>
          </DialogHeader>
          <Button
            type="button"
            className="mt-2 h-12 rounded-[14px] !bg-[#3f7b58] text-base font-black !text-white hover:!bg-[#4c8b67]"
            onClick={() => setSentDialogOpen(false)}
          >
            Tamam
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );

  if (isPointRole) {
    return <div className="point-admin-page">{content}</div>;
  }

  return content;
}
