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
    paymentMethod?: string;
    salesPriceType?: string;
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

function includesBatum(value?: string | number | null): boolean {
  return String(value ?? "").trim().toLocaleUpperCase("tr-TR").includes("BATUM");
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

function stripAutomaticCheckoutNote(value?: string | null): string {
  return String(value ?? "")
    .split(/\r?\n/)
    .filter((line) => !AUTOMATIC_CHECKOUT_NOTE_MARKERS.some((marker) => line.includes(marker)))
    .join("\n")
    .trim();
}

function normalizeOrderNoteForScope(value: string | null | undefined, isBatumBranch: boolean): string {
  return isBatumBranch ? stripAutomaticCheckoutNote(value) : String(value ?? "");
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const { status, user, selectedCustomer } = useSession();
  const roleSlugs = Array.isArray(user?.roles) ? user.roles.map((role) => role.slug) : [];
  const warehouseTransferRequired = roleSlugs.includes("salesperson");
  const isBatumBranch = useMemo(() => {
    const batumScopeValues = [
      selectedCustomer?.branch_code,
      selectedCustomer?.branch_name,
      selectedCustomer?.region_code,
      selectedCustomer?.region_name,
      selectedCustomer?.title,
      user?.branch_code,
      user?.branch_name,
      user?.region_code,
      user?.region_name,
    ];

    return batumScopeValues.some(includesBatum) || selectedCustomer?.code?.trim().startsWith("120-00-") === true;
  }, [
    selectedCustomer?.branch_code,
    selectedCustomer?.branch_name,
    selectedCustomer?.code,
    selectedCustomer?.region_code,
    selectedCustomer?.region_name,
    selectedCustomer?.title,
    user?.branch_code,
    user?.branch_name,
    user?.region_code,
    user?.region_name,
  ]);

  const [open, setOpen] = useState(false);
  const [cartData, setCartData] = useState<CartResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [shippingMethod, setShippingMethod] = useState("depo_teslim");
  const [warehouseTransfer, setWarehouseTransfer] = useState(true);
  const [orderNote, setOrderNoteState] = useState("");

  const effectiveWarehouseTransfer =
    !isBatumBranch &&
    (warehouseTransferRequired ||
      warehouseTransfer || shippingMethod === "depo_teslim");

  const clearLocalCart = useCallback(() => {
    setCartData(emptyCartData());
    setShippingMethod("depo_teslim");
    setWarehouseTransfer(true);
    setOrderNoteState("");
  }, []);

  const setOrderNote = useCallback((value: string) => {
    setOrderNoteState(normalizeOrderNoteForScope(value, isBatumBranch));
  }, [isBatumBranch]);

  const refresh = useCallback(async () => {
    if (status !== "authenticated") {
      setCartData(null);
      setLoading(false);
      return;
    }

    if (!selectedCustomer) {
      clearLocalCart();
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const data = await getCart({ customer_id: selectedCustomer.id });
      setCartData(data);

      setShippingMethod(data.cart?.shipping_method ?? "depo_teslim");
      setWarehouseTransfer(isBatumBranch ? false : (warehouseTransferRequired ? true : (data.cart?.warehouse_transfer ?? true)));
      setOrderNoteState(normalizeOrderNoteForScope(data.cart?.order_note, isBatumBranch));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sepet bilgisi alınamadı");
    } finally {
      setLoading(false);
    }
  }, [clearLocalCart, isBatumBranch, selectedCustomer, status, warehouseTransferRequired]);

  const setWarehouseTransferValue = useCallback(
    (value: boolean) => {
      setWarehouseTransfer(isBatumBranch ? false : (warehouseTransferRequired ? true : value));
    },
    [isBatumBranch, warehouseTransferRequired]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upsertQuantity = useCallback(
    async (productId: number, quantity: number, campaignKey?: string | null) => {
      if (!selectedCustomer) {
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
          await queryClient.invalidateQueries({ queryKey: ["campaignProgress", selectedCustomer.id] });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Kalem silinemedi";
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
          customer_id: selectedCustomer.id,
          shipping_method: shippingMethod || undefined,
          warehouse_transfer: effectiveWarehouseTransfer,
          order_note: normalizeOrderNoteForScope(orderNote, isBatumBranch),
          campaign_key: campaignKey === undefined ? (currentItem?.campaign_key ?? null) : campaignKey,
        });

        setCartData(data);
        await queryClient.invalidateQueries({ queryKey: ["campaignProgress", selectedCustomer.id] });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Sepet güncellenemedi";
        setError(message);
        toast.error(message);
      } finally {
        setMutating(false);
      }
    },
    [cartData?.items, effectiveWarehouseTransfer, isBatumBranch, orderNote, queryClient, refresh, selectedCustomer, shippingMethod]
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
        const message = err instanceof Error ? err.message : "Kalem silinemedi";
        setError(message);
        toast.error(message);
      } finally {
        setMutating(false);
      }
    },
    [cartData?.items, queryClient, refresh, selectedCustomer]
  );

  const saveCheckoutMeta = useCallback(async () => {
    if (!selectedCustomer) {
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
        customer_id: selectedCustomer.id,
        shipping_method: shippingMethod || undefined,
        warehouse_transfer: effectiveWarehouseTransfer,
        order_note: normalizeOrderNoteForScope(orderNote, isBatumBranch),
        campaign_key: firstItem.campaign_key ?? null,
      });

      setCartData(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Sepet alanları kaydedilemedi";
      setError(message);
      toast.error(message);
      throw err;
    } finally {
      setMutating(false);
    }
  }, [cartData?.items, effectiveWarehouseTransfer, isBatumBranch, orderNote, selectedCustomer, shippingMethod]);

  const createOrderFromCart = useCallback(async (options?: {
    note?: string;
    checkoutSummaryMode?: "detailed" | "excluded" | "included";
    paymentMethod?: string;
    salesPriceType?: string;
  }) => {
    if (!selectedCustomer) {
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
      const checkoutNote = normalizeOrderNoteForScope(options?.note ?? orderNote, isBatumBranch);

      // Persist checkout fields with any existing draft item before order creation.
      const firstItem = cartData.items[0];
      await upsertCartItem({
        product_id: firstItem.product_id,
        quantity: firstItem.quantity,
        customer_id: selectedCustomer.id,
        shipping_method: shippingMethod || undefined,
        warehouse_transfer: effectiveWarehouseTransfer,
        order_note: checkoutNote,
        campaign_key: firstItem.campaign_key ?? null,
      });

      const orderResponse = await createOrder({
        cart_id: cartData.cart.id,
        customer_id: selectedCustomer.id,
        note: checkoutNote,
        checkout_summary_mode: options?.checkoutSummaryMode,
        payment_method: options?.paymentMethod,
        sales_price_type: options?.salesPriceType,
      });

      clearLocalCart();
      await queryClient.invalidateQueries({ queryKey: ["campaignProgress", selectedCustomer.id] });
      toast.success(
        effectiveWarehouseTransfer
          ? `Sipariş depoya gönderildi: ${orderResponse.order.order_no}`
          : `Sipariş gönderildi: ${orderResponse.order.order_no}`
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sipariş oluşturulamadı");
      throw err;
    } finally {
      setMutating(false);
    }
  }, [
    cartData?.cart,
    cartData?.items,
    clearLocalCart,
    orderNote,
    isBatumBranch,
    refresh,
    queryClient,
    selectedCustomer,
    shippingMethod,
    effectiveWarehouseTransfer,
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
