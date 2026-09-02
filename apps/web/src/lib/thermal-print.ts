"use client";

export type ThermalReceiptLine = {
  label: string;
  value: string | number | null | undefined;
  strong?: boolean;
};

export type ThermalReceiptItem = {
  title: string;
  subtitle?: string | null;
  amount?: string | null;
  lines?: ThermalReceiptLine[];
};

export type ThermalReceiptPayload = {
  title: string;
  plainTextLines?: string[];
  documentNo?: string | null;
  customerCode?: string | null;
  customerTitle?: string | null;
  cashierName?: string | null;
  date?: string | null;
  items?: ThermalReceiptItem[];
  lines?: ThermalReceiptLine[];
  totalLabel?: string;
  total?: string | null;
  note?: string | null;
  footer?: string | null;
};

const RECEIPT_WIDTH_MM = 58;

function isTouchMobileUserAgent(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  const userAgent = navigator.userAgent;
  const isAppleTablet = /Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1;

  return /Android|iPhone|iPad|iPod/i.test(userAgent) || isAppleTablet;
}

export function canUseThermalBrowserPrintFallback(): boolean {
  return !isTouchMobileUserAgent();
}

export type ThermalNativeBridgeResult =
  | { ok: true; message: string }
  | { ok: false; reason: "unsupported" | "payload-too-large"; message: string };

function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clean(value: string | number | null | undefined): string {
  return String(value ?? "").trim();
}

function normalizeReceiptText(value: string): string {
  return value
    .replaceAll("ı", "i")
    .replaceAll("İ", "I")
    .replaceAll("ğ", "g")
    .replaceAll("Ğ", "G")
    .replaceAll("ü", "u")
    .replaceAll("Ü", "U")
    .replaceAll("ş", "s")
    .replaceAll("Ş", "S")
    .replaceAll("ö", "o")
    .replaceAll("Ö", "O")
    .replaceAll("ç", "c")
    .replaceAll("Ç", "C")
    .replace(/[^\x20-\x7E\n]/g, "");
}

function splitReceiptLine(label: string, value: string, width = 32): string {
  const left = normalizeReceiptText(label).trim();
  const right = normalizeReceiptText(value).trim();

  if (!right) {
    return "";
  }

  const gap = Math.max(1, width - left.length - right.length);
  if (gap > 1) {
    return `${left}${" ".repeat(gap)}${right}`;
  }

  return `${left}\n${right}`;
}

