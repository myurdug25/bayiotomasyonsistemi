"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useSession } from "@/components/auth/session-provider";
import {
  type CartResponse,
  createOrder,
  deleteCartItem,
  ensureCsrfCookie,
  getCart,
  upsertCartItem,
} from "@/lib/api";
import { toast } from "sonner";

type CartContextType = {
  open: boolean;
  setOpen: (next: boolean) => void;
  cartData: CartResponse | null;
  loading: boolean;
  mutating: boolean;
  error: string | null;
  shippingMethod: string;
  warehouseTransfer: boolean;
  effectiveWarehouseTransfer: boolean;
  warehouseTransferRequired: boolean;
  orderNote: string;
  setShippingMethod: (value: string) => void;
  setWarehouseTransfer: (value: boolean) => void;
  setOrderNote: (value: string) => void;
  refresh: () => Promise<void>;
  upsertQuantity: (productId: number, quantity: number, campaignKey?: string | null) => Promise<void>;
  removeItemByProduct: (productId: number) => Promise<void>;
  saveCheckoutMeta: () => Promise<void>;
  createOrderFromCart: (options?: {
    note?: string;
    checkoutSummaryMode?: "detailed" | "excluded" | "included";
    itemCheckoutSummaryModes?: Record<number, "detailed" | "excluded" | "included">;
    checkoutGrandTotal?: number;
    shippingFeeAmount?: number;
    paymentMethod?: string;
    salesPriceType?: string;
    selectedProductIds?: number[];
    warehouseTransferRequest?: boolean;
    shippingTargetWarehouseCode?: string | null;
    shippingTargetWarehouseName?: string | null;
    transferSourceWarehouseCode?: string | null;
    transferSourceWarehouseName?: string | null;
    transferTargetWarehouseCode?: string | null;
    transferTargetWarehouseName?: string | null;
  }) => Promise<void>;
  getProductQty: (productId: number) => number;
};

const CartContext = createContext<CartContextType | null>(null);

function emptyCartData(): CartResponse {
  return {
    cart: null,
    items: [],
    totals: {
      total: "0.00",
      discount_total: "0.00",
      net_total: "0.00",
      vat_total: "0.00",
      grand_total: "0.00",
      subtotal: "0.00",
      line_count: 0,
    },
  };
}

const AUTOMATIC_CHECKOUT_NOTE_MARKERS = [
  "Ödeme tercihi:",
  "Satış tipi:",
  "Ekranda gösterilen ödeme tutarı:",
  "Özet gösterimi:",
  "Referans kodu:",
  "Ulaşım / nakliye bedeli:",
  "Depo transfer:",
] as const;

const OPEN_ACCOUNT_RISK_LIMIT_MESSAGE =
  "Müşterinin vadesi geçmiş açık hesabı var ve sipariş açık hesap risk limitini aşıyor.";

function stripAutomaticCheckoutNote(value?: string | null): string {
  return String(value ?? "")
    .split(/\r?\n/)
    .filter((line) => !AUTOMATIC_CHECKOUT_NOTE_MARKERS.some((marker) => line.includes(marker)))
    .join("\n")
    .trim();
}

function normalizeOrderNote(value: string | null | undefined): string {
  return stripAutomaticCheckoutNote(value);
}

function normalizeCartErrorMessage(message: string): string {
  return message.includes("sipariş açık hesap risk limitini aşıyor")
    ? OPEN_ACCOUNT_RISK_LIMIT_MESSAGE
    : message;
}

