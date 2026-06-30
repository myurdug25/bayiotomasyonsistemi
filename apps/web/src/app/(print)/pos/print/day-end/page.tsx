"use client";

import { useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Printer } from "lucide-react";

import {
  getCurrentPosSession,
  getPosDayEndReport,
  type PosSaleType,
} from "@/lib/api";
import { Button } from "@/components/ui/button";

function formatMoney(value: string | number) {
  const amount = typeof value === "number" ? value : Number(value);
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    minimumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0);
}

function methodLabel(method: PosSaleType) {
  if (method === "cash") {
    return "Nakit";
  }

  if (method === "card") {
    return "Kredi Kartı";
  }

  return "Havale";
}

function parseNumber(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export default function PosDayEndPrintPage() {
  const searchParams = useSearchParams();
  const printedRef = useRef(false);

  const queryFilters = useMemo(
    () => ({
      pos_session_id: parseNumber(searchParams.get("pos_session_id")),
      cashbox_id: parseNumber(searchParams.get("cashbox_id")),
      date: searchParams.get("date") ?? undefined,
      date_from: searchParams.get("date_from") ?? undefined,
      date_to: searchParams.get("date_to") ?? undefined,
    }),
    [searchParams]
  );

  const hasExplicitFilter = useMemo(
    () =>
      Boolean(
        queryFilters.pos_session_id ||
          queryFilters.cashbox_id ||
          queryFilters.date ||
          queryFilters.date_from ||
          queryFilters.date_to
      ),
    [queryFilters]
  );

  const currentSessionQuery = useQuery({
    queryKey: ["pos", "print", "day-end", "session", "current"],
    queryFn: () => getCurrentPosSession(),
    enabled: !hasExplicitFilter,
  });

  const effectiveSessionId = hasExplicitFilter
    ? queryFilters.pos_session_id
    : (queryFilters.pos_session_id ?? currentSessionQuery.data?.data?.id ?? undefined);

  const dayEndQuery = useQuery({
    queryKey: ["pos", "print", "day-end", queryFilters, effectiveSessionId ?? null],
    queryFn: () =>
      getPosDayEndReport({
        ...queryFilters,
        pos_session_id: effectiveSessionId,
      }),
    enabled: hasExplicitFilter || !currentSessionQuery.isLoading,
  });

  const report = dayEndQuery.data?.data;

  useEffect(() => {
    if (!report || printedRef.current) {
      return;
    }

    printedRef.current = true;
    window.setTimeout(() => window.print(), 120);
  }, [report]);

  if (currentSessionQuery.isLoading || dayEndQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-neutral-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Rapor hazırlanıyor...
      </div>
    );
  }

  if (dayEndQuery.isError || !report) {
    return (
      <div className="mx-auto max-w-md p-6 text-center text-sm text-red-600">
        {(dayEndQuery.error as Error)?.message ?? "Gun sonu raporu alinamadi."}
      </div>
    );
  }

  return (
    <main className="report-wrap p-5 text-[12px] text-black">
      <style jsx global>{`
        @page {
          margin: 10mm;
        }

        @media screen {
          .day-end-section {
            display: none !important;
          }

          .print-waiting {
            display: flex !important;
          }
        }

        @media print {
          body {
            background: #fff !important;
          }

          .print-waiting {
            display: none !important;
          }

          .report-wrap {
            padding: 0;
          }
        }
      `}</style>


      <div
        className="print-waiting"
        style={{ display: "none", alignItems: "center", justifyContent: "center", minHeight: "100vh", flexDirection: "column", gap: "12px", color: "#555", fontSize: "14px" }}
      >
        <span>Yazdırma ekranı açılıyor...</span>
      </div>

      <section className="day-end-section mx-auto w-full max-w-3xl border border-neutral-300 p-4">
        <header className="border-b border-neutral-300 pb-3">
          <h1 className="text-lg font-bold">Powersa POS - Gun Sonu Ozeti</h1>
          <p className="mt-1 text-xs text-neutral-700">Uretilme: {new Date(report.generated_at).toLocaleString("tr-TR")}</p>
          {report.session ? (
            <p className="mt-1 text-xs text-neutral-700">
              Oturum #{report.session.id} · {report.session.cashbox.code ?? "-"} / {report.session.cashbox.name ?? "-"}
            </p>
          ) : null}
        </header>

        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <div className="border border-neutral-300 p-2">
            <p className="text-[11px] text-neutral-600">Toplam Satis</p>
            <p className="text-lg font-bold">{report.summary.sale_count}</p>
          </div>
          <div className="border border-neutral-300 p-2">
            <p className="text-[11px] text-neutral-600">Iptal Satis</p>
            <p className="text-lg font-bold">{report.summary.cancelled_count}</p>
          </div>
          <div className="border border-neutral-300 p-2">
            <p className="text-[11px] text-neutral-600">KDV Toplami</p>
            <p className="text-lg font-bold">{formatMoney(report.summary.vat_total)}</p>
          </div>
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="border border-neutral-300 p-2">
            <p className="text-[11px] text-neutral-600">Genel Toplam</p>
            <p className="text-lg font-bold">{formatMoney(report.summary.grand_total)}</p>
          </div>
          <div className="border border-neutral-300 p-2">
            <p className="text-[11px] text-neutral-600">Net Toplam</p>
            <p className="text-lg font-bold">{formatMoney(report.summary.net_total)}</p>
          </div>
        </div>

        <table className="mt-4 w-full border-collapse">
          <thead>
            <tr className="border-y border-neutral-300 text-left">
              <th className="py-1">Odeme Yontemi</th>
              <th className="py-1 text-right">Islem</th>
              <th className="py-1 text-right">Toplam</th>
            </tr>
          </thead>
          <tbody>
            {report.totals_by_method.map((row) => (
              <tr key={row.method} className="border-b border-neutral-200">
                <td className="py-1">{methodLabel(row.method)}</td>
                <td className="py-1 text-right">{row.payment_count}</td>
                <td className="py-1 text-right">{formatMoney(row.total_amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="border border-neutral-300 p-2">
            <p className="text-[11px] text-neutral-600">Belge Adetleri</p>
            <p className="mt-1">Fatura: {report.summary.document_count.invoice}</p>
            <p>Irsaliye: {report.summary.document_count.delivery}</p>
          </div>
          <div className="border border-neutral-300 p-2">
            <p className="text-[11px] text-neutral-600">Iptal Ozeti</p>
            <p className="mt-1">Adet: {report.cancelled.count}</p>
            <p>Tutar: {formatMoney(report.cancelled.total_amount)}</p>
          </div>
        </div>
      </section>
    </main>
  );
}
