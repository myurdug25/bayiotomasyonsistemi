"use client";

import { useMemo, useRef } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { getWarehouseShipmentInvoicePrintHtml } from "@/lib/api";

export default function WarehouseInvoicePrintPage() {
  const params = useParams<{ id: string }>();
  const printedRef = useRef(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const shipmentId = useMemo(() => {
    const parsed = Number(params.id);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, [params.id]);

  const invoiceQuery = useQuery({
    queryKey: ["warehouse", "print", "invoice", shipmentId],
    queryFn: () => {
      if (!shipmentId) {
        throw new Error("Geçersiz sevkiyat ID");
      }

      return getWarehouseShipmentInvoicePrintHtml(shipmentId);
    },
    enabled: Boolean(shipmentId),
  });

  const handleFrameLoad = () => {
    if (!invoiceQuery.data || printedRef.current) {
      return;
    }

    printedRef.current = true;
    window.setTimeout(() => frameRef.current?.contentWindow?.print(), 450);
  };

  if (invoiceQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 bg-white text-sm text-neutral-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Fatura çıktısı hazırlanıyor...
      </div>
    );
  }

  if (invoiceQuery.isError || !invoiceQuery.data) {
    return (
      <div className="mx-auto max-w-md p-6 text-center text-sm text-red-600">
        {(invoiceQuery.error as Error)?.message ?? "Fatura çıktısı alınamadı."}
      </div>
    );
  }

  return (
    <iframe
      ref={frameRef}
      title="Fatura çıktısı"
      srcDoc={invoiceQuery.data}
      onLoad={handleFrameLoad}
      className="h-screen w-screen border-0 bg-white"
    />
  );
}
