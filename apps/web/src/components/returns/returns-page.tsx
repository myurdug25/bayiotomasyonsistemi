"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  ClipboardList,
  FileWarning,
  Loader2,
  ReceiptText,
  RefreshCcw,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import {
  createReturnRequest,
  getOrderDetail,
  listOrders,
  listReturnRequests,
  type OrderListItem,
  type ReturnRequestListItem,
  updateReturnRequestStatus,
} from "@/lib/api";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { LogoSyncInline } from "@/components/integrations/logo-sync-badge";

type RequestType = "return" | "damaged" | "faulty";
type StatusFilter = "all" | "submitted" | "reviewing" | "approved" | "rejected" | "completed";
type RequestListFilter = "active" | StatusFilter;
type ReturnWorkflowStatus = Exclude<StatusFilter, "all">;
const ACTIVE_REQUEST_STATUSES: ReturnWorkflowStatus[] = ["submitted", "reviewing"];
const REQUEST_PAGE_SIZE = 8;

const REQUEST_TYPES: Array<{
  value: RequestType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    value: "return",
    label: "İade",
    icon: RefreshCcw,
  },
  {
    value: "damaged",
    label: "Hasarlı",
    icon: AlertTriangle,
  },
  {
    value: "faulty",
    label: "Arızalı",
    icon: Wrench,
  },
];

const REASON_OPTIONS: Record<RequestType, Array<{ value: string; label: string }>> = {
  return: [
    { value: "ordered_by_mistake", label: "Yanlış sipariş verdim" },
    { value: "wrong_product_sent", label: "Yanlış ürün gönderildi" },
    { value: "vehicle_incompatible", label: "Araca uyumlu değil" },
    { value: "excess_quantity", label: "Fazla adet sipariş edilmiş" },
    { value: "other", label: "Diğer" },
  ],
  damaged: [
    { value: "damaged_in_transit", label: "Kargoda hasar görmüş" },
    { value: "box_deformed", label: "Kutu/ambalaj ezik geldi" },
    { value: "missing_parts", label: "Eksik parça var" },
    { value: "sealed_but_damaged", label: "Kapalı kutu ama ürün hasarlı" },
    { value: "other", label: "Diğer" },
  ],
  faulty: [
    { value: "defective_on_arrival", label: "Bozuk geldi" },
    { value: "leakage_issue", label: "Sızdırma / kaçak var" },
    { value: "fitment_issue", label: "Montaj sonrası sorun verdi" },
    { value: "performance_issue", label: "Performans sorunu yaşandı" },
    { value: "other", label: "Diğer" },
  ],
};

const STATUS_OPTIONS: Array<{ value: RequestListFilter; label: string }> = [
  { value: "active", label: "Aktif Talepler" },
  { value: "all", label: "Tümü" },
  { value: "submitted", label: "Yeni" },
  { value: "reviewing", label: "İncelemede" },
  { value: "approved", label: "Onaylandı" },
  { value: "rejected", label: "Reddedildi" },
  { value: "completed", label: "Tamamlandı" },
];

const SHELL_CARD_CLASSNAME =
  "overflow-hidden rounded-[26px] border border-emerald-300/20 bg-[linear-gradient(145deg,rgba(9,34,27,0.96)_0%,rgba(8,20,28,0.96)_52%,rgba(20,52,37,0.94)_100%)] shadow-[0_26px_70px_-44px_rgba(16,185,129,0.7)]";
const FIELD_CLASSNAME =
  "rounded-[16px] border-emerald-300/20 bg-white/[0.045] text-[var(--foreground)] shadow-inner shadow-black/10 placeholder:text-[var(--muted-foreground)] focus:border-emerald-300/45";

const REVIEW_ACTIONS: Record<
  ReturnWorkflowStatus,
  Array<{ status: ReturnWorkflowStatus; label: string; variant: "default" | "secondary" | "outline" | "destructive" }>
> = {
  submitted: [
    { status: "reviewing", label: "İncelemeye Al", variant: "outline" },
    { status: "approved", label: "Onayla", variant: "secondary" },
    { status: "rejected", label: "Reddet", variant: "destructive" },
  ],
  reviewing: [
    { status: "approved", label: "Onayla", variant: "secondary" },
    { status: "rejected", label: "Reddet", variant: "destructive" },
  ],
  approved: [],
  rejected: [],
  completed: [],
};

