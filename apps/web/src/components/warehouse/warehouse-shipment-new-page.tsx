"use client";

import Link from "next/link";
import { useEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { ArrowLeft, CheckCircle2, Loader2, MapPin, Truck } from "lucide-react";
import { toast } from "sonner";

import { createWarehouseShipment, listWarehouseReadyOrders } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

const DEFAULT_WAREHOUSE_ID = 1;

const createShipmentSchema = z
  .object({
    order_id: z.number().int().positive("Sipariş ID zorunlu"),
    warehouse_id: z.number().int().positive().optional(),
    warehouse_code: z.string().trim().optional(),
    warehouse_name: z.string().trim().optional(),
  })
  .superRefine((value, context) => {
    if (!value.warehouse_id && !value.warehouse_code) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Logo ambar seçimi zorunlu",
        path: ["warehouse_code"],
      });
    }
  });

type CreateShipmentFormValues = z.infer<typeof createShipmentSchema>;

export function WarehouseShipmentNewPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const form = useForm<CreateShipmentFormValues>({
    resolver: zodResolver(createShipmentSchema),
    defaultValues: {
      order_id: Number(searchParams.get("order_id") ?? "") || undefined,
      warehouse_id: undefined,
      warehouse_code: undefined,
      warehouse_name: undefined,
    },
  });
  const selectedOrderId = useWatch({
    control: form.control,
    name: "order_id",
  });
  const selectedWarehouseCode = useWatch({
    control: form.control,
    name: "warehouse_code",
  });

  const readyOrdersQuery = useQuery({
    queryKey: ["warehouse", "shipment-new", "ready-orders"],
    queryFn: () => listWarehouseReadyOrders({ limit: 20 }),
    staleTime: 30_000,
  });

  const readyOrders = useMemo(() => readyOrdersQuery.data?.data ?? [], [readyOrdersQuery.data?.data]);
  const selectedOrder = useMemo(
    () => readyOrders.find((order) => order.id === selectedOrderId),
    [readyOrders, selectedOrderId]
  );
  const logoWarehouseOptions = useMemo(
    () => selectedOrder?.logo_warehouse_options ?? [],
    [selectedOrder?.logo_warehouse_options]
  );
  const selectedWarehouse = useMemo(
    () => logoWarehouseOptions.find((warehouse) => warehouse.warehouse_code === selectedWarehouseCode),
    [logoWarehouseOptions, selectedWarehouseCode]
  );

  useEffect(() => {
    const nextOrderId = Number(searchParams.get("order_id") ?? "");
    if (Number.isFinite(nextOrderId) && nextOrderId > 0) {
      form.setValue("order_id", nextOrderId, {
        shouldDirty: false,
        shouldTouch: false,
      });
    }
  }, [form, searchParams]);

  useEffect(() => {
    if (!selectedOrder) {
      return;
    }

    const firstLogoWarehouse = logoWarehouseOptions.find(
      (warehouse) => warehouse.warehouse_code === selectedOrder.preferred_warehouse_code
    )
      ?? logoWarehouseOptions.find((warehouse) => warehouse.missing_quantity === 0)
      ?? logoWarehouseOptions[0];

    if (firstLogoWarehouse) {
      form.setValue("warehouse_id", firstLogoWarehouse.warehouse_id ?? undefined, {
        shouldDirty: false,
        shouldTouch: false,
      });
      form.setValue("warehouse_code", firstLogoWarehouse.warehouse_code ?? undefined, {
        shouldDirty: false,
        shouldTouch: false,
        shouldValidate: true,
      });
      form.setValue("warehouse_name", firstLogoWarehouse.warehouse_name, {
        shouldDirty: false,
        shouldTouch: false,
      });
      return;
    }

    form.setValue("warehouse_id", DEFAULT_WAREHOUSE_ID, {
      shouldDirty: false,
      shouldTouch: false,
      shouldValidate: true,
    });
    form.setValue("warehouse_code", undefined, {
      shouldDirty: false,
      shouldTouch: false,
    });
    form.setValue("warehouse_name", undefined, {
      shouldDirty: false,
      shouldTouch: false,
    });
  }, [form, logoWarehouseOptions, selectedOrder]);

  const createMutation = useMutation({
    mutationFn: createWarehouseShipment,
    onSuccess: (response) => {
      const shipmentId = response.data.shipment.id;
      toast.success(`Sevkiyat oluşturuldu (#${response.data.shipment.shipment_no})`);
      router.replace(`/warehouse/shipments/${shipmentId}`);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Sevkiyat oluşturulamadı";
      toast.error(message);
    },
  });

  const submit = form.handleSubmit((values) => {
    createMutation.mutate({
      order_id: values.order_id,
      ...(values.warehouse_id ? { warehouse_id: values.warehouse_id } : {}),
      ...(values.warehouse_code ? { warehouse_code: values.warehouse_code } : {}),
      ...(values.warehouse_name ? { warehouse_name: values.warehouse_name } : {}),
    });
  });

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <Card className="border-[var(--brand-border)] bg-white shadow-sm">
        <CardContent className="space-y-2 p-4">
          <h2 className="text-xl font-extrabold tracking-tight text-[var(--brand-primary-strong)]">
            Yeni Sevkiyat Başlat
          </h2>
          <p className="text-sm text-[var(--muted-foreground)]">Hazır siparişi seçin ve sevkiyat akışını başlatın.</p>
        </CardContent>
      </Card>

      <Button variant="ghost" asChild className="w-fit">
        <Link href="/warehouse">
          <ArrowLeft className="h-4 w-4" /> Sipariş listesine dön
        </Link>
      </Button>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Truck className="h-4 w-4 text-[var(--brand-primary)]" />
            Yeni Sevkiyat Oluştur
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit}>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label className="text-sm font-medium">Hazır Sipariş</label>
                <Badge variant="outline">{readyOrders.length} kayıt</Badge>
              </div>
              {readyOrdersQuery.isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, index) => (
                    <Skeleton key={index} className="h-16 w-full" />
                  ))}
                </div>
              ) : readyOrders.length > 0 ? (
                <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
                  {readyOrders.map((order) => {
                    const active = selectedOrderId === order.id;

                    return (
                      <button
                        key={order.id}
                        type="button"
                        className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                          active
                            ? "border-[var(--brand-primary)] bg-[var(--surface-soft)]"
                            : "border-[var(--brand-border)] bg-[var(--surface)] hover:bg-[var(--surface-soft)]"
                        }`}
                        onClick={() =>
                          form.setValue("order_id", order.id, {
                            shouldDirty: true,
                            shouldTouch: true,
                            shouldValidate: true,
                          })
                        }
                        disabled={createMutation.isPending}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-semibold text-[var(--foreground)]">{order.order_no}</p>
                            <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                              {order.customer.code ?? "-"} · {order.customer.title ?? "-"}
                            </p>
                          </div>
                          <Badge variant={active ? "default" : "outline"}>{active ? "Seçili" : "Seç"}</Badge>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2 text-xs text-[var(--muted-foreground)]">
                          {order.logo_stock_summary ? (
                            <span>
                              Logo stok: {order.logo_stock_summary.stock_covered_quantity}/{order.items_summary?.total_quantity ?? 0}
                              {order.logo_stock_summary.missing_quantity > 0
                                ? ` · eksik ${order.logo_stock_summary.missing_quantity}`
                                : ""}
                            </span>
                          ) : null}
                          {order.logo_warehouse_options?.[0] ? (
                            <span>
                              Ambar: {order.logo_warehouse_options[0].warehouse_name}
                              {order.logo_warehouse_options[0].warehouse_code
                                ? ` (${order.logo_warehouse_options[0].warehouse_code})`
                                : ""}
                            </span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-lg border border-[var(--brand-border)] bg-[var(--surface-soft)] p-3 text-sm text-[var(--muted-foreground)]">
                  Sevkiyata hazır sipariş bulunamadı.
                </div>
              )}
              {form.formState.errors.order_id ? (
                <p className="text-xs text-red-600">{form.formState.errors.order_id.message}</p>
              ) : null}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label className="text-sm font-medium">Logo Ambarı</label>
                {selectedWarehouse ? (
                  <Badge variant="secondary">
                    {selectedWarehouse.stock_covered_quantity}/{selectedWarehouse.order_quantity} karşılıyor
                  </Badge>
                ) : null}
              </div>

              {selectedOrder && logoWarehouseOptions.length > 0 ? (
                <div className="grid gap-2 md:grid-cols-2">
                  {logoWarehouseOptions.map((warehouse) => {
                    const active = selectedWarehouseCode === warehouse.warehouse_code;
                    const isEnough = warehouse.missing_quantity <= 0;

                    return (
                      <button
                        key={warehouse.warehouse_code ?? warehouse.warehouse_name}
                        type="button"
                        className={`rounded-2xl border px-4 py-3 text-left transition ${
                          active
                            ? "border-[var(--brand-primary)] bg-[var(--surface-soft)] shadow-[0_0_0_1px_var(--brand-primary)]"
                            : "border-[var(--brand-border)] bg-[var(--surface)] hover:bg-[var(--surface-soft)]"
                        }`}
                        disabled={createMutation.isPending}
                        onClick={() => {
                          form.setValue("warehouse_id", warehouse.warehouse_id ?? undefined, {
                            shouldDirty: true,
                            shouldTouch: true,
                          });
                          form.setValue("warehouse_code", warehouse.warehouse_code ?? undefined, {
                            shouldDirty: true,
                            shouldTouch: true,
                            shouldValidate: true,
                          });
                          form.setValue("warehouse_name", warehouse.warehouse_name, {
                            shouldDirty: true,
                            shouldTouch: true,
                          });
                        }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="flex items-center gap-2 font-semibold text-[var(--foreground)]">
                              <MapPin className="h-4 w-4 text-[var(--brand-primary)]" />
                              <span className="truncate">{warehouse.warehouse_name}</span>
                            </p>
                            <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                              Logo kodu: {warehouse.warehouse_code ?? "-"} · Stok: {warehouse.available_total}
                            </p>
                          </div>
                          {active ? <CheckCircle2 className="h-5 w-5 text-[var(--brand-primary)]" /> : null}
                        </div>
                        <p className={`mt-2 text-xs font-semibold ${isEnough ? "text-emerald-500" : "text-amber-500"}`}>
                          {isEnough
                            ? "Bu siparişi karşılıyor"
                            : `Eksik: ${warehouse.missing_quantity} adet`}
                        </p>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="space-y-1">
                  <Input
                    inputMode="numeric"
                    placeholder="Varsayılan depo"
                    {...form.register("warehouse_id", { valueAsNumber: true })}
                    disabled={createMutation.isPending}
                  />
                  <p className="text-xs text-[var(--muted-foreground)]">
                    Bu siparişte Logo ambar kırılımı gelmedi. Sevkiyat varsayılan depo kaydıyla açılır.
                  </p>
                </div>
              )}

              {form.formState.errors.warehouse_code || form.formState.errors.warehouse_id ? (
                <p className="text-xs text-red-600">
                  {form.formState.errors.warehouse_code?.message ?? form.formState.errors.warehouse_id?.message}
                </p>
              ) : null}
            </div>

            <div className="rounded-lg bg-[var(--surface-soft)] px-3 py-2 text-sm text-[var(--muted-foreground)]">
              {selectedOrder ? (
                <>
                  Seçili sipariş: <strong>{selectedOrder.order_no}</strong>. Oluşturunca barkod okutma ekranına geçilir.
                </>
              ) : (
                "Sevkiyat başlatmak için listeden bir sipariş seçin."
              )}
            </div>

            <Button type="submit" className="w-full" disabled={createMutation.isPending}>
              {createMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Oluşturuluyor...
                </>
              ) : (
                "Sevkiyatı Oluştur"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
