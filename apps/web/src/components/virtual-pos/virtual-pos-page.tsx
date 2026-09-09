"use client";

import { type FormEvent, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, CreditCard, LockKeyhole, MessageCircle, Printer, ReceiptText, ShieldCheck, UserRound } from "lucide-react";
import { toast } from "sonner";

import { useSession } from "@/components/auth/session-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiClientError, startVirtualPosPayment } from "@/lib/api";
import { canUseThermalBrowserPrintFallback, printThermalReceipt, tryThermalReceiptNativeBridge } from "@/lib/thermal-print";
import { cn } from "@/lib/utils";

const INSTALLMENT_OPTIONS = ["1", "2", "3"] as const;

function formatAmountInput(value: string) {
  const normalized = value.replace(/[^\d,.]/g, "");
  const separatorIndex = normalized.indexOf(",");
  const integerRaw = separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex);
  const decimalRaw = separatorIndex === -1 ? "" : normalized.slice(separatorIndex + 1).replace(/\D/g, "");
  const integerDigits = integerRaw.replace(/[^\d]/g, "");
  const formattedInteger = integerDigits ? Number(integerDigits).toLocaleString("tr-TR") : "";

  if (separatorIndex !== -1) {
    return `${formattedInteger},${decimalRaw.slice(0, 2)}`;
  }

  return formattedInteger;
}

function parseAmount(value: string) {
  const parsed = Number(value.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    minimumFractionDigits: 2,
  }).format(value);
}

function submitNestpayPaymentForm(
  gatewayUrl: string,
  payload: Record<string, string | number | null>
) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = gatewayUrl;
  form.acceptCharset = "UTF-8";
  form.style.display = "none";

  const fields: Record<string, string | number | null> = {
    ...payload,
  };

  Object.entries(fields).forEach(([name, value]) => {
    if (value === null || value === undefined) {
      return;
    }

    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = String(value);
    form.appendChild(input);
  });

  document.body.appendChild(form);
  form.submit();
}

