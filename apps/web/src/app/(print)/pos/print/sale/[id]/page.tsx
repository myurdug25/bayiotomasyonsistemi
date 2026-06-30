"use client";

import { useEffect, useMemo, useRef } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Printer } from "lucide-react";

import { getPosSale } from "@/lib/api";
import { Button } from "@/components/ui/button";

const VAT_RATE_LABEL = "%20";

function formatMoney(value: string | number) {
  const amount = typeof value === "number" ? value : Number(value);
  const formatted = new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0);

  return `${formatted} ₺`;
}

function formatDate(value: string) {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleDateString("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export default function PosSalePrintPage() {
  const params = useParams<{ id: string }>();
  const printedRef = useRef(false);

  const saleId = useMemo(() => {
    const parsed = Number(params.id);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, [params.id]);

  const saleQuery = useQuery({
    queryKey: ["pos", "print", "sale", saleId],
    queryFn: () => {
      if (!saleId) {
        throw new Error("Geçersiz satış ID");
      }

      return getPosSale(saleId);
    },
    enabled: Boolean(saleId),
  });

  const sale = saleQuery.data?.data;

  useEffect(() => {
    if (!sale || printedRef.current) {
      return;
    }

    printedRef.current = true;
    window.setTimeout(() => window.print(), 120);
  }, [sale]);

  if (saleQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-neutral-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Yazdırma şablonu hazırlanıyor...
      </div>
    );
  }

  if (saleQuery.isError || !sale) {
    return (
      <div className="mx-auto max-w-md p-6 text-center text-sm text-red-600">
        {(saleQuery.error as Error)?.message ?? "Satış verisi alınamadı."}
      </div>
    );
  }

  const receiptSubtotal = Math.max(0, Number(sale.subtotal) - Number(sale.discount_total));
  const customerTitle = sale.customer.title ?? sale.customer.code ?? "-";

  return (
    <main className="print-screen min-h-screen bg-[#d7d9dd] px-3 py-4 text-black">
      <style jsx global>{`
        @page {
          size: 90mm 110mm portrait;
          margin: 0;
        }

        html {
          width: 90mm;
          min-width: 90mm;
          max-width: 90mm;
          height: 110mm;
          min-height: 110mm;
          max-height: 110mm;
        }

        body {
          background: #d7d9dd;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
          user-select: none;
        }

        @media screen {
          .receipt-paper {
            display: none !important;
          }

          .print-waiting {
            display: flex !important;
          }
        }

        @media print {
          .print-waiting {
            display: none !important;
          }
        }

        .receipt-paper {
          width: 90mm;
          height: 110mm;
          font-family: "Courier New", Courier, monospace;
          font-size: 10.8px;
          font-weight: 900;
          line-height: 1.22;
        }

        .receipt-inner {
          position: relative;
          width: 90mm;
          height: 110mm;
          margin: 0 auto;
          padding: 7mm 7mm 5mm;
          overflow: hidden;
          user-select: none;
        }

        .receipt-top {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 28mm;
          column-gap: 4mm;
          align-items: start;
        }

        .receipt-customer {
          min-height: 14mm;
          font-size: 12.4px;
          font-weight: 900;
          line-height: 1.18;
          letter-spacing: 0.01em;
          text-transform: uppercase;
          word-break: break-word;
        }

        .receipt-meta {
          padding-top: 0.4mm;
          font-size: 10.6px;
          font-weight: 900;
          line-height: 1.5;
          white-space: nowrap;
        }

        .receipt-meta div:empty {
          display: none;
        }

        .receipt-address {
          min-height: 8mm;
          margin-top: 8mm;
          padding-bottom: 1.6mm;
          border-bottom: 1px dashed #111;
          text-transform: uppercase;
          white-space: pre-line;
        }

        .receipt-table {
          width: 100%;
          margin-top: 3.2mm;
        }

        .receipt-table-head,
        .receipt-table-row {
          display: grid;
          grid-template-columns: 29mm 8mm 18mm 21mm;
          column-gap: 0;
          align-items: baseline;
        }

        .receipt-table-head {
          border-bottom: 1.5px solid #111;
          padding-bottom: 1mm;
          font-size: 10.4px;
          font-weight: 900;
        }

        .receipt-table-row {
          padding: 1mm 0 0.8mm;
          font-size: 11.8px;
          font-weight: 900;
          line-height: 1.1;
        }

        .receipt-table-row + .receipt-table-row {
          border-top: 1px dotted #999;
        }

        .receipt-sku {
          overflow-wrap: anywhere;
        }

        .receipt-qty {
          text-align: right;
        }

        .receipt-price {
          padding-left: 1.8mm;
          text-align: right;
          white-space: nowrap;
        }

        .receipt-line-total {
          padding-left: 2.4mm;
          text-align: right;
          white-space: nowrap;
        }

        .receipt-bottom {
          position: absolute;
          right: 7mm;
          bottom: 5mm;
          left: 33mm;
          display: block;
        }

        .receipt-totals {
          display: grid;
          gap: 1.1mm;
          border-top: 1.5px solid #111;
          padding-top: 1.5mm;
          font-weight: 900;
        }

        .receipt-total-line {
          display: grid;
          grid-template-columns: 1fr 20mm;
          gap: 3mm;
          white-space: nowrap;
        }

        .receipt-total-line span:last-child {
          text-align: right;
        }

        .receipt-grand-total {
          border-top: 1.5px solid #111;
          margin-top: 0.6mm;
          padding-top: 1mm;
          font-size: 11.5px;
          font-weight: 900;
        }

        @media print {
          @page {
            size: 90mm 110mm portrait;
            margin: 0;
          }

          html,
          body {
            background: #fff !important;
            width: 90mm !important;
            min-width: 90mm !important;
            max-width: 90mm !important;
            height: 110mm !important;
            min-height: 110mm !important;
            max-height: 110mm !important;
            margin: 0 !important;
            overflow: hidden !important;
          }

          .no-print {
            display: none !important;
          }

          .print-screen {
            width: 90mm !important;
            min-width: 90mm !important;
            max-width: 90mm !important;
            height: 110mm !important;
            min-height: 110mm !important;
            max-height: 110mm !important;
            min-height: auto;
            padding: 0;
            background: #fff !important;
          }

          .receipt-paper {
            width: 90mm !important;
            min-width: 90mm !important;
            max-width: 90mm !important;
            height: 110mm !important;
            min-height: 110mm !important;
            max-height: 110mm !important;
            margin: 0;
            box-shadow: none !important;
          }

          .receipt-inner {
            margin: 0;
          }
        }
      `}</style>


      <div
        className="print-waiting"
        style={{ display: "none", alignItems: "center", justifyContent: "center", minHeight: "100vh", flexDirection: "column", gap: "12px", color: "#555", fontSize: "14px" }}
      >
        <span>Yazdırma ekranı açılıyor...</span>
      </div>

      <section className="receipt-paper mx-auto bg-white shadow-[0_0_0_1px_#c9ccd2,0_18px_42px_rgba(15,23,42,0.18)]">
        <div className="receipt-inner">
          <div className="receipt-top">
            <div className="receipt-customer">{customerTitle}</div>
            <div className="receipt-meta">
              <div>{formatDate(sale.created_at)}</div>
              <div>{sale.receipt_no}</div>
            </div>
          </div>

          <div className="receipt-address">{sale.customer.code ?? ""}</div>

          <div className="receipt-table">
            <div className="receipt-table-head">
              <div className="receipt-sku">Stok Kodu</div>
              <div className="receipt-qty">Adet</div>
              <div className="receipt-price">Fiyat</div>
              <div className="receipt-line-total">Tutar</div>
            </div>
            {sale.items.map((item) => (
              <div key={item.id} className="receipt-table-row">
                <div className="receipt-sku">{item.sku ?? item.name ?? "-"}</div>
                <div className="receipt-qty">{item.qty}</div>
                <div className="receipt-price">{formatMoney(item.unit_price)}</div>
                <div className="receipt-line-total">{formatMoney(item.line_total)}</div>
              </div>
            ))}
          </div>

          <div className="receipt-bottom">
            <div className="receipt-totals">
              <div className="receipt-total-line"><span>Toplam</span><span>{formatMoney(receiptSubtotal)}</span></div>
              <div className="receipt-total-line"><span>KDV ({VAT_RATE_LABEL})</span><span>{formatMoney(sale.vat_total)}</span></div>
              <div className="receipt-total-line receipt-grand-total"><span>Genel Toplam</span><span>{formatMoney(sale.grand_total)}</span></div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
