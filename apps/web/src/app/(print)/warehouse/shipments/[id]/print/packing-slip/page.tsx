"use client";

import { useEffect, useMemo, useRef } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Printer } from "lucide-react";

import { getWarehouseShipment, type WarehouseShipmentItemDto } from "@/lib/api";
import { Button } from "@/components/ui/button";

function formatMoney(value: string, currency = "TRY") {
  const amount = Number(value);
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0);
}

function formatDate(value: string | null | undefined) {
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

function mergeShipmentItems(params: {
  remaining: WarehouseShipmentItemDto[];
  shipped: WarehouseShipmentItemDto[];
}) {
  const byId = new Map<number, WarehouseShipmentItemDto>();

  params.remaining.forEach((item) => {
    byId.set(item.id, item);
  });

  params.shipped.forEach((item) => {
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      return;
    }

    byId.set(item.id, {
      ...existing,
      shipped_qty: Math.max(existing.shipped_qty, item.shipped_qty),
      remaining_qty: Math.min(existing.remaining_qty, item.remaining_qty),
      line_total_shipped: item.line_total_shipped,
    });
  });

  return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}

export default function WarehousePackingSlipPrintPage() {
  const params = useParams<{ id: string }>();
  const printedRef = useRef(false);

  const shipmentId = useMemo(() => {
    const parsed = Number(params.id);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, [params.id]);

  const shipmentQuery = useQuery({
    queryKey: ["warehouse", "print", "packing-slip", shipmentId],
    queryFn: () => {
      if (!shipmentId) {
        throw new Error("Geçersiz sevkiyat ID");
      }

      return getWarehouseShipment(shipmentId);
    },
    enabled: Boolean(shipmentId),
  });

  const state = shipmentQuery.data?.data;

  const allItems = useMemo(() => {
    if (!state) {
      return [];
    }

    return mergeShipmentItems({
      remaining: state.remaining_items,
      shipped: state.shipped_items,
    });
  }, [state]);

  useEffect(() => {
    if (!state || printedRef.current) {
      return;
    }

    printedRef.current = true;
    window.setTimeout(() => window.print(), 120);
  }, [state]);

  if (shipmentQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-neutral-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Packing slip hazırlanıyor...
      </div>
    );
  }

  if (shipmentQuery.isError || !state) {
    return (
      <div className="mx-auto max-w-md p-6 text-center text-sm text-red-600">
        {(shipmentQuery.error as Error)?.message ?? "Sevkiyat verisi alınamadı."}
      </div>
    );
  }

  const shipment = state.shipment;
  const customer = shipment.order.customer;

  return (
    <main className="packing-print-wrap p-5 text-[12px] text-black">
      <style jsx global>{`
        @page {
          size: A4;
          margin: 10mm;
        }

        @media screen {
          .packing-print-section {
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

          .packing-print-wrap {
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

      <section className="packing-print-section mx-auto w-full max-w-4xl border border-neutral-300 bg-white p-4">
        <header className="flex items-start justify-between gap-3 border-b border-neutral-300 pb-3">
          <div>
            <h1 className="text-lg font-bold">Powersa B2B - Packing Slip</h1>
            <p className="mt-1 text-xs text-neutral-700">Sevkiyat Toplama Fişi</p>
          </div>
          <div className="text-right text-xs">
            <p><strong>Sevkiyat:</strong> {shipment.shipment_no}</p>
            <p><strong>Sipariş:</strong> {shipment.order.order_no ?? "-"}</p>
            <p><strong>Tarih:</strong> {formatDate(shipment.shipped_at ?? shipment.created_at)}</p>
            <p><strong>Durum:</strong> {shipment.status}</p>
          </div>
        </header>

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="border border-neutral-300 p-2">
            <p className="text-[11px] font-semibold text-neutral-600">ALICI CARİ</p>
            <p className="mt-1 font-semibold">{customer.title ?? "-"}</p>
            <p>Kod: {customer.code ?? "-"}</p>
          </div>
          <div className="border border-neutral-300 p-2">
            <p className="text-[11px] font-semibold text-neutral-600">SEVKİYAT</p>
            <p className="mt-1">Depo: {shipment.warehouse.name ?? "-"}</p>
            <p>Taşıyıcı: {shipment.carrier_name ?? "-"}</p>
            <p>Takip No: {shipment.tracking_no ?? "-"}</p>
          </div>
        </div>

        <table className="mt-4 w-full border-collapse">
          <thead>
            <tr className="border-y border-neutral-300 text-left">
              <th className="py-1">SKU/OEM</th>
              <th className="py-1">Ürün</th>
              <th className="py-1 text-right">Sipariş</th>
              <th className="py-1 text-right">Sevk</th>
              <th className="py-1 text-right">Kalan</th>
              <th className="py-1 text-right">Tutar</th>
            </tr>
          </thead>
          <tbody>
            {allItems.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-4 text-center text-neutral-500">Kalem bulunamadı</td>
              </tr>
            ) : (
              allItems.map((item) => (
                <tr key={item.id} className="border-b border-neutral-200 align-top">
                  <td className="py-1 pr-2">{item.sku ?? item.oem ?? "-"}</td>
                  <td className="py-1 pr-2">{item.name ?? "-"}</td>
                  <td className="py-1 text-right">{item.ordered_qty}</td>
                  <td className="py-1 text-right">{item.shipped_qty}</td>
                  <td className="py-1 text-right">{item.remaining_qty}</td>
                  <td className="py-1 text-right">{formatMoney(item.line_total_shipped)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        <div className="mt-4 ml-auto w-full max-w-xs border border-neutral-300 p-2 text-sm">
          <p className="flex items-center justify-between">
            <span>Toplam Sipariş</span>
            <strong>{state.totals.ordered_qty_total}</strong>
          </p>
          <p className="mt-1 flex items-center justify-between">
            <span>Toplam Sevk</span>
            <strong>{state.totals.shipped_qty_total}</strong>
          </p>
          <p className="mt-1 flex items-center justify-between">
            <span>Kalan</span>
            <strong>{state.totals.remaining_qty_total}</strong>
          </p>
          <p className="mt-2 flex items-center justify-between border-t border-neutral-300 pt-2 text-base">
            <span>Gönderilen Tutar</span>
            <strong>{formatMoney(state.totals.gonderilen_tutar)}</strong>
          </p>
        </div>
      </section>
    </main>
  );
}