function buildReceiptPlainText(payload: ThermalReceiptPayload): string {
  if (payload.plainTextLines?.length) {
    return payload.plainTextLines
      .map((line) => normalizeReceiptText(line))
      .join("\n");
  }

  const printedAt = payload.date ?? new Date().toLocaleString("tr-TR");
  const rows: string[] = [
    "POWERSA B2B",
    normalizeReceiptText(payload.title).toUpperCase(),
    "-".repeat(32),
    splitReceiptLine("Tarih", printedAt),
    splitReceiptLine("Belge", clean(payload.documentNo)),
    splitReceiptLine("Cari Kod", clean(payload.customerCode)),
    splitReceiptLine("Cari", clean(payload.customerTitle)),
    splitReceiptLine("Kullanici", clean(payload.cashierName)),
  ].filter(Boolean);

  for (const line of payload.lines ?? []) {
    rows.push(splitReceiptLine(line.label, clean(line.value)));
  }

  if (payload.items?.length) {
    rows.push("-".repeat(32));
    payload.items.forEach((item, index) => {
      rows.push(`${index + 1}. ${normalizeReceiptText(item.title)}`);
      if (item.subtitle) {
        rows.push(normalizeReceiptText(item.subtitle));
      }
      if (item.amount) {
        rows.push(splitReceiptLine("Tutar", item.amount));
      }
      for (const line of item.lines ?? []) {
        rows.push(splitReceiptLine(line.label, clean(line.value)));
      }
      rows.push("");
    });
  }

  if (payload.total) {
    rows.push("-".repeat(32));
    rows.push(splitReceiptLine(payload.totalLabel ?? "Toplam", payload.total));
  }

  if (payload.note) {
    rows.push("-".repeat(32));
    rows.push(normalizeReceiptText(payload.note));
  }

  rows.push("");
  rows.push(normalizeReceiptText(payload.footer ?? "Bayi Otomasyon Sistemi"));
  rows.push("");

  return rows.join("\n");
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function buildNativeBridgePayload(payload: ThermalReceiptPayload): string {
  return base64UrlEncode(JSON.stringify({
    version: 1,
    type: "thermal_receipt",
    receipt: payload,
    plain_text: buildReceiptPlainText(payload),
  }));
}

function buildNativeBridgeUrl(payload: ThermalReceiptPayload): ThermalNativeBridgeResult & { url?: string } {
  if (typeof window === "undefined") {
    return {
      ok: false,
      reason: "unsupported",
      message: "PowerSA yazdirma koprusu bu ortamda acilamaz.",
    };
  }

  const encodedPayload = buildNativeBridgePayload(payload);
  if (encodedPayload.length > 12000) {
    return {
      ok: false,
      reason: "payload-too-large",
      message: "Makbuz verisi dogrudan yazdirma koprusu icin cok buyuk.",
    };
  }

  const receiptPath = `receipt?payload=${encodeURIComponent(encodedPayload)}`;
  const url = `powersa-print://${receiptPath}`;

  return {
    ok: true,
    message: "Fis PowerSA yazdirma koprusune gonderildi.",
    url,
  };
}

function openNativeBridgeUrl(url: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.style.display = "none";
  link.rel = "noreferrer";
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => link.remove(), 1500);
}

export function openThermalReceiptNativeBridge(payload: ThermalReceiptPayload): ThermalNativeBridgeResult {
  const bridgeUrl = buildNativeBridgeUrl(payload);
  if (!bridgeUrl.ok || !bridgeUrl.url) {
    return bridgeUrl;
  }

  openNativeBridgeUrl(bridgeUrl.url);

  return {
    ok: true,
    message: bridgeUrl.message,
  };
}

export async function tryThermalReceiptNativeBridge(
  payload: ThermalReceiptPayload,
  timeoutMs = 900
): Promise<ThermalNativeBridgeResult> {
  const bridgeUrl = buildNativeBridgeUrl(payload);
  if (!bridgeUrl.ok || !bridgeUrl.url) {
    return bridgeUrl;
  }

  if (isTouchMobileUserAgent()) {
    openNativeBridgeUrl(bridgeUrl.url);
    return {
      ok: true,
      message: bridgeUrl.message,
    };
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: number | null = null;

    const finish = (result: ThermalNativeBridgeResult) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      resolve(result);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        finish({
          ok: true,
          message: bridgeUrl.message,
        });
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    timeoutId = window.setTimeout(() => {
      finish({
        ok: false,
        reason: "unsupported",
        message: "PowerSA yazdirma koprusu acilamadi.",
      });
    }, timeoutMs);

    openNativeBridgeUrl(bridgeUrl.url);
  });
}

