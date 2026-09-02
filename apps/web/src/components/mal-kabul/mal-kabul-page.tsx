"use client";

import { useCallback, useMemo, useState } from "react";
import {
  ArrowRight,
  Barcode,
  CheckCircle2,
  ChevronsRight,
  ClipboardCheck,
  ClipboardList,
  DatabaseZap,
  Loader2,
  PackageCheck,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Truck,
} from "lucide-react";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  approvePurchaseReceipt,
  createPurchaseReceipt,
  getPurchaseReceipt,
  listPurchaseReceipts,
  type PurchaseReceiptRecord,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type ReceiptLine = {
  id: string;
  productCode: string;
  productName: string;
  expectedQuantity: number;
  acceptedQuantity: number;
  note: string;
};

type DraftLine = Omit<ReceiptLine, "id">;

const emptyLine: DraftLine = {
  productCode: "",
  productName: "",
  expectedQuantity: 1,
  acceptedQuantity: 1,
  note: "",
};

const panelClass =
  "rounded-[26px] border border-emerald-300/20 bg-[linear-gradient(145deg,rgba(9,34,27,0.96)_0%,rgba(8,20,28,0.96)_52%,rgba(20,52,37,0.94)_100%)] shadow-[0_26px_70px_-44px_rgba(16,185,129,0.7)]";

function nextLineId() {
  return `line-${Date.now()}-${Math.round(Math.random() * 10000)}`;
}

function toSafeQuantity(value: string) {
  const quantity = Number(value);

  if (!Number.isFinite(quantity) || quantity < 0) {
    return 0;
  }

  return Math.round(quantity);
}

