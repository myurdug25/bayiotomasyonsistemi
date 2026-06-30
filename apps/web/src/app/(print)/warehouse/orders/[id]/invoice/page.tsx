"use client";

import { useMemo } from "react";
import Image from "next/image";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { getOrderDetail } from "@/lib/api";

const SELLER = {
  title: "GÜÇSA FİLTRECİM GRUP OTOMOTİV SANAYİ VE TİCARET A.Ş",
  lines: [
    "Şükrüpaşa Mah. Harezmî Sk. Dörtyol Yapı Koop A Blok No: 16/11",
    "YAKUTİYE / ERZURUM",
    "Trabzon: Anadolu Cd. Sanayi Mh. No:34/A Değirmendere/TRABZON",
    "Samsun: Yeni Mh. 46 Sk. Gülsan San. Sit. 43/1 Canik/SAMSUN",
    "Batım: Fridon Khalvashi No:25 Batumi/GEORGIA",
    "TLF: 0442 242 71 40 / FAX: 0442 242 71 42",
    "Ticaret Sicil No: 19397",
    "MersisNo: 0388168075100001",
    "Vergi Dairesi: AZİZİYE",
    "VKN: 388 168 0751",
  ],
};

const TURKISH_ONES = ["", "Bir", "İki", "Üç", "Dört", "Beş", "Altı", "Yedi", "Sekiz", "Dokuz"];
const TURKISH_TENS = ["", "On", "Yirmi", "Otuz", "Kırk", "Elli", "Altmış", "Yetmiş", "Seksen", "Doksan"];

function toAmount(value: string | number | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "0").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatTry(value: string | number | null | undefined): string {
  return `${toAmount(value).toLocaleString("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} TL`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("tr-TR", { maximumFractionDigits: 2 });
}

function formatDate(value: string | null | undefined): string {
  const parsed = value ? new Date(value) : new Date();

  if (Number.isNaN(parsed.getTime())) {
    return value ?? "-";
  }

  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(parsed);
}

