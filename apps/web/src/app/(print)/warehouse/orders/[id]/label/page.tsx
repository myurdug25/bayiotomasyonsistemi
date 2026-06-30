"use client";

import { useEffect, useMemo, useRef } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { getOrderDetail } from "@/lib/api";

function clean(value: string | null | undefined): string {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : "-";
}

function upper(value: string | null | undefined): string {
  return clean(value).toLocaleUpperCase("tr-TR");
}

function formatDateTime(value: string | null | undefined): string {
  const parsed = value ? new Date(value) : new Date();

  if (Number.isNaN(parsed.getTime())) {
    return value ?? "-";
  }

  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(parsed);
}

export default function WarehouseOrderLabelPage() {
  const params = useParams<{ id: string }>();
  const printedRef = useRef(false);

  const orderId = useMemo(() => {
    const parsed = Number(params.id);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, [params.id]);

  const orderQuery = useQuery({
    queryKey: ["warehouse", "order-label", orderId],
    queryFn: () => {
      if (!orderId) {
        throw new Error("Geçersiz sipariş ID");
      }

      return getOrderDetail(orderId);
    },
    enabled: Boolean(orderId),
  });

  const order = orderQuery.data?.order;

  useEffect(() => {
    if (!order || printedRef.current) {
      return;
    }

    printedRef.current = true;
    window.setTimeout(() => window.print(), 120);
  }, [order]);

  if (orderQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-neutral-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Kargo etiketi hazırlanıyor...
      </div>
    );
  }

  if (orderQuery.isError || !order) {
    return (
      <div className="mx-auto max-w-md p-6 text-center text-sm text-red-600">
        {(orderQuery.error as Error)?.message ?? "Sipariş verisi alınamadı."}
      </div>
    );
  }

  const customer = order.customer;
  const cityLine = [customer?.district, customer?.city].filter(Boolean).join("/") || "-";
  const address = clean(customer?.address);
  const phone = clean(customer?.phone);

  return (
    <main className="label-print-wrap min-h-screen bg-neutral-200 p-4 text-black">
      <style jsx global>{`
        @page {
          size: 100mm 75mm;
          margin: 3mm;
        }

        @media screen {
          .cargo-label {
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

          .label-print-wrap {
            min-height: 0 !important;
            background: #fff !important;
            padding: 0 !important;
          }

          .cargo-label {
            box-shadow: none !important;
          }
        }
      `}</style>


      <div
        className="print-waiting"
        style={{ display: "none", alignItems: "center", justifyContent: "center", minHeight: "100vh", flexDirection: "column", gap: "12px", color: "#555", fontSize: "14px" }}
      >
        <span>Yazdırma ekranı açılıyor...</span>
      </div>

      <section className="cargo-label mx-auto h-[75mm] w-[100mm] border border-neutral-400 bg-white p-[3mm] shadow-xl">
        <div className="flex h-full flex-col border border-dotted border-neutral-400 p-[3mm]">
          <header className="bg-black px-3 py-2 text-center text-white">
            <h1 className="text-[18px] font-black leading-tight tracking-[0.02em]">
              {upper(customer?.title)}
            </h1>
          </header>

          <div className="flex flex-1 flex-col justify-between px-2 py-3">
            <div className="text-center">
              <p className="text-[15px] font-black leading-tight">{upper(address)}</p>
              <p className="mt-4 text-[10px] font-black">{upper(cityLine)}</p>
            </div>

            <div className="grid grid-cols-[1fr_45mm] items-end gap-3">
              <div className="space-y-2 text-[11px] font-black">
                <p>{phone}</p>
                <p>{formatDateTime(order.ordered_at)}</p>
              </div>

              <div className="space-y-1">
                <div className="border-2 border-neutral-700 px-1 py-0.5 text-[15px] font-black leading-tight">
                  1 Desi
                </div>
                <div className="border-2 border-neutral-700 px-1 py-0.5 text-[15px] font-black leading-tight">
                  Koli No: 1
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
