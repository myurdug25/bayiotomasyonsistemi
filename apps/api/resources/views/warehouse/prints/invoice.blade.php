<!doctype html>
<html lang="tr">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>PowerSA Fatura - {{ $shipment->shipment_no }}</title>
    @php
        $order = $shipment->order;
        $customer = $order?->customer;
        $dealer = $order?->dealer;
        $currency = $order?->currency ?? 'TRY';
        $invoiceNo = $shipment->logo_external_ref ?? $shipment->shipment_no;
        $invoiceDate = optional($shipment->shipped_at ?? $shipment->updated_at ?? $shipment->created_at)->format('d.m.Y H:i');
        $printedDate = optional($printedAt)->format('d.m.Y H:i');
        $fmt = static fn ($value) => number_format((float) $value, 2, ',', '.').' '.$currency;
        $address = data_get($customer?->meta, 'address')
            ?? data_get($customer?->meta, 'full_address')
            ?? trim(implode(' / ', array_filter([$customer?->district, $customer?->city])))
            ?: '-';
    @endphp
    <style>
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; }
        body { font-family: Arial, Helvetica, sans-serif; background: #eef3ef; color: #1f1f1f; }
        .actions { position: sticky; top: 0; z-index: 3; display: flex; justify-content: flex-end; gap: 8px; padding: 8px 14px; background: rgba(238,243,239,.94); border-bottom: 1px solid #d8e2da; }
        .actions button { border: 0; border-radius: 999px; padding: 8px 13px; font-weight: 800; cursor: pointer; color: #fff; background: linear-gradient(135deg,#198754,#0f5132); }
        .page { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 7mm 9mm; background: #fff; box-shadow: 0 20px 58px rgba(0,0,0,.08); }
        .doc-topline { display: flex; justify-content: space-between; color: #6b6b6b; font-size: 9px; font-weight: 700; margin-bottom: 2mm; }
        .top { display: grid; grid-template-columns: 1fr 78mm; gap: 7mm; align-items: start; min-height: 58mm; }
        .brand { display: block; }
        .logo { width: 78mm; max-height: 26mm; object-fit: contain; object-position: left center; display: block; margin-bottom: 6mm; }
        .fallback { display: inline-flex; width: 62mm; min-height: 18mm; align-items: center; justify-content: center; border-radius: 8px; background: #153d2b; color: #fff; font-size: 17px; font-weight: 900; letter-spacing: .12em; margin-bottom: 6mm; }
        .company { margin-top: 0; font-size: 8.8px; line-height: 1.18; color: #303030; }
        .stamp-box { display: flex; gap: 12mm; align-items: center; justify-content: center; min-height: 44mm; padding-top: 9mm; }
        .stamp, .qr { display: flex; align-items: center; justify-content: center; color: #777; font-weight: 900; }
        .stamp { width: 24mm; height: 24mm; border: 2px solid #a5adb5; border-radius: 50%; font-size: 9px; text-align: center; color: #9b1f27; }
        .stamp::first-line { color: #9b1f27; }
        .qr { width: 26mm; height: 26mm; border: 1px solid #aaa; font-size: 0; background:
            linear-gradient(90deg, #222 50%, transparent 50%) 0 0 / 4px 4px,
            linear-gradient(#222 50%, transparent 50%) 0 0 / 4px 4px,
            #fff; }
        .title { margin: 2mm 0 3mm; padding-top: 2mm; border-top: 1px solid #d7d7d7; text-align: center; }
        .title h1 { margin: 0; font-size: 18px; letter-spacing: .02em; color: #666; }
        .title p { margin: 2px 0 0; font-size: 10px; color: #69756d; font-weight: 700; }
        .info { display: grid; grid-template-columns: 1.15fr .85fr; gap: 5mm; margin-bottom: 4mm; }
        .box { border: 1px solid #cfdad2; border-radius: 4px; padding: 2.5mm; font-size: 9.5px; line-height: 1.25; }
        .box h2 { margin: 0 0 1.6mm; font-size: 10px; letter-spacing: .08em; color: #1f5b3f; }
        .meta-grid { display: grid; grid-template-columns: 28mm 1fr; border: 1px solid #cfdad2; border-bottom: 0; font-size: 9.5px; }
        .meta-grid div { padding: 1.25mm 1.6mm; border-bottom: 1px solid #cfdad2; }
        .meta-grid div:nth-child(odd) { background: #f4f8f5; font-weight: 800; }
        table { width: 100%; border-collapse: collapse; font-size: 9.5px; }
        th, td { border: 1px solid #c7d2ca; padding: 1.35mm; vertical-align: top; }
        th { background: #f2f5f3; font-size: 9px; text-align: left; }
        td.num, th.num { text-align: right; white-space: nowrap; }
        .totals { display: grid; grid-template-columns: 1fr 64mm; gap: 6mm; margin-top: 3.5mm; align-items: start; }
        .bank { border: 1px solid #cfdad2; font-size: 9.5px; }
        .bank div { display: grid; grid-template-columns: 32mm 1fr; border-bottom: 1px solid #cfdad2; }
        .bank div:last-child { border-bottom: 0; }
        .bank span { padding: 1.35mm; }
        .bank span:first-child { background: #f4f8f5; font-weight: 800; }
        .total-table td:first-child { background: #f4f8f5; font-weight: 800; }
        .slogan { margin-top: 4mm; padding-top: 2.5mm; border-top: 1px solid #dce4dd; text-align: center; color: #6f756f; font-size: 12px; font-weight: 900; letter-spacing: .04em; }
        @media print {
            body { background: #fff; }
            .actions { display: none; }
            @page { size: A4 portrait; margin: 6mm; }
            .page { width: auto; min-height: auto; padding: 0; box-shadow: none; }
        }
    </style>
</head>
<body>
    <div class="actions">
        <button type="button" onclick="window.print()">Yazdır</button>
        <button type="button" onclick="window.close()">Kapat</button>
    </div>
    <main class="page">
        <div class="doc-topline">
            <span>e-Fatura</span>
            <span>Page 1 of 1</span>
        </div>
        <section class="top">
            <div>
                <div class="brand">
                    @if($powersaLogoDataUri)
                        <img src="{{ $powersaLogoDataUri }}" alt="PowerSA Güçsa" class="logo">
                    @else
                        <div class="fallback">POWERSA</div>
                    @endif
                </div>
                <div class="company">
                    <strong>GÜÇSA FİLTRECİM GRUP OTOMOTİV SANAYİ VE TİCARET A.Ş.</strong><br>
                    Şehit Nevtes Bulvarı Kızılay İş Merkezi No: 3 Kat: 6 KONAK / İZMİR<br>
                    Trabzon: Anadolu Cd. Sanayi Mh. No:34/A · Samsun: Yeni Mh. 40 Sk. Gülsan San. Sit. 43/1<br>
                    Batum: Fridon Khalvashi No:25 Batumi / GEORGIA<br>
                    Vergi Dairesi: KONAK · VKN: 1113111000
                </div>
            </div>
            <div class="stamp-box">
                <div class="stamp">GİB<br>e-Fatura</div>
                <div class="qr">QR<br>KOD</div>
            </div>
        </section>

        <section class="title">
            <h1>e-Arşiv Fatura</h1>
            <p>(İrsaliye Yerine Geçer)</p>
        </section>

        <section class="info">
            <div class="box">
                <h2>SAYIN</h2>
                <strong>{{ $customer?->name ?? '-' }}</strong><br>
                Cari Kod: {{ $customer?->code ?? '-' }}<br>
                Adres: {{ $address }}<br>
                Telefon: {{ $customer?->phone ?? '-' }}<br>
                Vergi Dairesi: {{ $customer?->tax_office ?? '-' }} · VKN/TC: {{ $customer?->tax_number ?? '-' }}
            </div>
            <div class="meta-grid">
                <div>Fatura No</div><div>{{ $invoiceNo }}</div>
                <div>Fatura Tarihi</div><div>{{ $invoiceDate }}</div>
                <div>Sipariş No</div><div>{{ $order?->order_no ?? '-' }}</div>
                <div>Sevkiyat No</div><div>{{ $shipment->shipment_no }}</div>
                <div>Satış Tipi</div><div>{{ data_get($checkoutSummary, 'label') ?? '-' }}</div>
                <div>Fiyat Tipi</div><div>{{ $salesPriceType ?? '-' }}</div>
                <div>Gönderim</div><div>{{ $shippingLabel ?? '-' }}</div>
            </div>
        </section>

        <table>
            <thead>
                <tr>
                    <th style="width: 9mm;">Sıra</th>
                    <th style="width: 32mm;">Stok Kodu</th>
                    <th>Stok Adı</th>
                    <th style="width: 28mm;">Marka</th>
                    <th class="num" style="width: 22mm;">Miktar</th>
                    <th class="num" style="width: 28mm;">Birim Fiyat</th>
                    <th class="num" style="width: 28mm;">Tutar</th>
                </tr>
            </thead>
            <tbody>
                @foreach($shipment->items as $item)
                    @if((int) $item->shipped_qty > 0)
                        <tr>
                            <td>{{ $loop->iteration }}</td>
                            <td>{{ $item->product?->sku ?? '-' }}</td>
                            <td>{{ $item->product?->name ?? '-' }}</td>
                            <td>{{ $item->product?->brand?->name ?? '-' }}</td>
                            <td class="num">{{ (int) $item->shipped_qty }} Adet</td>
                            <td class="num">{{ $fmt($item->unit_price) }}</td>
                            <td class="num">{{ $fmt($item->line_total_shipped) }}</td>
                        </tr>
                    @endif
                @endforeach
            </tbody>
        </table>

        <section class="totals">
            <div class="bank">
                <div><span>Önceki Bakiyeniz</span><span></span></div>
                <div><span>Son Bakiyeniz</span><span></span></div>
                <div><span>Banka</span><span>ZİRAAT BANKASI</span></div>
                <div><span>IBAN Numaramız</span><span>TR41 0001 0027 7297 6078 9650 06</span></div>
            </div>
            <table class="total-table">
                <tbody>
                    <tr><td>Toplam Miktar</td><td class="num">{{ (int) data_get($totals, 'quantity_total', 0) }} Adet</td></tr>
                    <tr><td>Ara Toplam</td><td class="num">{{ $fmt(data_get($totals, 'subtotal', 0)) }}</td></tr>
                    <tr><td>KDV</td><td class="num">{{ data_get($checkoutSummary, 'mode') === 'excluded' ? 'KDV Yok' : $fmt(data_get($totals, 'vat_total', 0)) }}</td></tr>
                    <tr><td>Genel Toplam</td><td class="num"><strong>{{ $fmt(data_get($totals, 'grand_total', 0)) }}</strong></td></tr>
                </tbody>
            </table>
        </section>

        <div class="slogan">EN İYİ HİZMET - KALİTE - FİYAT - GARANTİ - ÜRÜN ÇEŞİTLİLİĞİ - SÜREKLİLİK</div>
        <p style="margin-top: 3mm; text-align: right; font-size: 9px; color: #7a857d;">Yazdırma: {{ $printedDate }}</p>
    </main>
</body>
</html>