export function MalKabulPage() {
  const queryClient = useQueryClient();
  const [documentNo, setDocumentNo] = useState("");
  const [supplier, setSupplier] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [receivedAt, setReceivedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [draftLine, setDraftLine] = useState<DraftLine>(emptyLine);
  const [lines, setLines] = useState<ReceiptLine[]>([]);
  const [lastReceipt, setLastReceipt] = useState<PurchaseReceiptRecord | null>(null);
  const [selectedTransferId, setSelectedTransferId] = useState<number | null>(null);
  const [selectedTransferLineIds, setSelectedTransferLineIds] = useState<Set<number>>(new Set());
  const [selectedTransferLineId, setSelectedTransferLineId] = useState<number | null>(null);

  const transferReceiptsQuery = useQuery({
    queryKey: ["purchase-receipts", "warehouse-transfers", "draft"],
    queryFn: () => listPurchaseReceipts({ status: "draft", warehouse_transfers: true, limit: 50 }),
    staleTime: 10_000,
  });

  const transferReceipts = useMemo(() => transferReceiptsQuery.data?.data ?? [], [transferReceiptsQuery.data?.data]);
  const lastReceiptLogoState = lastReceipt?.logo_sync_status ?? lastReceipt?.status ?? null;
  const lastReceiptIsSynced = lastReceiptLogoState === "synced" || Boolean(lastReceipt?.logo_external_ref);
  const lastReceiptIsFailed = lastReceiptLogoState === "failed";
  const lastReceiptBadgeLabel = lastReceiptIsSynced ? "Gönderildi" : lastReceiptIsFailed ? "Hata" : "Kuyrukta";
  const lastReceiptBadgeClass = lastReceiptIsSynced
    ? "w-fit bg-emerald-700 text-white"
    : lastReceiptIsFailed
      ? "w-fit bg-red-700 text-white"
      : "w-fit bg-amber-500 text-amber-950";
  const selectedTransfer = useMemo(
    () => transferReceipts.find((receipt) => receipt.id === selectedTransferId) ?? transferReceipts[0] ?? null,
    [selectedTransferId, transferReceipts]
  );
  const stagedTransferItemIds = useMemo(
    () => new Set(
      lines
        .filter((line) => line.id.startsWith("transfer-"))
        .map((line) => Number(line.id.replace("transfer-", "")))
        .filter(Number.isFinite)
    ),
    [lines]
  );
  const availableTransferItems = useMemo(() => {
    if (!selectedTransfer) {
      return [];
    }

    return selectedTransfer.items.filter((item) => !stagedTransferItemIds.has(item.id));
  }, [selectedTransfer, stagedTransferItemIds]);
  const selectedTransferLine = useMemo(() => {
    if (!selectedTransfer) {
      return null;
    }

    if (selectedTransferLineId !== null) {
      return selectedTransfer.items.find((item) => item.id === selectedTransferLineId) ?? selectedTransfer.items[0] ?? null;
    }

    return selectedTransfer.items.find((item) => selectedTransferLineIds.has(item.id)) ?? selectedTransfer.items[0] ?? null;
  }, [selectedTransfer, selectedTransferLineId, selectedTransferLineIds]);

  const totals = useMemo(
    () => {
      return lines.reduce(
        (accumulator, line) => {
          accumulator.expected += line.expectedQuantity;
          accumulator.accepted += line.acceptedQuantity;
          accumulator.difference += line.expectedQuantity - line.acceptedQuantity;

          return accumulator;
        },
        { expected: 0, accepted: 0, difference: 0 }
      );
    },
    [lines]
  );

  const addLine = () => {
    const productCode = draftLine.productCode.trim();
    const productName = draftLine.productName.trim();

    if (!productCode && !productName) {
      toast.error("Ürün kodu veya ürün adı girin.");
      return;
    }

    setLines((current) => [
      ...current,
      {
        ...draftLine,
        id: nextLineId(),
        productCode,
        productName: productName || productCode,
        expectedQuantity: Math.max(1, draftLine.expectedQuantity),
        acceptedQuantity: Math.max(0, draftLine.acceptedQuantity),
        note: draftLine.note.trim(),
      },
    ]);
    setDraftLine(emptyLine);
  };

  const removeLine = (id: string) => {
    setLines((current) => current.filter((line) => line.id !== id));
  };

  const resetDraft = () => {
    setDocumentNo("");
    setSupplier("");
    setWarehouse("");
    setReceivedAt(new Date().toISOString().slice(0, 10));
    setNote("");
    setDraftLine(emptyLine);
    setLines([]);
    setSelectedTransferId(null);
    setSelectedTransferLineIds(new Set());
    setSelectedTransferLineId(null);
  };

  const pollReceiptLogoStatus = useCallback((receiptId: number) => {
    let attempts = 0;

    const poll = async () => {
      attempts += 1;

      try {
        const response = await getPurchaseReceipt(receiptId);
        const latest = response.data;
        setLastReceipt(latest);

        const logoState = latest.logo_sync_status ?? latest.status;
        if (logoState === "synced" || logoState === "failed" || latest.logo_external_ref || attempts >= 18) {
          if (logoState === "synced" || latest.logo_external_ref) {
            toast.success(`${latest.receipt_no} Logo'ya gönderildi.`);
          }

          return;
        }
      } catch {
        if (attempts >= 3) {
          return;
        }
      }

      window.setTimeout(poll, 2500);
    };

    window.setTimeout(poll, 1800);
  }, []);

  const rememberReceiptAndPoll = useCallback(
    (receipt: PurchaseReceiptRecord) => {
      setLastReceipt(receipt);
      pollReceiptLogoStatus(receipt.id);
    },
    [pollReceiptLogoStatus]
  );

  const saveReceiptMutation = useMutation({
    mutationFn: () =>
      createPurchaseReceipt({
        document_no: documentNo.trim() || null,
        supplier_name: supplier.trim() || null,
        warehouse_code: warehouse.trim() || null,
        warehouse_name: warehouse.trim() || null,
        received_at: receivedAt,
        note: note.trim() || null,
        items: lines.map((line) => ({
          product_code: line.productCode || null,
          product_name: line.productName,
          expected_quantity: line.expectedQuantity,
          accepted_quantity: line.acceptedQuantity,
          note: line.note || null,
        })),
      }),
    onSuccess: (response) => {
      rememberReceiptAndPoll(response.data);
      toast.success(`${response.data.receipt_no} Logo kuyruğuna alındı.`);
      resetDraft();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Mal kabul kaydedilemedi.");
    },
  });

  const approveTransferMutation = useMutation({
    mutationFn: (receipt: PurchaseReceiptRecord) => approvePurchaseReceipt(
      receipt.id,
      lines
        .filter((line) => line.id.startsWith("transfer-"))
        .map((line) => ({
          id: Number(line.id.replace("transfer-", "")),
          accepted_quantity: line.acceptedQuantity,
        })),
    ),
    onSuccess: (response) => {
      toast.success(response.message ?? "Depo transferi Logo kuyruğuna alındı.");
      rememberReceiptAndPoll(response.data);
      setSelectedTransferId(null);
      setSelectedTransferLineIds(new Set());
      setSelectedTransferLineId(null);
      setLines([]);
      void queryClient.invalidateQueries({ queryKey: ["purchase-receipts", "warehouse-transfers", "draft"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Mal kabul onaylanamadı.");
    },
  });

  const prepareReceipt = () => {
    if (selectedTransfer) {
      if (!lines.some((line) => line.id.startsWith("transfer-"))) {
        toast.error("Mal kabul için soldan ürün seçip sağ listeye gönderin.");
        return;
      }

      approveTransferMutation.mutate(selectedTransfer);
      return;
    }

    if (lines.length === 0) {
      toast.error("Mal kabul için en az bir ürün satırı ekleyin.");
      return;
    }

    saveReceiptMutation.mutate();
  };

  const selectTransfer = (receipt: PurchaseReceiptRecord) => {
    setSelectedTransferId(receipt.id);
    setSelectedTransferLineIds(new Set());
    setSelectedTransferLineId(receipt.items[0]?.id ?? null);
    setDocumentNo(receipt.document_no ?? receipt.receipt_no ?? "");
    setSupplier(receipt.supplier_name ?? "");
    setWarehouse(receipt.warehouse_name ?? receipt.warehouse_code ?? "");
    setReceivedAt(String(receipt.received_at ?? new Date().toISOString()).slice(0, 10));
    setNote(receipt.note ?? "");
    setLines([]);
  };

  const toggleTransferLine = (lineId: number, checked: boolean) => {
    setSelectedTransferLineIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(lineId);
        setSelectedTransferLineId(lineId);
      } else {
        next.delete(lineId);
        setSelectedTransferLineId((current) => {
          if (current !== lineId) {
            return current;
          }

          const first = next.values().next();

          return first.done ? null : Number(first.value);
        });
      }
      return next;
    });
  };

  const transferItemToLine = (item: PurchaseReceiptRecord["items"][number]): ReceiptLine => ({
    id: `transfer-${item.id}`,
    productCode: item.product_code ?? "",
    productName: item.product_name,
    expectedQuantity: Number(item.expected_quantity ?? 0),
    acceptedQuantity: Number(item.accepted_quantity ?? 0),
    note: item.note ?? "",
  });

  const sendTransferItems = (itemIds: number[]) => {
    if (!selectedTransfer) {
      return;
    }

    const ids = new Set(itemIds);
    const itemsToStage = selectedTransfer.items.filter((item) => ids.has(item.id) && !stagedTransferItemIds.has(item.id));

    if (itemsToStage.length === 0) {
      toast.error("Sağa gönderilecek ürün seçin.");
      return;
    }

    setLines((current) => [...current, ...itemsToStage.map(transferItemToLine)]);
    setSelectedTransferLineIds((current) => {
      const next = new Set(current);
      for (const item of itemsToStage) {
        next.delete(item.id);
      }
      return next;
    });
    setSelectedTransferLineId(itemsToStage[0]?.id ?? selectedTransferLineId);
  };

  const sendSelectedTransferItems = () => {
    sendTransferItems([...selectedTransferLineIds]);
  };

  const sendAllTransferItems = () => {
    sendTransferItems(availableTransferItems.map((item) => item.id));
  };

  const selectProductLine = (line: ReceiptLine) => {
    if (!line.id.startsWith("transfer-")) {
      return;
    }

    const id = Number(line.id.replace("transfer-", ""));
    if (Number.isFinite(id)) {
      setSelectedTransferLineId(id);
    }
  };

  return (
    <div className="space-y-4">
      <Card className={panelClass}>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="flex items-center gap-3 text-xl font-black text-[var(--brand-primary-strong)]">
              <Truck className="h-6 w-6 text-[var(--brand-primary)]" />
              Depolar Arası Transfer Mal Kabul
            </CardTitle>
            <Badge variant="secondary" className="w-fit px-3 py-1 text-xs font-black">
              Bekleyen: {transferReceipts.length}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {transferReceiptsQuery.isLoading ? (
            <div className="flex items-center gap-2 rounded-2xl border border-[var(--brand-border)] bg-[var(--surface)] px-4 py-5 text-sm font-black text-[var(--muted-foreground)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Bekleyen transferler yükleniyor
            </div>
          ) : transferReceipts.length ? (
            <div className="grid gap-3 xl:grid-cols-[1fr_0.95fr]">
              <div className="overflow-hidden rounded-[22px] border border-[var(--brand-border)] bg-[var(--surface)]">
                <div className="grid grid-cols-[1fr_0.9fr_0.9fr_0.45fr] gap-3 border-b border-[var(--brand-border)] bg-[var(--surface-soft)] px-4 py-3 text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)] max-lg:hidden">
                  <span>Transfer</span>
                  <span>Gönderen</span>
                  <span>Hedef Depo</span>
                  <span className="text-right">Adet</span>
                </div>
                <div className="divide-y divide-[var(--brand-border)]">
                  {transferReceipts.map((receipt) => {
                    const totalAccepted = receipt.items.reduce((sum, item) => sum + Number(item.accepted_quantity ?? 0), 0);
                    const isSelected = receipt.id === selectedTransfer?.id;

                    return (
                      <button
                        key={receipt.id}
                        type="button"
                        className={[
                          "grid w-full gap-3 px-4 py-4 text-left transition lg:grid-cols-[1fr_0.9fr_0.9fr_0.45fr] lg:items-center",
                          isSelected ? "bg-emerald-500/10 ring-1 ring-inset ring-emerald-300/60" : "hover:bg-white/5",
                        ].join(" ")}
                        onClick={() => selectTransfer(receipt)}
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-black text-[var(--foreground)]">{receipt.document_no ?? receipt.receipt_no}</p>
                          <p className="mt-1 truncate text-xs font-semibold text-[var(--muted-foreground)]">{receipt.note}</p>
                        </div>
                        <p className="truncate text-sm font-black text-[var(--brand-primary-strong)]">{receipt.supplier_name ?? "-"}</p>
                        <p className="truncate text-sm font-black text-[var(--brand-primary-strong)]">{receipt.warehouse_name ?? receipt.warehouse_code ?? "-"}</p>
                        <p className="text-sm font-black text-[var(--foreground)] lg:text-right">{totalAccepted}</p>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-[22px] border border-[var(--brand-border)] bg-[var(--surface)] p-4">
                {selectedTransfer ? (
                  <div className="space-y-4">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p className="text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Seçili Transfer</p>
                        <p className="mt-1 text-base font-black text-[var(--foreground)]">{selectedTransfer.note ?? selectedTransfer.document_no}</p>
                      </div>
                      <Badge variant="secondary" className="w-fit px-3 py-1 text-xs font-black">
                        {selectedTransfer.items.length} satır
                      </Badge>
                    </div>

                    <div className="grid gap-2 sm:grid-cols-2">
                      <Button
                        type="button"
                        className="h-10 rounded-xl bg-[var(--brand-primary)] px-4 text-xs font-black text-[var(--primary-foreground)] hover:opacity-95"
                        disabled={availableTransferItems.length === 0}
                        onClick={sendAllTransferItems}
                      >
                        <ChevronsRight className="h-4 w-4" />
                        Tümünü Gönder
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-10 rounded-xl px-4 text-xs font-black"
                        disabled={selectedTransferLineIds.size === 0}
                        onClick={sendSelectedTransferItems}
                      >
                        <ArrowRight className="h-4 w-4" />
                        Seçilenleri Gönder
                      </Button>
                    </div>

                    <div className="overflow-hidden rounded-2xl border border-[var(--brand-border)]">
                      {availableTransferItems.length > 0 ? (
                        availableTransferItems.map((item) => (
                          <label
                            key={item.id}
                            className={[
                              "grid cursor-pointer grid-cols-[28px_1fr_72px] gap-3 border-b border-[var(--brand-border)] px-3 py-3 transition last:border-b-0",
                              selectedTransferLine?.id === item.id ? "bg-emerald-500/10" : "hover:bg-white/5",
                            ].join(" ")}
                            onClick={() => setSelectedTransferLineId(item.id)}
                          >
                            <input
                              type="checkbox"
                              className="mt-1 h-4 w-4 accent-emerald-500"
                              checked={selectedTransferLineIds.has(item.id)}
                              onChange={(event) => toggleTransferLine(item.id, event.target.checked)}
                              onClick={(event) => event.stopPropagation()}
                            />
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-black text-[var(--foreground)]">{item.product_code ?? "-"}</span>
                              <span className="block truncate text-xs font-semibold text-[var(--muted-foreground)]">{item.product_name}</span>
                            </span>
                            <span className="text-right text-sm font-black text-[var(--brand-primary-strong)]">{item.accepted_quantity}</span>
                          </label>
                        ))
                      ) : (
                        <div className="px-3 py-7 text-center">
                          <PackageCheck className="mx-auto h-8 w-8 text-[var(--brand-primary)]" />
                          <p className="mt-3 text-sm font-black text-[var(--brand-primary-strong)]">Solda bekleyen ürün kalmadı</p>
                        </div>
                      )}
                    </div>

                    {selectedTransferLine ? (
                      <div className="grid gap-2 rounded-2xl border border-emerald-300/40 bg-emerald-500/10 p-3 text-sm sm:grid-cols-2">
                        <p><span className="font-black">Ürün Kodu:</span> {selectedTransferLine.product_code ?? "-"}</p>
                        <p><span className="font-black">Gönderilen:</span> {selectedTransferLine.expected_quantity}</p>
                        <p><span className="font-black">Kabul:</span> {selectedTransferLine.accepted_quantity}</p>
                        <p><span className="font-black">Satır Notu:</span> {selectedTransferLine.note ?? "-"}</p>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-[var(--brand-border)] bg-[var(--surface)] px-4 py-8 text-center">
              <PackageCheck className="mx-auto h-9 w-9 text-[var(--brand-primary)]" />
              <p className="mt-3 text-base font-black text-[var(--brand-primary-strong)]">Mal kabul bekleyen transfer yok</p>
              <p className="mt-1 text-sm font-semibold text-[var(--muted-foreground)]">
                Depo transferi tamamlanınca burada hedef depo onayına düşer.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
        <Card className={panelClass}>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle className="flex items-center gap-3 text-2xl font-black text-[var(--brand-primary-strong)]">
                <PackageCheck className="h-7 w-7 text-[var(--brand-primary)]" />
                Satınalma / Mal Kabul
              </CardTitle>
              <Badge variant="secondary" className="w-fit px-3 py-1 text-xs font-black">
                Logo Kuyruğu
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-2">
                <span className="text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">İrsaliye No</span>
                <Input value={documentNo} onChange={(event) => setDocumentNo(event.target.value)} placeholder="IRS-000001" />
              </label>
              <label className="space-y-2">
                <span className="text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Tedarikçi</span>
                <Input value={supplier} onChange={(event) => setSupplier(event.target.value)} placeholder="Tedarikçi adı" />
              </label>
              <label className="space-y-2">
                <span className="text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Depo / Ambar</span>
                <Input value={warehouse} onChange={(event) => setWarehouse(event.target.value)} placeholder="Merkez depo" />
              </label>
              <label className="space-y-2">
                <span className="text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Kabul Tarihi</span>
                <Input type="date" value={receivedAt} onChange={(event) => setReceivedAt(event.target.value)} />
              </label>
            </div>

            <label className="space-y-2">
              <span className="text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Not</span>
              <Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Belge veya teslimat notu" />
            </label>

            <div className="rounded-2xl border border-emerald-200/60 bg-emerald-50/80 p-3 text-sm text-emerald-950">
              <div className="flex items-start gap-2">
                <DatabaseZap className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="font-bold">
                  Kaydettiğiniz mal kabul B2B veritabanına yazılır ve Logo GO Wings köprüsü için
                  <span className="font-black"> purchase-receipts</span> kuyruğuna alınır.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
          <div className="rounded-[24px] border border-[var(--brand-border)] bg-[var(--surface)] p-5 shadow-[0_14px_28px_-24px_rgba(0,0,0,0.18)]">
            <ClipboardList className="h-7 w-7 text-[var(--brand-primary)]" />
            <p className="mt-4 text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Beklenen</p>
            <p className="mt-2 text-3xl font-black text-[var(--brand-primary-strong)]">{totals.expected}</p>
          </div>
          <div className="rounded-[24px] border border-[var(--brand-border)] bg-[var(--surface)] p-5 shadow-[0_14px_28px_-24px_rgba(0,0,0,0.18)]">
            <ClipboardCheck className="h-7 w-7 text-[var(--brand-primary)]" />
            <p className="mt-4 text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Kabul</p>
            <p className="mt-2 text-3xl font-black text-[var(--brand-primary-strong)]">{totals.accepted}</p>
          </div>
          <div className="rounded-[24px] border border-[var(--brand-border)] bg-[var(--surface)] p-5 shadow-[0_14px_28px_-24px_rgba(0,0,0,0.18)]">
            <Truck className="h-7 w-7 text-[var(--brand-primary)]" />
            <p className="mt-4 text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Fark</p>
            <p className="mt-2 text-3xl font-black text-[var(--brand-primary-strong)]">{totals.difference}</p>
          </div>
        </div>
      </div>

      <Card className={panelClass}>
        <CardHeader>
          <CardTitle className="flex items-center gap-3 text-xl font-black text-[var(--brand-primary-strong)]">
            <Barcode className="h-6 w-6 text-[var(--brand-primary)]" />
            Ürün Satırları
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-[1fr_1.35fr_0.7fr_0.7fr_1fr_auto]">
            <Input
              value={draftLine.productCode}
              onChange={(event) => setDraftLine((current) => ({ ...current, productCode: event.target.value }))}
              placeholder="Stok kodu / barkod"
            />
            <Input
              value={draftLine.productName}
              onChange={(event) => setDraftLine((current) => ({ ...current, productName: event.target.value }))}
              placeholder="Ürün adı"
            />
            <Input
              min={1}
              type="number"
              value={draftLine.expectedQuantity}
              onChange={(event) => setDraftLine((current) => ({ ...current, expectedQuantity: toSafeQuantity(event.target.value) }))}
              placeholder="Beklenen"
            />
            <Input
              min={0}
              type="number"
              value={draftLine.acceptedQuantity}
              onChange={(event) => setDraftLine((current) => ({ ...current, acceptedQuantity: toSafeQuantity(event.target.value) }))}
              placeholder="Kabul"
            />
            <Input
              value={draftLine.note}
              onChange={(event) => setDraftLine((current) => ({ ...current, note: event.target.value }))}
              placeholder="Satır notu"
            />
            <Button type="button" className="h-10 rounded-xl px-4 font-black" onClick={addLine}>
              <Plus className="h-4 w-4" />
              Ekle
            </Button>
          </div>

          <div className="overflow-hidden rounded-[22px] border border-[var(--brand-border)] bg-[var(--surface)]">
            <div className="grid grid-cols-[1fr_1.4fr_0.7fr_0.7fr_0.8fr_44px] gap-3 border-b border-[var(--brand-border)] bg-[var(--surface-soft)] px-4 py-3 text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)] max-lg:hidden">
              <span>Kod</span>
              <span>Ürün</span>
              <span className="text-right">Beklenen</span>
              <span className="text-right">Kabul</span>
              <span>Durum</span>
              <span />
            </div>

            {lines.length > 0 ? (
              <div className="divide-y divide-[var(--brand-border)]">
                {lines.map((line) => {
                  const isMissing = line.acceptedQuantity < line.expectedQuantity;

                  return (
                    <div
                      key={line.id}
                      className={[
                        "grid gap-3 px-4 py-4 transition lg:grid-cols-[1fr_1.4fr_0.7fr_0.7fr_0.8fr_44px] lg:items-center",
                        line.id.startsWith("transfer-") ? "cursor-pointer hover:bg-white/5" : "",
                        selectedTransferLine && line.id === `transfer-${selectedTransferLine.id}` ? "bg-emerald-500/10" : "",
                      ].join(" ")}
                      onClick={() => selectProductLine(line)}
                    >
                      <p className="truncate text-sm font-black text-[var(--brand-primary-strong)]">{line.productCode || "-"}</p>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-black text-[var(--foreground)]">{line.productName}</p>
                        {line.note ? <p className="mt-1 truncate text-xs font-semibold text-[var(--muted-foreground)]">{line.note}</p> : null}
                      </div>
                      <p className="text-sm font-black text-[var(--foreground)] lg:text-right">{line.expectedQuantity}</p>
                      <p className="text-sm font-black text-[var(--foreground)] lg:text-right">{line.acceptedQuantity}</p>
                      <Badge variant={isMissing ? "outline" : "secondary"} className="w-fit font-black">
                        {isMissing ? "Eksik" : "Tam"}
                      </Badge>
                      <Button type="button" size="icon" variant="ghost" className="h-9 w-9 rounded-xl" onClick={() => removeLine(line.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="px-4 py-10 text-center">
                <PackageCheck className="mx-auto h-10 w-10 text-[var(--brand-primary)]" />
                <p className="mt-4 text-lg font-black text-[var(--brand-primary-strong)]">Henüz ürün satırı yok</p>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="h-11 rounded-xl px-5 font-black" onClick={resetDraft}>
              <RotateCcw className="h-4 w-4" />
              Temizle
            </Button>
            <Button
              type="button"
              className="h-11 rounded-[16px] bg-[linear-gradient(135deg,#ff5b5b_0%,#dc2626_48%,#991b1b_100%)] px-6 font-black text-white shadow-[0_18px_40px_-24px_rgba(239,68,68,0.95)] hover:brightness-110"
              disabled={saveReceiptMutation.isPending || approveTransferMutation.isPending}
              onClick={prepareReceipt}
            >
              {saveReceiptMutation.isPending || approveTransferMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Kaydet
            </Button>
          </div>
        </CardContent>
      </Card>

      {lastReceipt ? (
        <Card className="border-emerald-200 bg-emerald-50/90">
          <CardContent className="flex flex-col gap-3 p-4 text-emerald-950 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
              <div>
                <p className="text-sm font-black">{lastReceipt.receipt_no}</p>
                <p className="text-xs font-bold">
                  Logo durumu: {lastReceipt.logo_sync_status ?? lastReceipt.status}
                  {lastReceipt.logo_external_ref ? ` · Ref: ${lastReceipt.logo_external_ref}` : ""}
                </p>
              </div>
            </div>
            <Badge className={lastReceiptBadgeClass}>{lastReceiptBadgeLabel}</Badge>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
