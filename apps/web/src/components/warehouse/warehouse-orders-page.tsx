"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  Loader2,
  PackageSearch,
  Printer,
  RefreshCcw,
  Save,
  Search,
  Truck,
  UserRound,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  ApiClientError,
  createWarehouseShipment,
  getOrderDetail,
  listWarehouseStaff,
  listWarehouseReadyOrders,
  updateWarehouseOrderItem,
  type WarehouseReadyOrderItem,
} from "@/lib/api";
import { printPageInPlace } from "@/lib/print-page";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

const PAGE_LIMIT = 25;
const DEFAULT_WAREHOUSE_CODE = "1";
const DEFAULT_WAREHOUSE_NAME = "Varsayılan depo";
const WAREHOUSE_TABLE_ACTION_CLASSNAME =
  "h-8 min-w-0 flex-1 justify-center rounded-md px-1.5 text-[10px] font-extrabold shadow-[0_10px_18px_-18px_rgba(0,0,0,0.55)]";
const WAREHOUSE_DETAIL_ACTION_CLASSNAME =
  "h-8 justify-center rounded-md border-amber-200/55 [background:linear-gradient(135deg,#fff8db_0%,#f7c948_55%,#b76e00_100%)] px-2 text-[10px] font-extrabold text-[#231500] shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_12px_20px_-20px_rgba(183,110,0,0.9)] hover:-translate-y-0.5 hover:border-amber-100/80 hover:brightness-105";
const WAREHOUSE_PRINT_ACTION_CLASSNAME =
  "border-sky-200/45 [background:linear-gradient(135deg,#e8f7ff_0%,#8dd3f7_48%,#2376ac_100%)] text-[#041725] shadow-[inset_0_1px_0_rgba(255,255,255,0.48),0_22px_42px_-28px_rgba(35,118,172,0.9)] hover:-translate-y-0.5 hover:border-sky-100/75 hover:brightness-105";
const WAREHOUSE_PRIMARY_ACTION_CLASSNAME =
  "border-emerald-200/40 [background:linear-gradient(135deg,#f3f7df_0%,#b9d2bd_42%,#7faa8c_100%)] text-[#07140d] shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_24px_46px_-28px_rgba(139,194,150,0.85)] hover:-translate-y-0.5 hover:border-emerald-100/70 hover:brightness-105";
const WAREHOUSE_TAG_CLASSNAME =
  "inline-flex h-6 max-w-full items-center justify-center rounded-md border px-1.5 text-[9px] font-black uppercase tracking-[0.04em]";

type SalespersonFilterOption = {
  id: string;
  name: string;
  count: number;
};

type ShipmentWarehouseChoice = {
  warehouse_id?: number;
  warehouse_code?: string;
  warehouse_name?: string;
};

type WarehouseStaffChoice = {
  id: number;
  name: string;
  email?: string | null;
  phone?: string | null;
};

