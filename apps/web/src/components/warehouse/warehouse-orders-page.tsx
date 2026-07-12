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
  Trash2,
  Truck,
  UserRound,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  ApiClientError,
  bulkCancelWarehouseOrders,
  createWarehouseShipment,
  getOrderDetail,
  listWarehouseShelves,
  listWarehouseStaff,
  listWarehouseReadyOrders,
  updateWarehouseOrderItem,
  updateWarehouseShelf,
  type WarehouseReadyOrderItem,
  type WarehouseShelfProduct,
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
  assigned_user_id?: number;
  choice_key?: string;
  name: string;
  username?: string | null;
  email?: string | null;
  phone?: string | null;
  branch_code?: string | null;
  branch_name?: string | null;
};

type WarehouseDepotGroup = {
  warehouse_id?: number;
  warehouse_code: string;
  warehouse_name: string;
  available_total?: number;
  missing_quantity?: number;
  staff: WarehouseStaffChoice[];
};

const DEPOT_DISPLAY_STAFF: Record<string, string[]> = {
  "1": ["İrfan Karagözlü", "Ali Budak", "İbrahim Sayar"],
  "2": ["Mustafa Özmen"],
  "3": ["İlker Aygünoğlu"],
};

function warehouseStaffChoiceKey(staffUser: WarehouseStaffChoice): string {
  return staffUser.choice_key ?? String(staffUser.id);
}

function expandDepotDisplayStaff(group: WarehouseDepotGroup): WarehouseDepotGroup {
  const displayNames = DEPOT_DISPLAY_STAFF[group.warehouse_code];
  if (!displayNames || displayNames.length === 0) {
    return group;
  }

  const anchor =
    group.staff.find((staffUser) => normalizeWarehouseIdentity(staffUser.name).includes("DEPO"))
    ?? group.staff[0];

  if (!anchor) {
    return group;
  }

  return {
    ...group,
    staff: displayNames.map((name, index) => ({
      ...anchor,
      assigned_user_id: anchor.assigned_user_id ?? anchor.id,
      choice_key: `${group.warehouse_code}:${anchor.id}:${index}`,
      name,
      phone: index === 0 ? anchor.phone : null,
      email: anchor.email,
    })),
  };
}

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
  const identity = normalizeWarehouseIdentity([
    staffUser?.name,
    staffUser?.username,
    staffUser?.email,
    staffUser?.branch_code,
    staffUser?.branch_name,
  ].filter(Boolean).join(" "));

  if (!identity) {
    return null;
  }

  const choices: Array<ShipmentWarehouseChoice & { needles: string[] }> = [
    { warehouse_code: "0", warehouse_name: "ERZURUM POINT", needles: ["ERZURUMPOINT", "ERZPOINT", "POINT"] },
    { warehouse_code: "1", warehouse_name: "ERZURUM DEPO", needles: ["ERZURUMDEPO", "ERZDEPO", "ERZURUM", "IRFANKARAGOZLU", "ALIBUDAK", "IBRAHIMSAYAR"] },
    { warehouse_code: "2", warehouse_name: "TRABZON DEPO", needles: ["TRABZONDEPO", "TRABZON", "MUSTAFAOZMEN"] },
    { warehouse_code: "3", warehouse_name: "SAMSUN DEPO", needles: ["SAMSUNDEPO", "SAMSUN", "ILKERAYGUNOGLU"] },
    { warehouse_code: "4", warehouse_name: "BATUM DEPO", needles: ["BATUMDEPO", "BATUM"] },
  ];

  return choices.find((choice) => choice.needles.some((needle) => identity.includes(needle))) ?? {
    warehouse_code: "1",
    warehouse_name: "ERZURUM DEPO",
  };
}

function checkoutSummaryBadge(order: WarehouseReadyOrderItem): { code: string; label: string } | null {
  const summary = order.origin?.checkout_summary;
  const code = typeof summary?.code === "string" ? summary.code.trim() : "";
  const label = typeof summary?.label === "string" ? summary.label.trim() : "";

  if (code) {
    return { code, label: label || code };
  }

  const note = String(order.origin?.note ?? "").toLocaleUpperCase("tr-TR");
  const matched = note.match(/\b(1-F|2-0|2-O|3-B)\b/u)?.[1]?.replace("2-O", "2-0");

  if (!matched) {
    return { code: "1-F", label: "1 - F" };
  }

  return { code: matched, label: matched };
}

