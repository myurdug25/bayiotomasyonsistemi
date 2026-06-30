"use client";

import { useEffect, useMemo, useRef } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { getWarehouseShipment } from "@/lib/api";

function formatDate(value: string | null | undefined) {
  if (!value) {
    return "-";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function compactText(value: string | number | null | undefined): string {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : "-";
}

function upperText(value: string | number | null | undefined): string {
  return compactText(value).toLocaleUpperCase("tr-TR");
}

function parseLabelPositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  return fallback;
}

export default function WarehouseLabelPrintPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const printedRef = useRef(false);

  const shipmentId = useMemo(() => {
    const parsed = Number(params.id);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, [params.id]);

  const shipmentQuery = useQuery({
    queryKey: ["warehouse", "print", "label", shipmentId],
    queryFn: () => {
      if (!shipmentId) {
        throw new Error("Geçersiz sevkiyat ID");
      }

      return getWarehouseShipment(shipmentId);
    },
    enabled: Boolean(shipmentId),
  });

  const state = shipmentQuery.data?.data;

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
        <Loader2 className="h-4 w-4 animate-spin" /> Kargo etiketi hazırlanıyor...
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
  const customerName = upperText(customer.title);
  const address = upperText(customer.address);
  const district = compactText(customer.district);
  const city = compactText(customer.city);
  const locationParts = [city, district].filter((value) => value !== "-");
  const location = locationParts.length > 0 ? upperText(locationParts.join(" / ")) : "-";
  const recipientClass = customerName.length > 46 ? "recipient-long" : customerName.length > 30 ? "recipient-medium" : "";
  const addressClass = address.length > 58 ? "address-long" : address.length > 34 ? "address-medium" : "";
  const packageNo = parseLabelPositiveInt(searchParams.get("package_no"), 1);
  const packageTotal = Math.max(packageNo, parseLabelPositiveInt(searchParams.get("package_total"), packageNo));
  const packageDesi = parseLabelPositiveInt(searchParams.get("desi"), 1);

  return (
    <main className="label-print-wrap min-h-screen bg-[#ececec] p-4 text-black">
      <style jsx global>{`
        @page {
          size: 100mm 70mm;
          margin: 0;
        }

        html,
        body {
          background: #ececec;
        }

        .label-sheet {
          width: 100mm;
          height: 70mm;
          padding: 2mm;
          background: #ffffff;
          overflow: hidden;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }

        .label-inner {
          width: 100%;
          height: 100%;
          border: 1.2px solid #184c36;
          border-radius: 1.2mm;
          padding: 2mm 2.4mm 2.2mm;
          background: #fff;
          display: flex;
          flex-direction: column;
          gap: 1.5mm;
        }

        .label-topbar {
          min-height: 6.8mm;
          border: 1px solid #184c36;
          border-left-width: 3.5mm;
          border-radius: 0.8mm;
          background: #f7faf7;
          display: grid;
          grid-template-columns: 1fr auto;
          align-items: center;
          gap: 2mm;
          padding: 0.9mm 1.6mm;
          color: #184c36;
          font-weight: 950;
          line-height: 1;
          text-transform: uppercase;
        }

        .label-title {
          font-size: 9.6px;
          letter-spacing: 0.75px;
        }

        .shipment-no {
          border: 1px solid #111;
          border-radius: 0.8mm;
          background: #f0c85a;
          color: #111;
          padding: 0.8mm 1.5mm;
          font-size: 7.7px;
          font-weight: 950;
          letter-spacing: 0.5px;
          white-space: nowrap;
        }

        .recipient {
          min-height: 14.2mm;
          border: 1.2px solid #184c36;
          border-radius: 0.8mm;
          background: #ffffff;
          color: #111;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          padding: 1.4mm 2.4mm;
          font-size: 13.6px;
          line-height: 1.06;
          font-weight: 950;
          letter-spacing: 0.15px;
          text-transform: uppercase;
          word-break: break-word;
        }

        .recipient::before {
          content: "ALICI";
          margin-bottom: 0.6mm;
          border-radius: 999px;
          background: rgba(240, 200, 90, 0.95);
          color: #111;
          padding: 0.55mm 2mm;
          font-size: 6.5px;
          line-height: 1;
          letter-spacing: 0.7px;
        }

        .recipient-medium {
          font-size: 12.4px;
          line-height: 1.06;
        }

        .recipient-long {
          font-size: 11.2px;
          line-height: 1.05;
          letter-spacing: 0;
        }

        .address {
          min-height: 13.6mm;
          border: 1.1px solid #184c36;
          border-radius: 0.8mm;
          background: #fff8dc;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          padding: 1.1mm 2.2mm;
          font-size: 13.6px;
          line-height: 1.1;
          font-weight: 950;
          letter-spacing: 0.05px;
          text-transform: uppercase;
          word-break: break-word;
        }

        .address::before {
          content: "TESLİMAT ADRESİ";
          margin-bottom: 0.6mm;
          color: #184c36;
          font-size: 6.3px;
          line-height: 1;
          letter-spacing: 0.55px;
        }

        .address-medium {
          font-size: 12.4px;
          line-height: 1.1;
        }

        .address-long {
          font-size: 11px;
          line-height: 1.08;
          letter-spacing: 0;
        }

        .label-bottom {
          display: grid;
          grid-template-columns: 1fr 29mm;
          gap: 1.5mm;
          margin-top: auto;
          align-items: stretch;
        }

        .details {
          border: 1px solid #184c36;
          border-left-width: 2.5mm;
          border-radius: 0.9mm;
          background: #f5faf4;
          padding: 1.2mm 1.6mm;
          display: grid;
          grid-template-columns: 1.05fr 0.9fr 1fr;
          gap: 1.1mm 1.4mm;
          font-size: 7.8px;
          line-height: 1.05;
          font-weight: 950;
          letter-spacing: 0.05px;
          text-transform: uppercase;
        }

        .detail-row {
          display: block;
          min-width: 0;
        }

        .detail-label {
          display: block;
          color: #2f7d4f;
          font-size: 5.8px;
          letter-spacing: 0.45px;
          margin-bottom: 0.3mm;
        }

        .detail-value {
          display: block;
          min-width: 0;
          overflow-wrap: normal;
          word-break: normal;
        }

        .detail-wide {
          grid-column: span 2;
        }

        .boxes {
          display: flex;
          flex-direction: column;
          gap: 1.2mm;
        }

        .box {
          min-height: 7.4mm;
          border: 1px solid #184c36;
          border-left-width: 2.5mm;
          border-radius: 0.8mm;
          background: #fff9df;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0.8mm 1mm;
          font-size: 12.5px;
          line-height: 1;
          font-weight: 950;
          text-align: center;
          white-space: nowrap;
        }

        .box span {
          margin-right: 1.1mm;
          color: #2f7d4f;
          font-size: 6.2px;
          letter-spacing: 0.5px;
          text-transform: uppercase;
        }

        @media print {
          html,
          body {
            margin: 0 !important;
            background: #fff !important;
          }

          .no-print {
            display: none !important;
          }

          .label-print-wrap {
            padding: 0 !important;
            min-height: auto !important;
            background: #fff !important;
          }

          .label-sheet {
            padding: 2mm;
            background: #fff;
          }
        }
      `}</style>

      <section className="label-sheet mx-auto">
        <div className="label-inner">
          <div className="label-topbar">
            <div className="label-title">Kargo Etiketi</div>
            <div className="shipment-no">{shipment.shipment_no}</div>
          </div>

          <div className={`recipient ${recipientClass}`}>{customerName}</div>
          <div className={`address ${addressClass}`}>{address}</div>

          <div className="label-bottom">
            <div className="details">
              <div className="detail-row">
                <span className="detail-label">BÖLGE</span>
                <span className="detail-value">{location}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">TEL</span>
                <span className="detail-value">{compactText(customer.phone)}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">TARİH</span>
                <span className="detail-value">{formatDate(shipment.shipped_at ?? shipment.created_at)}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">KOD</span>
                <span className="detail-value">{compactText(customer.code)}</span>
              </div>
              <div className="detail-row detail-wide">
                <span className="detail-label">DEPO</span>
                <span className="detail-value">{upperText(shipment.warehouse.name)}</span>
              </div>
            </div>

            <div className="boxes">
              <div className="box"><span>Desi</span>{packageDesi}</div>
              <div className="box"><span>Koli No</span>{packageNo}/{packageTotal}</div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