function normalizeCurrency(currency: string | null | undefined): string {
  const normalized = String(currency ?? "").trim().toUpperCase();

  return /^[A-Z]{3}$/.test(normalized) ? normalized : "TRY";
}

function formatCurrency(value: number | string | null | undefined, currency?: string | null): string {
  const normalized = typeof value === "string" ? value.replace(",", ".") : value;
  const amount = Number(normalized ?? 0);
  const safeCurrency = normalizeCurrency(currency);

  if (!Number.isFinite(amount)) {
    return `0 ${safeCurrency}`;
  }

  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: safeCurrency,
    minimumFractionDigits: 2,
  }).format(amount);
}

function formatDate(value: string | null): string {
  if (!value) {
    return "-";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function toCount(value: number | undefined): string {
  return new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(value ?? 0);
}

function getStatusMeta(status: string | null | undefined): { label: string; className: string } {
  const normalized = String(status ?? "").trim().toLowerCase();

  if (normalized === "submitted") {
    return {
      label: "Yeni Talep",
      className: "border-amber-200 bg-amber-50 text-amber-700",
    };
  }

  if (normalized === "reviewing") {
    return {
      label: "İncelemede",
      className: "border-blue-200 bg-blue-50 text-blue-700",
    };
  }

  if (normalized === "approved") {
    return {
      label: "Onaylandı",
      className: "border-emerald-200 bg-emerald-50 text-emerald-700",
    };
  }

  if (normalized === "rejected") {
    return {
      label: "Reddedildi",
      className: "border-rose-200 bg-rose-50 text-rose-700",
    };
  }

  if (normalized === "completed") {
    return {
      label: "Tamamlandı",
      className: "border-slate-200 bg-slate-100 text-slate-700",
    };
  }

  return {
    label: normalized.length > 0 ? String(status) : "Durum Yok",
    className: "border-[var(--brand-border)] bg-[var(--surface-soft)] text-[var(--muted-foreground)]",
  };
}

function getTypeMeta(requestType: RequestType | string | null | undefined): {
  label: string;
  className: string;
} {
  if (requestType === "damaged") {
    return {
      label: "Hasarlı",
      className: "border-rose-200 bg-rose-50 text-rose-700",
    };
  }

  if (requestType === "faulty") {
    return {
      label: "Arızalı",
      className: "border-orange-200 bg-orange-50 text-orange-700",
    };
  }

  return {
    label: "İade",
    className: "border-slate-200 bg-slate-100 text-slate-700",
  };
}

function isScrapRequest(requestType: RequestType | string | null | undefined): boolean {
  return requestType === "damaged" || requestType === "faulty";
}

function getLogoWorkflowMeta(requestType: RequestType | string | null | undefined): {
  title: string;
  description: string;
  scrapLabel: string;
} {
  if (isScrapRequest(requestType)) {
    return {
      title: "Fire fişi",
      description: "Depocu onaylayınca Logo diğer malzeme fire fişi kuyruğuna alınır.",
      scrapLabel: "Fire fişi",
    };
  }

  return {
    title: "Toptan satış iadesi",
    description: "Depocu onaylayınca Logo toptan satış iade kuyruğuna alınır.",
    scrapLabel: "Fire yok",
  };
}

function getDefaultResolutionNote(status: ReturnWorkflowStatus): string {
  if (status === "reviewing") {
    return "Talep incelemeye alındı.";
  }

  if (status === "approved") {
    return "Talep onaylandı ve Logo kuyruğuna alındı.";
  }

  if (status === "rejected") {
    return "Talep reddedildi.";
  }

  return "Talep süreci tamamlandı.";
}

function RequestStatusBadge({ status }: { status: string | null | undefined }) {
  const meta = getStatusMeta(status);
  return (
    <Badge variant="outline" className={`font-semibold ${meta.className}`}>
      {meta.label}
    </Badge>
  );
}

function RequestTypeBadge({ requestType }: { requestType: RequestType | string | null | undefined }) {
  const meta = getTypeMeta(requestType);
  return (
    <Badge variant="outline" className={`font-semibold ${meta.className}`}>
      {meta.label}
    </Badge>
  );
}

function LogoApprovalWaitNotice({ label }: { label: string }) {
  return (
    <div className="rounded-2xl bg-[var(--surface-soft)] p-3">
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--muted-foreground)]">{label}</p>
      <div className="mt-2 inline-flex w-fit items-center rounded-full border border-amber-300/45 bg-amber-300/12 px-3 py-1 text-xs font-black text-amber-100">
        Onay bekliyor
      </div>
      <p className="mt-2 text-xs font-semibold text-[var(--muted-foreground)]">
        Depocu onayından sonra Logo kuyruğuna alınır.
      </p>
    </div>
  );
}

