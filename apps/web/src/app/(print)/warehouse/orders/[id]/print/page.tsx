"use client";

import { useEffect, useMemo, useRef } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Printer } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getOrderDetail, type OrderDetailResponse } from "@/lib/api";

type PrintOrder = OrderDetailResponse["order"];
type PrintOrderItem = PrintOrder["items"][number];

function formatDateTime(value: string | null | undefined): string {
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
    second: "2-digit",
  }).format(parsed);
}

function formatShippingMethod(value: string | null | undefined): string {
  const labels: Record<string, string> = {
    kargo: "KARGO",
    depo_teslim: "DEPO TESLİM",
    kendi_arac: "KENDİ ARAÇ",
  };

  if (!value) {
    return "-";
  }

  return labels[value] ?? value.toUpperCase();
}

function compactText(value: string | number | null | undefined): string {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : "-";
}

function upperText(value: string | number | null | undefined): string {
  return compactText(value).toLocaleUpperCase("tr-TR");
}

function sanitizeBarcode(value: string): string {
  const trimmed = (value || "").trim();
  if (!trimmed) {
    return "POWERSA";
  }

  return trimmed.replace(/[^\x20-\x7e]/g, "").slice(0, 60);
}

const CODE128_B_PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

function buildBarcodeDataUri(value: string): string {
  const seed = sanitizeBarcode(value);
  const codes = [104];
  let checksum = 104;

  for (let index = 0; index < seed.length; index += 1) {
    const code = seed.charCodeAt(index);
    const codeValue = code >= 32 && code <= 126 ? code - 32 : 0;
    codes.push(codeValue);
    checksum += codeValue * (index + 1);
  }

  codes.push(checksum % 103, 106);

  const bars: string[] = [];
  const moduleWidth = 1.35;
  const marginX = 12;
  let x = marginX;

  for (const code of codes) {
    const pattern = CODE128_B_PATTERNS[code] ?? CODE128_B_PATTERNS[0];
    for (let index = 0; index < pattern.length; index += 1) {
      const width = Number(pattern[index]) * moduleWidth;
      if (index % 2 === 0) {
        bars.push(`<rect x="${x.toFixed(2)}" y="5" width="${width.toFixed(2)}" height="42" fill="#111"/>`);
      }
      x += width;
    }
  }

  const width = Math.max(210, x + marginX);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="64" viewBox="0 0 ${width} 64" shape-rendering="crispEdges">
    <rect width="${width}" height="64" fill="#ffffff"/>
    ${bars.join("")}
  </svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function getShelfAddress(item: PrintOrderItem): string {
  return String(item.shelf_address ?? "").trim();
}

function HeaderInfo({
  order,
  barcodeDataUri,
  printOrderNo,
  barcodeValue,
  customerLocation,
  senderName,
}: {
  order: PrintOrder;
  barcodeDataUri: string;
  printOrderNo: string;
  barcodeValue: string;
  customerLocation: string;
  senderName: string | null | undefined;
}) {
  const addressLine = compactText(order.customer?.address);
  const phoneLine = compactText(order.customer?.phone);

  return (
    <header className="print-block">
      <div className="grid grid-cols-[1fr_76mm] items-start gap-[8mm]">
        <div className="rounded-[2mm] border border-[#d9d9d9] bg-[#fafafa] p-[5mm] text-[14.5px] font-bold leading-[1.45]">
          <InfoLine label="Kodu" value={upperText(order.customer?.code)} />
          <InfoLine label="Ünvanı" value={upperText(order.customer?.title)} />
          <InfoLine label="Adres" value={upperText(addressLine)} />
          <InfoLine label="Telefon" value={phoneLine} />
          <InfoLine label="İl - İlçe" value={upperText(customerLocation)} />
        </div>

        <div className="flex flex-col items-center rounded-[2mm] border border-[#cfd8d2] bg-[#fbfffc] px-[5mm] py-[4mm] text-[13.5px] font-bold leading-tight">
          <span className="mb-[1.8mm] rounded-full bg-[#174f36] px-[4mm] py-[1.3mm] text-[12px] font-black uppercase tracking-[0.08em] text-white">
            Sipariş Barkodu
          </span>
          <img className="barcode-image h-[22mm] w-[73mm]" src={barcodeDataUri} alt="Sipariş numarası barkodu" />
          <span className="mt-[1.5mm] text-[18px] font-black tracking-[0.06em] text-[#174f36]">
            {barcodeValue}
          </span>
          <span className="mt-[0.6mm] text-[11px] font-black uppercase tracking-[0.08em] text-[#6b6b6b]">
            Depo ekranında okut
          </span>
        </div>
      </div>

      <div className="mt-[4mm] grid grid-cols-[1fr_68mm] items-start gap-[8mm]">
        <div>
          <p className="text-[13px] font-black uppercase tracking-[0.16em] text-[#174f36]">Depo Hazırlık</p>
          <h1 className="mt-[1mm] text-[42px] font-black tracking-[0.02em] text-[#303030]">
            SİPARİŞ FORMU
          </h1>
        </div>
        <div className="text-[14px] font-bold leading-[1.4]">
          <InfoLine label="Sipariş No" value={printOrderNo} />
          <InfoLine label="Referans" value={order.order_no} />
          <InfoLine label="Sipariş Tarihi" value={formatDateTime(order.ordered_at)} />
          <InfoLine label="Plasiyer" value={upperText(order.salesperson?.name)} />
          <InfoLine label="Gönderen" value={upperText(senderName)} />
          <InfoLine label="Gönderi Şekli" value={formatShippingMethod(order.shipping_method ?? order.origin?.shipping_method)} />
        </div>
      </div>

      <div className="mt-[3mm] border-b border-[#ca6e6e]" />
    </header>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <p className="grid grid-cols-[25mm_1fr] gap-[2mm]">
      <span>{label}</span>
      <span>{value}</span>
    </p>
  );
}

function OrderNote({ note }: { note: string }) {
  if (!note.trim()) {
    return null;
  }

  return (
    <section className="print-block mt-[5mm] flex min-h-[12mm] items-start gap-[3mm] rounded-[2mm] border border-[#ead1d1] bg-[#fffdfd] p-[3mm] text-[12.5px]">
      <p className="shrink-0 font-black">
        Sipariş Notu
      </p>
      <p className="whitespace-pre-line font-semibold">{note}</p>
    </section>
  );
}

function printableOrderNote(order: PrintOrder): string {
  const raw = String(order.note ?? order.origin?.note ?? "").trim();
  if (!raw) {
    return "";
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const normalized = line.toLocaleLowerCase("tr-TR");

      return !(
        normalized.startsWith("ödeme tercihi:") ||
        normalized.startsWith("satis tipi:") ||
        normalized.startsWith("satış tipi:") ||
        normalized.startsWith("ekranda gösterilen ödeme tutarı:") ||
        normalized.startsWith("depo transfer:") ||
        normalized.startsWith("özet gösterimi:") ||
        normalized.startsWith("referans kodu:") ||
        normalized.startsWith("ulaşım / nakliye bedeli:")
      );
    });

  return lines.join("\n");
}