function formatTime(value: string | null | undefined): string {
  const parsed = value ? new Date(value) : new Date();

  if (Number.isNaN(parsed.getTime())) {
    return "-";
  }

  return new Intl.DateTimeFormat("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(parsed);
}

function buildInvoiceNo(orderId: number, orderedAt: string | null | undefined): string {
  const year = orderedAt ? new Date(orderedAt).getFullYear() : new Date().getFullYear();
  return `C03${year}${String(orderId).padStart(8, "0")}`;
}

function numberToTurkishWords(value: number): string {
  const normalized = Math.max(0, Math.floor(value));

  if (normalized === 0) {
    return "Sıfır";
  }

  const underThousand = (amount: number): string => {
    const hundreds = Math.floor(amount / 100);
    const tens = Math.floor((amount % 100) / 10);
    const ones = amount % 10;
    const parts: string[] = [];

    if (hundreds > 0) {
      parts.push(hundreds === 1 ? "Yüz" : `${TURKISH_ONES[hundreds]} Yüz`);
    }

    if (tens > 0) {
      parts.push(TURKISH_TENS[tens]);
    }

    if (ones > 0) {
      parts.push(TURKISH_ONES[ones]);
    }

    return parts.join(" ");
  };

  const millions = Math.floor(normalized / 1_000_000);
  const thousands = Math.floor((normalized % 1_000_000) / 1000);
  const remainder = normalized % 1000;
  const parts: string[] = [];

  if (millions > 0) {
    parts.push(`${underThousand(millions)} Milyon`);
  }

  if (thousands > 0) {
    parts.push(thousands === 1 ? "Bin" : `${underThousand(thousands)} Bin`);
  }

  if (remainder > 0) {
    parts.push(underThousand(remainder));
  }

  return parts.join(" ");
}

function amountInWords(value: string | number | null | undefined): string {
  const amount = Math.max(0, toAmount(value));
  const lira = Math.floor(amount);
  const cents = Math.round((amount - lira) * 100);

  return `Yalnız ${numberToTurkishWords(lira)} TL ${numberToTurkishWords(cents)} KR`;
}

function buildQrDataUri(parts: Array<string | number | null | undefined>): string {
  const seed = parts.map((part) => String(part ?? "")).join("|");
  const size = 33;
  const cell = 4;
  let state = 2166136261;

  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }

  const nextBit = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % 5 < 2;
  };

  const inFinder = (x: number, y: number) =>
    (x < 8 && y < 8) || (x >= size - 8 && y < 8) || (x < 8 && y >= size - 8);

  const finder = (x: number, y: number) => `
    <rect x="${x * cell}" y="${y * cell}" width="${7 * cell}" height="${7 * cell}" fill="#000"/>
    <rect x="${(x + 1) * cell}" y="${(y + 1) * cell}" width="${5 * cell}" height="${5 * cell}" fill="#fff"/>
    <rect x="${(x + 2) * cell}" y="${(y + 2) * cell}" width="${3 * cell}" height="${3 * cell}" fill="#000"/>
  `;

  const rects: string[] = [finder(0, 0), finder(size - 7, 0), finder(0, size - 7)];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (inFinder(x, y)) {
        continue;
      }

      if ((x === 6 || y === 6 || nextBit()) && (x + y) % 7 !== 0) {
        rects.push(`<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="#000"/>`);
      }
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size * cell}" height="${size * cell}" viewBox="0 0 ${
    size * cell
  } ${size * cell}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/>${rects.join("")}</svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export default function WarehouseInvoicePage() {
  const params = useParams<{ id: string }>();

  const orderId = useMemo(() => {
    const parsed = Number(params.id);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, [params.id]);

  const orderQuery = useQuery({
    queryKey: ["warehouse", "invoice", "order", orderId],
    queryFn: () => {
      if (!orderId) {
        throw new Error("Geçersiz sipariş ID");
      }

      return getOrderDetail(orderId);
    },
    enabled: Boolean(orderId),
  });

  if (orderQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-neutral-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Fatura şablonu hazırlanıyor...
      </div>
    );
  }

  if (orderQuery.isError || !orderQuery.data?.order) {
    return (
      <div className="mx-auto max-w-md p-6 text-center text-sm text-red-600">
        {(orderQuery.error as Error)?.message ?? "Sipariş verisi alınamadı."}
      </div>
    );
  }

  const order = orderQuery.data.order;
  const customer = order.customer;
  const totalQuantity = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const invoiceNo = order.invoice?.reference_no ?? buildInvoiceNo(order.id, order.ordered_at);
  const invoiceTimestamp = order.invoice?.created_at ?? new Date().toISOString();
  const invoiceDate = formatDate(invoiceTimestamp);
  const invoiceTime = formatTime(invoiceTimestamp);
  const customerTitle = customer?.title ?? customer?.code ?? "-";
  const customerCode = customer?.code && customer.code !== customerTitle ? customer.code : null;
  const customerPlace = [customer?.district, customer?.city].filter(Boolean).join(" / ");
  const discountTotal = toAmount(order.discount_total);
  const taxableTotal = Math.max(0, toAmount(order.subtotal) - discountTotal);
  const qrDataUri = buildQrDataUri([
    invoiceNo,
    invoiceDate,
    order.order_no,
    customer?.code,
    customerTitle,
    order.grand_total,
  ]);

  return (
    <main className="min-h-screen bg-[#2b2b2b] px-4 py-6 text-black">
      <style jsx global>{`
        @page {
          size: A4;
          margin: 0;
        }

        .invoice-sheet {
          width: 210mm;
          min-height: 297mm;
          font-family: Arial, Helvetica, sans-serif;
          color: #111111;
        }

        .invoice-table th,
        .invoice-table td {
          border: 1.6px solid #111111;
        }

        .invoice-meta td {
          border: 1.6px solid #111111;
        }

        .gib-seal {
          position: relative;
          width: 34mm;
          height: 34mm;
          border: 2px solid #29577d;
          border-radius: 999px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          color: #29577d;
        }

        .gib-seal::before {
          content: "T.C. Hazine ve Maliye Bakanlığı";
          position: absolute;
          top: 2.5mm;
          width: 100%;
          font-size: 7px;
          font-weight: 700;
          letter-spacing: 0.2px;
        }

        .gib-mark {
          color: #d3292f;
          font-size: 34px;
          font-weight: 900;
          letter-spacing: -1px;
          line-height: 1;
        }

        .gib-title {
          margin-top: 1mm;
          max-width: 23mm;
          font-size: 7px;
          font-weight: 800;
          line-height: 1.05;
        }

        .invoice-qr {
          image-rendering: pixelated;
        }

        @media print {
          html,
          body {
            margin: 0 !important;
            width: 210mm;
            background: #ffffff !important;
          }

          .no-print {
            display: none !important;
          }

          main {
            padding: 0 !important;
            background: #ffffff !important;
          }

          .invoice-sheet {
            margin: 0 !important;
            width: 210mm !important;
            min-height: 297mm !important;
            box-shadow: none !important;
          }
        }
      `}</style>


      <section className="invoice-sheet relative mx-auto overflow-hidden bg-white px-[13mm] py-[10mm] shadow-2xl">
        <Image
          aria-hidden="true"
          className="pointer-events-none absolute bottom-[47mm] left-1/2 w-[78mm] -translate-x-1/2 opacity-[0.035]"
          src="/brand/gucsa-transparent.png"
          width={295}
          height={120}
          alt=""
          priority
        />

        <header className="relative z-10 grid grid-cols-[1fr_42mm_38mm] gap-[8mm] border-b-[2px] border-black pb-[6mm]">
          <div className="pt-[1mm]">
            <h1 className="max-w-[92mm] text-[18px] font-black leading-[1.08] tracking-[0.01em]">
              {SELLER.title}
            </h1>
            <div className="mt-[3mm] space-y-[1px] text-[11px] leading-[1.18]">
              {SELLER.lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </div>

          <div className="flex flex-col items-center justify-end gap-[5mm]">
            <div className="gib-seal" aria-label="Gelir İdaresi Başkanlığı">
              <div className="gib-mark">G</div>
              <div className="gib-title">Gelir İdaresi Başkanlığı</div>
            </div>
            <div className="text-center">
              <h2 className="text-[20px] font-black leading-none">e-Arşiv Fatura</h2>
              <p className="mt-[4mm] text-[11px] font-bold">(İrsaliye Yerine Geçer)</p>
            </div>
          </div>

          <div className="flex justify-end pt-[5mm]">
            <Image
              aria-label="Fatura QR"
              className="invoice-qr h-[34mm] w-[34mm] border border-black p-[1mm]"
              src={qrDataUri}
              width={132}
              height={132}
              alt="Fatura QR"
              unoptimized
            />
          </div>
        </header>

        <section className="relative z-10 grid grid-cols-[1fr_67mm] gap-[8mm] border-b-[2px] border-black py-[6mm]">
          <div className="min-h-[56mm]">
            <p className="text-[15px] font-black tracking-wide">SAYIN</p>
            <div className="mt-[7mm] space-y-[4mm] text-[14px] leading-tight">
              <div>
                <p className="font-bold">{customerTitle}</p>
                {customerCode ? <p className="mt-[1.5mm] text-[11px]">Cari Kodu: {customerCode}</p> : null}
              </div>
              <p>{customer?.address || "-"}</p>
              <p>{customerPlace || "-"}</p>
              <div className="space-y-[1.5mm] text-[12px]">
                <p>Vergi Dairesi: {customer?.tax_office || "-"}</p>
                <p>Vergi No: {customer?.tax_number || "-"}</p>
                <p>Tel: {customer?.phone || "-"}</p>
              </div>
            </div>
          </div>

          <div>
            <table className="invoice-meta mt-[2mm] w-full border-collapse text-[12px] leading-tight">
              <tbody>
                {[
                  ["Özelleştirme No:", "TR1.2"],
                  ["Senaryo:", "TEMELFATURA"],
                  ["Fatura Tipi:", "SATIŞ"],
                  ["Fatura No:", invoiceNo],
                  ["Fatura Tarihi:", invoiceDate],
                  ["Düzenleme Saati:", invoiceTime],
                ].map(([label, value]) => (
                  <tr key={label}>
                    <td className="w-[31mm] px-[1.5mm] py-[1.7mm] font-black">{label}</td>
                    <td className="px-[1.5mm] py-[1.7mm]">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="relative z-10 pt-[8mm]">
          <table className="invoice-table w-full border-collapse text-[11px] leading-tight">
            <thead>
              <tr className="text-[13px]">
                <th className="w-[8mm] px-[1mm] py-[2.2mm] text-left">No</th>
                <th className="w-[34mm] px-[1.5mm] py-[2.2mm] text-left">Stok Kodu</th>
                <th className="px-[1.5mm] py-[2.2mm] text-left">Stok Açıklama</th>
                <th className="w-[21mm] px-[1.5mm] py-[2.2mm] text-right">Miktar</th>
                <th className="w-[25mm] px-[1.5mm] py-[2.2mm] text-right">Birim Fiyat</th>
                <th className="w-[25mm] px-[1.5mm] py-[2.2mm] text-right">Tutar</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item, index) => (
                <tr key={item.id}>
                  <td className="px-[1mm] py-[1.7mm] align-top">{index + 1}</td>
                  <td className="px-[1.5mm] py-[1.7mm] align-top font-medium">{item.sku ?? "-"}</td>
                  <td className="px-[1.5mm] py-[1.7mm] align-top">
                    <span className="font-medium">{item.name ?? "-"}</span>
                    {item.brand ? <span className="ml-[2mm] text-[10px] text-neutral-600">({item.brand})</span> : null}
                  </td>
                  <td className="px-[1.5mm] py-[1.7mm] text-right align-top">{formatNumber(item.quantity)}</td>
                  <td className="px-[1.5mm] py-[1.7mm] text-right align-top">
                    {formatTry(item.unit_net_price).replace(" TL", "")}
                  </td>
                  <td className="px-[1.5mm] py-[1.7mm] text-right align-top">
                    {formatTry(item.line_total).replace(" TL", "")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="relative z-10 mt-[8mm] grid grid-cols-[62mm_1fr_76mm] gap-[6mm]">
          <div className="space-y-[5mm]">
            <table className="invoice-table h-fit w-full border-collapse text-[12px]">
              <tbody>
                <tr>
                  <td className="px-[1.5mm] py-[1mm] font-black">Kalem Sayısı</td>
                  <td className="w-[16mm] px-[1.5mm] py-[1mm] text-right">{order.items.length}</td>
                </tr>
                <tr>
                  <td className="px-[1.5mm] py-[1mm] font-black">Kalem Miktarı</td>
                  <td className="px-[1.5mm] py-[1mm] text-right">{formatNumber(totalQuantity)}</td>
                </tr>
              </tbody>
            </table>

            <div className="border border-black px-[2mm] py-[1.5mm] text-[10.5px] leading-tight">
              <p className="font-black">Yazıyla</p>
              <p className="mt-[1mm]">{amountInWords(order.grand_total)}</p>
            </div>
          </div>

          <div />

          <table className="invoice-table h-fit w-full border-collapse text-[12px]">
            <tbody>
              {[
                ["Toplam", formatTry(order.subtotal)],
                ["Toplam İskonto", discountTotal === 0 ? "0" : formatTry(discountTotal)],
                ["Ara Toplam", formatTry(taxableTotal)],
                ["KDV (%20)", formatTry(order.tax_total)],
                ["Genel Toplam", formatTry(order.grand_total)],
              ].map(([label, value]) => (
                <tr key={label}>
                  <td className="px-[1.5mm] py-[1.2mm] text-right font-black">{label}</td>
                  <td className="w-[32mm] px-[1.5mm] py-[1.2mm] text-right">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <footer className="relative z-10 mt-[11mm] grid grid-cols-[1fr_48mm] gap-[8mm] border-t border-black pt-[3mm] text-[9px] leading-tight text-neutral-700">
          <p>
            Bu belge elektronik ortamda düzenlenmiştir. Malların sevkinde e-Arşiv fatura irsaliye yerine geçer.
            Sipariş No: <span className="font-bold text-black">{order.order_no}</span>
          </p>
          <p className="text-right">
            Güçsa Filtrecim Grup Otomotiv
            <br />
            Sanayi ve Ticaret A.Ş.
          </p>
        </footer>
      </section>
    </main>
  );
}
