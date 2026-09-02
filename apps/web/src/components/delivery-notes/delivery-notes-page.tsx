"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Edit3, FileText, Loader2, Printer, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  deletePosSale,
  getPosSale,
  listPosSales,
  type PosSaleDto,
  type PosSaleListItemDto,
  updatePosSale,
} from "@/lib/api";
import { printPageInPlace } from "@/lib/print-page";
import { LogoSyncBadge, LogoSyncInline } from "@/components/integrations/logo-sync-badge";
import { useSession } from "@/components/auth/session-provider";

type EditLine = {
  id: number;
  sku: string | null;
  name: string | null;
  brand: string | null;
  qty: string;
  unit_price: string;
};

const panelClass =
  "border-[var(--brand-border)] bg-[linear-gradient(180deg,var(--surface)_0%,var(--surface-soft)_100%)] shadow-[0_18px_34px_-28px_rgba(33,52,22,0.28)]";
const EMPTY_DELIVERY_NOTES: PosSaleListItemDto[] = [];

function formatMoney(value: string | number, currency = "TRY") {
  const amount = typeof value === "number" ? value : Number(value);

  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0);
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function toNumber(value: string | number | null | undefined) {
  const amount = typeof value === "number" ? value : Number(String(value ?? "").replace(",", "."));

  return Number.isFinite(amount) ? amount : 0;
}

function calculateLineTotal(line: Pick<EditLine, "qty" | "unit_price">) {
  return toNumber(line.qty) * toNumber(line.unit_price);
}

function calculateEditTotal(lines: EditLine[]) {
  return lines.reduce((total, line) => total + calculateLineTotal(line), 0);
}

function customerLabel(row: PosSaleListItemDto) {
  return row.customer.title || row.customer.code || "-";
}

function methodLabel(method: PosSaleListItemDto["sale_type"]) {
  if (method === "cash") {
    return "Nakit";
  }

  if (method === "card") {
    return "Kart";
  }

  return "Havale";
}

function detailCustomerLabel(sale: PosSaleDto) {
  return sale.customer.title || sale.customer.code || "-";
}