export function ReturnsPage() {
  const queryClient = useQueryClient();
  const { user, selectedCustomer } = useAuth();
  const roleSlugs = user?.roles?.map((role) => role.slug) ?? [];
  const isSalesperson = roleSlugs.includes("salesperson");
  const userBranchSignal = [
    user?.branch_code,
    user?.branch_name,
    user?.region_code,
    user?.region_name,
    user?.username,
    user?.name,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleUpperCase("tr-TR");
  const isBatumReturnOperator =
    !isSalesperson &&
    (user?.menu_permissions?.includes("returns") ?? false) &&
    userBranchSignal.includes("BATUM");
  const canReviewReturns =
    roleSlugs.includes("admin") ||
    roleSlugs.includes("warehouse") ||
    isBatumReturnOperator;

  const [requestType, setRequestType] = useState<RequestType>("return");
  const [reasonCode, setReasonCode] = useState(REASON_OPTIONS.return[0].value);
  const [reasonNote, setReasonNote] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [orderSearch, setOrderSearch] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [selectedOrderItemId, setSelectedOrderItemId] = useState("");
  const [statusFilter, setStatusFilter] = useState<RequestListFilter>("active");
  const [requestPagination, setRequestPagination] = useState<{
    scopeKey: string;
    cursor?: string;
    stack: string[];
  }>({ scopeKey: "", stack: [] });

  const debouncedOrderSearch = useDebouncedValue(orderSearch, 400);
  const normalizedOrderSearch = debouncedOrderSearch.trim();
  const canRunOrderSearch = normalizedOrderSearch.length === 0 || normalizedOrderSearch.length >= 2;
  const requestScopeKey = `${selectedCustomer?.id ?? "all"}:${statusFilter}`;
  const effectiveRequestCursor = requestPagination.scopeKey === requestScopeKey ? requestPagination.cursor : undefined;
  const effectiveRequestCursorStack = requestPagination.scopeKey === requestScopeKey ? requestPagination.stack : [];
  const selectedRequestStatuses = useMemo<ReturnWorkflowStatus[] | undefined>(() => {
    if (statusFilter === "active") {
      return ACTIVE_REQUEST_STATUSES;
    }

    if (statusFilter === "all") {
      return undefined;
    }

    return [statusFilter];
  }, [statusFilter]);

  const ordersQuery = useQuery({
    queryKey: ["returns", "orders", normalizedOrderSearch, selectedCustomer?.id ?? null],
    queryFn: () =>
      listOrders({
        q: normalizedOrderSearch || undefined,
        customer_id: selectedCustomer?.id ?? undefined,
        limit: 40,
      }),
    enabled: Boolean(user) && (!isSalesperson || Boolean(selectedCustomer)) && canRunOrderSearch,
    retry: 1,
    staleTime: 60_000,
  });

  const returnRequestsQuery = useQuery({
    queryKey: ["returns", "requests", statusFilter, selectedCustomer?.id ?? null, effectiveRequestCursor ?? null],
    queryFn: () =>
      listReturnRequests({
        customer_id: selectedCustomer?.id ?? undefined,
        statuses: selectedRequestStatuses,
        limit: REQUEST_PAGE_SIZE,
        cursor: effectiveRequestCursor,
      }),
    enabled: Boolean(user) && (!isSalesperson || Boolean(selectedCustomer)),
    staleTime: 30_000,
    refetchInterval: (query) => {
      const rows = query.state.data?.data ?? [];
      const hasWaitingLogoSync = rows.some((row) => {
        const isScrap = isScrapRequest(row.request_type);
        const status = isScrap ? row.scrap_logo_sync_status : row.logo_sync_status;

        return row.status === "approved" || row.status === "completed"
          ? !status || status === "queued" || status === "failed"
          : false;
      });

      return hasWaitingLogoSync ? 5000 : false;
    },
  });

  const orderOptions = useMemo(() => ordersQuery.data?.data ?? [], [ordersQuery.data?.data]);
  const resolvedSelectedOrderId = useMemo(() => {
    if (!orderOptions.length) {
      return "";
    }

    if (orderOptions.some((order) => String(order.id) === selectedOrderId)) {
      return selectedOrderId;
    }

    return String(orderOptions[0].id);
  }, [orderOptions, selectedOrderId]);
  const selectedOrder = useMemo(
    () => orderOptions.find((order) => String(order.id) === resolvedSelectedOrderId) ?? null,
    [orderOptions, resolvedSelectedOrderId]
  );

  const orderDetailQuery = useQuery({
    queryKey: ["returns", "order-detail", resolvedSelectedOrderId],
    queryFn: () => getOrderDetail(Number(resolvedSelectedOrderId)),
    enabled: resolvedSelectedOrderId.trim().length > 0,
    staleTime: 60_000,
  });

  const orderItems = useMemo(() => orderDetailQuery.data?.order.items ?? [], [orderDetailQuery.data?.order.items]);
  const resolvedSelectedOrderItemId = useMemo(() => {
    if (!orderItems.length) {
      return "";
    }

    if (orderItems.some((item) => String(item.id) === selectedOrderItemId)) {
      return selectedOrderItemId;
    }

    return String(orderItems[0].id);
  }, [orderItems, selectedOrderItemId]);
  const selectedOrderItem = useMemo(
    () => orderItems.find((item) => String(item.id) === resolvedSelectedOrderItemId) ?? null,
    [orderItems, resolvedSelectedOrderItemId]
  );

  const requestMutation = useMutation({
    mutationFn: createReturnRequest,
    onSuccess: (response) => {
      toast.success(`Talep oluşturuldu: ${response.data.request_no}`);
      setReasonNote("");
      setQuantity("1");
      void queryClient.invalidateQueries({ queryKey: ["returns", "requests"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Talep oluşturulamadı");
    },
  });
  const statusMutation = useMutation({
    mutationFn: ({
      returnRequestId,
      status,
      resolutionNote,
    }: {
      returnRequestId: number;
      status: ReturnWorkflowStatus;
      resolutionNote?: string;
    }) => updateReturnRequestStatus(returnRequestId, { status, resolution_note: resolutionNote }),
    onSuccess: (response) => {
      toast.success(`Talep durumu güncellendi: ${getStatusMeta(response.data.status).label}`);
      void queryClient.invalidateQueries({ queryKey: ["returns", "requests"] });
      for (const delayMs of [3000, 8000, 15000]) {
        window.setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: ["returns", "requests"] });
        }, delayMs);
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Talep durumu güncellenemedi");
    },
  });

  const canLoadPage = Boolean(user) && (!isSalesperson || Boolean(selectedCustomer));
  const availableReasons = REASON_OPTIONS[requestType];
  const workflowMeta = getLogoWorkflowMeta(requestType);
  const resolvedReasonCode = useMemo(() => {
    if (availableReasons.some((option) => option.value === reasonCode)) {
      return reasonCode;
    }

    return availableReasons[0]?.value ?? "other";
  }, [availableReasons, reasonCode]);
  const resolvedQuantity = useMemo(() => {
    if (!selectedOrderItem) {
      return quantity.trim().length > 0 ? quantity : "1";
    }

    const parsedQuantity = Number.parseInt(quantity, 10);
    const nextQuantity = Number.isFinite(parsedQuantity) ? parsedQuantity : 1;
    const maxQuantity = Math.max(0, Number(selectedOrderItem.returnable_quantity ?? selectedOrderItem.quantity ?? 0));

    if (maxQuantity <= 0) {
      return "0";
    }

    return String(Math.max(1, Math.min(nextQuantity, maxQuantity)));
  }, [quantity, selectedOrderItem]);
  const requestRows = useMemo<ReturnRequestListItem[]>(
    () => returnRequestsQuery.data?.data ?? [],
    [returnRequestsQuery.data?.data]
  );

  const handleReset = () => {
    setRequestType("return");
    setReasonCode(REASON_OPTIONS.return[0].value);
    setReasonNote("");
    setQuantity("1");
    setOrderSearch("");
    setSelectedOrderId("");
    setSelectedOrderItemId("");
    setStatusFilter("active");
  };

  const handleSubmit = () => {
    if (!selectedOrder) {
      toast.error("Önce bir sipariş seçin.");
      return;
    }

    if (!selectedOrderItem) {
      toast.error("İade edilecek sipariş kalemini seçin.");
      return;
    }

    const returnableQuantity = Number(selectedOrderItem.returnable_quantity ?? selectedOrderItem.quantity ?? 0);
    if (returnableQuantity <= 0) {
      toast.error("Bu ürün için iade edilebilir adet kalmadı.");
      return;
    }

    requestMutation.mutate({
      order_id: selectedOrder.id,
      order_item_id: selectedOrderItem.id,
      request_type: requestType,
      reason_code: resolvedReasonCode,
      reason_note: reasonNote.trim() || undefined,
      quantity: Math.max(1, Number(resolvedQuantity || 1)),
    });
  };

  const summary = returnRequestsQuery.data?.summary;
  const totalCount = summary?.total_count ?? requestRows.length;
  const nextRequestCursor = returnRequestsQuery.data?.next_cursor ?? null;
  const hasNextRequestPage = Boolean(nextRequestCursor);
  const hasPreviousRequestPage = effectiveRequestCursorStack.length > 0;
  const requestPageNumber = effectiveRequestCursorStack.length + 1;

  const handleNextRequestPage = () => {
    if (!nextRequestCursor) {
      return;
    }

    setRequestPagination({
      scopeKey: requestScopeKey,
      cursor: nextRequestCursor,
      stack: [...effectiveRequestCursorStack, effectiveRequestCursor ?? ""],
    });
  };

  const handlePreviousRequestPage = () => {
    const previousCursor = effectiveRequestCursorStack[effectiveRequestCursorStack.length - 1];

    setRequestPagination({
      scopeKey: requestScopeKey,
      cursor: previousCursor ? previousCursor : undefined,
      stack: effectiveRequestCursorStack.slice(0, -1),
    });
  };

  return (
    <div className="space-y-5 text-slate-100">
      {!canLoadPage ? (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="p-4 text-sm font-semibold text-amber-800">Önce müşteri seçin.</CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.08fr)_minmax(380px,0.92fr)]">
        <Card className={SHELL_CARD_CLASSNAME}>
          <CardContent className="space-y-5 p-4 sm:p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-[var(--brand-border)] bg-[var(--surface-soft)] text-[var(--brand-primary)]">
                <ClipboardList className="h-6 w-6" />
              </div>
              <h2 className="text-2xl font-extrabold tracking-tight text-[var(--brand-primary-strong)]">Yeni Talep</h2>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {REQUEST_TYPES.map((type) => {
                const Icon = type.icon;
                const active = requestType === type.value;

                return (
                  <button
                    key={type.value}
                    type="button"
                    onClick={() => setRequestType(type.value)}
                    className={`min-h-[112px] rounded-3xl border p-4 text-left transition-all ${
                      active
                        ? "border-[var(--brand-primary)] bg-[var(--brand-primary-soft)] text-[var(--brand-primary-strong)] shadow-[0_18px_30px_-24px_rgba(67,131,75,0.55)]"
                        : "border-[var(--brand-border)] bg-[var(--surface)] text-[var(--foreground)] hover:border-[var(--brand-primary)]"
                    }`}
                  >
                    <Icon className="h-8 w-8 text-[var(--brand-primary)]" />
                    <span className="mt-4 block text-lg font-extrabold">{type.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="grid gap-3 rounded-2xl border border-[var(--brand-border)] bg-[var(--surface)] p-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700">
                  <ReceiptText className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-extrabold text-[var(--brand-primary-strong)]">Toptan satış iadesi</p>
                  <p className="text-xs font-semibold text-[var(--muted-foreground)]">
                    Normal iadede depocu onayı sonrası Logo iade kuyruğuna gider.
                  </p>
                </div>
              </div>
              <ArrowRight className="hidden h-5 w-5 text-[var(--muted-foreground)] sm:block" />
              <div className="flex min-w-0 items-center gap-3">
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${
                    isScrapRequest(requestType)
                      ? "border-orange-200 bg-orange-50 text-orange-700"
                      : "border-[var(--brand-border)] bg-[var(--surface-soft)] text-[var(--muted-foreground)]"
                  }`}
                >
                  <FileWarning className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-extrabold text-[var(--brand-primary-strong)]">{workflowMeta.scrapLabel}</p>
                  <p className="text-xs font-semibold text-[var(--muted-foreground)]">{workflowMeta.description}</p>
                </div>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-bold text-[var(--brand-primary-strong)]">Sipariş Ara</label>
                <Input
                  className={FIELD_CLASSNAME}
                  value={orderSearch}
                  onChange={(event) => setOrderSearch(event.target.value)}
                  placeholder="Sipariş no, müşteri, ürün kodu, OEM veya rakip kod"
                />
                {!canRunOrderSearch ? (
                  <p className="text-xs font-semibold text-[var(--muted-foreground)]">Arama için en az 2 karakter yazın.</p>
                ) : null}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-bold text-[var(--brand-primary-strong)]">Sipariş</label>
                <Select value={resolvedSelectedOrderId} onValueChange={setSelectedOrderId}>
                  <SelectTrigger className={FIELD_CLASSNAME}>
                    <SelectValue placeholder="Sipariş seçin" />
                  </SelectTrigger>
                  {orderOptions.length > 0 ? (
                    <SelectContent>
                      {orderOptions.map((order: OrderListItem) => (
                        <SelectItem key={order.id} value={String(order.id)}>
                          {order.order_no} {order.customer?.title ? `· ${order.customer.title}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  ) : null}
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-bold text-[var(--brand-primary-strong)]">Ürün</label>
              <Select
                value={resolvedSelectedOrderItemId}
                onValueChange={setSelectedOrderItemId}
                disabled={orderDetailQuery.isLoading || orderItems.length === 0}
              >
                <SelectTrigger className={FIELD_CLASSNAME}>
                  <SelectValue placeholder="Ürün seçin" />
                </SelectTrigger>
                {orderItems.length > 0 ? (
                  <SelectContent>
                    {orderItems.map((item) => (
                      <SelectItem key={item.id} value={String(item.id)}>
                        {item.sku ?? "-"} · {item.name ?? "-"} · İade edilebilir: {item.returnable_quantity ?? item.quantity} adet
                      </SelectItem>
                    ))}
                  </SelectContent>
                ) : null}
              </Select>
            </div>

            {ordersQuery.isError ? (
              <div className="rounded-3xl border border-red-300/35 bg-red-500/10 p-5 text-sm font-bold text-red-100">
                Sipariş araması yapılamadı. {ordersQuery.error instanceof Error ? ordersQuery.error.message : "Lütfen tekrar deneyin."}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3 border-red-200/40 bg-red-500/10 text-red-50 hover:bg-red-500/20"
                  onClick={() => void ordersQuery.refetch()}
                >
                  Tekrar Dene
                </Button>
              </div>
            ) : ordersQuery.isLoading || orderDetailQuery.isLoading ? (
              <div className="grid gap-3 md:grid-cols-3">
                {Array.from({ length: 3 }).map((_, index) => (
                  <Skeleton key={`return-form-skeleton-${index}`} className="h-12 w-full" />
                ))}
              </div>
            ) : selectedOrderItem ? (
              <div className="grid gap-3 rounded-3xl border border-[var(--brand-border)] bg-[var(--surface)] p-4 sm:grid-cols-4">
                <div className="sm:col-span-2">
                  <p className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">Ürün</p>
                  <p className="mt-1 text-lg font-extrabold text-[var(--brand-primary-strong)]">{selectedOrderItem.name ?? "-"}</p>
                  <p className="mt-1 text-sm font-semibold text-[var(--muted-foreground)]">{selectedOrderItem.sku ?? "-"}</p>
                </div>
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">Sipariş</p>
                  <p className="mt-1 text-2xl font-extrabold text-[var(--brand-primary-strong)]">{selectedOrderItem.quantity}</p>
                </div>
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">İade Edilebilir</p>
                  <p className="mt-1 text-2xl font-extrabold text-[var(--brand-primary-strong)]">
                    {selectedOrderItem.returnable_quantity ?? selectedOrderItem.quantity}
                  </p>
                </div>
                <div className="sm:col-span-4 grid gap-3 rounded-2xl bg-[var(--surface-soft)] p-3 text-sm font-semibold text-[var(--muted-foreground)] sm:grid-cols-5">
                  <span>Sevk: <strong className="text-[var(--brand-primary-strong)]">{selectedOrderItem.shipped_qty ?? "-"}</strong></span>
                  <span>Önceki iade/ariza: <strong className="text-[var(--brand-primary-strong)]">{selectedOrderItem.returned_quantity ?? 0}</strong></span>
                  <span>Birim: <strong className="text-[var(--brand-primary-strong)]">{formatCurrency(selectedOrderItem.unit_net_price, selectedOrderItem.currency)}</strong></span>
                  <span>Toplam: <strong className="text-[var(--brand-primary-strong)]">{formatCurrency(selectedOrderItem.line_total, selectedOrderItem.currency)}</strong></span>
                  <span>Logo stok: <strong className="text-[var(--brand-primary-strong)]">{selectedOrderItem.logo_stock?.erzurum_depo_available_total ?? selectedOrderItem.logo_stock?.available_total ?? "-"}</strong></span>
                </div>
              </div>
            ) : (
              <div className="rounded-3xl border border-[var(--brand-border)] bg-[var(--surface)] p-5 text-sm font-semibold text-[var(--muted-foreground)]">
                {orderOptions.length > 0 ? "Ürün seçin." : "İade için uygun sipariş bulunamadı."}
              </div>
            )}

            <div className="grid gap-4 md:grid-cols-[180px_minmax(220px,280px)_1fr]">
              <div className="space-y-2">
                <label className="text-sm font-bold text-[var(--brand-primary-strong)]">Adet</label>
                <Input
                  className={FIELD_CLASSNAME}
                  type="number"
                  min={selectedOrderItem && (selectedOrderItem.returnable_quantity ?? selectedOrderItem.quantity) <= 0 ? 0 : 1}
                  max={selectedOrderItem?.returnable_quantity ?? selectedOrderItem?.quantity ?? 1}
                  value={resolvedQuantity}
                  onChange={(event) => setQuantity(event.target.value)}
                  disabled={Boolean(selectedOrderItem) && (selectedOrderItem.returnable_quantity ?? selectedOrderItem.quantity) <= 0}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-bold text-[var(--brand-primary-strong)]">Neden</label>
                <Select value={resolvedReasonCode} onValueChange={setReasonCode}>
                  <SelectTrigger className={FIELD_CLASSNAME}>
                    <SelectValue placeholder="Neden seçin" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableReasons.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-bold text-[var(--brand-primary-strong)]">Açıklama</label>
                <Textarea
                  className={FIELD_CLASSNAME + " min-h-[96px]"}
                  value={reasonNote}
                  onChange={(event) => setReasonNote(event.target.value)}
                  placeholder="Kısa açıklama"
                />
              </div>
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" className="border-[var(--brand-border)] bg-[var(--surface)]" onClick={handleReset}>
                Temizle
              </Button>
              <Button
                type="button"
                className="rounded-[16px] bg-[linear-gradient(135deg,#ff5b5b_0%,#dc2626_48%,#991b1b_100%)] px-7 font-black text-white shadow-[0_18px_40px_-24px_rgba(239,68,68,0.95)] hover:brightness-110"
                onClick={handleSubmit}
                disabled={
                  requestMutation.isPending ||
                  !selectedOrderItem ||
                  (selectedOrderItem.returnable_quantity ?? selectedOrderItem.quantity) <= 0
                }
              >
                {requestMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />}
                Gönder
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className={SHELL_CARD_CLASSNAME}>
          <CardContent className="space-y-4 p-4 sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <RefreshCcw className="h-5 w-5 text-[var(--brand-primary)]" />
                <h2 className="text-xl font-extrabold text-[var(--brand-primary-strong)]">Talepler</h2>
                <Badge className="border-[var(--brand-border)] bg-[var(--surface-soft)] text-[var(--brand-primary-strong)]">
                  {toCount(totalCount)}
                </Badge>
              </div>
              <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as RequestListFilter)}>
                <SelectTrigger className={FIELD_CLASSNAME + " w-full sm:w-[170px]"}>
                  <SelectValue placeholder="Durum" />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-3">
            {returnRequestsQuery.isLoading ? (
              Array.from({ length: 4 }).map((_, index) => (
                <div
                  key={`return-request-skeleton-${index}`}
                  className="rounded-2xl bg-[var(--surface-soft)] p-4"
                >
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="mt-2 h-3 w-24" />
                  <Skeleton className="mt-4 h-3 w-full" />
                </div>
              ))
            ) : requestRows.length > 0 ? (
              requestRows.map((row) => (
                <div
                  key={row.id}
                  className="rounded-3xl border border-[var(--brand-border)] bg-[var(--surface)] p-4 shadow-[0_14px_26px_-24px_rgba(0,0,0,0.18)]"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-lg font-extrabold text-[var(--brand-primary-strong)]">
                        {row.product?.name ?? "-"}
                      </p>
                      <p className="mt-1 text-sm font-semibold text-[var(--muted-foreground)]">{row.product?.sku ?? "-"}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <RequestTypeBadge requestType={row.request_type} />
                      <RequestStatusBadge status={row.status} />
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-4">
                    <div className="rounded-2xl bg-[var(--surface-soft)] p-3">
                      <p className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">Adet</p>
                      <p className="mt-1 text-xl font-extrabold text-[var(--brand-primary-strong)]">{row.quantity}</p>
                    </div>
                    <div className="rounded-2xl bg-[var(--surface-soft)] p-3">
                      <p className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">Tutar</p>
                      <p className="mt-1 text-xl font-extrabold text-[var(--brand-primary-strong)]">
                        {formatCurrency(row.line_total, row.currency)}
                      </p>
                    </div>
                    <div className="rounded-2xl bg-[var(--surface-soft)] p-3">
                      <p className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">Tarih</p>
                      <p className="mt-1 text-sm font-bold text-[var(--brand-primary-strong)]">{formatDate(row.created_at)}</p>
                    </div>
                  </div>

                  <div className="mt-3 grid gap-3">
                    {isScrapRequest(row.request_type) ? (
                      row.scrap_logo_sync_status ? (
                      <LogoSyncInline
                        className="rounded-2xl bg-orange-50 p-3"
                        label="Logo Fire Fişi"
                        status={row.scrap_logo_sync_status}
                        error={row.scrap_logo_sync_error}
                        externalRef={row.scrap_logo_external_ref}
                        lastSyncedAt={row.scrap_logo_last_synced_at}
                      />
                      ) : (
                        <LogoApprovalWaitNotice label="Logo Fire Fişi" />
                      )
                    ) : row.logo_sync_status ? (
                      <LogoSyncInline
                        className="rounded-2xl bg-[var(--surface-soft)] p-3"
                        label="Logo İade"
                        status={row.logo_sync_status}
                        error={row.logo_sync_error}
                        externalRef={row.logo_external_ref}
                        lastSyncedAt={row.logo_last_synced_at}
                      />
                    ) : (
                      <LogoApprovalWaitNotice label="Logo İade" />
                    )}
                  </div>

                  {row.resolution_note?.trim() ? (
                    <div className="mt-3 rounded-xl bg-emerald-50 px-3 py-2.5">
                      <p className="mt-1 text-sm text-emerald-900">{row.resolution_note}</p>
                    </div>
                  ) : null}

                  {canReviewReturns && REVIEW_ACTIONS[(row.status as ReturnWorkflowStatus)]?.length ? (
                    <div className="mt-3 flex flex-wrap gap-2 pt-3">
                      {REVIEW_ACTIONS[row.status as ReturnWorkflowStatus].map((action) => {
                        const isBusy =
                          statusMutation.isPending &&
                          statusMutation.variables?.returnRequestId === row.id &&
                          statusMutation.variables?.status === action.status;

                        return (
                          <Button
                            key={`${row.id}-${action.status}`}
                            type="button"
                            size="sm"
                            variant={action.variant}
                            disabled={statusMutation.isPending}
                            onClick={() =>
                              statusMutation.mutate({
                                returnRequestId: row.id,
                                status: action.status,
                                resolutionNote: getDefaultResolutionNote(action.status),
                              })
                            }
                          >
                            {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                            {action.label}
                          </Button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ))
            ) : (
              <div className="rounded-3xl bg-[var(--surface)] px-6 py-12 text-center">
                <p className="text-lg font-extrabold text-[var(--brand-primary-strong)]">Kayıt yok</p>
              </div>
            )}
            </div>

            {requestRows.length > 0 || hasPreviousRequestPage || hasNextRequestPage ? (
              <div className="flex flex-col gap-2 rounded-2xl border border-[var(--brand-border)] bg-[var(--surface-soft)] p-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-sm font-bold text-[var(--muted-foreground)]">
                  Sayfa {toCount(requestPageNumber)} · Bu sayfada {toCount(requestRows.length)} talep
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="border-[var(--brand-border)] bg-[var(--surface)]"
                    disabled={!hasPreviousRequestPage || returnRequestsQuery.isFetching}
                    onClick={handlePreviousRequestPage}
                  >
                    Önceki
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="bg-[var(--brand-primary)] text-[var(--primary-foreground)] hover:opacity-95"
                    disabled={!hasNextRequestPage || returnRequestsQuery.isFetching}
                    onClick={handleNextRequestPage}
                  >
                    Sonraki
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