function salesPriceTypeLabel(order: WarehouseReadyOrderItem): string {
  const rawLabel = order.origin?.sales_price_type_label ?? order.origin?.sales_price_type ?? "";
  const normalized = String(rawLabel).trim().toLocaleLowerCase("tr-TR");

  if (!normalized) {
    return "-";
  }

  if (["bank_transfer", "transfer", "havale", "havale/eft", "havale / eft"].includes(normalized)) {
    return "Havale / EFT";
  }

  if (["cash", "nakit"].includes(normalized)) {
    return "Nakit";
  }

  if (["single_payment", "tek çekim", "tek cekim"].includes(normalized)) {
    return "Tek Çekim";
  }

  return String(rawLabel).trim();
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

  const code = String(preferred?.warehouse_code ?? "").trim();
  const name = toDisplayText(preferred?.warehouse_name ?? order.origin?.panel_label, "");
  const normalized = normalizeWarehouseIdentity(`${code} ${name}`);

  if (code === "0" || normalized.includes("ERZURUMPOINT")) {
    return "ERZURUM POINT";
  }

  if (code === "1" || normalized.includes("ERZURUMDEPO")) {
    return "ERZURUM";
  }

  if (code === "2" || normalized.includes("TRABZON")) {
    return "TRABZON";
  }

  if (code === "3" || normalized.includes("SAMSUN")) {
    return "SAMSUN";
  }

  if (code === "4" || normalized.includes("BATUM")) {
    return "BATUM";
  }

  return name && !normalizeWarehouseIdentity(name).startsWith("LOGOAMBAR") ? name : "Bölge yok";
}

function resolveCleanWarehouseName(code: string | null | undefined, name: string | null | undefined): string {
  const normalizedCode = String(code ?? "").trim();
  const normalizedName = normalizeWarehouseIdentity(name ?? "");

  if (normalizedCode === "0" || normalizedName.includes("ERZURUMPOINT")) {
    return "ERZURUM POINT";
  }

  if (normalizedCode === "1" || normalizedName.includes("ERZURUMDEPO")) {
    return "ERZURUM DEPO";
  }

  if (normalizedCode === "2" || normalizedName.includes("TRABZON")) {
    return "TRABZON DEPO";
  }

  if (normalizedCode === "3" || normalizedName.includes("SAMSUN")) {
    return "SAMSUN DEPO";
  }

  if (normalizedCode === "4" || normalizedName.includes("BATUM")) {
    return "BATUM DEPO";
  }

  const fallback = toDisplayText(name, "");
  return fallback && !normalizeWarehouseIdentity(fallback).startsWith("LOGOAMBAR") ? fallback : "DEPO";
}