export function VirtualPosPage() {
  const { selectedCustomer, user } = useSession();
  const [amount, setAmount] = useState("");
  const [installment, setInstallment] = useState<(typeof INSTALLMENT_OPTIONS)[number]>("1");
  const [description, setDescription] = useState("");
  const [lastPreview, setLastPreview] = useState<{
    amount: number;
    installment: string;
    reference?: string;
  } | null>(null);

  const numericAmount = useMemo(() => parseAmount(amount), [amount]);
  const validationMessage = useMemo(() => {
    if (!selectedCustomer) {
      return "Cari seçimi zorunlu.";
    }
    if (numericAmount <= 0) {
      return "Tutar 0'dan büyük olmalı.";
    }

    return null;
  }, [numericAmount, selectedCustomer]);
  const canSubmit = validationMessage === null;
  const paymentMutation = useMutation({
    mutationFn: () =>
      startVirtualPosPayment({
        customer_id: selectedCustomer?.id ?? 0,
        amount: numericAmount,
        currency: "TRY",
        installment: Number(installment),
        description: description.trim() || undefined,
      }),
    onSuccess: (response) => {
      setLastPreview({
        amount: numericAmount,
        installment,
        reference: response.payment.reference,
      });

      toast.success(`3D ödeme başlatılıyor: ${response.payment.reference}`);
      submitNestpayPaymentForm(response.provider.gateway_url, response.provider.payload);
    },
    onError: (error) => {
      if (error instanceof ApiClientError) {
        toast.error(error.payload?.message ?? error.message);
        return;
      }

      toast.error(error instanceof Error ? error.message : "Sanal POS işlemi başlatılamadı.");
    },
  });

  const handleWhatsAppShare = () => {
    const message = [
      "PowerSA Sanal POS",
      selectedCustomer ? `Cari: ${selectedCustomer.title}` : null,
      `Tutar: ${formatMoney(numericAmount)}`,
      `Taksit: ${installment === "1" ? "Tek Çekim" : `${installment} Taksit`}`,
      description.trim() ? `Açıklama: ${description.trim()}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
  };

  const handlePrint = async () => {
    if (!selectedCustomer || numericAmount <= 0) {
      toast.error("Fiş yazdırmak için cari ve tutar bilgisi girin.");
      return;
    }

    const receiptPayload = {
      title: "SANAL POS FİŞİ",
      customerCode: selectedCustomer.code,
      customerTitle: selectedCustomer.title,
      cashierName: user?.name ?? user?.username ?? null,
      date: new Date().toLocaleString("tr-TR"),
      lines: [
        { label: "Tutar", value: formatMoney(numericAmount), strong: true },
        { label: "Taksit", value: installment === "1" ? "Tek Çekim" : `${installment} Taksit` },
        { label: "Kart Bilgisi", value: "Banka ekranında girilecek" },
      ],
      totalLabel: "Toplam",
      total: formatMoney(numericAmount),
      note: description.trim() || "Sanal POS sağlayıcı entegrasyonu bekleyen ödeme talebidir.",
      footer: "PowerSA B2B · BOS",
    };

    const bridgeResult = await tryThermalReceiptNativeBridge(receiptPayload);
    if (bridgeResult.ok) {
      toast.success("Fiş PowerSA yazdırma köprüsüne gönderildi.");
      return;
    }

    if (!canUseThermalBrowserPrintFallback()) {
      toast.error("BOS Print Bridge açılamadı. APK kurulu ve yazıcı seçili olmalı.");
      return;
    }

    const opened = printThermalReceipt(receiptPayload);

    if (!opened) {
      toast.error("Yazdırma penceresi açılamadı. Tarayıcı popup iznini kontrol edin.");
      return;
    }

    toast.error("BOS Print Bridge açılamadı. Masaüstü yazdırma ekranı açıldı.");
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!canSubmit) {
      toast.error(validationMessage ?? "Formu kontrol edin.");
      return;
    }

    paymentMutation.mutate();
  };

  return (
    <div className="virtual-pos-workspace space-y-4">
      <section className="virtual-pos-hero rounded-[18px] border border-[var(--brand-border)] bg-[linear-gradient(135deg,var(--surface)_0%,var(--surface-soft)_100%)] px-5 py-5 shadow-[0_24px_54px_-44px_rgba(18,40,26,0.55)]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="virtual-pos-hero-icon inline-flex h-10 w-10 items-center justify-center rounded-[14px] bg-[var(--brand-primary)] text-[var(--primary-foreground)]">
                <CreditCard className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-2xl font-black tracking-tight text-[var(--brand-primary-strong)]">Sanal Pos</h2>
                <p className="mt-1 text-sm font-semibold text-[var(--muted-foreground)]">Ziraat/Payten 3D ödeme ekranı</p>
              </div>
            </div>
          </div>
          <Badge variant="outline" className="virtual-pos-status-badge w-fit border-emerald-300/45 bg-emerald-300/10 text-emerald-700">
            3D Pay Hazır
          </Badge>
        </div>
      </section>

      <div className="virtual-pos-main-grid grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="virtual-pos-card-panel rounded-[18px]">
          <CardHeader className="virtual-pos-card-header border-b border-[var(--brand-border)]">
            <CardTitle className="flex items-center gap-2 text-base font-black text-[var(--brand-primary-strong)]">
              <LockKeyhole className="h-4 w-4" /> Ödeme Bilgileri
            </CardTitle>
          </CardHeader>
          <CardContent className="p-5">
            <form className="grid gap-4" onSubmit={handleSubmit}>
              <div className="virtual-pos-form-grid grid gap-5 xl:grid-cols-[minmax(360px,520px)_minmax(0,1fr)] xl:items-start">
                <div className="virtual-pos-card-preview relative aspect-[1.62/1] min-h-[210px] w-full overflow-hidden rounded-[24px] border border-white/15 bg-[radial-gradient(circle_at_18%_12%,rgba(255,255,255,0.20)_0%,transparent_32%),radial-gradient(circle_at_85%_18%,rgba(255,89,94,0.34)_0%,transparent_36%),linear-gradient(135deg,#152333_0%,#0b1424_48%,#451018_100%)] p-4 text-white shadow-[0_22px_56px_rgba(0,0,0,0.32)] sm:p-5">
                  <div className="absolute -right-12 -top-12 h-32 w-32 rounded-full bg-red-400/20 blur-2xl" />
                  <div className="absolute -bottom-14 left-8 h-32 w-32 rounded-full bg-emerald-300/14 blur-2xl" />
                  <div className="absolute inset-x-6 top-1/2 h-px bg-white/10" />
                  <div className="relative flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/62">PowerSA Sanal POS</p>
                      <p className="mt-5 text-[clamp(18px,4.2vw,26px)] font-black tracking-tight sm:mt-7">
                        Banka Güvenli Ödeme
                      </p>
                    </div>
                    <span className="flex h-9 w-12 items-center justify-center rounded-[8px] border border-white/18 bg-white/10">
                      <CreditCard className="h-6 w-6 text-white/72" />
                    </span>
                  </div>
                  <div className="relative mt-5 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 sm:mt-6">
                    <div className="min-w-0">
                      <p className="text-[10px] font-black uppercase tracking-[0.16em] text-white/48">Kart Bilgisi</p>
                      <p className="mt-1 max-w-[260px] truncate text-sm font-black tracking-[0.02em]">Ziraat/Payten ekranında girilecek</p>
                    </div>
                    <div className="virtual-pos-card-meta-grid grid grid-cols-2 gap-2 text-right sm:gap-4">
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-white/48">3D</p>
                        <p className="mt-1 font-mono text-sm font-black">SECURE</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-white/48">POS</p>
                        <p className="mt-1 font-mono text-sm font-black">HOSTED</p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="grid gap-3">
                  <section className="virtual-pos-form-section rounded-[18px] border border-[var(--brand-border)] bg-[var(--surface-soft)] p-3">
                    <p className="mb-2 text-[11px] font-black uppercase tracking-[0.14em] text-[var(--brand-primary-strong)]">1 · Cari</p>
                    <div className="virtual-pos-two-field-grid grid gap-3 md:grid-cols-2">
                      <label className="space-y-1.5">
                        <span className="text-xs font-black uppercase tracking-[0.1em] text-[var(--muted-foreground)]">Cari</span>
                        <Input className="virtual-pos-input" value={selectedCustomer ? `${selectedCustomer.code} - ${selectedCustomer.title}` : ""} disabled />
                      </label>
                      <label className="space-y-1.5">
                        <span className="text-xs font-black uppercase tracking-[0.1em] text-[var(--muted-foreground)]">Kullanıcı</span>
                        <Input className="virtual-pos-input" value={user?.name ?? ""} disabled />
                      </label>
                    </div>
                  </section>

                  <section className="virtual-pos-form-section rounded-[18px] border border-[var(--brand-border)] bg-[var(--surface-soft)] p-3">
                    <p className="mb-2 text-[11px] font-black uppercase tracking-[0.14em] text-[var(--brand-primary-strong)]">2 · Tutar / Taksit</p>
                    <div className="grid gap-3">
                      <div className="virtual-pos-card-detail-grid grid gap-3 md:grid-cols-3">
                        <label className="space-y-1.5 md:col-span-2">
                          <span className="text-xs font-black uppercase tracking-[0.1em] text-[var(--muted-foreground)]">Tutar</span>
                          <Input
                            className="virtual-pos-input"
                            value={amount}
                            onChange={(event) => setAmount(formatAmountInput(event.target.value))}
                            placeholder="0,00"
                            inputMode="decimal"
                          />
                        </label>
                        <label className="space-y-1.5">
                          <span className="text-xs font-black uppercase tracking-[0.1em] text-[var(--muted-foreground)]">Taksit</span>
                          <Select value={installment} onValueChange={(value) => setInstallment(value as typeof installment)}>
                            <SelectTrigger className="virtual-pos-input">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {INSTALLMENT_OPTIONS.map((option) => (
                                <SelectItem key={option} value={option}>
                                  {option === "1" ? "Peşin" : `${option} Taksit`}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </label>
                      </div>
                    </div>
                  </section>

                  <section className="virtual-pos-form-section rounded-[18px] border border-[var(--brand-border)] bg-[var(--surface-soft)] p-3">
                    <p className="mb-2 text-[11px] font-black uppercase tracking-[0.14em] text-[var(--brand-primary-strong)]">3 · Açıklama</p>
                    <div className="grid gap-3">
                      <label className="space-y-1.5">
                        <span className="text-xs font-black uppercase tracking-[0.1em] text-[var(--muted-foreground)]">Açıklama</span>
                        <Input
                          className="virtual-pos-input"
                          value={description}
                          onChange={(event) => setDescription(event.target.value)}
                          placeholder="Sipariş / tahsilat notu"
                        />
                      </label>
                    </div>
                  </section>
                </div>
              </div>

              <div className="virtual-pos-actions-panel flex flex-col gap-3 rounded-[14px] border border-[var(--brand-border)] bg-[var(--surface-soft)] px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
                <p
                  data-valid={validationMessage ? "false" : "true"}
                  className={cn("virtual-pos-validation-message text-sm font-bold", validationMessage ? "text-[var(--muted-foreground)]" : "text-emerald-600")}
                >
                  {validationMessage ?? "Ödeme bilgileri hazır."}
                </p>
                <div className="virtual-pos-action-grid grid min-w-0 gap-2 sm:grid-cols-3 lg:min-w-[430px]">
                  <Button
                    type="button"
                    className="virtual-pos-whatsapp-button h-11 rounded-[14px] border border-emerald-300/45 bg-[linear-gradient(135deg,#2dd36f_0%,#16a34a_52%,#0f6f35_100%)] px-3 text-sm font-black text-white shadow-[0_14px_30px_rgba(22,163,74,0.24)] hover:brightness-110"
                    onClick={handleWhatsAppShare}
                  >
                    <MessageCircle className="h-4 w-4" /> WhatsApp
                  </Button>
                  <Button
                    type="button"
                    className="virtual-pos-print-button h-11 rounded-[14px] border border-white/10 bg-[linear-gradient(135deg,#64748b_0%,#334155_55%,#111827_100%)] px-3 text-sm font-black text-white shadow-[0_14px_28px_rgba(15,23,42,0.20)] hover:brightness-110"
                    onClick={handlePrint}
                  >
                    <Printer className="h-4 w-4" /> Yazdır
                  </Button>
                  <Button
                    type="submit"
                    className="virtual-pos-start-button h-11 gap-2 rounded-[14px] border border-red-300/45 bg-[linear-gradient(135deg,#ff5a5f_0%,#e11d2e_48%,#8f1118_100%)] px-3 text-sm font-black text-white shadow-[0_14px_34px_rgba(225,29,46,0.28)] hover:brightness-110"
                    disabled={!canSubmit || paymentMutation.isPending}
                  >
                    {paymentMutation.isPending ? <LockKeyhole className="h-4 w-4 animate-pulse" /> : <CreditCard className="h-4 w-4" />}
                    Ödemeyi Başlat
                  </Button>
                </div>
              </div>
            </form>
          </CardContent>
        </Card>

        <aside className="space-y-4">
          <Card className="virtual-pos-summary-card rounded-[18px]">
            <CardHeader className="border-b border-[var(--brand-border)]">
              <CardTitle className="flex items-center gap-2 text-base font-black text-[var(--brand-primary-strong)]">
                <ReceiptText className="h-4 w-4" /> Ödeme Özeti
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 p-5">
              <div className="virtual-pos-summary-tile rounded-[14px] border border-[var(--brand-border)] bg-[var(--surface-soft)] p-4">
                <p className="text-[11px] font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Cari</p>
                <p className="mt-1 line-clamp-2 text-sm font-black text-[var(--brand-primary-strong)]">
                  {selectedCustomer?.title ?? "Cari seçilmedi"}
                </p>
              </div>

              <div className="virtual-pos-summary-grid grid grid-cols-2 gap-3">
                <div className="virtual-pos-summary-tile rounded-[14px] border border-[var(--brand-border)] bg-[var(--surface-soft)] p-4">
                  <p className="text-[11px] font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Tutar</p>
                  <p className="mt-1 text-lg font-black text-[var(--brand-primary-strong)]">{formatMoney(numericAmount)}</p>
                </div>
                <div className="virtual-pos-summary-tile rounded-[14px] border border-[var(--brand-border)] bg-[var(--surface-soft)] p-4">
                  <p className="text-[11px] font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Taksit</p>
                  <p className="mt-1 text-lg font-black text-[var(--brand-primary-strong)]">{installment === "1" ? "Peşin" : installment}</p>
                </div>
              </div>

              {lastPreview ? (
                <div className="rounded-[14px] border border-emerald-300/45 bg-emerald-300/10 p-4 text-emerald-700">
                  <div className="flex items-center gap-2 text-sm font-black">
                    <CheckCircle2 className="h-4 w-4" /> Provizyon Ön Kontrolü
                  </div>
                  <p className="mt-2 text-sm font-bold">{formatMoney(lastPreview.amount)}</p>
                  {lastPreview.reference ? <p className="mt-1 text-xs font-black">{lastPreview.reference}</p> : null}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card className="virtual-pos-info-card rounded-[18px]">
            <CardContent className="space-y-3 p-5">
              <div className="flex items-start gap-3">
                <span className="virtual-pos-info-icon inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]">
                  <ShieldCheck className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-sm font-black text-[var(--brand-primary-strong)]">Güvenli Akış</p>
                  <p className="mt-1 text-sm font-semibold text-[var(--muted-foreground)]">
                    Kart bilgisi API&apos;ye gönderilmez; tarayıcı bankanın 3D ödeme kapısına güvenli form gönderir.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <span className="virtual-pos-info-icon inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]">
                  <UserRound className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-sm font-black text-[var(--brand-primary-strong)]">Cari Bağlantısı</p>
                  <p className="mt-1 text-sm font-semibold text-[var(--muted-foreground)]">
                    Ödeme, seçili cari üzerinden provizyon ve tahsilat kaydına bağlanacak şekilde hazırlandı.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