function renderLine(line: ThermalReceiptLine): string {
  const value = clean(line.value);
  if (!value) {
    return "";
  }

  return `
    <div class="line${line.strong ? " strong" : ""}">
      <span>${escapeHtml(line.label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderItem(item: ThermalReceiptItem, index: number): string {
  const lines = (item.lines ?? []).map(renderLine).join("");
  const amount = clean(item.amount);

  return `
    <section class="item">
      <div class="item-head">
        <strong>${index + 1}. ${escapeHtml(item.title)}</strong>
        ${amount ? `<b>${escapeHtml(amount)}</b>` : ""}
      </div>
      ${item.subtitle ? `<p>${escapeHtml(item.subtitle)}</p>` : ""}
      ${lines ? `<div class="item-lines">${lines}</div>` : ""}
    </section>
  `;
}

function buildReceiptHtml(payload: ThermalReceiptPayload): string {
  const lines = (payload.lines ?? []).map(renderLine).join("");
  const items = (payload.items ?? []).map(renderItem).join("");
  const printedAt = payload.date ?? new Date().toLocaleString("tr-TR");
  const total = clean(payload.total);

  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(payload.title)}</title>
  <style>
    @page { size: ${RECEIPT_WIDTH_MM}mm auto; margin: 0; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #f3f4f6;
      color: #000;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 11px;
      line-height: 1.32;
    }
    .receipt {
      width: ${RECEIPT_WIDTH_MM}mm;
      min-height: 100vh;
      margin: 0 auto;
      background: #fff;
      padding: 4mm 3mm 6mm;
    }
    .screen-actions {
      display: flex;
      gap: 8px;
      padding: 10px;
      justify-content: center;
      background: #111827;
      position: sticky;
      top: 0;
      z-index: 2;
    }
    button {
      border: 0;
      border-radius: 10px;
      padding: 10px 14px;
      font: 800 13px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: pointer;
    }
    .print { background: #16a34a; color: #fff; }
    .close { background: #e5e7eb; color: #111827; }
    h1, h2, p { margin: 0; }
    h1 { text-align: center; font-size: 15px; font-weight: 900; letter-spacing: .08em; }
    h2 { margin-top: 2mm; text-align: center; font-size: 12px; font-weight: 900; }
    .muted { color: #333; font-size: 10px; }
    .sep { margin: 3mm 0; border-top: 1px dashed #000; }
    .line, .item-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
      padding: 1mm 0;
    }
    .line span { color: #222; }
    .line strong, .item-head b {
      text-align: right;
      font-weight: 900;
      word-break: break-word;
    }
    .line.strong { font-size: 12px; }
    .item { padding: 1.5mm 0; }
    .item + .item { border-top: 1px dashed #999; }
    .item-head strong { max-width: 33mm; font-weight: 900; }
    .item p { margin-top: .5mm; color: #333; font-size: 10px; }
    .item-lines { margin-top: 1mm; }
    .total {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-size: 14px;
      font-weight: 900;
    }
    .note { margin-top: 2mm; white-space: pre-wrap; word-break: break-word; }
    .footer { margin-top: 4mm; text-align: center; font-size: 10px; }
    @media print {
      body { background: #fff; }
      .screen-actions { display: none; }
      .receipt { margin: 0; box-shadow: none; min-height: auto; }
    }
  </style>
</head>
<body>
  <div class="screen-actions">
    <button class="print" onclick="window.print()">Yazdır</button>
    <button class="close" onclick="window.close()">Kapat</button>
  </div>
  <main class="receipt">
    <h1>POWERSA B2B</h1>
    <h2>${escapeHtml(payload.title)}</h2>
    <div class="sep"></div>
    ${renderLine({ label: "Tarih", value: printedAt })}
    ${renderLine({ label: "Belge", value: payload.documentNo })}
    ${renderLine({ label: "Cari Kod", value: payload.customerCode })}
    ${renderLine({ label: "Cari", value: payload.customerTitle })}
    ${renderLine({ label: "Kullanıcı", value: payload.cashierName })}
    ${lines}
    ${items ? `<div class="sep"></div>${items}` : ""}
    ${total ? `<div class="sep"></div><div class="total"><span>${escapeHtml(payload.totalLabel ?? "Toplam")}</span><strong>${escapeHtml(total)}</strong></div>` : ""}
    ${payload.note ? `<div class="sep"></div><p class="note">${escapeHtml(payload.note)}</p>` : ""}
    <p class="footer">${escapeHtml(payload.footer ?? "Bayi Otomasyon Sistemi")}</p>
  </main>
  <script>
    window.addEventListener("load", () => window.setTimeout(() => window.print(), 250));
  </script>
</body>
</html>`;
}

export function printThermalReceipt(payload: ThermalReceiptPayload): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const printWindow = window.open("", "_blank", "width=360,height=720");
  if (!printWindow) {
    return false;
  }

  printWindow.opener = null;
  printWindow.document.open();
  printWindow.document.write(buildReceiptHtml(payload));
  printWindow.document.close();
  return true;
}