export function DeliveryNotesPage() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [selectedSaleId, setSelectedSaleId] = useState<number | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editReceiptNo, setEditReceiptNo] = useState("");
  const [editLines, setEditLines] = useState<EditLine[]>([]);
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const searchQuery = deferredSearchTerm.trim();
  const userBranchIdentity = [
    user?.username,
    user?.branch_code,
    user?.branch_name,
    user?.region_code,
    user?.region_name,
  ].filter(Boolean).join(" ").toLocaleUpperCase("tr-TR");
  const displayCurrency = userBranchIdentity.includes("BATUM") ? "GEL" : "TRY";

  const deliveryNotesQuery = useQuery({
    queryKey: ["delivery-notes", searchQuery, dateFrom, dateTo, cursor],
    queryFn: () =>
      listPosSales({
        q: searchQuery || undefined,
        document_type: "delivery",
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        cursor: cursor || undefined,
        limit: 30,
      }),
    staleTime: 20_000,
    refetchInterval: 15_000,
  });

  const rows = deliveryNotesQuery.data?.data ?? EMPTY_DELIVERY_NOTES;
  const filteredRows = rows;
  const selectedSaleQuery = useQuery({
    queryKey: ["delivery-notes", "detail", selectedSaleId],
    queryFn: () => {
      if (!selectedSaleId) {
        throw new Error("Geçersiz irsaliye kaydı.");
      }

      return getPosSale(selectedSaleId);
    },
    enabled: Boolean(selectedSaleId),
  });
  const selectedSale = selectedSaleQuery.data?.data;
  const editTotal = useMemo(() => calculateEditTotal(editLines), [editLines]);
  const totalAmount = useMemo(
    () => filteredRows.reduce((total, row) => total + (Number(row.grand_total) || 0), 0),
    [filteredRows]
  );

  const updateSaleMutation = useMutation({
    mutationFn: (saleId: number) =>
      updatePosSale(saleId, {
        receipt_no: editReceiptNo.trim(),
        sale_type: selectedSale?.sale_type ?? "cash",
        discount_total: 0,
        items: editLines.map((line) => ({
          id: line.id,
          qty: Math.max(1, Math.round(toNumber(line.qty))),
          unit_price: toNumber(line.unit_price),
          vat_rate: 0,
          line_total: calculateLineTotal(line),
        })),
        payments: [
          {
            method: selectedSale?.sale_type ?? "cash",
            amount: editTotal,
          },
        ],
      }),
    onSuccess: async (response) => {
      const status = response.data.logo_sync_status;
      if (status === "queued") {
        toast.success("İrsaliye düzenlemesi Logo ERP güncellemesi için kuyruğa alındı.");
      } else if (status === "synced") {
        toast.success("İrsaliye PowerSA ve Logo ERP’de başarıyla güncellendi.");
      } else {
        toast.success("İrsaliye düzenlemesi kaydedildi.");
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["delivery-notes"] }),
        queryClient.invalidateQueries({ queryKey: ["pos"] }),
      ]);
      queryClient.setQueryData(["delivery-notes", "detail", response.data.id], response);
      setEditMode(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "İrsaliye belgesi güncellenemedi.");
    },
  });

  const deleteSaleMutation = useMutation({
    mutationFn: (saleId: number) => deletePosSale(saleId),
    onSuccess: async () => {
      toast.success("İrsaliye belgesi silindi.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["delivery-notes"] }),
        queryClient.invalidateQueries({ queryKey: ["pos"] }),
      ]);
      setDeleteConfirmOpen(false);
      setSelectedSaleId(null);
      setEditMode(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "İrsaliye belgesi silinemedi.");
    },
  });

  const updateDateFrom = (value: string) => {
    setCursor(null);
    setDateFrom(value);
  };

  const updateDateTo = (value: string) => {
    setCursor(null);
    setDateTo(value);
  };

  const updateSearchTerm = (value: string) => {
    setCursor(null);
    setSearchTerm(value);
  };

  const closeDetail = () => {
    if (deleteSaleMutation.isPending || updateSaleMutation.isPending) {
      return;
    }

    setSelectedSaleId(null);
    setDeleteConfirmOpen(false);
    setEditMode(false);
  };

  const deleteSelectedSale = () => {
    if (!selectedSale) {
      return;
    }

    deleteSaleMutation.mutate(selectedSale.id);
  };

  const updateEditLine = (lineId: number, field: keyof Pick<EditLine, "qty" | "unit_price">, value: string) => {
    setEditLines((current) =>
      current.map((line) => (line.id === lineId ? { ...line, [field]: value } : line))
    );
  };

  const removeEditLine = (lineId: number) => {
    setEditLines((current) => {
      if (current.length <= 1) {
        toast.error("Belgede en az bir ürün satırı kalmalı.");
        return current;
      }

      return current.filter((line) => line.id !== lineId);
    });
  };

  const startEditSelectedSale = () => {
    if (!selectedSale) {
      return;
    }

    setEditReceiptNo(selectedSale.receipt_no);
    setEditLines(
      selectedSale.items.map((item) => ({
        id: item.id,
        sku: item.sku,
        name: item.name,
        brand: item.brand,
        qty: String(Number(item.qty) || 0),
        unit_price: String(Number(item.unit_price) || 0),
      }))
    );
    setEditMode(true);
  };

  const openPrintWindow = (saleId: number) => {
    printPageInPlace(`/pos/print/sale/${saleId}`);
  };

  const saveSelectedSale = () => {
    if (!selectedSale) {
      return;
    }

    if (!editReceiptNo.trim()) {
      toast.error("Belge numarası boş olamaz.");
      return;
    }

    if (editLines.length === 0) {
      toast.error("Belgede en az bir ürün satırı olmalı.");
      return;
    }

    if (editLines.some((line) => toNumber(line.qty) <= 0 || toNumber(line.unit_price) < 0)) {
      toast.error("Ürün satırlarında adet ve fiyat değerlerini kontrol edin.");
      return;
    }

    updateSaleMutation.mutate(selectedSale.id);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[1fr_0.42fr]">
        <Card className={panelClass}>
          <CardContent className="space-y-3 pt-6">
            <label className="block space-y-2">
              <span className="text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Arama</span>
              <span className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
                <Input
                  className="h-11 pl-10"
                  value={searchTerm}
                  onChange={(event) => updateSearchTerm(event.target.value)}
                  placeholder="Belge no, cari kodu veya cari adı ara"
                />
              </span>
            </label>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-2">
                <span className="text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Başlangıç</span>
                <Input type="date" value={dateFrom} onChange={(event) => updateDateFrom(event.target.value)} />
              </label>
              <label className="space-y-2">
                <span className="text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Bitiş</span>
                <Input type="date" value={dateTo} onChange={(event) => updateDateTo(event.target.value)} />
              </label>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
          <div className="rounded-[24px] border border-[var(--brand-border)] bg-[var(--surface)] p-5 shadow-[0_14px_28px_-24px_rgba(0,0,0,0.18)]">
            <p className="text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Kayıt</p>
            <p className="mt-2 text-3xl font-black text-[var(--brand-primary-strong)]">{filteredRows.length}</p>
          </div>
          <div className="rounded-[24px] border border-[var(--brand-border)] bg-[var(--surface)] p-5 shadow-[0_14px_28px_-24px_rgba(0,0,0,0.18)]">
            <p className="text-xs font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Toplam</p>
            <p className="mt-2 text-2xl font-black text-[var(--brand-primary-strong)]">{formatMoney(totalAmount, displayCurrency)}</p>
          </div>
        </div>
      </div>

      <Card className={panelClass}>
        <CardContent className="p-0">
          <Table className="border-collapse">
            <TableHeader>
              <TableRow className="border-b border-[var(--brand-border)]">
                <TableHead className="border-r border-[var(--brand-border)]">Belge No</TableHead>
                <TableHead className="border-r border-[var(--brand-border)]">Cari</TableHead>
                <TableHead className="border-r border-[var(--brand-border)]">Tarih</TableHead>
                <TableHead className="border-r border-[var(--brand-border)]">Ödeme</TableHead>
                <TableHead className="border-r border-[var(--brand-border)]">Logo</TableHead>
                <TableHead className="border-r border-[var(--brand-border)] text-right">Tutar</TableHead>
                <TableHead className="w-[190px] text-center">Aksiyon</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveryNotesQuery.isLoading ? (
                Array.from({ length: 8 }).map((_, index) => (
                  <TableRow key={`delivery-note-skeleton-${index}`} className="border-b border-[var(--brand-border)] last:border-b-0">
                    <TableCell className="border-r border-[var(--brand-border)]"><Skeleton className="h-4 w-28" /></TableCell>
                    <TableCell className="border-r border-[var(--brand-border)]"><Skeleton className="h-4 w-44" /></TableCell>
                    <TableCell className="border-r border-[var(--brand-border)]"><Skeleton className="h-4 w-32" /></TableCell>
                    <TableCell className="border-r border-[var(--brand-border)]"><Skeleton className="h-4 w-16" /></TableCell>
                    <TableCell className="border-r border-[var(--brand-border)]"><Skeleton className="h-6 w-24 rounded-full" /></TableCell>
                    <TableCell className="border-r border-[var(--brand-border)]"><Skeleton className="ml-auto h-4 w-24" /></TableCell>
                    <TableCell><Skeleton className="mx-auto h-9 w-36 rounded-xl" /></TableCell>
                  </TableRow>
                ))
              ) : deliveryNotesQuery.isError ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-sm font-semibold text-red-600">
                    {(deliveryNotesQuery.error as Error)?.message ?? "İrsaliye kayıtları alınamadı."}
                  </TableCell>
                </TableRow>
              ) : filteredRows.length > 0 ? (
                filteredRows.map((row) => (
                  <TableRow
                    key={row.id}
                    className="cursor-pointer border-b border-[var(--brand-border)] last:border-b-0"
                    onClick={() => {
                      setEditMode(false);
                      setSelectedSaleId(row.id);
                    }}
                  >
                    <TableCell className="border-r border-[var(--brand-border)] font-black text-[var(--brand-primary-strong)]">{row.receipt_no}</TableCell>
                    <TableCell className="border-r border-[var(--brand-border)]">
                      <p className="max-w-[260px] truncate font-semibold text-[var(--foreground)]">{customerLabel(row)}</p>
                      {row.customer.code ? <p className="text-xs font-semibold text-[var(--muted-foreground)]">{row.customer.code}</p> : null}
                    </TableCell>
                    <TableCell className="border-r border-[var(--brand-border)]">{formatDateTime(row.created_at)}</TableCell>
                    <TableCell className="border-r border-[var(--brand-border)]">{methodLabel(row.sale_type)}</TableCell>
                    <TableCell className="border-r border-[var(--brand-border)]">
                      <LogoSyncBadge status={row.logo_sync_status} />
                    </TableCell>
                    <TableCell className="border-r border-[var(--brand-border)] text-right font-black text-[var(--brand-primary-strong)]">{formatMoney(row.grand_total, displayCurrency)}</TableCell>
                    <TableCell>
                      <div className="flex items-center justify-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          className="h-9 rounded-xl px-3 font-black"
                          onClick={(event) => {
                            event.stopPropagation();
                            setEditMode(false);
                            setSelectedSaleId(row.id);
                          }}
                        >
                          <FileText className="h-4 w-4" />
                          Detay
                        </Button>
                        <Button
                          type="button"
                          className="h-9 rounded-xl bg-[var(--brand-primary)] px-3 font-black text-[var(--primary-foreground)] hover:opacity-95"
                          onClick={(event) => {
                            event.stopPropagation();
                            openPrintWindow(row.id);
                          }}
                        >
                          <Printer className="h-4 w-4" />
                          Yazdır
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-sm font-semibold text-[var(--muted-foreground)]">
                    {searchTerm.trim() ? "Arama kriterine uygun irsaliye kaydı bulunamadı." : "İrsaliye kaydı bulunamadı."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          className="h-10 rounded-xl px-5 font-black"
          disabled={!deliveryNotesQuery.data?.next_cursor || deliveryNotesQuery.isFetching}
          onClick={() => setCursor(deliveryNotesQuery.data?.next_cursor ?? null)}
        >
          Sonraki Sayfa
        </Button>
      </div>

      <Dialog open={selectedSaleId !== null} onOpenChange={(open) => !open && closeDetail()}>
        <DialogContent className="flex max-h-[88dvh] w-[calc(100vw-24px)] max-w-6xl flex-col overflow-hidden rounded-2xl border border-[var(--brand-border)] bg-[var(--surface)] p-0 text-[var(--foreground)] shadow-2xl sm:max-w-6xl">
          <DialogHeader className="mb-0 shrink-0 border-b border-[var(--brand-border)] bg-[var(--surface-soft)] px-4 py-3 sm:px-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <DialogTitle className="flex items-center gap-3 text-xl font-black text-[var(--brand-primary-strong)] sm:text-2xl">
                  <FileText className="h-6 w-6 text-[var(--brand-primary)]" />
                  İrsaliye Detayı
                </DialogTitle>
                <DialogDescription className="mt-1 text-[var(--muted-foreground)]">
                  Cari bilgisi, belge özeti ve bu irsaliyede alınan ürün satırları.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {selectedSaleQuery.isLoading ? (
            <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
              <Skeleton className="h-24 w-full rounded-2xl" />
              <Skeleton className="h-64 w-full rounded-2xl" />
            </div>
          ) : selectedSaleQuery.isError || !selectedSale ? (
            <div className="m-4 flex-1 rounded-2xl border border-red-200 bg-red-50 p-5 text-sm font-semibold text-red-700 sm:m-6">
              {(selectedSaleQuery.error as Error)?.message ?? "İrsaliye detayı alınamadı."}
            </div>
          ) : (
            <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
              <div className="rounded-xl border border-[var(--brand-border)] bg-[var(--surface-soft)] px-4 py-3">
                <div className="grid gap-x-5 gap-y-3 md:grid-cols-[minmax(260px,1.15fr)_minmax(260px,1.2fr)_190px_160px] md:items-end">
                  <label className="space-y-1.5">
                    <span className="text-[11px] font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Belge No</span>
                    {editMode ? (
                      <Input
                        value={editReceiptNo}
                        onChange={(event) => setEditReceiptNo(event.target.value)}
                        className="h-10 border-[var(--brand-border)] bg-[var(--surface)] font-black text-[var(--brand-primary-strong)]"
                      />
                    ) : (
                      <span className="block truncate text-base font-black text-[var(--brand-primary-strong)]">{selectedSale.receipt_no}</span>
                    )}
                  </label>
                  <div className="min-w-0 space-y-1.5">
                    <p className="text-[11px] font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Cari</p>
                    <p className="truncate text-base font-black text-[var(--foreground)]">{detailCustomerLabel(selectedSale)}</p>
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-[11px] font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Tarih</p>
                    <p className="whitespace-nowrap text-base font-black text-[var(--foreground)]">{formatDateTime(selectedSale.created_at)}</p>
                  </div>
                  <div className="space-y-1.5 md:text-right">
                    <p className="text-[11px] font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Tutar</p>
                    <p className="whitespace-nowrap text-base font-black text-[var(--brand-primary-strong)]">
                      {formatMoney(editMode ? editTotal : selectedSale.grand_total, displayCurrency)}
                    </p>
                  </div>
                </div>
                <LogoSyncInline
                  className="mt-4 border-t border-[var(--brand-border)] pt-3"
                  label="Logo irsaliye aktarımı"
                  status={selectedSale.logo_sync_status}
                  error={selectedSale.logo_sync_error}
                  externalRef={selectedSale.logo_external_ref}
                  lastSyncedAt={selectedSale.logo_last_synced_at}
                />
              </div>

              <div className="overflow-hidden rounded-xl border border-[var(--brand-border)] bg-[var(--surface)]">
                <Table className="min-w-[940px] table-fixed border-collapse">
                  <TableHeader className="border-[var(--brand-border)] bg-[var(--surface-soft)]">
                    <TableRow className="border-b border-[var(--brand-border)]">
                      <TableHead className="w-[150px] border-r border-[var(--brand-border)] text-[var(--muted-foreground)]">Stok Kodu</TableHead>
                      <TableHead className="border-r border-[var(--brand-border)] text-[var(--muted-foreground)]">Ürün</TableHead>
                      <TableHead className="w-[150px] border-r border-[var(--brand-border)] text-[var(--muted-foreground)]">Marka</TableHead>
                      <TableHead className="w-[120px] border-r border-[var(--brand-border)] text-right text-[var(--muted-foreground)]">Adet</TableHead>
                      <TableHead className="w-[150px] border-r border-[var(--brand-border)] text-right text-[var(--muted-foreground)]">Birim</TableHead>
                      <TableHead className="w-[160px] border-r border-[var(--brand-border)] text-right text-[var(--muted-foreground)]">Tutar</TableHead>
                      {editMode ? <TableHead className="w-[74px] text-right text-[var(--muted-foreground)]">Sil</TableHead> : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {editMode
                      ? editLines.map((line) => (
                          <TableRow key={line.id} className="border-b border-[var(--brand-border)] hover:bg-[var(--surface-soft)] last:border-b-0">
                            <TableCell className="border-r border-[var(--brand-border)] font-black text-[var(--brand-primary-strong)]">{line.sku ?? "-"}</TableCell>
                            <TableCell className="border-r border-[var(--brand-border)]">
                              <p className="truncate font-semibold text-[var(--foreground)]">{line.name ?? "-"}</p>
                            </TableCell>
                            <TableCell className="border-r border-[var(--brand-border)] truncate text-[var(--muted-foreground)]">{line.brand ?? "-"}</TableCell>
                            <TableCell className="border-r border-[var(--brand-border)]">
                              <Input
                                type="number"
                                min="1"
                                step="1"
                                value={line.qty}
                                onChange={(event) => updateEditLine(line.id, "qty", event.target.value)}
                                className="h-10 border-[var(--brand-border)] bg-[var(--surface)] text-right font-black text-[var(--foreground)]"
                              />
                            </TableCell>
                            <TableCell className="border-r border-[var(--brand-border)]">
                              <Input
                                type="number"
                                min="0"
                                step="0.01"
                                value={line.unit_price}
                                onChange={(event) => updateEditLine(line.id, "unit_price", event.target.value)}
                                className="h-10 border-[var(--brand-border)] bg-[var(--surface)] text-right font-black text-[var(--foreground)]"
                              />
                            </TableCell>
                            <TableCell className="border-r border-[var(--brand-border)] text-right font-black text-[var(--brand-primary-strong)]">{formatMoney(calculateLineTotal(line), displayCurrency)}</TableCell>
                            <TableCell className="text-right">
                              <Button
                                type="button"
                                variant="destructive"
                                className="h-9 w-9 rounded-xl p-0"
                                disabled={editLines.length <= 1}
                                onClick={() => removeEditLine(line.id)}
                              >
                                <Trash2 className="h-4 w-4" />
                                <span className="sr-only">Ürünü sil</span>
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))
                      : selectedSale.items.map((item) => (
                          <TableRow key={item.id} className="border-b border-[var(--brand-border)] hover:bg-[var(--surface-soft)] last:border-b-0">
                            <TableCell className="border-r border-[var(--brand-border)] font-black text-[var(--brand-primary-strong)]">{item.sku ?? "-"}</TableCell>
                            <TableCell className="border-r border-[var(--brand-border)]">
                              <p className="truncate font-semibold text-[var(--foreground)]">{item.name ?? "-"}</p>
                              {item.oem ? <p className="text-xs font-semibold text-[var(--muted-foreground)]">OEM: {item.oem}</p> : null}
                            </TableCell>
                            <TableCell className="border-r border-[var(--brand-border)] truncate text-[var(--muted-foreground)]">{item.brand ?? "-"}</TableCell>
                            <TableCell className="border-r border-[var(--brand-border)] text-right font-black">{item.qty}</TableCell>
                            <TableCell className="border-r border-[var(--brand-border)] text-right">
                              {formatMoney(displayCurrency === "GEL" ? item.unit_price_vat_included ?? item.unit_price : item.unit_price, displayCurrency)}
                            </TableCell>
                            <TableCell className="text-right font-black text-[var(--brand-primary-strong)]">
                              {formatMoney(displayCurrency === "GEL" ? item.line_total_vat_included ?? item.line_total : item.line_total, displayCurrency)}
                            </TableCell>
                          </TableRow>
                        ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          <DialogFooter className="mt-0 shrink-0 border-t border-[var(--brand-border)] bg-[var(--surface-soft)] px-4 py-3 sm:flex-row sm:justify-between sm:px-6">
            <div className="flex gap-2">
              {editMode ? (
                <>
                  <Button
                    type="button"
                    className="h-11 rounded-xl px-5 font-black"
                    disabled={!selectedSale || updateSaleMutation.isPending}
                    onClick={saveSelectedSale}
                  >
                    {updateSaleMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    Kaydet
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 rounded-xl px-5 font-black"
                    disabled={updateSaleMutation.isPending}
                    onClick={() => setEditMode(false)}
                  >
                    <X className="h-4 w-4" />
                    Vazgeç
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 rounded-xl px-5 font-black"
                  disabled={!selectedSale || selectedSale.status === "cancelled"}
                  onClick={startEditSelectedSale}
                >
                  <Edit3 className="h-4 w-4" />
                  Düzenle
                </Button>
              )}
              <Button
                type="button"
                variant="destructive"
                className="h-11 rounded-xl px-5 font-black"
                disabled={!selectedSale || deleteSaleMutation.isPending || updateSaleMutation.isPending}
                onClick={() => setDeleteConfirmOpen(true)}
              >
                {deleteSaleMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Belge Sil
              </Button>
            </div>
            <div className="flex gap-2">
              {!editMode && selectedSale ? (
                <Button
                  type="button"
                  className="h-11 rounded-xl bg-[var(--brand-primary)] px-5 font-black text-[var(--primary-foreground)] hover:opacity-95"
                  onClick={() => openPrintWindow(selectedSale.id)}
                >
                  <Printer className="h-4 w-4" />
                  Yazdır
                </Button>
              ) : null}
              <Button type="button" variant="outline" className="h-11 rounded-xl px-5 font-black" onClick={closeDetail}>
                Kapat
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteConfirmOpen}
        onOpenChange={(open) => {
          if (!deleteSaleMutation.isPending) {
            setDeleteConfirmOpen(open);
          }
        }}
      >
        <DialogContent className="max-w-[460px] rounded-3xl border border-red-200/70 bg-[var(--surface)] p-0 shadow-[0_28px_80px_-40px_rgba(127,29,29,0.55)]">
          <DialogHeader className="border-b border-red-100 bg-[linear-gradient(180deg,rgba(254,242,242,0.96)_0%,rgba(255,255,255,0.9)_100%)] px-6 py-5 text-left">
            <div className="flex items-start gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-red-100 text-red-700">
                <Trash2 className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <DialogTitle className="text-xl font-black text-red-950">İrsaliye silinsin mi?</DialogTitle>
                <DialogDescription className="mt-1 text-sm font-semibold leading-6 text-red-900/75">
                  Bu belge PowerSA’dan kaldırılır ve Logo ERP silme kuyruğuna alınır.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-3 px-6 py-5">
            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--surface-soft)] p-4">
              <p className="text-xs font-black uppercase tracking-[0.16em] text-[var(--muted-foreground)]">Belge No</p>
              <p className="mt-1 break-all text-base font-black text-[var(--foreground)]">{selectedSale?.receipt_no ?? "-"}</p>
            </div>
            <p className="text-sm font-semibold leading-6 text-[var(--muted-foreground)]">
              Sadece mevcut ay içindeki ve gün sonu kilidine takılmayan irsaliyeler silinebilir.
            </p>
          </div>

          <DialogFooter className="border-t border-[var(--brand-border)] bg-[var(--surface-soft)] px-6 py-4 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="h-11 rounded-xl px-5 font-black"
              disabled={deleteSaleMutation.isPending}
              onClick={() => setDeleteConfirmOpen(false)}
            >
              Vazgeç
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="h-11 rounded-xl px-5 font-black"
              disabled={!selectedSale || deleteSaleMutation.isPending}
              onClick={deleteSelectedSale}
            >
              {deleteSaleMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Belgeyi Sil
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