function toNumberOrUndefined(value: string): number | undefined {
  if (!value.trim()) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function formatMoney(value: string | number | null | undefined, currency?: string | null): string {
  const amount = Number(value ?? 0);
  const resolvedCurrency = typeof currency === "string" && currency.trim() ? currency : "TRY";

  if (!Number.isFinite(amount)) {
    return "-";
  }

  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: resolvedCurrency,
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

function toDisplayText(value: unknown, fallback = "-"): string {
  if (typeof value === "string") {
    return value.trim() || fallback;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : fallback;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return toDisplayText(record.name ?? record.title ?? record.code ?? record.label, fallback);
  }

  return fallback;
}

function toSafeNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "string" ? Number(value.replace(",", ".")) : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildSalespersonOptions(orders: WarehouseReadyOrderItem[]): SalespersonFilterOption[] {
  const options = new Map<string, SalespersonFilterOption>();
  const seenOrders = new Set<string>();

  orders.forEach((order) => {
    const salespersonId = order.salesperson?.id;
    if (typeof salespersonId !== "number" || salespersonId <= 0) {
      return;
    }

    const id = String(salespersonId);
    const seenKey = `${id}:${order.id}`;
    if (seenOrders.has(seenKey)) {
      return;
    }

    seenOrders.add(seenKey);
    const current = options.get(id);
    if (current) {
      current.count += 1;
      return;
    }

    options.set(id, {
      id,
      name: toDisplayText(order.salesperson?.name, `Plasiyer #${id}`),
      count: 1,
    });
  });

  return Array.from(options.values()).sort((first, second) =>
    first.name.localeCompare(second.name, "tr")
  );
}

function countUniqueCustomers(orders: WarehouseReadyOrderItem[]): number {
  const customerKeys = new Set<string>();

  orders.forEach((order) => {
    const customerId = order.customer?.id;
    const fallbackKey = order.customer?.code ?? order.customer?.title;

    if (typeof customerId === "number" && customerId > 0) {
      customerKeys.add(`id:${customerId}`);
      return;
    }

    if (fallbackKey && fallbackKey.trim()) {
      customerKeys.add(`key:${fallbackKey.trim()}`);
    }
  });

  return customerKeys.size;
}

function normalizeWarehouseIdentity(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLocaleUpperCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "");
}

function preferredWarehouseForStaff(staffUser: WarehouseStaffChoice | null): ShipmentWarehouseChoice | null {
  const identity = normalizeWarehouseIdentity([staffUser?.name, staffUser?.email].filter(Boolean).join(" "));

  if (!identity) {
    return null;
  }

  const choices: Array<ShipmentWarehouseChoice & { needles: string[] }> = [
    { warehouse_code: "0", warehouse_name: "ERZURUM POINT", needles: ["ERZURUMPOINT", "ERZPOINT"] },
    { warehouse_code: "1", warehouse_name: "ERZURUM DEPO", needles: ["ERZURUMDEPO", "ERZDEPO"] },
    { warehouse_code: "2", warehouse_name: "TRABZON DEPO", needles: ["TRABZONDEPO"] },
    { warehouse_code: "3", warehouse_name: "SAMSUN DEPO", needles: ["SAMSUNDEPO"] },
    { warehouse_code: "4", warehouse_name: "BATUM DEPO", needles: ["BATUMDEPO"] },
  ];

  return choices.find((choice) => choice.needles.some((needle) => identity.includes(needle))) ?? null;
}

function checkoutSummaryBadge(order: WarehouseReadyOrderItem): { code: string; label: string } | null {
  const summary = order.origin?.checkout_summary;
  const code = typeof summary?.code === "string" ? summary.code.trim() : "";
  const label = typeof summary?.label === "string" ? summary.label.trim() : "";

  if (!code) {
    return null;
  }

  return { code, label: label || code };
}

function isCargoOrder(order: WarehouseReadyOrderItem): boolean {
  const source = [order.origin?.shipping_method, order.origin?.note]
    .filter(Boolean)
    .join(" ")
    .toLocaleUpperCase("tr-TR");

  return source.includes("KARGO") || source.includes("CARGO");
}

function resolveOrderRegion(order: WarehouseReadyOrderItem): string {
  const preferred =
    order.logo_warehouse_options?.find((warehouse) => warehouse.warehouse_code === order.preferred_warehouse_code)
    ?? order.logo_warehouse_options?.find((warehouse) => warehouse.missing_quantity === 0)
    ?? order.logo_warehouse_options?.[0];

  return toDisplayText(preferred?.warehouse_name ?? order.origin?.panel_label, "Bölge yok");
}

function resolveShipmentWarehouseChoice(
  order: WarehouseReadyOrderItem | null,
  staffUser: WarehouseStaffChoice | null
): ShipmentWarehouseChoice {
  const staffWarehouse = preferredWarehouseForStaff(staffUser);

  if (staffWarehouse?.warehouse_code) {
    const warehouseOption = order?.logo_warehouse_options?.find(
      (warehouse) => warehouse.warehouse_code === staffWarehouse.warehouse_code
    );

    return {
      ...(warehouseOption?.warehouse_id ? { warehouse_id: warehouseOption.warehouse_id } : {}),
      warehouse_code: staffWarehouse.warehouse_code,
      warehouse_name: staffWarehouse.warehouse_name,
    };
  }

  const warehouseOption =
    order?.logo_warehouse_options?.find(
      (warehouse) =>
        order.preferred_warehouse_code !== null
        && order.preferred_warehouse_code !== undefined
        && warehouse.warehouse_code === order.preferred_warehouse_code
    )
    ?? order?.logo_warehouse_options?.find((warehouse) => warehouse.missing_quantity === 0)
    ?? order?.logo_warehouse_options?.[0];

  if (warehouseOption) {
    return {
      ...(warehouseOption.warehouse_id ? { warehouse_id: warehouseOption.warehouse_id } : {}),
      ...(warehouseOption.warehouse_code ? { warehouse_code: warehouseOption.warehouse_code } : {}),
      warehouse_name: warehouseOption.warehouse_name,
    };
  }

  return { warehouse_code: DEFAULT_WAREHOUSE_CODE, warehouse_name: DEFAULT_WAREHOUSE_NAME };
}

function buildPaginationKey(params: {
  q: string;
  dateFrom: string;
  dateTo: string;
  salespersonId: string;
}): string {
  return [params.q, params.dateFrom, params.dateTo, params.salespersonId].join("|");
}

export function WarehouseOrdersPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [selectedSalespersonId, setSelectedSalespersonId] = useState("");
  const [detailOrderPreview, setDetailOrderPreview] = useState<WarehouseReadyOrderItem | null>(null);
  const [detailQuantityDrafts, setDetailQuantityDrafts] = useState<Record<number, string>>({});
  const [shipmentOrder, setShipmentOrder] = useState<WarehouseReadyOrderItem | null>(null);
  const [selectedWarehouseStaffId, setSelectedWarehouseStaffId] = useState("");
  const [paginationByKey, setPaginationByKey] = useState<
    Record<string, { cursor?: string; history: string[] }>
  >({});

  const debouncedQuery = useDebouncedValue(query, 400);
  const detailOrderId = detailOrderPreview?.id ?? null;

  const paginationKey = useMemo(
    () =>
      buildPaginationKey({
        q: debouncedQuery,
        dateFrom,
        dateTo,
        salespersonId: selectedSalespersonId,
      }),
    [debouncedQuery, dateFrom, dateTo, selectedSalespersonId]
  );

  const currentPagination = paginationByKey[paginationKey] ?? { cursor: undefined, history: [] };

  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  const readyOrdersQuery = useQuery({
    queryKey: [
      "warehouse",
      "ready-orders",
      {
        q: debouncedQuery,
        dateFrom,
        dateTo,
        salespersonId: selectedSalespersonId,
        cursor: currentPagination.cursor ?? null,
      },
    ],
    refetchInterval: 15_000,
    queryFn: () =>
      listWarehouseReadyOrders({
        q: debouncedQuery || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        salesperson_user_id: toNumberOrUndefined(selectedSalespersonId),
        cursor: currentPagination.cursor,
        limit: PAGE_LIMIT,
      }),
    placeholderData: (previous) => previous,
  });

  const salespersonOptionsQuery = useQuery({
    queryKey: [
      "warehouse",
      "ready-order-salespeople",
      {
        q: debouncedQuery,
        dateFrom,
        dateTo,
      },
    ],
    queryFn: () =>
      listWarehouseReadyOrders({
        q: debouncedQuery || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        limit: 50,
      }),
    placeholderData: (previous) => previous,
    staleTime: 30_000,
  });

  const orderDetailQuery = useQuery({
    queryKey: ["warehouse", "order-detail-modal", detailOrderId],
    queryFn: () => getOrderDetail(detailOrderId as number),
    enabled: detailOrderId !== null,
    staleTime: 60_000,
  });

  const warehouseStaffQuery = useQuery({
    queryKey: ["warehouse", "staff"],
    queryFn: listWarehouseStaff,
    staleTime: 60_000,
  });

  const rows = useMemo(() => readyOrdersQuery.data?.data ?? [], [readyOrdersQuery.data?.data]);
  const warehouseStaff = useMemo(() => warehouseStaffQuery.data?.data ?? [], [warehouseStaffQuery.data?.data]);
  const detailOrder = orderDetailQuery.data?.order;
  const detailItems = useMemo(
    () => (Array.isArray(detailOrder?.items) ? detailOrder.items : []),
    [detailOrder?.items]
  );
  const detailTotalQuantity = useMemo(
    () => detailItems.reduce((total, item) => total + toSafeNumber(item.quantity), 0),
    [detailItems]
  );
  const effectiveSelectedWarehouseStaffId =
    selectedWarehouseStaffId || (shipmentOrder && warehouseStaff[0] ? String(warehouseStaff[0].id) : "");
  const selectedWarehouseStaff = useMemo(
    () => warehouseStaff.find((staffUser) => String(staffUser.id) === effectiveSelectedWarehouseStaffId) ?? null,
    [effectiveSelectedWarehouseStaffId, warehouseStaff]
  );
  const warehouseStaffGroups = useMemo(() => {
    const groups = new Map<string, { title: string; staff: WarehouseStaffChoice[] }>();

    warehouseStaff.forEach((staffUser) => {
      const warehouse = preferredWarehouseForStaff(staffUser);
      const key = warehouse?.warehouse_code ?? "general";
      const title = warehouse?.warehouse_name ?? "GENEL DEPO";
      const current = groups.get(key);

      if (current) {
        current.staff.push(staffUser);
        return;
      }

      groups.set(key, { title, staff: [staffUser] });
    });

    return Array.from(groups.values()).sort((first, second) => first.title.localeCompare(second.title, "tr"));
  }, [warehouseStaff]);
  const shipmentWarehouseChoice = useMemo(
    () => resolveShipmentWarehouseChoice(shipmentOrder, selectedWarehouseStaff),
    [selectedWarehouseStaff, shipmentOrder]
  );
  const salespersonSourceRows = useMemo(
    () => [...(salespersonOptionsQuery.data?.data ?? []), ...rows],
    [rows, salespersonOptionsQuery.data?.data]
  );
  const salespersonOptions = useMemo(
    () => buildSalespersonOptions(salespersonSourceRows),
    [salespersonSourceRows]
  );
  const selectedSalespersonName = useMemo(
    () => salespersonOptions.find((option) => option.id === selectedSalespersonId)?.name ?? null,
    [salespersonOptions, selectedSalespersonId]
  );
  const listedCustomerCount = useMemo(() => countUniqueCustomers(rows), [rows]);
  const activeFilterCount =
    Number(Boolean(query.trim())) +
    Number(Boolean(dateFrom)) +
    Number(Boolean(dateTo)) +
    Number(Boolean(selectedSalespersonId));

  const onNextPage = () => {
    const nextCursor = readyOrdersQuery.data?.next_cursor;
    if (!nextCursor) {
      return;
    }

    setPaginationByKey((previous) => {
      const active = previous[paginationKey] ?? { cursor: undefined, history: [] };
      return {
        ...previous,
        [paginationKey]: {
          cursor: nextCursor,
          history: [...active.history, active.cursor ?? ""],
        },
      };
    });
  };

  const onPreviousPage = () => {
    setPaginationByKey((previous) => {
      const active = previous[paginationKey] ?? { cursor: undefined, history: [] };
      if (active.history.length === 0) {
        return previous;
      }

      const nextHistory = [...active.history];
      const previousCursor = nextHistory.pop() ?? "";

      return {
        ...previous,
        [paginationKey]: {
          cursor: previousCursor || undefined,
          history: nextHistory,
        },
      };
    });
  };

  const onRefresh = () => {
    void readyOrdersQuery.refetch();
  };

  const clearFilters = () => {
    setQuery("");
    setDateFrom("");
    setDateTo("");
    setSelectedSalespersonId("");
  };

  const openOrderDetail = (order: WarehouseReadyOrderItem) => {
    setDetailQuantityDrafts({});
    setDetailOrderPreview(order);
  };

  const closeOrderDetail = () => {
    setDetailQuantityDrafts({});
    setDetailOrderPreview(null);
  };

  const hasActiveFilters = Boolean(
    query.trim() || dateFrom || dateTo || selectedSalespersonId
  );

  const updateOrderItemMutation = useMutation({
    mutationFn: async (payload: { orderId: number; itemId: number; quantity: number }) =>
      updateWarehouseOrderItem(payload.orderId, payload.itemId, { quantity: payload.quantity }),
    onSuccess: (response, variables) => {
      queryClient.setQueryData(["warehouse", "order-detail-modal", response.order.id], response);
      setDetailQuantityDrafts((previous) => {
        const nextDrafts = { ...previous };
        delete nextDrafts[variables.itemId];

        return nextDrafts;
      });
      void queryClient.invalidateQueries({ queryKey: ["warehouse", "ready-orders"] });
      void queryClient.invalidateQueries({ queryKey: ["warehouse", "ready-order-salespeople"] });
      toast.success("Sipariş adeti güncellendi");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Sipariş adeti güncellenemedi.");
    },
  });

  const setDetailQuantityDraft = (itemId: number, value: string) => {
    const numericValue = value.replace(/\D/g, "");

    setDetailQuantityDrafts((previous) => ({
      ...previous,
      [itemId]: numericValue,
    }));
  };

  const commitDetailQuantityDraft = (itemId: number, currentQuantity: number) => {
    if (!detailOrder) {
      return;
    }

    const draftValue = detailQuantityDrafts[itemId];
    const parsedQuantity = Number.parseInt(draftValue ?? "", 10);

    if (!Number.isFinite(parsedQuantity) || parsedQuantity < 1) {
      setDetailQuantityDrafts((previous) => ({
        ...previous,
        [itemId]: String(currentQuantity),
      }));
      return;
    }

    if (parsedQuantity === currentQuantity) {
      return;
    }

    updateOrderItemMutation.mutate({
      orderId: detailOrder.id,
      itemId,
      quantity: parsedQuantity,
    });
  };

  const createShipmentMutation = useMutation({
    mutationFn: async () => {
      if (!shipmentOrder) {
        throw new Error("Sevkiyat başlatılacak sipariş seçilmedi.");
      }

      const assignedUserId = Number(effectiveSelectedWarehouseStaffId);
      if (!Number.isFinite(assignedUserId) || assignedUserId <= 0) {
        throw new Error("Depocu seçimi zorunlu.");
      }

      const payload = {
        order_id: shipmentOrder.id,
        ...shipmentWarehouseChoice,
        assigned_user_id: assignedUserId,
      };

      try {
        return await createWarehouseShipment(payload);
      } catch (error) {
        const assignedUserMessages =
          error instanceof ApiClientError ? error.payload?.errors?.assigned_user_id ?? [] : [];
        const warehouseMessages =
          error instanceof ApiClientError ? error.payload?.errors?.warehouse_id ?? [] : [];
        const shouldRetryWithoutAssignedUser =
          error instanceof ApiClientError &&
          error.status === 422 &&
          (error.message === "validation.exists" || assignedUserMessages.includes("validation.exists"));
        const shouldRetryWithoutWarehouseId =
          error instanceof ApiClientError &&
          error.status === 422 &&
          Boolean(payload.warehouse_id) &&
          (error.message === "validation.exists" ||
            warehouseMessages.some((message) => message.includes("Depo bulunamadi")));

        if (!shouldRetryWithoutAssignedUser && !shouldRetryWithoutWarehouseId) {
          throw error;
        }

        const retryPayload: Parameters<typeof createWarehouseShipment>[0] = { ...payload };
        if (shouldRetryWithoutAssignedUser) {
          delete retryPayload.assigned_user_id;
        }
        if (shouldRetryWithoutWarehouseId) {
          delete retryPayload.warehouse_id;
          retryPayload.warehouse_code = retryPayload.warehouse_code ?? DEFAULT_WAREHOUSE_CODE;
          retryPayload.warehouse_name = retryPayload.warehouse_name ?? DEFAULT_WAREHOUSE_NAME;
        }
        return createWarehouseShipment(retryPayload);
      }
    },
    onSuccess: (response) => {
      const shipmentId = response.data.shipment.id;
      const staffName = selectedWarehouseStaff?.name ?? "Depocu";
      toast.success(`${staffName} için sevkiyat başlatıldı`);
      setShipmentOrder(null);
      setSelectedWarehouseStaffId("");
      router.push(`/warehouse/shipments/${shipmentId}`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Sevkiyat başlatılamadı.");
    },
  });

  const openShipment = (order: WarehouseReadyOrderItem) => {
    if (order.shipment?.id) {
      router.push(`/warehouse/shipments/${order.shipment.id}`);
      return;
    }

    setShipmentOrder(order);
    setSelectedWarehouseStaffId(warehouseStaff[0] ? String(warehouseStaff[0].id) : "");
  };

  return (
    <div className="space-y-4">
      <Card className="md:sticky md:top-24 md:z-20">
        <CardContent className="space-y-2.5 py-3">
          <div className="rounded-xl border border-[var(--brand-border)]/70 bg-[color-mix(in_oklab,var(--surface)_58%,transparent)] px-2.5 py-2">
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1 xl:pb-0">
                <Button
                  type="button"
                  variant={selectedSalespersonId === "" ? "default" : "outline"}
                  className={cn(
                    "h-10 min-w-[132px] shrink-0 rounded-lg px-3 text-xs font-black",
                    selectedSalespersonId === ""
                      ? "border-[#2f7f56] bg-[#2f7f56] text-white shadow-[0_10px_20px_-18px_rgba(47,127,86,0.9)] hover:bg-[#276d49] hover:text-white"
                      : "border-[var(--brand-border)] bg-[var(--surface)] text-[var(--foreground)] hover:border-[var(--brand-primary)] hover:bg-[var(--surface-soft)]"
                  )}
                  onClick={() => setSelectedSalespersonId("")}
                >
                  <UserRound className="h-3.5 w-3.5" />
                  <span className="whitespace-nowrap">Tüm Plasiyer</span>
                </Button>
                {salespersonOptions.map((salesperson) => {
                  const active = selectedSalespersonId === salesperson.id;

                  return (
                    <Button
                      key={salesperson.id}
                      type="button"
                      variant={active ? "default" : "outline"}
                      className={cn(
                        "h-10 min-w-[190px] shrink-0 rounded-lg px-3 text-xs font-black",
                        active
                          ? "border-[#2f7f56] bg-[#2f7f56] text-white shadow-[0_10px_20px_-18px_rgba(47,127,86,0.9)] hover:bg-[#276d49] hover:text-white"
                          : "border-[var(--brand-border)] bg-[var(--surface)] text-[var(--foreground)] hover:border-[var(--brand-primary)] hover:bg-[var(--surface-soft)]"
                      )}
                      onClick={() => setSelectedSalespersonId(salesperson.id)}
                    >
                      <UserRound className="h-3.5 w-3.5 shrink-0" />
                      <span className="max-w-[128px] truncate">{salesperson.name}</span>
                      <span className="ml-auto rounded-full bg-black/10 px-1.5 py-0.5 text-[10px] font-black">
                        {salesperson.count}
                      </span>
                    </Button>
                  );
                })}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2 xl:justify-end">
                <Badge className="h-8 border border-emerald-200 bg-emerald-50 px-2.5 text-xs font-black text-emerald-700">
                  {rows.length} sipariş
                </Badge>
                <Badge className="h-8 border border-sky-200 bg-sky-50 px-2.5 text-xs font-black text-sky-700">
                  {listedCustomerCount} müşteri
                </Badge>
                {salespersonOptionsQuery.isFetching ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--brand-primary)]" />
                ) : null}
              </div>
            </div>
          </div>

          <div className="grid gap-2 lg:grid-cols-[minmax(300px,1fr)_150px_150px_112px] lg:items-end">
            <div className="space-y-1">
              <div className="relative">
                <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
                <Input
                  ref={searchInputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  autoFocus
                  placeholder="Barkod okut / sipariş no / cari kod / cari ünvan"
                  className="h-11 rounded-xl pl-11 text-sm font-bold"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Input className="h-11 rounded-xl text-sm" type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
            </div>
            <div className="space-y-1">
              <Input className="h-11 rounded-xl text-sm" type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
            </div>
            <Button className="h-11 rounded-xl text-sm font-extrabold" onClick={onRefresh} disabled={readyOrdersQuery.isFetching}>
              {readyOrdersQuery.isFetching ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCcw className="h-4 w-4" />
              )}
              Yenile
            </Button>
          </div>

          {hasActiveFilters ? (
            <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-[var(--surface-soft)] px-3 py-2">
              <p className="text-sm font-semibold text-[var(--muted-foreground)]">
                Aktif Filtre: {activeFilterCount}
              </p>
              {query.trim() ? (
                <Badge variant="secondary" className="gap-1">
                  {query.trim()}
                  <button type="button" onClick={() => setQuery("")} aria-label="Clear query">
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ) : null}
              {dateFrom ? (
                <Badge variant="secondary" className="gap-1">
                  Başlangıç: {dateFrom}
                  <button type="button" onClick={() => setDateFrom("")} aria-label="Clear date from">
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ) : null}
              {dateTo ? (
                <Badge variant="secondary" className="gap-1">
                  Bitiş: {dateTo}
                  <button type="button" onClick={() => setDateTo("")} aria-label="Clear date to">
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ) : null}
              {selectedSalespersonId ? (
                <Badge variant="secondary" className="gap-1">
                  Plasiyer: {selectedSalespersonName ?? selectedSalespersonId}
                  <button type="button" onClick={() => setSelectedSalespersonId("")} aria-label="Clear salesperson">
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ) : null}
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Temizle
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="overflow-hidden bg-[var(--surface)] shadow-[0_22px_46px_-38px_rgba(10,32,20,0.32)] md:rounded-[22px]">
            <div className="space-y-3 p-3 lg:hidden">
              {readyOrdersQuery.isLoading ? (
                Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={`warehouse-mobile-skeleton-${index}`} className="h-40 rounded-2xl" />
                ))
              ) : null}

              {readyOrdersQuery.isError ? (
                <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700">
                  {readyOrdersQuery.error instanceof Error ? readyOrdersQuery.error.message : "Depo siparişleri alınamadı."}
                </div>
              ) : null}

              {!readyOrdersQuery.isLoading && !readyOrdersQuery.isError && rows.length === 0 ? (
                <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--surface-soft)] p-5 text-center text-[var(--muted-foreground)]">
                  <PackageSearch className="mx-auto h-9 w-9 text-[var(--brand-primary)]" />
                  <p className="mt-3 text-sm font-black">Sipariş yok</p>
                  {hasActiveFilters ? (
                    <Button variant="outline" size="sm" className="mt-3" onClick={clearFilters}>
                      Filtreleri Temizle
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {!readyOrdersQuery.isLoading &&
                !readyOrdersQuery.isError &&
                rows.map((order: WarehouseReadyOrderItem) => {
                  const totalQuantity = toSafeNumber(order.items_summary?.total_quantity);
                  const itemCount = toSafeNumber(order.items_summary?.item_count);
                  const checkoutBadge = checkoutSummaryBadge(order);
                  const cargoOrder = isCargoOrder(order);
                  const region = resolveOrderRegion(order);

                  return (
                    <article
                      key={`warehouse-mobile-order-${order.id}`}
                      className="rounded-2xl border border-[var(--brand-border)] bg-[var(--surface)] p-3 shadow-[0_16px_36px_-30px_rgba(10,32,20,0.45)]"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-black text-[var(--brand-primary-strong)]">
                            {toDisplayText(order.order_no)}
                          </p>
                          <p className="mt-1 text-xs font-bold text-[var(--muted-foreground)]">
                            {itemCount} kalem · {totalQuantity} adet
                          </p>
                          <div className="mt-2 flex flex-wrap gap-1">
                            <span className={cn(WAREHOUSE_TAG_CLASSNAME, "border-emerald-200/70 bg-emerald-50 text-emerald-800")}>
                              {region}
                            </span>
                            {checkoutBadge ? (
                              <span
                                title={checkoutBadge.label}
                                className={cn(WAREHOUSE_TAG_CLASSNAME, "border-amber-200/80 bg-amber-50 text-amber-800")}
                              >
                                {checkoutBadge.code}
                              </span>
                            ) : null}
                            {cargoOrder ? (
                              <span className={cn(WAREHOUSE_TAG_CLASSNAME, "border-rose-200/80 bg-rose-50 text-rose-800")}>
                                KARGO
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <span className="shrink-0 rounded-lg border border-[#c7ddd1] bg-[#eef8f1] px-2 py-1 text-xs font-black text-[#1f6a43]">
                          {formatMoney(order.grand_total, order.currency)}
                        </span>
                      </div>

                      <div className="mt-3 grid gap-2 rounded-xl bg-[var(--surface-soft)] p-3 text-xs">
                        <div>
                          <p className="font-black text-[var(--foreground)]">{toDisplayText(order.customer?.title)}</p>
                          <p className="mt-0.5 font-bold text-[var(--muted-foreground)]">{toDisplayText(order.customer?.code)}</p>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <p className="text-[10px] font-black uppercase text-[var(--muted-foreground)]">Plasiyer</p>
                            <p className="truncate font-bold text-[var(--foreground)]">{toDisplayText(order.salesperson?.name, "Atanmamış")}</p>
                          </div>
                          <div>
                            <p className="text-[10px] font-black uppercase text-[var(--muted-foreground)]">Tarih</p>
                            <p className="font-bold text-[var(--foreground)]">{formatDate(order.approved_at)}</p>
                          </div>
                        </div>
                      </div>

                      <div className="mt-3 grid grid-cols-3 gap-2">
                        <Button
                          type="button"
                          className={cn(WAREHOUSE_DETAIL_ACTION_CLASSNAME, "h-10 px-2 text-[11px]")}
                          onClick={() => openOrderDetail(order)}
                        >
                          <Eye className="h-4 w-4 shrink-0" />
                          Detay
                        </Button>
                        <Button
                          className={cn(WAREHOUSE_TABLE_ACTION_CLASSNAME, WAREHOUSE_PRINT_ACTION_CLASSNAME, "h-10 px-2 text-[11px]")}
                          onClick={() => printPageInPlace(`/warehouse/orders/${order.id}/print`)}
                        >
                          <Printer className="h-4 w-4 shrink-0" />
                          Form
                        </Button>
                        <Button
                          className={cn(WAREHOUSE_TABLE_ACTION_CLASSNAME, WAREHOUSE_PRIMARY_ACTION_CLASSNAME, "h-10 px-2 text-[11px]")}
                          onClick={() => openShipment(order)}
                        >
                          <Truck className="h-4 w-4 shrink-0" />
                          {order.shipment?.id ? "Sevkiyatı Aç" : "Sevkiyat"}
                        </Button>
                      </div>
                    </article>
                  );
                })}
            </div>

            <div className="hidden overflow-hidden px-2 pb-1 pt-2 lg:block lg:px-3">
              <Table className="min-w-0 table-fixed text-[11px]">
                <colgroup>
                  <col className="w-[6%]" />
                  <col className="w-[12%]" />
                  <col className="w-[24%]" />
                  <col className="w-[11%]" />
                  <col className="w-[10%]" />
                  <col className="w-[8%]" />
                  <col className="w-[7%]" />
                  <col className="w-[10%]" />
                  <col className="w-[8%]" />
                  <col className="w-[14%]" />
                </colgroup>
                <TableHeader className="bg-[linear-gradient(135deg,rgba(22,128,55,0.96)_0%,rgba(18,90,45,0.98)_52%,rgba(11,64,35,1)_100%)]">
                  <TableRow className="border-b border-emerald-300/35 hover:bg-transparent">
                    <TableHead className="h-8 border-r border-white/15 px-1.5 text-center text-[9px] font-bold uppercase tracking-[0.06em] text-white">
                      Detay
                    </TableHead>
                    <TableHead className="h-8 border-r border-white/15 px-1.5 text-center text-[9px] font-bold uppercase tracking-[0.06em] text-white">
                      Sipariş
                    </TableHead>
                    <TableHead className="h-8 border-r border-white/15 px-2 text-[9px] font-bold uppercase tracking-[0.06em] text-white">
                      Müşteri
                    </TableHead>
                    <TableHead className="h-8 border-r border-white/15 px-1.5 text-center text-[9px] font-bold uppercase tracking-[0.06em] text-white">
                      Plasiyer
                    </TableHead>
                    <TableHead className="h-8 border-r border-white/15 px-1.5 text-center text-[9px] font-bold uppercase tracking-[0.06em] text-white">
                      Bölge
                    </TableHead>
                    <TableHead className="h-8 border-r border-white/15 px-1.5 text-center text-[9px] font-bold uppercase tracking-[0.06em] text-white">
                      Satış Tipi
                    </TableHead>
                    <TableHead className="h-8 border-r border-white/15 px-1.5 text-center text-[9px] font-bold uppercase tracking-[0.06em] text-white">
                      Kalem
                    </TableHead>
                    <TableHead className="h-8 border-r border-white/15 px-1.5 text-center text-[9px] font-bold uppercase tracking-[0.06em] text-white">
                      Tarih
                    </TableHead>
                    <TableHead className="h-8 border-r border-white/15 px-1.5 text-center text-[9px] font-bold uppercase tracking-[0.06em] text-white">
                      Tutar
                    </TableHead>
                    <TableHead className="h-8 px-1.5 text-center text-[9px] font-bold uppercase tracking-[0.06em] text-white">
                      Aksiyon
                    </TableHead>
                  </TableRow>
                </TableHeader>

                <TableBody>
                  {readyOrdersQuery.isLoading ? (
                    Array.from({ length: 8 }).map((_, index) => (
                      <TableRow key={`warehouse-table-skeleton-${index}`} className="h-[56px] border-b border-[var(--brand-border)]">
                        <TableCell className="border-r border-[var(--brand-border)]/80 px-1.5 py-2"><Skeleton className="mx-auto h-8 w-14 rounded-md" /></TableCell>
                        <TableCell className="border-r border-[var(--brand-border)]/80 px-1.5 py-2"><Skeleton className="mx-auto h-4 w-20" /></TableCell>
                        <TableCell className="border-r border-[var(--brand-border)]/80 py-2"><Skeleton className="h-4 w-52" /></TableCell>
                        <TableCell className="border-r border-[var(--brand-border)]/80 py-2"><Skeleton className="mx-auto h-4 w-24" /></TableCell>
                        <TableCell className="border-r border-[var(--brand-border)]/80 py-2"><Skeleton className="mx-auto h-4 w-20" /></TableCell>
                        <TableCell className="border-r border-[var(--brand-border)]/80 py-2"><Skeleton className="mx-auto h-4 w-16" /></TableCell>
                        <TableCell className="border-r border-[var(--brand-border)]/80 py-2"><Skeleton className="mx-auto h-4 w-12" /></TableCell>
                        <TableCell className="border-r border-[var(--brand-border)]/80 py-2"><Skeleton className="mx-auto h-4 w-24" /></TableCell>
                        <TableCell className="border-r border-[var(--brand-border)]/80 py-2"><Skeleton className="mx-auto h-7 w-20 rounded-md" /></TableCell>
                        <TableCell className="px-1.5 py-2"><Skeleton className="mx-auto h-8 w-full rounded-md" /></TableCell>
                      </TableRow>
                    ))
                  ) : null}

                  {readyOrdersQuery.isError ? (
                    <TableRow>
                      <TableCell colSpan={10} className="py-8 text-center text-base text-red-600">
                        {readyOrdersQuery.error instanceof Error ? readyOrdersQuery.error.message : "Depo siparişleri alınamadı."}
                      </TableCell>
                    </TableRow>
                  ) : null}

                  {!readyOrdersQuery.isLoading && !readyOrdersQuery.isError && rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10} className="py-10 text-center text-[var(--muted-foreground)]">
                        <PackageSearch className="mx-auto h-10 w-10 text-[var(--brand-primary)]" />
                        <p className="mt-3 text-base font-semibold">Sipariş yok</p>
                        {hasActiveFilters ? (
                          <Button variant="outline" size="sm" className="mt-3" onClick={clearFilters}>
                            Filtreleri Temizle
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ) : null}

                  {!readyOrdersQuery.isLoading &&
                    !readyOrdersQuery.isError &&
                    rows.map((order: WarehouseReadyOrderItem) => {
                      const totalQuantity = toSafeNumber(order.items_summary?.total_quantity);
                      const itemCount = toSafeNumber(order.items_summary?.item_count);
                      const checkoutBadge = checkoutSummaryBadge(order);
                      const cargoOrder = isCargoOrder(order);
                      const region = resolveOrderRegion(order);

                      return (
                        <TableRow
                          key={order.id}
                          className="h-[56px] border-b border-l-2 border-l-transparent border-[var(--brand-border)] bg-[var(--surface)] transition-[background-color,border-color,box-shadow] duration-150 hover:border-l-[#2f7f56] hover:bg-[var(--surface-soft)]"
                        >
                          <TableCell
                            className="cursor-pointer border-r border-[var(--brand-border)]/80 px-1.5 py-1.5 text-center align-middle"
                            onClick={() => openOrderDetail(order)}
                          >
                            <Button
                              type="button"
                              className={cn(WAREHOUSE_DETAIL_ACTION_CLASSNAME, "w-full")}
                            >
                              <Eye className="h-4 w-4 shrink-0" />
                              Detay
                            </Button>
                          </TableCell>
                          <TableCell className="border-r border-[var(--brand-border)]/80 px-1.5 py-1.5 text-center align-middle">
                            <p className="truncate whitespace-nowrap text-[11px] font-black text-[var(--brand-primary-strong)]">
                              {toDisplayText(order.order_no)}
                            </p>
                            <p className="text-[9px] font-semibold text-[var(--muted-foreground)]">
                              {itemCount} kalem · {totalQuantity} adet
                            </p>
                          </TableCell>
                          <TableCell className="border-r border-[var(--brand-border)]/80 py-1.5 align-middle">
                            <div className="min-w-0 pr-2">
                              <p className="truncate whitespace-nowrap text-[12px] font-extrabold text-[var(--foreground)]">
                                {toDisplayText(order.customer?.title)}
                              </p>
                              <p className="truncate whitespace-nowrap text-[10px] font-bold text-[var(--muted-foreground)]">
                                {toDisplayText(order.customer?.code)}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell className="border-r border-[var(--brand-border)]/80 px-1.5 py-1.5 text-center align-middle">
                            <span className="inline-flex max-w-full items-center justify-center rounded-md border border-[var(--brand-border)] bg-[var(--surface-soft)] px-1.5 py-1 text-[10px] font-bold text-[var(--foreground)]">
                              <span className="truncate">{toDisplayText(order.salesperson?.name, "Atanmamış")}</span>
                            </span>
                          </TableCell>
                          <TableCell className="border-r border-[var(--brand-border)]/80 px-1.5 py-1.5 text-center align-middle">
                            <span
                              title={region}
                              className={cn(WAREHOUSE_TAG_CLASSNAME, "border-emerald-200/70 bg-emerald-50 text-emerald-800")}
                            >
                              <span className="truncate">{region}</span>
                            </span>
                            {cargoOrder ? (
                              <span className={cn(WAREHOUSE_TAG_CLASSNAME, "mt-1 border-rose-200/80 bg-rose-50 text-rose-800")}>
                                KARGO
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell className="border-r border-[var(--brand-border)]/80 px-1.5 py-1.5 text-center align-middle">
                            {checkoutBadge ? (
                              <span
                                title={checkoutBadge.label}
                                className={cn(WAREHOUSE_TAG_CLASSNAME, "border-amber-200/80 bg-amber-50 text-amber-800")}
                              >
                                {checkoutBadge.code}
                              </span>
                            ) : (
                              <span className="text-[10px] font-black text-[var(--muted-foreground)]">-</span>
                            )}
                          </TableCell>
                          <TableCell className="border-r border-[var(--brand-border)]/80 px-1.5 py-1.5 text-center align-middle">
                            <span className="text-[12px] font-black text-[var(--foreground)]">{itemCount}</span>
                            <span className="block text-[9px] font-bold text-[var(--muted-foreground)]">{totalQuantity} ad.</span>
                          </TableCell>
                          <TableCell className="border-r border-[var(--brand-border)]/80 px-1.5 py-1.5 text-center align-middle">
                            <span className="text-[10px] font-semibold text-[var(--foreground)]">
                              {formatDate(order.approved_at)}
                            </span>
                          </TableCell>
                          <TableCell className="border-r border-[var(--brand-border)]/80 px-1.5 py-1.5 text-center align-middle">
                            <span className="inline-flex min-w-[84px] justify-center rounded-md border border-[#c7ddd1] bg-[#eef8f1] px-1.5 py-1 text-[11px] font-black text-[#1f6a43]">
                              {formatMoney(order.grand_total, order.currency)}
                            </span>
                          </TableCell>
                          <TableCell className="px-1.5 py-1.5 text-center align-middle">
                            <div className="flex w-full items-center justify-center gap-1">
                              <Button
                                className={cn(
                                  WAREHOUSE_TABLE_ACTION_CLASSNAME,
                                  WAREHOUSE_PRINT_ACTION_CLASSNAME
                                )}
                                onClick={() => printPageInPlace(`/warehouse/orders/${order.id}/print`)}
                              >
                                <Printer className="h-4 w-4 shrink-0" />
                                <span className="truncate">Sipariş Formu</span>
                              </Button>
                            <Button
                              className={cn(
                                WAREHOUSE_TABLE_ACTION_CLASSNAME,
                                WAREHOUSE_PRIMARY_ACTION_CLASSNAME
                              )}
                              onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  openShipment(order);
                                }}
                              >
                                <Truck className="h-4 w-4 shrink-0" />
                                <span className="truncate">{order.shipment?.id ? "Sevkiyatı Aç" : "Sevkiyat"}</span>
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                </TableBody>
              </Table>
            </div>

            <div className="mt-3 flex flex-col gap-3 px-5 py-4 md:flex-row md:items-center md:justify-between">
              <p className="text-base text-[var(--muted-foreground)]">
                Sayfa {currentPagination.history.length + 1} · Limit {PAGE_LIMIT}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  className="h-10 px-4 text-base"
                  onClick={onPreviousPage}
                  disabled={currentPagination.history.length === 0 || readyOrdersQuery.isFetching}
                >
                  <ChevronLeft className="h-4 w-4" /> Önceki
                </Button>
                <Button
                  variant="outline"
                  className="h-10 px-4 text-base"
                  onClick={onNextPage}
                  disabled={!readyOrdersQuery.data?.next_cursor || readyOrdersQuery.isFetching}
                >
                  Sonraki <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={shipmentOrder !== null} onOpenChange={(open) => {
        if (!open && !createShipmentMutation.isPending) {
          setShipmentOrder(null);
          setSelectedWarehouseStaffId("");
        }
      }}>
        <DialogContent className="max-h-[88vh] max-w-[760px] overflow-hidden rounded-[24px] border border-emerald-900/80 bg-[#071018] p-0 text-[#eef8ef] shadow-[0_34px_110px_-42px_rgba(0,0,0,0.92)]">
          <DialogHeader className="mb-0 border-b border-emerald-900/70 bg-[linear-gradient(135deg,#102019_0%,#071018_55%,#0c1c24_100%)] px-6 py-5 pr-12">
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#72bf82]/55 bg-[#1f6b45]/35 text-[#b8f7b5]">
                <Truck className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <DialogTitle className="text-2xl font-black text-white">
                  Sevkiyat Başlat
                </DialogTitle>
                <DialogDescription className="mt-1 text-sm font-semibold text-[#9fb2a7]">
                  Depocuyu seçin ve sevkiyat ekranına geçin.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {shipmentOrder ? (
            <div className="flex max-h-[calc(88vh-86px)] flex-col">
              <div className="flex-1 overflow-y-auto bg-[#071018] px-6 py-5">
                <div className="rounded-[20px] border border-emerald-900/70 bg-[#0b1712] p-4 shadow-[0_22px_54px_-44px_rgba(0,0,0,0.95)]">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <p className="text-sm font-black uppercase tracking-[0.12em] text-[#cfe1d2]">Depocu Seçimi</p>
                    {warehouseStaffQuery.isFetching ? (
                      <Loader2 className="h-4 w-4 animate-spin text-[#b8f7b5]" />
                    ) : (
                      <Badge className="border border-[#72bf82]/45 bg-[#1f6b45]/25 px-2.5 py-1 text-xs font-black text-[#d9ffe1]">
                        {warehouseStaff.length} depocu
                      </Badge>
                    )}
                  </div>

                  {warehouseStaffQuery.isLoading ? (
                    <div className="grid gap-2 md:grid-cols-2">
                      {Array.from({ length: 4 }).map((_, index) => (
                        <Skeleton key={`warehouse-staff-skeleton-${index}`} className="h-16 rounded-xl" />
                      ))}
                    </div>
                  ) : warehouseStaff.length > 0 ? (
                    <div className="space-y-3">
                      {warehouseStaffGroups.map((group) => (
                        <section key={group.title} className="rounded-[16px] border border-emerald-900/65 bg-[#07120f] p-3">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <p className="truncate text-xs font-black uppercase tracking-[0.14em] text-[#b8f7b5]">
                              {group.title}
                            </p>
                            <span className="rounded-full border border-[#72bf82]/35 bg-[#1f6b45]/25 px-2 py-0.5 text-[10px] font-black text-[#d9ffe1]">
                              {group.staff.length} kişi
                            </span>
                          </div>
                          <div className="grid gap-2 md:grid-cols-2">
                            {group.staff.map((staffUser) => {
                              const active = effectiveSelectedWarehouseStaffId === String(staffUser.id);

                              return (
                                <button
                                  key={staffUser.id}
                                  type="button"
                                  disabled={createShipmentMutation.isPending}
                                  onClick={() => setSelectedWarehouseStaffId(String(staffUser.id))}
                                  className={cn(
                                    "flex min-h-14 items-center justify-between gap-3 rounded-[14px] border px-3 py-2 text-left transition",
                                    active
                                      ? "border-[#72bf82]/80 bg-[#1f6b45]/35 text-white shadow-[inset_0_0_0_1px_rgba(114,191,130,0.22),0_18px_38px_-30px_rgba(114,191,130,0.8)]"
                                      : "border-emerald-900/75 bg-[#0b1712] text-[#e6f3e9] hover:border-[#72bf82]/55 hover:bg-[#102019]"
                                  )}
                                >
                                  <span className="min-w-0">
                                    <span className="block truncate text-sm font-black">{staffUser.name}</span>
                                    <span className="mt-0.5 block truncate text-xs font-semibold text-[#9fb2a7]">
                                      {staffUser.phone || staffUser.email}
                                    </span>
                                  </span>
                                  <span
                                    className={cn(
                                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
                                      active ? "border-[#b8f7b5] bg-[#b8f7b5] text-[#07140d]" : "border-emerald-900/75 bg-[#071018] text-transparent"
                                    )}
                                  >
                                    <CheckCircle2 className="h-4 w-4" />
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </section>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-[16px] border border-amber-400/35 bg-amber-950/25 p-3 text-sm font-semibold text-amber-100">
                      Aktif depocu bulunamadı. Önce warehouse rolünde aktif kullanıcı tanımlayın.
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-col-reverse gap-2 border-t border-emerald-900/70 bg-[#091510] px-6 py-4 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 rounded-xl border-emerald-900/80 bg-[#07120f] px-5 font-bold text-[#e6f3e9] hover:border-[#72bf82]/55 hover:bg-[#102019] hover:text-white"
                  disabled={createShipmentMutation.isPending}
                  onClick={() => {
                    setShipmentOrder(null);
                    setSelectedWarehouseStaffId("");
                  }}
                >
                  Vazgeç
                </Button>
                <Button
                  type="button"
                  className={cn("h-11 rounded-xl px-5 text-sm font-black", WAREHOUSE_PRIMARY_ACTION_CLASSNAME)}
                  disabled={
                    createShipmentMutation.isPending ||
                    warehouseStaff.length === 0 ||
                    !effectiveSelectedWarehouseStaffId
                  }
                  onClick={() => createShipmentMutation.mutate()}
                >
                  {createShipmentMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Truck className="h-4 w-4" />
                  )}
                  Sevkiyat Başlat
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={detailOrderPreview !== null} onOpenChange={(open) => {
        if (!open) {
          closeOrderDetail();
        }
      }}>
        <DialogContent className="max-h-[88vh] max-w-[min(980px,calc(100vw-28px))] overflow-hidden rounded-2xl p-0">
          {detailOrderPreview ? (
            <>
              <DialogHeader className="border-b border-[var(--brand-border)] bg-[var(--surface-soft)] px-4 py-3 pr-12 text-left">
                <DialogTitle className="text-xl font-black text-[var(--brand-primary-strong)]">
                  {toDisplayText(detailOrder?.order_no ?? detailOrderPreview.order_no, "Sipariş Detayı")}
                </DialogTitle>
                <DialogDescription className="text-xs font-semibold text-[var(--muted-foreground)]">
                  Sipariş Formu · ürün kalemleri ana odakta
                </DialogDescription>
              </DialogHeader>

              <div className="max-h-[calc(88vh-72px)] overflow-y-auto p-3">
                <div className="mb-3 grid gap-2 md:grid-cols-[1.35fr_0.85fr_0.65fr_0.65fr]">
                  <div className="rounded-xl border border-[var(--brand-border)] bg-[var(--surface)] p-3">
                    <p className="text-[11px] font-black uppercase tracking-[0.08em] text-[var(--muted-foreground)]">Müşteri</p>
                    <p className="mt-1 truncate text-sm font-black text-[var(--foreground)]">
                      {toDisplayText(detailOrder?.customer?.title ?? detailOrderPreview.customer?.title)}
                    </p>
                    <p className="mt-0.5 truncate text-xs font-bold text-[var(--muted-foreground)]">
                      {toDisplayText(detailOrder?.customer?.code ?? detailOrderPreview.customer?.code)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-[var(--brand-border)] bg-[var(--surface)] p-3">
                    <p className="text-[11px] font-black uppercase tracking-[0.08em] text-[var(--muted-foreground)]">Plasiyer</p>
                    <p className="mt-1 truncate text-sm font-black text-[var(--foreground)]">
                      {toDisplayText(detailOrder?.salesperson?.name ?? detailOrderPreview.salesperson?.name, "Atanmamış")}
                    </p>
                    <p className="mt-0.5 text-xs font-bold text-[var(--muted-foreground)]">
                      {detailOrder
                        ? `${detailItems.length} kalem · ${detailTotalQuantity} adet`
                        : `${toSafeNumber(detailOrderPreview.items_summary?.item_count)} kalem · ${toSafeNumber(detailOrderPreview.items_summary?.total_quantity)} adet`}
                    </p>
                  </div>
                  <div className="rounded-xl border border-amber-200/70 bg-amber-50 p-3 text-amber-950">
                    <p className="text-[11px] font-black uppercase tracking-[0.08em]">Satış Tipi</p>
                    <p className="mt-1 text-sm font-black">
                      {toDisplayText(
                        detailOrder?.origin?.checkout_summary?.code
                          ?? detailOrderPreview.origin?.checkout_summary?.code,
                        "-"
                      )}
                    </p>
                    <p className="mt-0.5 truncate text-xs font-bold">
                      {isCargoOrder(detailOrderPreview) ? "KARGO" : toDisplayText(detailOrder?.shipping_method ?? detailOrderPreview.origin?.shipping_method, "Standart")}
                    </p>
                  </div>
                  <div className="rounded-xl border border-emerald-200/70 bg-emerald-50 p-3 text-emerald-950">
                    <p className="text-[11px] font-black uppercase tracking-[0.08em]">Tutar</p>
                    <p className="mt-1 text-sm font-black">
                      {formatMoney(detailOrder?.grand_total ?? detailOrderPreview.grand_total, detailOrder?.currency ?? detailOrderPreview.currency)}
                    </p>
                    <p className="mt-0.5 text-xs font-bold">
                      {formatDate(detailOrder?.approved_at ?? detailOrderPreview.approved_at)}
                    </p>
                  </div>
                </div>

                {orderDetailQuery.isLoading ? (
                  <div className="grid gap-3">
                    <Skeleton className="h-20 rounded-xl" />
                    <Skeleton className="h-36 rounded-xl" />
                  </div>
                ) : null}

                {orderDetailQuery.isError ? (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900">
                    Detay servisi cevap vermedi. Liste bilgileri gösteriliyor.
                    <span className="mt-1 block font-bold">
                      {orderDetailQuery.error instanceof Error ? orderDetailQuery.error.message : "Sipariş detayı alınamadı."}
                    </span>
                  </div>
                ) : null}

                {detailOrder ? (
                  <div className="flex flex-col gap-3">
                    <div className="grid gap-2 rounded-xl border border-[var(--brand-border)] bg-[var(--surface-soft)] p-2 text-[11px] font-bold text-[var(--muted-foreground)] md:grid-cols-4">
                      <p className="truncate"><span className="text-[var(--foreground)]">Telefon:</span> {toDisplayText(detailOrder.customer?.phone, "-")}</p>
                      <p className="truncate"><span className="text-[var(--foreground)]">İl/İlçe:</span> {[detailOrder.customer?.city, detailOrder.customer?.district].filter(Boolean).join(" / ") || "-"}</p>
                      <p className="truncate"><span className="text-[var(--foreground)]">Fatura:</span> {toDisplayText(detailOrder.invoice?.reference_no)}</p>
                      <p className="truncate"><span className="text-[var(--foreground)]">Not:</span> {toDisplayText(detailOrder.note ?? detailOrder.origin?.note, "-")}</p>
                    </div>

                    <div className="overflow-x-auto rounded-xl border border-[var(--brand-border)]">
                      <Table className="min-w-[720px] table-fixed text-[11px]">
                        <colgroup>
                          <col className="w-[16%]" />
                          <col className="w-[30%]" />
                          <col className="w-[11%]" />
                          <col className="w-[14%]" />
                          <col className="w-[9%]" />
                          <col className="w-[10%]" />
                          <col className="w-[11%]" />
                        </colgroup>
                        <TableHeader className="bg-[var(--surface-soft)]">
                          <TableRow>
                            <TableHead>SKU / OEM</TableHead>
                            <TableHead>Ürün</TableHead>
                            <TableHead>Marka</TableHead>
                            <TableHead className="text-right">Adet</TableHead>
                            <TableHead className="text-right">Logo Stok</TableHead>
                            <TableHead className="text-right">Birim</TableHead>
                            <TableHead className="text-right">Tutar</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {detailItems.map((item) => (
                            <TableRow key={item.id}>
                              <TableCell className="font-bold">{toDisplayText(item.sku)}</TableCell>
                              <TableCell>{toDisplayText(item.name)}</TableCell>
                              <TableCell>{toDisplayText(item.brand)}</TableCell>
                              <TableCell className="text-right">
                                <div className="ml-auto flex w-[112px] items-center gap-1">
                                  <Input
                                    type="text"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    value={detailQuantityDrafts[item.id] ?? String(item.quantity)}
                                    onChange={(event) => setDetailQuantityDraft(item.id, event.target.value)}
                                    onFocus={(event) => event.currentTarget.select()}
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter") {
                                        commitDetailQuantityDraft(item.id, toSafeNumber(item.quantity));
                                      }
                                    }}
                                    disabled={updateOrderItemMutation.isPending}
                                    aria-label={`${toDisplayText(item.name, "Ürün")} sipariş adeti`}
                                    className="h-8 rounded-lg px-2 text-center text-xs font-black"
                                  />
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="outline"
                                    className="h-8 w-8 shrink-0 rounded-lg"
                                    disabled={updateOrderItemMutation.isPending}
                                    onClick={() => commitDetailQuantityDraft(item.id, toSafeNumber(item.quantity))}
                                  >
                                    {updateOrderItemMutation.isPending &&
                                    updateOrderItemMutation.variables?.itemId === item.id ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <Save className="h-3.5 w-3.5" />
                                    )}
                                  </Button>
                                </div>
                              </TableCell>
                              <TableCell className="text-right">{toSafeNumber(item.logo_stock?.available_total)}</TableCell>
                              <TableCell className="text-right">{formatMoney(item.unit_net_price, item.currency || detailOrder.currency)}</TableCell>
                              <TableCell className="text-right font-black">{formatMoney(item.line_total, item.currency || detailOrder.currency)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