function cartErrorMessage(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : fallback;

  return normalizeCartErrorMessage(message);
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const { status, user, selectedCustomer } = useSession();
  const roleSlugs = Array.isArray(user?.roles) ? user.roles.map((role) => role.slug) : [];
  const warehouseTransferRequired = roleSlugs.includes("salesperson");

  const [open, setOpen] = useState(false);
  const [cartData, setCartData] = useState<CartResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [shippingMethod, setShippingMethod] = useState("depo_teslim");
  const [warehouseTransfer, setWarehouseTransfer] = useState(false);
  const [orderNote, setOrderNoteState] = useState("");

  const effectiveWarehouseTransfer = warehouseTransferRequired || warehouseTransfer;

  const clearLocalCart = useCallback(() => {
    setCartData(emptyCartData());
    setShippingMethod("depo_teslim");
    setWarehouseTransfer(false);
    setOrderNoteState("");
  }, []);

  const setOrderNote = useCallback((value: string) => {
    setOrderNoteState(normalizeOrderNote(value));
  }, []);

  const refresh = useCallback(async () => {
    if (status !== "authenticated") {
      setCartData(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const data = await getCart(selectedCustomer ? { customer_id: selectedCustomer.id } : undefined);
      setCartData(data);

      setShippingMethod(data.cart?.shipping_method ?? "depo_teslim");
      setWarehouseTransfer(warehouseTransferRequired ? true : (data.cart?.warehouse_transfer ?? false));
      setOrderNoteState(normalizeOrderNote(data.cart?.order_note));
    } catch (err) {
      setError(cartErrorMessage(err, "Sepet bilgisi alınamadı"));
    } finally {
      setLoading(false);
    }
  }, [selectedCustomer, status, warehouseTransferRequired]);

  const setWarehouseTransferValue = useCallback(
    (value: boolean) => {
      setWarehouseTransfer(warehouseTransferRequired ? true : value);
    },
    [warehouseTransferRequired]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upsertQuantity = useCallback(
    async (productId: number, quantity: number, campaignKey?: string | null) => {
      if (!selectedCustomer && !effectiveWarehouseTransfer) {
        setError("Önce müşteri seçmelisiniz");
        return;
      }

      if (quantity < 1) {
        const item = cartData?.items.find((line) => line.product_id === productId);
        if (!item) {
          return;
        }

        setMutating(true);
        setError(null);

        try {
          await ensureCsrfCookie();
          await deleteCartItem(item.id);
          await refresh();
          if (selectedCustomer) {
            await queryClient.invalidateQueries({ queryKey: ["campaignProgress", selectedCustomer.id] });
          }
        } catch (err) {
          const message = cartErrorMessage(err, "Kalem silinemedi");
          setError(message);
          toast.error(message);
        } finally {
          setMutating(false);
        }

        return;
      }

      setMutating(true);
      setError(null);

      try {
        await ensureCsrfCookie();
        const currentItem = cartData?.items.find((line) => line.product_id === productId);

        const data = await upsertCartItem({
          product_id: productId,
          quantity,
          customer_id: selectedCustomer?.id,
          shipping_method: shippingMethod || undefined,
          warehouse_transfer: effectiveWarehouseTransfer,
          order_note: normalizeOrderNote(orderNote),
          campaign_key: campaignKey === undefined ? (currentItem?.campaign_key ?? null) : campaignKey,
        });

        setCartData(data);
        if (selectedCustomer) {
          await queryClient.invalidateQueries({ queryKey: ["campaignProgress", selectedCustomer.id] });
        }
      } catch (err) {
        const message = cartErrorMessage(err, "Sepet güncellenemedi");
        setError(message);
        toast.error(message);
      } finally {
        setMutating(false);
      }
    },
    [cartData?.items, effectiveWarehouseTransfer, orderNote, queryClient, refresh, selectedCustomer, shippingMethod]
  );

  const removeItemByProduct = useCallback(
    async (productId: number) => {
      const item = cartData?.items.find((line) => line.product_id === productId);
      if (!item) {
        return;
      }

      setMutating(true);
      setError(null);

      try {
        await ensureCsrfCookie();
        await deleteCartItem(item.id);
        await refresh();
        if (selectedCustomer) {
          await queryClient.invalidateQueries({ queryKey: ["campaignProgress", selectedCustomer.id] });
        }
      } catch (err) {
        const message = cartErrorMessage(err, "Kalem silinemedi");
        setError(message);
        toast.error(message);
      } finally {
        setMutating(false);
      }
    },
    [cartData?.items, queryClient, refresh, selectedCustomer]
  );

  const saveCheckoutMeta = useCallback(async () => {
      if (!selectedCustomer && !effectiveWarehouseTransfer) {
        setError("Önce müşteri seçmelisiniz");
        return;
      }

    const firstItem = cartData?.items[0];
    if (!firstItem) {
      setError("Sepette en az bir ürün olmalı");
      return;
    }

    setMutating(true);
    setError(null);

    try {
      await ensureCsrfCookie();
      const data = await upsertCartItem({
        product_id: firstItem.product_id,
        quantity: firstItem.quantity,
        customer_id: selectedCustomer?.id,
        shipping_method: shippingMethod || undefined,
        warehouse_transfer: effectiveWarehouseTransfer,
        order_note: normalizeOrderNote(orderNote),
        campaign_key: firstItem.campaign_key ?? null,
      });

      setCartData(data);
    } catch (err) {
      const message = cartErrorMessage(err, "Sepet alanları kaydedilemedi");
      setError(message);
      toast.error(message);
      throw err;
    } finally {
      setMutating(false);
    }
  }, [cartData?.items, effectiveWarehouseTransfer, orderNote, selectedCustomer, shippingMethod]);

  const createOrderFromCart = useCallback(async (options?: {
    note?: string;
    checkoutSummaryMode?: "detailed" | "excluded" | "included";
    itemCheckoutSummaryModes?: Record<number, "detailed" | "excluded" | "included">;
    checkoutGrandTotal?: number;
    shippingFeeAmount?: number;
    paymentMethod?: string;
    salesPriceType?: string;
    selectedProductIds?: number[];
    warehouseTransferRequest?: boolean;
    shippingTargetWarehouseCode?: string | null;
    shippingTargetWarehouseName?: string | null;
    transferSourceWarehouseCode?: string | null;
    transferSourceWarehouseName?: string | null;
    transferTargetWarehouseCode?: string | null;
    transferTargetWarehouseName?: string | null;
  }) => {
    if (!selectedCustomer && !options?.warehouseTransferRequest) {
      setError("Önce müşteri seçmelisiniz");
      return;
    }

    if (!cartData?.cart || cartData.items.length === 0) {
      setError("Sipariş için sepette ürün olmalı");
      return;
    }

    setMutating(true);
    setError(null);

    try {
      await ensureCsrfCookie();
      const checkoutNote = normalizeOrderNote(options?.note ?? orderNote);

      // Persist checkout fields with any existing draft item before order creation.
      const firstItem = cartData.items[0];
      await upsertCartItem({
        product_id: firstItem.product_id,
        quantity: firstItem.quantity,
        customer_id: selectedCustomer?.id,
        shipping_method: shippingMethod || undefined,
        warehouse_transfer: options?.warehouseTransferRequest === true,
        order_note: checkoutNote,
        campaign_key: firstItem.campaign_key ?? null,
      });

      const orderResponse = await createOrder({
        cart_id: cartData.cart.id,
        customer_id: selectedCustomer?.id,
        note: checkoutNote,
        checkout_summary_mode: options?.checkoutSummaryMode,
        item_checkout_summary_modes: options?.itemCheckoutSummaryModes,
        checkout_grand_total: options?.checkoutGrandTotal,
        shipping_fee_amount: options?.shippingFeeAmount,
        selected_product_ids: options?.selectedProductIds,
        payment_method: options?.paymentMethod,
        sales_price_type: options?.salesPriceType,
        warehouse_transfer_request: options?.warehouseTransferRequest,
        shipping_target_warehouse_code: options?.shippingTargetWarehouseCode ?? null,
        shipping_target_warehouse_name: options?.shippingTargetWarehouseName ?? null,
        transfer_source_warehouse_code: options?.transferSourceWarehouseCode ?? null,
        transfer_source_warehouse_name: options?.transferSourceWarehouseName ?? null,
        transfer_target_warehouse_code: options?.transferTargetWarehouseCode ?? null,
        transfer_target_warehouse_name: options?.transferTargetWarehouseName ?? null,
      });

      if (options?.selectedProductIds && options.selectedProductIds.length > 0 && options.selectedProductIds.length < cartData.items.length) {
        await refresh();
      } else {
        clearLocalCart();
      }
      if (selectedCustomer) {
        await queryClient.invalidateQueries({ queryKey: ["campaignProgress", selectedCustomer.id] });
      }
      toast.success(options?.warehouseTransferRequest ? "Depolar arası transfer talebi gönderildi" : "Sipariş depoya gönderildi", {
        description: selectedCustomer
          ? `${orderResponse.order.order_no} · ${selectedCustomer.title ?? selectedCustomer.code}`
          : `${orderResponse.order.order_no} · Depolar arası transfer`,
        duration: 2800,
      });
      await refresh();
    } catch (err) {
      const message = cartErrorMessage(err, "Sipariş oluşturulamadı");
      setError(message);
      toast.error(message);
      throw err;
    } finally {
      setMutating(false);
    }
  }, [
    cartData?.cart,
    cartData?.items,
    clearLocalCart,
    orderNote,
    refresh,
    queryClient,
    selectedCustomer,
    shippingMethod,
  ]);

  const getProductQty = useCallback(
    (productId: number) =>
      cartData?.items.find((line) => line.product_id === productId)?.quantity ?? 0,
    [cartData?.items]
  );

  const value = useMemo<CartContextType>(
    () => ({
      open,
      setOpen,
      cartData,
      loading,
      mutating,
      error,
      shippingMethod,
      warehouseTransfer,
      effectiveWarehouseTransfer,
      warehouseTransferRequired,
      orderNote,
      setShippingMethod,
      setWarehouseTransfer: setWarehouseTransferValue,
      setOrderNote,
      refresh,
      upsertQuantity,
      removeItemByProduct,
      saveCheckoutMeta,
      createOrderFromCart,
      getProductQty,
    }),
    [
      open,
      cartData,
      loading,
      mutating,
      error,
      shippingMethod,
      warehouseTransfer,
      effectiveWarehouseTransfer,
      warehouseTransferRequired,
      orderNote,
      setWarehouseTransferValue,
      setOrderNote,
      refresh,
      upsertQuantity,
      removeItemByProduct,
      saveCheckoutMeta,
      createOrderFromCart,
      getProductQty,
    ]
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error("useCart must be used inside CartProvider");
  }

  return context;
}
