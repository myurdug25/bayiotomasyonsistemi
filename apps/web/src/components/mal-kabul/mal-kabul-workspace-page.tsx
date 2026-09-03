"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  ChevronsRight,
  Loader2,
  PackageCheck,
  Save,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  approvePurchaseReceipt,
  getPurchaseReceipt,
  listPurchaseReceipts,
  type PurchaseReceiptRecord,
  type PurchaseReceiptItemPayload,
} from "@/lib/api";
import { useSession } from "@/components/auth/session-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const shellClass =
  "mal-kabul-shell overflow-hidden rounded-[28px] border border-emerald-300/20 bg-[linear-gradient(145deg,rgba(8,31,24,0.98),rgba(5,20,25,0.98)_55%,rgba(32,46,19,0.96))] shadow-[0_28px_80px_-48px_rgba(16,185,129,0.75)]";

function cleanTransferNote(note?: string | null) {
  if (!note) return "Depolar arası transfer ve mal kabul";
  return note.split("| Siparis:")[0]?.replace("Depolar arasi transfer:", "Transfer:").trim()
    || "Depolar arası transfer ve mal kabul";
}

function safeQuantity(value: string, maximum: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(maximum, Math.max(0, Math.round(number)));
}

function numericStock(value?: number | string | null) {
  const number = Number(value);

  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : null;
}

function formatStock(value?: number | string | null) {
  const number = numericStock(value);

  return number === null ? "-" : number.toLocaleString("tr-TR");
}

type ReceiptItem = PurchaseReceiptItemPayload & { id: number };

function defaultAcceptedQuantity(item: ReceiptItem) {
  const accepted = Number(item.accepted_quantity);
  if (Number.isFinite(accepted) && accepted > 0) {
    return Math.round(accepted);
  }

  const expected = Number(item.expected_quantity);
  return Number.isFinite(expected) ? Math.max(0, Math.round(expected)) : 0;
}