function resolveShipmentWarehouseChoice(
  order: WarehouseReadyOrderItem | null,
  warehouseGroup: WarehouseDepotGroup | null
): ShipmentWarehouseChoice {
  if (warehouseGroup) {
    return {
      ...(warehouseGroup.warehouse_id ? { warehouse_id: warehouseGroup.warehouse_id } : {}),
      warehouse_code: warehouseGroup.warehouse_code,
      warehouse_name: warehouseGroup.warehouse_name,
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

function preferredWarehouseCodeForOrder(order: WarehouseReadyOrderItem): string {
  return isCargoOrder(order)
    ? "1"
    : (order.preferred_warehouse_code
      ?? order.logo_warehouse_options?.find((warehouse) => warehouse.missing_quantity === 0)?.warehouse_code
      ?? order.logo_warehouse_options?.[0]?.warehouse_code
      ?? DEFAULT_WAREHOUSE_CODE);
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
  const { user } = useAuth();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [selectedSalespersonId, setSelectedSalespersonId] = useState("");
  const [detailOrderPreview, setDetailOrderPreview] = useState<WarehouseReadyOrderItem | null>(null);
  const [detailQuantityDrafts, setDetailQuantityDrafts] = useState<Record<number, string>>({});
  const [shipmentOrder, setShipmentOrder] = useState<WarehouseReadyOrderItem | null>(null);
  const [selectedShipmentWarehouseCode, setSelectedShipmentWarehouseCode] = useState("");
  const [selectedWarehouseStaffId, setSelectedWarehouseStaffId] = useState("");
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<number>>(() => new Set());
  const [bulkDeleteMode, setBulkDeleteMode] = useState<"selected" | "all" | null>(null);
  const [shelfDialogOpen, setShelfDialogOpen] = useState(false);
  const [shelfQuery, setShelfQuery] = useState("");
  const [shelfDrafts, setShelfDrafts] = useState<Record<number, string>>({});
  const [paginationByKey, setPaginationByKey] = useState<
    Record<string, { cursor?: string; history: string[] }>
  >({});

  const debouncedQuery = useDebouncedValue(query, 400);
  const debouncedShelfQuery = useDebouncedValue(shelfQuery, 300);
  const detailOrderId = detailOrderPreview?.id ?? null;
  const activeShelfWarehouse = useMemo(
    () =>
      preferredWarehouseForStaff(
        user
          ? {
              id: user.id,
              name: user.name,
              username: user.username,
              email: user.email,
              branch_code: user.branch_code,
              branch_name: user.branch_name,
            }
          : null
      ),
    [user]
  );
  const activeShelfWarehouseCode = activeShelfWarehouse?.warehouse_code ?? DEFAULT_WAREHOUSE_CODE;

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
  const warehouseUserKey = user?.id ?? user?.username ?? "guest";

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
        user: warehouseUserKey,
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
  });

  const salespersonOptionsQuery = useQuery({
    queryKey: [
      "warehouse",
      "ready-order-salespeople",
      {
        q: debouncedQuery,
        dateFrom,
        dateTo,
        user: warehouseUserKey,
      },
    ],
    queryFn: () =>
      listWarehouseReadyOrders({
        q: debouncedQuery || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        limit: 50,
      }),
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

  const shelfProductsQuery = useQuery({
    queryKey: ["warehouse", "shelves", activeShelfWarehouseCode, debouncedShelfQuery],
    queryFn: () =>
      listWarehouseShelves({
        q: debouncedShelfQuery || undefined,
        warehouse_code: activeShelfWarehouseCode,
        limit: 50,
      }),
    enabled: shelfDialogOpen,
    staleTime: 15_000,
  });

  const rows = useMemo(() => readyOrdersQuery.data?.data ?? [], [readyOrdersQuery.data?.data]);
  const visibleOrderIds = useMemo(() => rows.map((order) => order.id), [rows]);
  const selectedVisibleCount = useMemo(
    () => visibleOrderIds.filter((id) => selectedOrderIds.has(id)).length,
    [selectedOrderIds, visibleOrderIds]
  );
  const warehouseStaff = useMemo(() => warehouseStaffQuery.data?.data ?? [], [warehouseStaffQuery.data?.data]);
  const shelfProducts = useMemo(() => shelfProductsQuery.data?.data ?? [], [shelfProductsQuery.data?.data]);
  const shelfWarehouse = shelfProductsQuery.data?.warehouse ?? null;
  const detailOrder = orderDetailQuery.data?.order;
  const detailItems = useMemo(
    () => (Array.isArray(detailOrder?.items) ? detailOrder.items : []),
    [detailOrder?.items]
  );
  const detailTotalQuantity = useMemo(
    () => detailItems.reduce((total, item) => total + toSafeNumber(item.quantity), 0),
    [detailItems]
  );

  const shipmentWarehouseGroups = useMemo<WarehouseDepotGroup[]>(() => {
    if (!shipmentOrder) {
      return [];
    }

    const groups = new Map<string, WarehouseDepotGroup>();
    const targetWarehouseCode = preferredWarehouseCodeForOrder(shipmentOrder);
    const sourceWarehouses =
      shipmentOrder.logo_warehouse_options
        ?.filter((warehouse) => warehouse.warehouse_code)
        .filter((warehouse) => String(warehouse.warehouse_code ?? "").trim() === targetWarehouseCode) ?? [];

    sourceWarehouses.forEach((warehouse) => {
      const code = String(warehouse.warehouse_code ?? "").trim();
      if (!code) {
        return;
      }

      groups.set(code, {
        ...(warehouse.warehouse_id ? { warehouse_id: warehouse.warehouse_id } : {}),
        warehouse_code: code,
        warehouse_name: resolveCleanWarehouseName(code, warehouse.warehouse_name),
        available_total: warehouse.available_total,
        missing_quantity: warehouse.missing_quantity,
        staff: [],
      });
    });

    if (groups.size === 0) {
      [
        { warehouse_code: "1", warehouse_name: "ERZURUM DEPO" },
        { warehouse_code: "2", warehouse_name: "TRABZON DEPO" },
        { warehouse_code: "3", warehouse_name: "SAMSUN DEPO" },
      ]
        .filter((warehouse) => warehouse.warehouse_code === targetWarehouseCode)
        .forEach((warehouse) => groups.set(warehouse.warehouse_code, { ...warehouse, staff: [] }));
    }

    warehouseStaff.forEach((staffUser) => {
      const warehouse = preferredWarehouseForStaff(staffUser);
      if (!warehouse?.warehouse_code) {
        return;
      }

      if (warehouse.warehouse_code !== targetWarehouseCode) {
        return;
      }

      const group = groups.get(warehouse.warehouse_code);
      if (group) {
        group.staff.push(staffUser);
      }
    });

    return Array.from(groups.values())
      .map(expandDepotDisplayStaff)
      .sort((first, second) => Number(first.warehouse_code) - Number(second.warehouse_code));
  }, [shipmentOrder, warehouseStaff]);
  const selectedShipmentWarehouseGroup = useMemo(
    () => shipmentWarehouseGroups.find((group) => group.warehouse_code === selectedShipmentWarehouseCode) ?? shipmentWarehouseGroups[0] ?? null,
    [selectedShipmentWarehouseCode, shipmentWarehouseGroups]
  );
  const effectiveSelectedWarehouseStaffId =
    selectedWarehouseStaffId || (selectedShipmentWarehouseGroup?.staff[0] ? warehouseStaffChoiceKey(selectedShipmentWarehouseGroup.staff[0]) : "");
  const selectedWarehouseStaff = useMemo(
    () => selectedShipmentWarehouseGroup?.staff.find((staffUser) => warehouseStaffChoiceKey(staffUser) === effectiveSelectedWarehouseStaffId) ?? null,
    [effectiveSelectedWarehouseStaffId, selectedShipmentWarehouseGroup]
  );
  const shipmentWarehouseChoice = useMemo(
    () => resolveShipmentWarehouseChoice(shipmentOrder, selectedShipmentWarehouseGroup),
    [selectedShipmentWarehouseGroup, shipmentOrder]
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

  const toggleOrderSelection = (orderId: number) => {
    setSelectedOrderIds((previous) => {
      const next = new Set(previous);
      if (next.has(orderId)) {
        next.delete(orderId);
      } else {
        next.add(orderId);
      }

      return next;
    });
  };

  const toggleVisibleOrdersSelection = () => {
    setSelectedOrderIds((previous) => {
      const next = new Set(previous);
      const allVisibleSelected =
        visibleOrderIds.length > 0 && visibleOrderIds.every((orderId) => next.has(orderId));

      visibleOrderIds.forEach((orderId) => {
        if (allVisibleSelected) {
          next.delete(orderId);
        } else {
          next.add(orderId);
        }
      });

      return next;
    });
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

  const bulkCancelOrdersMutation = useMutation({
    mutationFn: (orderIds: number[]) => bulkCancelWarehouseOrders(orderIds),
    onSuccess: (response, orderIds) => {
      toast.success(`${response.cancelled || orderIds.length} sipariş depo havuzundan kaldırıldı`);
      setBulkDeleteMode(null);
      setSelectedOrderIds((previous) => {
        const next = new Set(previous);
        orderIds.forEach((orderId) => next.delete(orderId));
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ["warehouse", "ready-orders"] });
      void queryClient.invalidateQueries({ queryKey: ["warehouse", "ready-order-salespeople"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Siparişler kaldırılamadı.");
    },
  });

  const updateShelfMutation = useMutation({
    mutationFn: (payload: { product: WarehouseShelfProduct; shelfAddress: string }) =>
      updateWarehouseShelf(payload.product.id, {
        warehouse_code: payload.product.warehouse_code,
        shelf_address: payload.shelfAddress.trim() || null,
      }),
    onSuccess: (response) => {
      toast.success(response.message ?? "Raf adresi kaydedildi");
      void queryClient.invalidateQueries({ queryKey: ["warehouse", "shelves"] });
      void queryClient.invalidateQueries({ queryKey: ["warehouse", "ready-orders"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Raf adresi kaydedilemedi.");
    },
  });

  const confirmBulkDelete = () => {
    const orderIds = bulkDeleteMode === "all" ? visibleOrderIds : Array.from(selectedOrderIds);
    const uniqueOrderIds = Array.from(new Set(orderIds)).filter((orderId) => visibleOrderIds.includes(orderId));

    if (uniqueOrderIds.length === 0) {
      toast.error("Silinecek sipariş seçilmedi.");
      return;
    }

    bulkCancelOrdersMutation.mutate(uniqueOrderIds);
  };

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

      const assignedUserId = Number(selectedWarehouseStaff?.assigned_user_id ?? selectedWarehouseStaff?.id);
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
    const preferredWarehouseCode = preferredWarehouseCodeForOrder(order);
    setSelectedShipmentWarehouseCode(preferredWarehouseCode);
    setSelectedWarehouseStaffId("");
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

          <div className="grid gap-2 lg:grid-cols-[minmax(300px,1fr)_150px_150px_minmax(330px,auto)] lg:items-end">
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
            <div className="flex flex-wrap items-center gap-2 lg:justify-end">
              <Button
                type="button"
                variant="outline"
                className="h-11 rounded-xl border-red-300/35 bg-[linear-gradient(135deg,rgba(48,18,18,0.92)_0%,rgba(17,28,23,0.88)_100%)] px-3 text-xs font-black text-red-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_14px_28px_-24px_rgba(248,113,113,0.85)] transition hover:-translate-y-0.5 hover:border-red-200/65 hover:bg-[linear-gradient(135deg,rgba(94,25,25,0.96)_0%,rgba(30,38,30,0.94)_100%)] hover:text-white disabled:translate-y-0 disabled:border-red-900/35 disabled:text-red-200/35 disabled:shadow-none"
                disabled={selectedOrderIds.size === 0 || bulkCancelOrdersMutation.isPending}
                onClick={() => setBulkDeleteMode("selected")}
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-lg border border-red-300/25 bg-red-500/10 text-red-200">
                  <Trash2 className="h-3.5 w-3.5" />
                </span>
                Seçilenleri Sil
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-11 rounded-xl border-red-200/45 bg-[radial-gradient(circle_at_18%_18%,rgba(254,202,202,0.26)_0%,transparent_34%),linear-gradient(135deg,#ef4444_0%,#b91c1c_54%,#6f1010_100%)] px-3 text-xs font-black text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_18px_36px_-24px_rgba(239,68,68,0.95)] transition hover:-translate-y-0.5 hover:border-red-100/70 hover:brightness-110 disabled:translate-y-0 disabled:border-red-900/35 disabled:from-red-950 disabled:to-slate-950 disabled:text-white/35 disabled:shadow-none"
                disabled={visibleOrderIds.length === 0 || bulkCancelOrdersMutation.isPending}
                onClick={() => setBulkDeleteMode("all")}
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-lg border border-white/20 bg-white/12 text-white">
                  <Trash2 className="h-3.5 w-3.5" />
                </span>
                Tümünü Sil
              </Button>
              <Button className="h-11 rounded-xl px-3 text-sm font-extrabold" onClick={onRefresh} disabled={readyOrdersQuery.isFetching}>
                {readyOrdersQuery.isFetching ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCcw className="h-4 w-4" />
                )}
                Yenile
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-11 rounded-xl border-amber-200/45 bg-[linear-gradient(135deg,rgba(46,39,12,0.92)_0%,rgba(16,39,28,0.9)_100%)] px-3 text-xs font-black text-amber-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_16px_32px_-26px_rgba(245,158,11,0.85)] transition hover:-translate-y-0.5 hover:border-amber-100/70 hover:bg-[linear-gradient(135deg,rgba(85,63,10,0.96)_0%,rgba(18,51,36,0.94)_100%)] hover:text-white"
                onClick={() => setShelfDialogOpen(true)}
              >
                <Save className="h-4 w-4" />
                Raf Adreslerini Güncelle
              </Button>
            </div>
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
                  const salesPriceType = salesPriceTypeLabel(order);
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
                            {salesPriceType !== "-" ? (
                              <span className={cn(WAREHOUSE_TAG_CLASSNAME, "border-sky-200/80 bg-sky-50 text-sky-800")}>
                                {salesPriceType}
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
                  <col className="w-[3%]" />
                  <col className="w-[6%]" />
                  <col className="w-[12%]" />
                  <col className="w-[23%]" />
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
                    <TableHead className="h-8 border-r border-white/15 px-1 text-center text-[9px] font-bold uppercase tracking-[0.06em] text-white">
                      <input
                        type="checkbox"
                        aria-label="Sayfadaki siparişleri seç"
                        checked={visibleOrderIds.length > 0 && selectedVisibleCount === visibleOrderIds.length}
                        onChange={toggleVisibleOrdersSelection}
                        className="h-4 w-4 rounded border-white/40 accent-emerald-400"
                      />
                    </TableHead>
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
                        <TableCell className="border-r border-[var(--brand-border)]/80 px-1 py-2"><Skeleton className="mx-auto h-4 w-4 rounded" /></TableCell>
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
                      <TableCell colSpan={11} className="py-8 text-center text-base text-red-600">
                        {readyOrdersQuery.error instanceof Error ? readyOrdersQuery.error.message : "Depo siparişleri alınamadı."}
                      </TableCell>
                    </TableRow>
                  ) : null}

                  {!readyOrdersQuery.isLoading && !readyOrdersQuery.isError && rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={11} className="py-10 text-center text-[var(--muted-foreground)]">
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
                      const salesPriceType = salesPriceTypeLabel(order);
                      const cargoOrder = isCargoOrder(order);
                      const region = resolveOrderRegion(order);
                      const selected = selectedOrderIds.has(order.id);

                      return (
                        <TableRow
                          key={order.id}
                          className={cn(
                            "h-[56px] border-b border-l-2 border-[var(--brand-border)] bg-[var(--surface)] transition-[background-color,border-color,box-shadow] duration-150 hover:border-l-[#2f7f56] hover:bg-[var(--surface-soft)]",
                            selected ? "border-l-emerald-400 bg-emerald-950/10" : "border-l-transparent"
                          )}
                        >
                          <TableCell className="border-r border-[var(--brand-border)]/80 px-1 py-1.5 text-center align-middle">
                            <input
                              type="checkbox"
                              aria-label={`${toDisplayText(order.order_no)} siparişini seç`}
                              checked={selected}
                              onChange={() => toggleOrderSelection(order.id)}
                              className="h-4 w-4 rounded border-[var(--brand-border)] accent-emerald-500"
                            />
                          </TableCell>
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
                            <span
                              title={checkoutBadge?.label ?? "-"}
                              className={cn(WAREHOUSE_TAG_CLASSNAME, "border-amber-200/80 bg-amber-50 text-amber-800")}
                            >
                              {checkoutBadge?.code ?? "-"}
                            </span>
                            {salesPriceType !== "-" ? (
                              <span
                                title={`Fiyat tipi: ${salesPriceType}`}
                                className="mt-1 block truncate text-[9px] font-bold text-[var(--muted-foreground)]"
                              >
                                {salesPriceType}
                              </span>
                            ) : null}
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

      <Dialog open={shelfDialogOpen} onOpenChange={setShelfDialogOpen}>
        <DialogContent className="max-h-[88vh] max-w-[min(1180px,calc(100vw-24px))] overflow-hidden rounded-[20px] border border-amber-900/45 bg-[#071018] p-0 text-[#eef8ef] shadow-[0_34px_110px_-42px_rgba(0,0,0,0.95)]">
          <DialogHeader className="border-b border-amber-900/35 bg-[linear-gradient(135deg,#172018_0%,#071018_58%,#1f1a08_100%)] px-4 py-3 pr-12 text-left">
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <DialogTitle className="text-xl font-black text-white">
                  Raf Adreslerini Güncelle
                </DialogTitle>
                <DialogDescription className="mt-0.5 text-xs font-semibold text-[#aebdaf]">
                  Logo ürün kartından gelen OEM, rakip kod ve raf bilgilerini depoya göre yönetin.
                </DialogDescription>
              </div>
              {shelfWarehouse ? (
                <Badge className="w-fit border border-amber-200/45 bg-amber-400/12 px-3 py-1 text-xs font-black text-amber-100">
                  {shelfWarehouse.name}
                </Badge>
              ) : null}
            </div>
          </DialogHeader>

          <div className="flex max-h-[calc(88vh-68px)] flex-col">
            <div className="border-b border-emerald-900/55 bg-[#091510] p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9fb2a7]" />
                <Input
                  className="h-9 rounded-xl border-emerald-900/70 bg-[#07120f] pl-9 text-sm font-bold text-white placeholder:text-[#819489]"
                  value={shelfQuery}
                  onChange={(event) => setShelfQuery(event.target.value)}
                  placeholder="Ürün kodu, ürün adı, OEM, rakip kod veya raf ara..."
                />
              </div>
            </div>

            <div className="flex-1 overflow-auto p-3">
              {shelfProductsQuery.isLoading ? (
                <div className="grid gap-2">
                  {Array.from({ length: 8 }).map((_, index) => (
                    <Skeleton key={`shelf-skeleton-${index}`} className="h-12 rounded-xl bg-emerald-950/45" />
                  ))}
                </div>
              ) : shelfProductsQuery.isError ? (
                <div className="rounded-2xl border border-red-400/30 bg-red-950/25 p-4 text-sm font-bold text-red-100">
                  {shelfProductsQuery.error instanceof Error ? shelfProductsQuery.error.message : "Raf adresleri alınamadı."}
                </div>
              ) : shelfProducts.length === 0 ? (
                <div className="rounded-2xl border border-emerald-900/60 bg-[#0b1712] p-8 text-center">
                  <PackageSearch className="mx-auto h-10 w-10 text-[#b8f7b5]" />
                  <p className="mt-3 text-lg font-black text-white">Ürün bulunamadı</p>
                  <p className="mt-1 text-sm font-semibold text-[#9fb2a7]">Kod, ad, OEM, rakip kod veya raf adresiyle arayın.</p>
                </div>
              ) : (
                <div className="overflow-hidden rounded-2xl border border-emerald-900/65 bg-[#06100d]">
                  <div className="overflow-x-auto">
                    <Table className="min-w-[980px] text-[12px]">
                      <TableHeader className="sticky top-0 z-10 bg-[#10241a]">
                        <TableRow className="border-emerald-900/70 hover:bg-transparent">
                          <TableHead className="h-9 w-[150px] px-3 text-[10px] font-black uppercase tracking-[0.08em] text-emerald-100">Ürün Kodu</TableHead>
                          <TableHead className="h-9 min-w-[260px] px-3 text-[10px] font-black uppercase tracking-[0.08em] text-emerald-100">Ürün</TableHead>
                          <TableHead className="h-9 w-[170px] px-3 text-[10px] font-black uppercase tracking-[0.08em] text-emerald-100">OEM</TableHead>
                          <TableHead className="h-9 min-w-[220px] px-3 text-[10px] font-black uppercase tracking-[0.08em] text-emerald-100">Rakip Kod</TableHead>
                          <TableHead className="h-9 w-[120px] px-3 text-center text-[10px] font-black uppercase tracking-[0.08em] text-emerald-100">Mevcut Raf</TableHead>
                          <TableHead className="h-9 w-[230px] px-3 text-[10px] font-black uppercase tracking-[0.08em] text-emerald-100">Yeni Raf</TableHead>
                          <TableHead className="h-9 w-[104px] px-3 text-center text-[10px] font-black uppercase tracking-[0.08em] text-emerald-100">İşlem</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {shelfProducts.map((product) => {
                          const draft = shelfDrafts[product.id] ?? product.shelf_address ?? "";
                          const saving =
                            updateShelfMutation.isPending &&
                            updateShelfMutation.variables?.product.id === product.id;
                          const competitorPreview =
                            product.competitor_codes.length > 0
                              ? product.competitor_codes.slice(0, 4).join(", ")
                              : "-";

                          return (
                            <TableRow key={product.id} className="border-emerald-950/80 hover:bg-emerald-400/5">
                              <TableCell className="px-3 py-2 align-middle font-black text-white">
                                <span className="block max-w-[138px] truncate" title={product.product_code}>
                                  {product.product_code}
                                </span>
                              </TableCell>
                              <TableCell className="px-3 py-2 align-middle">
                                <p className="max-w-[360px] truncate font-black text-white" title={product.product_name}>
                                  {product.product_name}
                                </p>
                                <p className="mt-0.5 max-w-[220px] truncate text-[10px] font-bold text-[#8aa092]" title={product.brand ?? undefined}>
                                  {product.brand ?? "-"}
                                </p>
                              </TableCell>
                              <TableCell className="px-3 py-2 align-middle font-bold text-[#cfe1d2]">
                                <span className="block max-w-[160px] truncate" title={product.oem ?? undefined}>
                                  {product.oem || "-"}
                                </span>
                              </TableCell>
                              <TableCell className="px-3 py-2 align-middle font-bold text-[#cfe1d2]">
                                <span className="block max-w-[260px] truncate" title={competitorPreview}>
                                  {competitorPreview}
                                </span>
                              </TableCell>
                              <TableCell className="px-3 py-2 text-center align-middle">
                                {product.shelf_address ? (
                                  <span className="inline-flex min-w-[58px] items-center justify-center rounded-lg border border-sky-200/35 bg-sky-400/12 px-2 py-1 text-xs font-black text-sky-100">
                                    {product.shelf_address}
                                  </span>
                                ) : (
                                  <span className="text-xs font-bold text-[#607267]">-</span>
                                )}
                              </TableCell>
                              <TableCell className="px-3 py-2 align-middle">
                                <Input
                                  className="h-8 rounded-lg border-emerald-800/80 bg-[#020907] px-2 text-center text-xs font-black text-white placeholder:text-[#5f7469]"
                                  value={draft}
                                  onChange={(event) =>
                                    setShelfDrafts((previous) => ({
                                      ...previous,
                                      [product.id]: event.target.value,
                                    }))
                                  }
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" && product.editable && !saving) {
                                      updateShelfMutation.mutate({ product, shelfAddress: draft });
                                    }
                                  }}
                                  placeholder="Raf adresi"
                                  disabled={!product.editable || saving}
                                />
                              </TableCell>
                              <TableCell className="px-3 py-2 text-center align-middle">
                                <Button
                                  type="button"
                                  size="sm"
                                  className="h-8 rounded-lg border border-amber-200/45 bg-[linear-gradient(135deg,#fff3b0_0%,#f6c44f_45%,#b77810_100%)] px-2.5 text-[11px] font-black text-[#201400] shadow-none hover:brightness-105 disabled:opacity-50"
                                  disabled={!product.editable || saving}
                                  onClick={() => updateShelfMutation.mutate({ product, shelfAddress: draft })}
                                >
                                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                                  Kaydet
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={shipmentOrder !== null} onOpenChange={(open) => {
        if (!open && !createShipmentMutation.isPending) {
          setShipmentOrder(null);
          setSelectedShipmentWarehouseCode("");
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
                  ) : shipmentWarehouseGroups.length > 0 ? (
                    <div className="space-y-3">
                      {shipmentWarehouseGroups.map((group) => {
                        const groupActive = selectedShipmentWarehouseGroup?.warehouse_code === group.warehouse_code;

                        return (
                        <section
                          key={group.warehouse_code}
                          className={cn(
                            "rounded-[16px] border bg-[#07120f] p-3 transition",
                            groupActive
                              ? "border-[#72bf82]/80 shadow-[inset_0_0_0_1px_rgba(114,191,130,0.20),0_18px_38px_-32px_rgba(114,191,130,0.85)]"
                              : "border-emerald-900/65"
                          )}
                        >
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <button
                              type="button"
                              disabled={createShipmentMutation.isPending}
                              onClick={() => {
                                setSelectedShipmentWarehouseCode(group.warehouse_code);
                                const currentStaffInGroup = group.staff.some((staffUser) => warehouseStaffChoiceKey(staffUser) === effectiveSelectedWarehouseStaffId);
                                setSelectedWarehouseStaffId(currentStaffInGroup ? effectiveSelectedWarehouseStaffId : (group.staff[0] ? warehouseStaffChoiceKey(group.staff[0]) : ""));
                              }}
                              className="flex min-w-0 flex-1 items-center gap-2 text-left"
                            >
                              <span
                                className={cn(
                                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
                                  groupActive ? "border-[#b8f7b5] bg-[#b8f7b5] text-[#07140d]" : "border-emerald-900/75 bg-[#071018] text-transparent"
                                )}
                              >
                                <CheckCircle2 className="h-4 w-4" />
                              </span>
                              <span className="min-w-0">
                                <span className="block truncate text-xs font-black uppercase tracking-[0.14em] text-[#b8f7b5]">
                                  {group.warehouse_name}
                                </span>
                                <span className="mt-0.5 block truncate text-[10px] font-bold text-[#9fb2a7]">
                                  Logo ambar kodu: {group.warehouse_code}
                                  {typeof group.available_total === "number" ? ` · Stok: ${group.available_total}` : ""}
                                  {typeof group.missing_quantity === "number" && group.missing_quantity > 0 ? ` · Eksik: ${group.missing_quantity}` : ""}
                                  {isCargoOrder(shipmentOrder) && group.warehouse_code === "1" ? " · KARGO HAVUZU" : ""}
                                </span>
                              </span>
                            </button>
                            <span className="rounded-full border border-[#72bf82]/35 bg-[#1f6b45]/25 px-2 py-0.5 text-[10px] font-black text-[#d9ffe1]">
                              {group.staff.length} depocu
                            </span>
                          </div>
                          {group.staff.length > 0 ? (
                            <div className="grid gap-2 md:grid-cols-2">
                            {group.staff.map((staffUser) => {
                              const choiceKey = warehouseStaffChoiceKey(staffUser);
                              const active = groupActive && effectiveSelectedWarehouseStaffId === choiceKey;

                              return (
                                <button
                                  key={choiceKey}
                                  type="button"
                                  disabled={createShipmentMutation.isPending}
                                  onClick={() => {
                                    setSelectedShipmentWarehouseCode(group.warehouse_code);
                                    setSelectedWarehouseStaffId(choiceKey);
                                  }}
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
                          ) : (
                            <button
                              type="button"
                              disabled={createShipmentMutation.isPending}
                              onClick={() => {
                                setSelectedShipmentWarehouseCode(group.warehouse_code);
                                setSelectedWarehouseStaffId("");
                              }}
                              className="w-full rounded-[12px] border border-dashed border-amber-300/35 bg-amber-950/15 px-3 py-2 text-left text-xs font-bold text-amber-100"
                            >
                              Bu depoya bağlı aktif depocu yok; yine de depo seçimi bu ambar koduyla yapılır.
                            </button>
                          )}
                        </section>
                      );
                      })}
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
                    setSelectedShipmentWarehouseCode("");
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
                    !selectedShipmentWarehouseGroup ||
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

      <Dialog open={bulkDeleteMode !== null} onOpenChange={(open) => {
        if (!open && !bulkCancelOrdersMutation.isPending) {
          setBulkDeleteMode(null);
        }
      }}>
        <DialogContent className="max-w-[460px] rounded-[24px] border border-red-900/50 bg-[#0b1210] p-0 text-[#eef8ef] shadow-[0_32px_96px_-42px_rgba(0,0,0,0.95)]">
          <DialogHeader className="border-b border-red-900/35 bg-[linear-gradient(135deg,#1a1111_0%,#0b1210_62%,#161b13_100%)] px-5 py-4 pr-12 text-left">
            <DialogTitle className="text-xl font-black text-white">
              {bulkDeleteMode === "all" ? "Tüm siparişleri kaldır" : "Seçilen siparişleri kaldır"}
            </DialogTitle>
            <DialogDescription className="text-sm font-semibold text-[#b8c7bd]">
              İşlem depo havuzundan kaldırır, ayrılmış stokları geri bırakır.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-5 py-5">
            <div className="rounded-2xl border border-red-400/25 bg-red-950/20 p-4 text-sm font-bold text-red-50">
              {bulkDeleteMode === "all"
                ? `Bu sayfadaki ${visibleOrderIds.length} siparişi silmek istediğinize emin misiniz?`
                : `Seçilen ${selectedOrderIds.size} siparişi silmek istediğinize emin misiniz?`}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                className="h-11 rounded-xl border-emerald-900/70 bg-[#07120f] px-5 font-black text-[#e6f3e9] hover:bg-[#102019]"
                disabled={bulkCancelOrdersMutation.isPending}
                onClick={() => setBulkDeleteMode(null)}
              >
                Vazgeç
              </Button>
              <Button
                type="button"
                className="h-11 rounded-xl border border-red-300/40 bg-[linear-gradient(135deg,#ff6b6b_0%,#d92f2f_54%,#8f1515_100%)] px-5 font-black text-white shadow-[0_18px_42px_-24px_rgba(255,77,79,0.9)]"
                disabled={bulkCancelOrdersMutation.isPending}
                onClick={confirmBulkDelete}
              >
                {bulkCancelOrdersMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Evet
              </Button>
            </div>
          </div>
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