function erzurumDepoStock(item: PrintOrderItem): number | null {
  const value = item.logo_stock?.erzurum_depo_available_total;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function PrintableTable({ items, totalQuantity }: { items: PrintOrderItem[]; totalQuantity: number }) {
  return (
    <section className="mt-[5mm]">
      <table className="order-table w-full border-collapse text-[14.5px] leading-[1.25]">
        <thead>
          <tr>
            <th className="w-[8mm] text-center">Sr</th>
            <th className="w-[37mm] text-left">Ürün Kodu</th>
            <th className="text-left">Ürün Adı</th>
            <th className="w-[25mm] text-center">Üretici</th>
            <th className="w-[30mm] text-center">Raf Adresi</th>
            <th className="w-[18mm] text-center">Miktar</th>
            <th className="w-[9mm] text-center">&nbsp;</th>
            <th className="w-[21mm] text-center">Erz. Stok</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-[2mm] py-[10mm] text-center text-[13px]">
                Sipariş kalemi bulunamadı.
              </td>
            </tr>
          ) : (
            items.map((item, index) => {
              const availableStock = erzurumDepoStock(item);
              const stockIsMissing = (availableStock ?? 0) < item.quantity;

              return (
                <tr key={item.id} className={stockIsMissing ? "stock-missing" : undefined}>
                  <td className="text-center font-bold">{index + 1}</td>
                  <td className="font-bold">{upperText(item.sku)}</td>
                  <td className="font-semibold">{upperText(item.name)}</td>
                  <td className="text-center">{compactText(item.brand)}</td>
                  <td className="text-center font-semibold">{getShelfAddress(item)}</td>
                  <td className="text-center font-black">{item.quantity}</td>
                  <td aria-hidden="true">&nbsp;</td>
                  <td className={stockIsMissing ? "text-center font-black" : "text-center font-semibold"}>
                    {availableStock ?? "-"}
                  </td>
                </tr>
              );
            })
          )}
          <tr className="total-row">
            <td colSpan={5} className="text-right font-black">Toplam:</td>
            <td className="text-center font-black">{totalQuantity}</td>
            <td aria-hidden="true">&nbsp;</td>
            <td aria-hidden="true">&nbsp;</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function PageCountFooter() {
  return (
    <footer className="print-block mt-[6mm] text-right text-[10px] font-bold text-[#2f2f2f]">
      1/1
    </footer>
  );
}

export default function WarehouseOrderPrintPage() {
  const params = useParams<{ id: string }>();
  const printedRef = useRef(false);

  const orderId = useMemo(() => {
    const parsed = Number(params.id);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, [params.id]);

  const orderQuery = useQuery({
    queryKey: ["warehouse", "print", "order", orderId],
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
    window.setTimeout(() => window.print(), 160);
  }, [order]);

  if (orderQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-neutral-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Sipariş formu hazırlanıyor...
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
  const totalQuantity = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const destination = [customer?.city, customer?.district].filter(Boolean).join(" / ");
  const note = printableOrderNote(order);
  const senderName = order.salesperson?.name ?? order.created_by?.name;
  const printOrderNo = String(order.id);
  const barcodeDataUri = buildBarcodeDataUri(printOrderNo);
  const customerAddress = String(customer?.address ?? "").trim();
  const customerLocation = destination || customerAddress || "Adres bilgisi yok";

  return (
    <main className="min-h-screen bg-white px-4 py-5 text-[#222]">
      <style jsx global>{`
        @page {
          size: A4 portrait;
          margin: 6mm;
        }

        html,
        body {
          background: #ffffff;
        }

        @media screen {
          .order-form-sheet {
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

        .order-form-sheet {
          width: 210mm;
          min-height: 297mm;
          font-family:
            Arial, Helvetica, sans-serif;
          color: #222;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }

        .order-table th,
        .order-table td {
          border: 1px solid #535353;
          padding: 2.6mm 2.2mm;
          vertical-align: middle;
        }

        .order-table thead {
          display: table-header-group;
        }

        .order-table thead th {
          background: #f4f4f4;
          color: #222222;
          font-weight: 900;
          font-size: 14.5px;
          padding-top: 2.8mm;
          padding-bottom: 2.8mm;
        }

        .order-table tbody tr:nth-child(even):not(.total-row) {
          background: #fafafa;
        }

        .order-table tbody tr {
          break-inside: avoid;
          page-break-inside: avoid;
        }

        .order-table .stock-missing {
          background: #fff8ef !important;
        }

        .total-row {
          background: #f4f4f4;
        }

        .order-form-sheet {
          border: 1px solid #dddddd;
        }

        .barcode-image {
          image-rendering: pixelated;
        }

        .print-block {
          break-inside: avoid;
        }

        @media print {
          html,
          body {
            margin: 0 !important;
            width: 297mm;
            overflow: visible !important;
            background: #ffffff !important;
          }

          .no-print {
            display: none !important;
          }

          main {
            padding: 0 !important;
            background: #ffffff !important;
          }

          .order-form-sheet {
            width: auto !important;
            min-height: auto !important;
            box-shadow: none !important;
          }
        }
      `}</style>

      <div
        className="print-waiting"
        style={{ display: "none", alignItems: "center", justifyContent: "center", minHeight: "100vh", flexDirection: "column", gap: "12px", color: "#555", fontSize: "14px" }}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: "spin 1s linear infinite" }}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <span>Yazdırma ekranı açılıyor...</span>
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>

      <section className="order-form-sheet mx-auto bg-white px-[6mm] py-[6mm]">
        <HeaderInfo
          order={order}
          barcodeDataUri={barcodeDataUri}
          printOrderNo={printOrderNo}
          barcodeValue={printOrderNo}
          customerLocation={customerLocation}
          senderName={senderName}
        />
        <OrderNote note={note} />
        <PrintableTable items={order.items as PrintOrderItem[]} totalQuantity={totalQuantity} />
        <PageCountFooter />
      </section>
    </main>
  );
}