export function MalKabulWorkspacePage() {
  const queryClient = useQueryClient();
  const { user } = useSession();
  const [activeReceiptId, setActiveReceiptId] = useState<number | null>(null);
  const [acceptedIds, setAcceptedIds] = useState<Set<number>>(new Set());
  const [selectedWaitingIds, setSelectedWaitingIds] = useState<Set<number>>(new Set());
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [lastReceipt, setLastReceipt] = useState<PurchaseReceiptRecord | null>(null);
  const lastReceiptId = lastReceipt?.id ?? null;
  const lastReceiptLogoState = lastReceipt?.logo_sync_status ?? lastReceipt?.status ?? null;
  const lastReceiptTerminal = lastReceiptLogoState === "synced"
    || lastReceiptLogoState === "failed"
    || Boolean(lastReceipt?.logo_external_ref);
  const receiptQueryKey = useMemo(
    () => [
      "purchase-receipts",
      "warehouse-transfers",
      "draft",
      user?.id ?? null,
      user?.branch_code ?? null,
      user?.branch_name ?? null,
    ],
    [user?.branch_code, user?.branch_name, user?.id],
  );

  const receiptsQuery = useQuery({
    queryKey: receiptQueryKey,
    queryFn: () => listPurchaseReceipts({ status: "draft", warehouse_transfers: true, limit: 50 }),
    staleTime: 10_000,
  });

  useEffect(() => {
    if (lastReceiptId === null || lastReceiptTerminal) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof window.setTimeout> | null = null;

    const pollReceipt = async () => {
      try {
        const latest = await getPurchaseReceipt(lastReceiptId);
        if (cancelled) return;

        setLastReceipt(latest.data);
        const state = latest.data.logo_sync_status ?? latest.data.status;
        const terminal = state === "synced"
          || state === "failed"
          || Boolean(latest.data.logo_external_ref);

        if (!terminal) {
          timer = window.setTimeout(pollReceipt, 1_250);
        }
      } catch {
        if (!cancelled) {
          timer = window.setTimeout(pollReceipt, 2_500);
        }
      }
    };

    timer = window.setTimeout(pollReceipt, 650);

    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [lastReceiptId, lastReceiptTerminal]);

  const receipts = useMemo(() => receiptsQuery.data?.data ?? [], [receiptsQuery.data?.data]);
  const activeReceipt = useMemo(
    () => receipts.find((receipt) => receipt.id === activeReceiptId) ?? receipts[0] ?? null,
    [activeReceiptId, receipts],
  );

  const waitingItems = useMemo(
    () => activeReceipt?.items.filter((item) => !acceptedIds.has(item.id)) ?? [],
    [acceptedIds, activeReceipt],
  );
  const acceptedItems = useMemo(
    () => activeReceipt?.items.filter((item) => acceptedIds.has(item.id)) ?? [],
    [acceptedIds, activeReceipt],
  );
  const quantityFor = useCallback(
    (item: ReceiptItem) => quantities[item.id] ?? defaultAcceptedQuantity(item),
    [quantities],
  );
  const expectedTotal = useMemo(
    () => activeReceipt?.items.reduce((sum, item) => sum + Number(item.expected_quantity ?? 0), 0) ?? 0,
    [activeReceipt],
  );
  const acceptedTotal = useMemo(
    () => acceptedItems.reduce((sum, item) => sum + quantityFor(item), 0),
    [acceptedItems, quantityFor],
  );

  const approveMutation = useMutation({
    mutationFn: (receipt: PurchaseReceiptRecord) => approvePurchaseReceipt(
      receipt.id,
      acceptedItems.map((item) => ({
        id: item.id,
        accepted_quantity: quantityFor(item),
      })),
    ),
    onSuccess: (response) => {
      setLastReceipt(response.data);
      setAcceptedIds(new Set());
      setSelectedWaitingIds(new Set());
      toast.success(response.message ?? "Mal kabul Logo kuyruğuna alındı.");
      void queryClient.invalidateQueries({ queryKey: receiptQueryKey });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Mal kabul kaydedilemedi.");
    },
  });

  const chooseReceipt = (receipt: PurchaseReceiptRecord) => {
    setActiveReceiptId(receipt.id);
    setAcceptedIds(new Set());
    setSelectedWaitingIds(new Set());
    setQuantities(Object.fromEntries(
      receipt.items.map((item) => [item.id, defaultAcceptedQuantity(item)]),
    ));
  };

  const moveRight = (itemId: number) => {
    setAcceptedIds((current) => new Set(current).add(itemId));
    setSelectedWaitingIds((current) => {
      const next = new Set(current);
      next.delete(itemId);
      return next;
    });
  };

  const moveAllRight = () => {
    if (waitingItems.length === 0) {
      return;
    }

    setAcceptedIds((current) => {
      const next = new Set(current);
      waitingItems.forEach((item) => next.add(item.id));
      return next;
    });
    setSelectedWaitingIds(new Set());
  };

  const moveSelectedRight = () => {
    if (selectedWaitingIds.size === 0) {
      toast.error("Gönderilecek ürünleri soldan işaretleyin.");
      return;
    }

    setAcceptedIds((current) => {
      const next = new Set(current);
      selectedWaitingIds.forEach((itemId) => next.add(itemId));
      return next;
    });
    setSelectedWaitingIds(new Set());
  };

  const moveLeft = (itemId: number) => {
    setAcceptedIds((current) => {
      const next = new Set(current);
      next.delete(itemId);
      return next;
    });
  };

  const toggleWaitingItem = (itemId: number, checked: boolean) => {
    setSelectedWaitingIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(itemId);
      } else {
        next.delete(itemId);
      }
      return next;
    });
  };

  const save = () => {
    if (!activeReceipt) {
      toast.error("Mal kabul bekleyen kayıt bulunamadı.");
      return;
    }
    if (acceptedItems.length === 0) {
      toast.error("Önce kabul edilecek ürünleri sağ tarafa gönderin.");
      return;
    }
    approveMutation.mutate(activeReceipt);
  };

  const logoState = lastReceipt?.logo_sync_status ?? lastReceipt?.status;
  const logoDone = logoState === "synced" || Boolean(lastReceipt?.logo_external_ref);
  const logoFailed = logoState === "failed";

  return (
    <div className="mal-kabul-workspace space-y-4">
      <section className={shellClass}>
        <div className="mal-kabul-summary border-b border-emerald-200/15 px-4 py-4 lg:px-5">
          <div className="mal-kabul-summary-grid grid gap-3 xl:grid-cols-[1fr_1.25fr_1fr_0.85fr_1.3fr_auto] xl:items-end">
            <InfoField label="İrsaliye No" value={activeReceipt?.document_no ?? "-"} />
            <InfoField label="Tedarikçi / Gönderen" value={activeReceipt?.supplier_name ?? "-"} />
            <InfoField label="Depo / Ambar" value={activeReceipt?.warehouse_name ?? activeReceipt?.warehouse_code ?? "-"} />
            <InfoField label="Kabul Tarihi" value={activeReceipt?.received_at ?? new Date().toLocaleDateString("tr-TR")} icon={<CalendarDays className="h-4 w-4" />} />
            <InfoField label="Not" value={cleanTransferNote(activeReceipt?.note)} />
            <div className="mal-kabul-stat-grid grid grid-cols-3 gap-2">
              <Stat label="Beklenen" value={expectedTotal} tone="gold" />
              <Stat label="Kabul" value={acceptedTotal} tone="green" />
              <Stat label="Fark" value={Math.max(0, expectedTotal - acceptedTotal)} tone="red" />
            </div>
          </div>
        </div>

        {receipts.length > 1 ? (
          <div className="mal-kabul-receipt-tabs flex gap-2 overflow-x-auto border-b border-emerald-200/15 px-4 py-3 lg:px-5">
            {receipts.map((receipt) => (
              <button
                key={receipt.id}
                type="button"
                onClick={() => chooseReceipt(receipt)}
                className={[
                  "shrink-0 rounded-xl border px-3 py-2 text-left text-xs font-black transition",
                  activeReceipt?.id === receipt.id
                    ? "border-[#f5cf54] bg-[#f5cf54]/18 text-[#ffe996]"
                    : "border-white/10 bg-white/5 text-white/70 hover:bg-white/10",
                ].join(" ")}
              >
                {receipt.supplier_name ?? "Gönderen"} → {receipt.warehouse_name ?? "Hedef depo"}
                <span className="ml-2 text-[10px] opacity-70">{receipt.items.length} ürün</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="mal-kabul-panels grid min-h-[520px] xl:grid-cols-[1.55fr_0.95fr]">
          <div className="mal-kabul-left-panel border-b border-emerald-200/15 p-4 xl:border-b-0 xl:border-r lg:p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="mal-kabul-section-kicker text-xs font-black uppercase tracking-[0.16em] text-[#f5cf54]">Depolar Arası Transfer ve Mal Kabul</p>
                <h2 className="mal-kabul-panel-heading mt-1 text-xl font-black text-white">Bekleyen Ürünler</h2>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  className="mal-kabul-send-all-button h-9 rounded-xl bg-[#f5cf54] px-3 text-xs font-black text-[#211900] hover:bg-[#ffe477]"
                  disabled={waitingItems.length === 0}
                  onClick={moveAllRight}
                >
                  <ChevronsRight className="h-3.5 w-3.5" />
                  Tümünü Gönder
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="mal-kabul-send-selected-button h-9 rounded-xl border-white/15 bg-white/5 px-3 text-xs font-black text-white hover:bg-white/10"
                  disabled={selectedWaitingIds.size === 0}
                  onClick={moveSelectedRight}
                >
                  <ArrowRight className="h-3.5 w-3.5" />
                  Seçilenleri Gönder
                </Button>
                <Badge className="mal-kabul-count-badge mal-kabul-count-badge-gold bg-[#f5cf54] px-3 py-1 text-[#241b00]">{waitingItems.length} ürün</Badge>
              </div>
            </div>

            {receiptsQuery.isLoading ? (
              <LoadingState />
            ) : waitingItems.length ? (
              <div className="mal-kabul-waiting-table overflow-hidden rounded-[20px] border border-white/10 bg-black/15">
                <div className="mal-kabul-waiting-header hidden grid-cols-[36px_1.45fr_0.9fr_0.9fr_0.65fr_0.7fr_0.65fr_150px] gap-3 border-b border-white/10 bg-emerald-600/20 px-3 py-3 text-[11px] font-black uppercase tracking-[0.08em] text-emerald-50 lg:grid">
                  <span>Seç</span><span>Ürün</span><span>Gönderen</span><span>Hedef Depo</span><span>Raf</span><span>Mevcut Stok</span><span>Gelen</span><span>İşlem</span>
                </div>
                <div className="divide-y divide-white/10">
                  {waitingItems.map((item) => (
                    <div key={item.id} className="mal-kabul-waiting-row grid gap-3 px-3 py-3 lg:grid-cols-[36px_1.45fr_0.9fr_0.9fr_0.65fr_0.7fr_0.65fr_150px] lg:items-center">
                      <label className="flex items-center gap-2">
                        <span className="text-[10px] font-black uppercase text-white/45 lg:hidden">Seç</span>
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[#f5cf54]"
                          checked={selectedWaitingIds.has(item.id)}
                          onChange={(event) => toggleWaitingItem(item.id, event.target.checked)}
                        />
                      </label>
                      <ProductCell code={item.product_code} name={item.product_name} />
                      <Cell label="Gönderen" value={activeReceipt?.supplier_name ?? "-"} />
                      <Cell label="Hedef Depo" value={activeReceipt?.warehouse_name ?? "-"} />
                      <Cell label="Raf Adresi" value={item.shelf_address ?? "-"} />
                      <Cell label="Mevcut Stok" value={formatStock(item.current_stock)} />
                      <label className="space-y-1">
                        <span className="text-[10px] font-black uppercase text-white/45 lg:hidden">Gelen</span>
                        <Input
                          id={`qty-${item.id}`}
                          type="number"
                          min={0}
                          max={Number(item.expected_quantity ?? 0)}
                          value={quantityFor(item)}
                          onChange={(event) => setQuantities((current) => ({
                            ...current,
                            [item.id]: safeQuantity(event.target.value, Number(item.expected_quantity ?? 0)),
                          }))}
                          className="h-9 border-[#f5cf54]/35 bg-black/20 text-center font-black text-white"
                        />
                      </label>
                      <div className="flex gap-2">
                        <Button type="button" variant="outline" className="h-9 flex-1 border-white/15 bg-white/5 px-2 text-xs font-black text-white hover:bg-white/10" onClick={() => document.getElementById(`qty-${item.id}`)?.focus()}>
                          Düzenle
                        </Button>
                        <Button type="button" className="h-9 flex-1 bg-[#f5cf54] px-2 text-xs font-black text-[#211900] hover:bg-[#ffe477]" onClick={() => moveRight(item.id)}>
                          Gönder <ArrowRight className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <EmptyState title={activeReceipt ? "Tüm ürünler kabul listesinde" : "Bekleyen mal kabul bulunamadı"} />
            )}
          </div>

          <aside className="mal-kabul-right-panel flex min-h-[480px] flex-col bg-[linear-gradient(180deg,rgba(245,207,84,0.06),rgba(16,185,129,0.04))] p-4 lg:p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="mal-kabul-section-kicker mal-kabul-section-kicker-green text-xs font-black uppercase tracking-[0.16em] text-emerald-300">Kabul Listesi</p>
                <h2 className="mal-kabul-panel-heading mt-1 text-xl font-black text-white">Kabul Edilecekler</h2>
              </div>
              <Badge className="mal-kabul-count-badge mal-kabul-count-badge-green bg-emerald-500 px-3 py-1 text-emerald-950">{acceptedItems.length} ürün</Badge>
            </div>

            <div className="flex-1 space-y-2">
              {acceptedItems.length ? acceptedItems.map((item) => {
                const incoming = quantityFor(item);
                const currentStock = numericStock(item.current_stock);
                const newTotalStock = currentStock === null ? null : currentStock + incoming;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => moveLeft(item.id)}
                    className="mal-kabul-accepted-row group grid w-full grid-cols-[36px_1fr_auto] items-center gap-3 rounded-2xl border border-emerald-300/20 bg-emerald-500/10 p-3 text-left transition hover:border-red-300/35 hover:bg-red-500/10"
                  >
                    <span className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-400/15 text-emerald-200 group-hover:bg-red-400/15 group-hover:text-red-200">
                      <ArrowLeft className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-black text-white">{item.product_code ?? item.product_name}</span>
                      <span className="mt-0.5 block truncate text-xs font-semibold text-white/55">{item.product_name}</span>
                    </span>
                    <span className="grid grid-cols-3 gap-2 text-center">
                      <MiniValue label="Mevcut" value={formatStock(currentStock)} />
                      <MiniValue label="Gelen" value={incoming} />
                      <MiniValue label="Yeni" value={newTotalStock === null ? "-" : formatStock(newTotalStock)} />
                    </span>
                  </button>
                );
              }) : <EmptyState title="Sağa gönderilen ürünler burada birikecek" compact />}
            </div>

            <div className="mal-kabul-save-area mt-4 border-t border-white/10 pt-4">
              <Button
                type="button"
                onClick={save}
                disabled={approveMutation.isPending || acceptedItems.length === 0}
                className="mal-kabul-save-button h-12 w-full rounded-2xl bg-[linear-gradient(135deg,#ff5f62,#dc2626_52%,#991b1b)] text-base font-black text-white shadow-[0_18px_36px_-20px_rgba(239,68,68,0.9)] hover:brightness-110"
              >
                {approveMutation.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />}
                Kaydet
              </Button>
              <p className="mal-kabul-save-note mt-2 text-center text-[11px] font-semibold text-white/45">Sağdaki ürünler mevcut Logo mal kabul akışına gönderilir.</p>
            </div>
          </aside>
        </div>
      </section>

      {lastReceipt ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-emerald-300/25 bg-emerald-500/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-300" />
            <div>
              <p className="text-sm font-black text-white">Mal kabul kaydedildi</p>
              <p className="text-xs font-semibold text-white/55">Logo durumu: {logoState ?? "queued"}</p>
            </div>
          </div>
          <Badge className={logoDone ? "bg-emerald-500 text-emerald-950" : logoFailed ? "bg-red-500 text-white" : "bg-[#f5cf54] text-[#241b00]"}>
            {logoDone ? "Gönderildi" : logoFailed ? "Hata" : "Kuyrukta"}
          </Badge>
        </div>
      ) : null}
    </div>
  );
}

function InfoField({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return <div className="mal-kabul-info-card min-w-0 rounded-2xl border border-white/10 bg-black/15 px-3 py-2.5"><p className="text-[10px] font-black uppercase tracking-[0.12em] text-white/45">{label}</p><p className="mt-1 flex items-center gap-1.5 truncate text-sm font-black text-white">{icon}{value}</p></div>;
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "gold" | "green" | "red" }) {
  const classes = tone === "gold" ? "border-[#f5cf54]/35 bg-[#f5cf54]/12 text-[#ffe477]" : tone === "green" ? "border-emerald-300/30 bg-emerald-500/12 text-emerald-300" : "border-red-300/30 bg-red-500/12 text-red-300";
  return <div className={`mal-kabul-stat-card min-w-[76px] rounded-2xl border px-2 py-2 text-center ${classes}`} data-tone={tone}><p className="text-[9px] font-black uppercase tracking-[0.08em]">{label}</p><p className="mt-1 text-xl font-black">{value}</p></div>;
}

function ProductCell({ code, name }: { code?: string | null; name: string }) {
  return <div className="min-w-0"><p className="truncate text-sm font-black text-white">{code ?? "-"}</p><p className="mt-0.5 truncate text-xs font-semibold text-white/55">{name}</p></div>;
}

function Cell({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><p className="text-[10px] font-black uppercase text-white/45 lg:hidden">{label}</p><p className="truncate text-xs font-black text-white/75">{value}</p></div>;
}

function MiniValue({ label, value }: { label: string; value: string | number }) {
  return <span className="min-w-[52px] rounded-xl border border-white/10 bg-black/15 px-2 py-1.5"><span className="block text-[8px] font-black uppercase text-white/40">{label}</span><span className="mt-0.5 block text-xs font-black text-white">{value}</span></span>;
}

function LoadingState() {
  return <div className="mal-kabul-empty-state flex min-h-52 items-center justify-center gap-2 rounded-2xl border border-white/10 bg-black/10 text-sm font-black text-white/60"><Loader2 className="h-5 w-5 animate-spin" /> Bekleyen ürünler yükleniyor</div>;
}

function EmptyState({ title, compact = false }: { title: string; compact?: boolean }) {
  return <div className={`mal-kabul-empty-state grid place-items-center rounded-2xl border border-dashed border-white/15 bg-black/10 px-4 text-center ${compact ? "min-h-48" : "min-h-72"}`}><div><PackageCheck className="mx-auto h-9 w-9 text-[#f5cf54]" /><p className="mt-3 text-sm font-black text-white/65">{title}</p></div></div>;
}
