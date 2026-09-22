import { getSanctumCsrfHeaders, getSanctumHeaders } from "@/lib/sanctum";

export type ValidationErrors = Record<string, string[]>;

export type ApiErrorPayload = {
  message?: string;
  errors?: ValidationErrors;
};

export class ApiClientError extends Error {
  status: number;
  payload?: ApiErrorPayload;

  constructor(message: string, status: number, payload?: ApiErrorPayload) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.payload = payload;
  }
}

export type ApiRole = {
  id: number;
  name: string;
  slug: string;
};

export type ApiDealer = {
  id: number;
  code?: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  tax_office?: string | null;
  tax_number?: string | null;
  address?: string | null;
};

export type SalespersonSummary = {
  id: number;
  name: string;
  email?: string | null;
  phone?: string | null;
  avatar_url?: string | null;
};

export type CustomerSummary = {
  id: number;
  code: string;
  title: string;
  name?: string | null;
  region_code?: string | null;
  region_name?: string | null;
  branch_code?: string | null;
  branch_name?: string | null;
  source_system?: string | null;
  source_reference?: string | null;
  e_invoice_user?: boolean;
  contact_name?: string | null;
  email?: string | null;
  city: string | null;
  district: string | null;
  phone: string | null;
  tax_office?: string | null;
  tax_number?: string | null;
  credit_limit?: string | null;
  special_discount_rate?: string | null;
  is_active?: boolean;
  address?: string | null;
  iban?: string | null;
  last_synced_at?: string | null;
  balance_summary?: {
    total_due: string;
    order_due: string;
    currency: string;
  };
  balance_source?: "b2b" | "logo";
  customer_user_feature_permissions?: string[] | null;
  salesperson?: SalespersonSummary | null;
  meta?: {
    address?: string | null;
    iban?: string | null;
    [key: string]: unknown;
  } | null;
};

export type ApiUser = {
  id: number;
  dealer_id: number | null;
  customer_scope?: "dealer" | "region" | "branch" | "assigned";
  region_code?: string | null;
  region_name?: string | null;
  branch_code?: string | null;
  branch_name?: string | null;
  logo_cashbox_code?: string | null;
  logo_cashbox_name?: string | null;
  selected_customer_id: number | null;
  name: string;
  username: string;
  email: string | null;
  phone: string | null;
  avatar_url?: string | null;
  roles: ApiRole[];
  menu_permissions: string[];
  feature_permissions?: string[];
  permissions_updated_at?: string | null;
  dealer?: ApiDealer | null;
  selectedCustomer?: CustomerSummary | null;
};

export type AdminDashboardOverview = {
  summary: {
    users_total: number;
    active_users_total: number;
    dealers_total: number;
    active_dealers_total: number;
    customers_total: number;
    active_customers_total: number;
    open_pos_sessions_total: number;
    warehouse_ready_orders_total: number;
    pending_customer_card_requests_total: number;
    pending_return_requests_total: number;
  };
  role_breakdown: Array<{
    slug: string;
    name: string;
    count: number;
  }>;
  recent_users: Array<{
    id: number;
    name: string;
    username?: string | null;
    email: string | null;
    phone: string | null;
    is_active: boolean;
    created_at: string | null;
    dealer: {
      id: number | null;
      code?: string | null;
      name: string | null;
    };
    selected_customer: {
      id: number | null;
      code: string | null;
      title: string | null;
    };
    roles: ApiRole[];
  }>;
  recent_dealers: Array<{
    id: number;
    code?: string | null;
    name: string;
    email?: string | null;
    phone?: string | null;
    is_active: boolean;
    users_count: number;
    customers_count: number;
    created_at: string | null;
  }>;
  pending_customer_card_requests: Array<{
    id: number;
    request_no: string;
    company_name: string;
    contact_name: string;
    phone: string;
    status: "submitted" | "reviewing" | "approved" | "rejected";
    created_at: string | null;
    dealer: {
      id: number | null;
      code?: string | null;
      name: string | null;
    };
    requested_by: {
      id: number | null;
      name: string | null;
    };
  }>;
  pending_return_requests: Array<{
    id: number;
    request_no: string;
    request_type: "return" | "damaged" | "faulty";
    status: "submitted" | "reviewing" | "approved" | "rejected" | "completed";
    reason_code: string;
    quantity: number;
    created_at: string | null;
    dealer: {
      id: number | null;
      code?: string | null;
      name: string | null;
    };
    customer: {
      id: number | null;
      code: string | null;
      title: string | null;
    };
    requested_by: {
      id: number | null;
      name: string | null;
    };
  }>;
  warehouse_ready_orders: Array<{
    id: number;
    order_no: string;
    status: string;
    currency: string;
    grand_total: string;
    approved_at: string | null;
    dealer: {
      id: number | null;
      code?: string | null;
      name: string | null;
    };
    customer: {
      id: number | null;
      code: string | null;
      title: string | null;
    };
  }>;
  open_pos_sessions: Array<{
    id: number;
    status: string;
    opened_at: string | null;
    opening_cash: string;
    cashbox: {
      id: number | null;
      code: string | null;
      name: string | null;
    };
    opened_by: {
      id: number | null;
      name: string | null;
      email: string | null;
    };
    dealer: {
      id: number | null;
      code?: string | null;
      name: string | null;
    };
  }>;
};

export type ModeratorRoleOption = {
  id: number;
  slug: string;
  name: string;
};

export type ModeratorMenuPermissionOption = {
  key: string;
  label: string;
  href: string;
};

export type ModeratorDealerRecord = {
  id: number;
  code: string | null;
  name: string;
  email?: string | null;
  phone?: string | null;
  is_active: boolean;
  users_count: number;
  customers_count: number;
  salespeople_count: number;
};

export type ModeratorUserRecord = {
  id: number;
  dealer_id: number | null;
  customer_scope: "dealer" | "region" | "branch" | "assigned";
  region_code: string | null;
  region_name: string | null;
  branch_code: string | null;
  branch_name: string | null;
  logo_customer_specode4: string | null;
  logo_cashbox_code: string | null;
  logo_cashbox_name: string | null;
  logo_expense_account_code: string | null;
  logo_expense_account_name: string | null;
  selected_customer_id: number | null;
  name: string;
  username: string;
  email: string | null;
  phone: string | null;
  is_active: boolean;
  menu_permissions: string[];
  feature_permissions: string[];
  permissions_updated_at?: string | null;
  created_at: string | null;
  assigned_customers_count: number;
  dealer: {
    id: number | null;
    code: string | null;
    name: string | null;
  };
  selected_customer: {
    id: number | null;
    code: string | null;
    title: string | null;
  };
  roles: ApiRole[];
};

export type ModeratorCustomerRecord = {
  id: number;
  dealer_id: number;
  salesperson_user_id: number | null;
  region_code: string | null;
  region_name: string | null;
  branch_code: string | null;
  branch_name: string | null;
  source_system: string | null;
  source_reference: string | null;
  sync_status: string | null;
  sync_error: string | null;
  code: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  district: string | null;
  tax_office: string | null;
  tax_number: string | null;
  credit_limit: string;
  special_discount_rate: string | null;
  balance_summary?: {
    total_due: string;
    order_due: string;
    currency: string;
  };
  balance_source?: "b2b" | "logo";
  is_active: boolean;
  address: string | null;
  iban: string | null;
  created_at: string | null;
  dealer: {
    id: number | null;
    code: string | null;
    name: string | null;
  };
  salesperson: {
    id: number | null;
    name: string | null;
    email: string | null;
    phone: string | null;
  };
};

export type VirtualPosSettingsDto = {
  enabled: boolean;
  mode: "test" | "live";
  gateway_url: string;
  merchant_no: string;
  username: string;
  has_security_code: boolean;
  has_password: boolean;
};

export type VirtualPosSettingsPayload = {
  enabled?: boolean;
  mode?: "test" | "live";
  gateway_url?: string;
  merchant_no?: string;
  username?: string;
  security_code?: string;
  password?: string;
};

export type ModeratorOverviewResponse = {
  summary: {
    users_total: number;
    active_users_total: number;
    customers_total: number;
    active_customers_total: number;
    salespeople_total: number;
    assigned_customers_total: number;
    unassigned_customers_total: number;
  };
  roles: ModeratorRoleOption[];
  menu_permissions: ModeratorMenuPermissionOption[];
  feature_permissions: CustomerUserFeaturePermissionOption[];
  system_settings: {
    complaint_mail_to: string;
    batum_exchange_rate: string;
    batum_exchange_multiplier: string;
    virtual_pos: VirtualPosSettingsDto;
  };
  dealers: ModeratorDealerRecord[];
  users: ModeratorUserRecord[];
  customers: ModeratorCustomerRecord[];
};

export type ModeratorOverviewParams = {
  include_customers?: boolean;
  customer_limit?: number;
  customer_q?: string;
};

export type CustomerUserRecord = {
  id: number;
  code: string;
  name: string;
  username: string;
  special_discount_rate: string | null;
  allowed_brand_ids: number[] | null;
  brand_discounts: CustomerBrandDiscount[];
  user: {
    id: number;
    username: string;
    is_active: boolean;
    menu_permissions: string[];
    feature_permissions: string[];
    permissions_updated_at?: string | null;
  } | null;
};

export type CustomerUserPermissionOption = {
  key: string;
  label: string;
  href?: string;
};

export type CustomerUserFeaturePermissionOption = {
  key: string;
  label: string;
  menu_key: string;
};

export type CustomerUsersResponse = {
  data: CustomerUserRecord[];
  total_count: number;
  limit: number;
  menu_permissions: CustomerUserPermissionOption[];
  feature_permissions: CustomerUserFeaturePermissionOption[];
  system_settings: {
    complaint_mail_to: string;
    batum_exchange_rate: string;
    batum_exchange_multiplier: string;
  };
  default_menu_permissions: string[];
  brands: Array<{ id: number; name: string }>;
};

export type CursorResponse<T> = {
  data: T[];
  next_cursor: string | null;
  prev_cursor: string | null;
  limit: number;
  total_count?: number;
  current_page?: number;
  total_pages?: number;
  search_backend?: string;
  meta?: Record<string, unknown>;
};

export type ProductPreviousPurchase = {
  order_id?: number | null;
  order_no?: string | null;
  invoice_no?: string | null;
  status?: string | null;
  quantity: number;
  unit_net_price?: string | null;
  discount_rate?: string | null;
  tax_rate?: string | null;
  line_total?: string | null;
  currency?: string | null;
  ordered_at?: string | null;
};

export type ProductPreviousPurchaseHistoryItem = {
  date?: string | null;
  document_no?: string | null;
  description?: string | null;
  quantity: number;
  unit?: string | null;
  unit_price: number;
  net_price: number;
  discounts: number[];
  gross_total: number;
  net_total: number;
};

export type ProductPreviousPurchaseHistorySummary = {
  purchase_count: number;
  total_quantity: number;
  total_net_amount: number;
  last_purchase_date?: string | null;
  last_quantity?: number | null;
  last_net_price?: number | null;
  last_unit?: string | null;
};

export type ProductPreviousPurchasesResponse = {
  customer_id: number;
  customer_code: string;
  product_code: string;
  summary: ProductPreviousPurchaseHistorySummary;
  items: ProductPreviousPurchaseHistoryItem[];
};

export type ProductSearchItem = {
  id: number;
  sku: string;
  oem?: string | null;
  name: string;
  type_name?: string | null;
  description?: string | null;
  image_url?: string | null;
  image_data_url?: string | null;
  logo_synced_at?: string | null;
  brand: {
    id: number | null;
    name: string | null;
  };
  category?: {
    id: number | null;
    name: string | null;
  };
  meta?: {
    kod1: string | null;
    kod2: string | null;
    kod3: string | null;
    specode4?: string | null;
    specode5?: string | null;
    stok_turu: string | null;
  };
  net_price: string | null;
  list_price?: string | null;
  currency?: string | null;
  special_discount_rate?: string | null;
  special_discounted_price?: string | null;
  price_cards?: Array<{
    code: string;
    label: string;
    price: string | null;
    currency: string | null;
  }>;
  campaigns?: Array<{
    key: string;
    name: string;
    tiers: Array<{
      min_quantity: number;
      unit_price: string | null;
      currency: string;
      discount_percent?: number | null;
      condition?: string | null;
      starts_at?: string | null;
      ends_at?: string | null;
    }>;
  }>;
  vat_rate?: string | null;
  available_total: number;
  open_cart_quantity?: number;
  package_quantity?: string | null;
  shelf_address?: string | null;
  stock_locations?: Array<{
    branch: string;
    warehouse_code?: string | null;
    stock: number;
    shelf_address?: string | null;
  }>;
  competitor_codes?: Array<{
    code: string;
    type: "competitor" | "equivalent" | string;
    brand_name?: string | null;
    source?: string | null;
  }>;
  vehicle_fitments?: Array<{
    vehicle_id?: number | null;
    make?: string | null;
    model?: string | null;
    trim?: string | null;
    engine?: string | null;
    fuel_type?: string | null;
    year_from?: number | null;
    year_to?: number | null;
    position?: string | null;
    fitment_note?: string | null;
  }>;
  previous_purchase?: ProductPreviousPurchase | ProductPreviousPurchase[] | null;
  created_at?: string;
  rank?: number | null;
};

export type ProductFilterBrandOption = {
  id: number;
  name: string;
};

export type ProductFilterCategoryOption = {
  id: number;
  name: string;
  parent_id: number | null;
};

export type ProductFilterVehicleYearOption = {
  vehicle_id: number;
  label: string;
};

export type ProductFilterVehicleTypeOption = {
  type: string;
  years: ProductFilterVehicleYearOption[];
};

export type ProductFilterVehicleModelOption = {
  model: string;
  types: ProductFilterVehicleTypeOption[];
};

export type ProductFilterVehicleMakeOption = {
  make: string;
  models: ProductFilterVehicleModelOption[];
};

export type ProductFilterOptionsResponse = {
  brands: ProductFilterBrandOption[];
  categories: ProductFilterCategoryOption[];
  vehicles: ProductFilterVehicleMakeOption[];
  meta: {
    kod1: string[];
    kod2: string[];
    kod3: string[];
    specode4: string[];
    specode5: string[];
    stok_turu: string[];
  };
};

export type CustomerListItem = {
  id: number;
  dealer_id: number | null;
  code: string;
  title: string;
  city: string | null;
  district: string | null;
  phone: string | null;
  region_code?: string | null;
  region_name?: string | null;
  branch_code?: string | null;
  branch_name?: string | null;
  source_system?: string | null;
  source_reference?: string | null;
  price_group?: string | null;
  last_synced_at?: string | null;
  balance_summary: {
    total_due: string;
    order_due: string;
    currency: string;
  };
  balance_source?: "b2b" | "logo";
  has_cart: boolean;
};

export type CustomerPriceGroupOption = {
  code: string;
  label: string;
};

export type CustomerListMeta = {
  price_groups?: CustomerPriceGroupOption[];
};

export type CartItemDto = {
  id: number;
  product_id: number;
  sku: string;
  name: string;
  brand: string | null;
  stock: number;
  available_total: number;
  qty: number;
  quantity: number;
  unit_price: string;
  unit_net_price: string;
  discount: string;
  discount_rate: string;
  vat_rate: string;
  line_total: string;
  currency: string;
  campaign_key?: string | null;
};

export type CartWarehouseOption = {
  warehouse_id: number | null;
  warehouse_code: string | null;
  warehouse_name: string;
  available_total: number;
  stock_covered_quantity: number;
  missing_quantity: number;
  order_quantity: number;
  item_count: number;
  is_active: boolean;
};

export type CartResponse = {
  cart: {
    id: number;
    dealer_id: number;
    customer_id: number;
    status: string;
    currency: string;
    note?: string | null;
    shipping_method?: string | null;
    warehouse_transfer?: boolean;
    order_note?: string | null;
    updated_at: string;
  } | null;
  items: CartItemDto[];
  warehouse_options?: CartWarehouseOption[];
  logo_integration?: {
    customer_ready: boolean;
    customer_source_system: string | null;
    customer_external_ref: string | null;
    customer_last_synced_at: string | null;
    items_total: number;
    items_ready: number;
    items_missing: number;
    latest_product_synced_at: string | null;
    order_will_queue: boolean;
  };
  totals: {
    total: string;
    discount_total: string;
    net_total: string;
    vat_total: string;
    grand_total: string;
    subtotal: string;
    line_count: number;
  };
  message?: string;
};

export type UserNoteStatus = "open" | "done";
export type UserNotePriority = "low" | "normal" | "high";

export type UserNote = {
  id: number;
  user_id: number;
  created_by: {
    id: number;
    name: string | null;
    username: string | null;
  };
  title: string;
  body: string | null;
  status: UserNoteStatus;
  priority: UserNotePriority;
  is_pinned: boolean;
  due_date: string | null;
  completed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type UserNotesResponse = {
  data: UserNote[];
  summary: {
    open: number;
    done: number;
  };
};

export type OrderCreateResponse = {
  order: {
    id: number;
    order_no: string;
    status: string;
    dealer_id: number;
    customer_id: number;
    currency: string;
    subtotal: string;
    discount_total: string;
    tax_total: string;
    grand_total: string;
    ordered_at: string;
    items: Array<{
      id: number;
      product_id: number;
      sku: string;
      name: string;
      brand: string | null;
      quantity: number;
      shipped_qty: number;
      remaining_quantity: number;
      unit_net_price: string;
      tax_rate: string;
      line_total: string;
      currency: string;
      logo_stock?: {
        available_total: number;
        erzurum_depo_available_total?: number | null;
        reserved_total: number;
        updated_at: string | null;
      };
    }>;
  };
  status_timeline: Array<{
    id: number;
    status: string;
    note: string | null;
    changed_by: {
      id: number | null;
      name: string | null;
    };
    created_at: string;
  }>;
};

export type OrderDetailResponse = {
  order: {
    id: number;
    order_no: string;
    status: string;
    dealer_id: number;
    customer_id: number;
    currency: string;
    subtotal: string;
    discount_total: string;
    tax_total: string;
    grand_total: string;
    ordered_at: string;
    approved_at?: string | null;
    shipping_method?: string | null;
    note?: string | null;
    logo_sync_status?: string | null;
    logo_sync_error?: string | null;
    logo_external_ref?: string | null;
    logo_last_synced_at?: string | null;
    created_by?: {
      id: number | null;
      name: string | null;
      role_slugs?: string[];
    };
    salesperson?: {
      id: number | null;
      name: string | null;
    };
    origin?: {
      source: string | null;
      source_label: string | null;
      panel: string | null;
      panel_label: string | null;
      warehouse_dispatch: boolean;
      checkout_summary: {
        mode: "detailed" | "excluded" | "included";
        code: string;
        label: string;
      } | null;
      sales_price_type?: string | null;
      sales_price_type_label?: string | null;
      payment_method?: string | null;
      shipping_method: string | null;
      target_warehouse_code?: string | null;
      target_warehouse_name?: string | null;
      note: string | null;
    };
    invoice?: {
      id: number | null;
      reference_no: string | null;
      description: string | null;
      created_at: string | null;
      created_by: {
        id: number | null;
        name: string | null;
      };
    };
    customer?: {
      id: number | null;
      code: string | null;
      title: string | null;
      address?: string | null;
      city?: string | null;
      district?: string | null;
      phone?: string | null;
      tax_office?: string | null;
      tax_number?: string | null;
    };
    items: Array<{
      id: number;
      product_id: number;
      sku: string | null;
      name: string | null;
      brand: string | null;
      quantity: number;
      shipped_qty?: number;
      remaining_quantity?: number;
      returned_quantity?: number;
      returnable_quantity?: number;
      unit_net_price: string;
      tax_rate: string;
      line_total: string;
      currency: string;
      barcode?: string | null;
      shelf_address?: string | null;
      logo_stock?: {
        available_total: number;
        erzurum_depo_available_total?: number | null;
        print_warehouse_code?: string | null;
        print_warehouse_name?: string | null;
        print_warehouse_available_total?: number | null;
        reserved_total: number;
        updated_at: string | null;
      };
    }>;
  };
  status_timeline: Array<{
    id: number;
    status: string;
    note: string | null;
    changed_by: {
      id: number | null;
      name: string | null;
    };
    created_at: string;
  }>;
};

export type OrderListItem = {
  id: number;
  order_id: number;
  order_no: string;
  status: string;
  dealer_id: number;
  customer_id?: number | null;
  customer: {
    id: number | null;
    code: string | null;
    title: string | null;
  };
  currency: string;
  subtotal: string;
  discount_total: string;
  tax_total: string;
  grand_total: string;
  item_count: number;
  total_quantity: number;
  shipped_quantity: number;
  remaining_quantity: number;
  ordered_at: string | null;
  approved_at: string | null;
  logo_sync_status?: string | null;
  logo_sync_error?: string | null;
  logo_external_ref?: string | null;
  logo_last_synced_at?: string | null;
  checkout_summary?: {
    mode: "detailed" | "excluded" | "included";
    code: string;
    label: string;
  } | null;
  sales_price_type?: string | null;
  sales_price_type_label?: string | null;
  shipping_method?: string | null;
  origin?: {
    checkout_summary?: {
      mode: "detailed" | "excluded" | "included";
      code: string;
      label: string;
    } | null;
    sales_price_type?: string | null;
    sales_price_type_label?: string | null;
    shipping_method?: string | null;
  } | null;
  totals?: {
    currency: string;
    subtotal: string;
    discount_total: string;
    tax_total: string;
    grand_total: string;
    item_count: number;
    total_quantity: number;
    shipped_quantity: number;
    remaining_quantity: number;
  };
  status_timeline_summary?: {
    total_events: number;
    last_event: {
      id: number;
      status: string;
      note: string | null;
      created_at: string;
      changed_by: {
        id: number | null;
        name: string | null;
      };
    } | null;
  };
};

export type OrderListResponse = CursorResponse<OrderListItem> & {
  summary?: {
    totals: {
      order_count: number;
      currency: string;
      subtotal: string;
      discount_total: string;
      tax_total: string;
      grand_total: string;
      item_count: number;
      total_quantity: number;
      shipped_quantity: number;
      remaining_quantity: number;
    };
    status_breakdown: Array<{
      status: string;
      order_count: number;
      grand_total: string;
    }>;
    status_timeline_summary: {
      total_events: number;
      orders_with_events: number;
      latest_event_at: string | null;
    };
  };
};

export type ReturnRequestListItem = {
  id: number;
  request_no: string;
  request_type: "return" | "damaged" | "faulty";
  status: "submitted" | "reviewing" | "approved" | "rejected" | "completed" | string;
  reason_code: string;
  reason_note: string | null;
  quantity: number;
  unit_price: string;
  currency: string;
  line_total: string;
  resolution_note: string | null;
  logo_sync_status?: string | null;
  logo_sync_error?: string | null;
  logo_external_ref?: string | null;
  logo_last_synced_at?: string | null;
  scrap_logo_sync_status?: string | null;
  scrap_logo_sync_error?: string | null;
  scrap_logo_external_ref?: string | null;
  scrap_logo_last_synced_at?: string | null;
  created_at: string | null;
  reviewed_at: string | null;
  customer: {
    id: number | null;
    code: string | null;
    title: string | null;
  };
  order: {
    id: number | null;
    order_no: string | null;
    ordered_at: string | null;
  };
  product: {
    id: number | null;
    sku: string | null;
    name: string | null;
    brand: string | null;
  };
  requested_by: {
    id: number | null;
    name: string | null;
  };
  reviewed_by: {
    id: number | null;
    name: string | null;
  };
};

export type ReturnRequestListResponse = CursorResponse<ReturnRequestListItem> & {
  summary?: {
    total_count: number;
    submitted_count: number;
    reviewing_count: number;
    closed_count: number;
    status_breakdown: Array<{
      status: string;
      count: number;
    }>;
    type_breakdown: Array<{
      request_type: string;
      count: number;
    }>;
  };
};

export type CustomerCardRequestListItem = {
  id: number;
  request_no: string;
  company_name: string;
  contact_name: string;
  phone: string;
  email: string | null;
  customer_kind: "person" | "company" | string;
  logo_special_code: string | null;
  logo_authorization_code: string | null;
  logo_e_collection_note: string | null;
  city: string;
  district: string | null;
  tax_office: string | null;
  tax_number: string | null;
  address: string | null;
  note: string | null;
  status: "submitted" | "reviewing" | "approved" | "rejected" | string;
  review_note: string | null;
  created_at: string | null;
  reviewed_at: string | null;
  dealer: {
    id: number | null;
    code: string | null;
    name: string | null;
  };
  salesperson: {
    id: number | null;
    dealer_id: number | null;
    name: string | null;
    email: string | null;
    phone: string | null;
  };
  customer: {
    id: number | null;
    code: string | null;
    title: string | null;
    city: string | null;
    district: string | null;
    phone: string | null;
  };
  requested_by: {
    id: number | null;
    name: string | null;
  };
  reviewed_by: {
    id: number | null;
    name: string | null;
  };
  converted_by: {
    id: number | null;
    name: string | null;
  };
  converted_at: string | null;
  attachments: Array<{
    id: number;
    attachment_type: "photo" | "tax_plate" | "tax_certificate" | "trade_registry" | "other" | string;
    original_name: string;
    mime_type: string | null;
    size_bytes: number;
    note: string | null;
    uploaded_at: string | null;
    uploaded_by: {
      id: number | null;
      name: string | null;
    };
    download_url: string;
  }>;
  attachment_requirements: {
    required_types: Array<{
      type: "photo" | "tax_plate" | "tax_certificate" | "trade_registry" | "other" | string;
      label: string;
    }>;
    uploaded_types: Array<"photo" | "tax_plate" | "tax_certificate" | "trade_registry" | "other" | string>;
    missing_types: Array<{
      type: "photo" | "tax_plate" | "tax_certificate" | "trade_registry" | "other" | string;
      label: string;
    }>;
    is_complete: boolean;
  };
};

export type CustomerCardSalesperson = {
  id: number;
  dealer_id: number | null;
  name: string;
  email: string | null;
  phone: string | null;
  dealer: {
    id: number | null;
    code: string | null;
    name: string | null;
  };
};

export type CreatedCustomerCardCustomer = {
  id: number;
  code: string;
  name: string;
  sync_status: string | null;
  logo_queue_status: string | null;
};

export type CustomerCardRequestListResponse = CursorResponse<CustomerCardRequestListItem> & {
  summary?: {
    total_count: number;
    submitted_count: number;
    reviewing_count: number;
    approved_count: number;
    rejected_count: number;
    converted_count: number;
    status_breakdown: Array<{
      status: string;
      count: number;
    }>;
  };
};

export type LedgerEntryType = "order" | "invoice" | "payment" | "return" | "credit" | "debit";
export type CollectionMethodFilter = "cash" | "transfer" | "check" | "note" | "cc" | "factory_cc";

export type LedgerEntryDto = {
  id: number;
  source_system?: string | null;
  source_reference?: string | null;
  last_synced_at?: string | null;
  date: string;
  type: LedgerEntryType;
  debit: string;
  credit: string;
  balance_after: string;
  description: string | null;
  currency: string;
  reference_no: string | null;
  order_id: number | null;
  collection_id: number | null;
  collection_method?: CollectionMethodFilter | "virtual_pos" | null;
  collection_method_label?: string | null;
  transaction_type?: LedgerEntryType | "transfer" | "offset" | "opening";
  transaction_type_label?: string;
  document_no?: string | null;
  document_date?: string | null;
  return_quantity?: number | null;
  return_total?: string | null;
  return_type_label?: string | null;
  source_document?: string | null;
  checkout_summary: {
    mode: "detailed" | "excluded" | "included";
    code: string;
    label: string;
  } | null;
  sales_price_type?: string | null;
  sales_price_type_label?: string | null;
  shipping_method?: string | null;
  shipping_method_label?: string | null;
  logo_invoice_detail?: {
    invoice_ref?: string | null;
    trcode?: number | null;
    document_kind?: string | null;
    total: string;
    lines: Array<{
      logo_line_ref?: string | null;
      line_no?: number | null;
      product_code?: string | null;
      product_name?: string | null;
      quantity: string;
      unit?: string | null;
      unit_price: string;
      discount_total: string;
      vat_rate: string;
      vat_amount: string;
      line_total: string;
      description?: string | null;
    }>;
  } | null;
  payment_method?: string | null;
};

export type LedgerSummaryDto = {
  total_debit: string;
  total_credit: string;
  balance: string;
  total_count: number;
  currency: string;
  total_return_amount?: string;
  total_return_quantity?: number;
};

export type PaginatedResponse<T> = {
  data: T[];
  links?: {
    first?: string | null;
    last?: string | null;
    prev?: string | null;
    next?: string | null;
  };
  meta?: {
    current_page: number;
    from: number | null;
    last_page: number;
    links: Array<{ url: string | null; label: string; active: boolean }>;
    path: string;
    per_page: number;
    to: number | null;
    total: number;
  };
  customer_id?: number;
  summary?: LedgerSummaryDto;
};

export type CollectionRecord = {
  id: number;
  record_type?: "collection" | "invoice";
  ledger_entry_id?: number | null;
  dealer_id: number;
  customer_id: number;
  source_system?: string | null;
  source_reference?: string | null;
  sync_status?: string | null;
  sync_error?: string | null;
  last_synced_at?: string | null;
  date: string;
  method: "cash" | "transfer" | "check" | "note" | "cc" | "factory_cc" | "invoice";
  amount: string;
  currency: string;
  reference_no: string | null;
  reference_fields: Record<string, string | number | boolean | null> | null;
  note: string | null;
  created_at: string;
  updated_at?: string;
};

export type CustomerCollectionsResponse = {
  customer_id: number;
  filters: {
    method: string | null;
    date_from: string | null;
    date_to: string | null;
  };
  tabs: Array<{
    method: "cash" | "transfer" | "check" | "note" | "cc" | "factory_cc" | "invoice";
    count: number;
    total_amount: string;
  }>;
  logo_sync?: {
    draft: number;
    pending: number;
    reviewing: number;
    synced: number;
    failed: number;
    latest_synced_at: string | null;
  };
  data: CollectionRecord[];
  meta: {
    current_page: number;
    last_page: number;
    per_page: number;
    total: number;
  };
};

export type ReportRunResponse = {
  run: {
    id: number;
    report_key: string;
    status: "queued" | "running" | "completed" | "failed";
    parameters: Record<string, unknown> | null;
    result: Record<string, unknown> | null;
    error_message: string | null;
    started_at: string | null;
    completed_at: string | null;
    created_at: string;
    updated_at: string;
  };
};

export type ReportQueueResponse = {
  message: string;
  run: {
    id: number;
    report_key: string;
    status: string;
    created_at: string;
  };
};

export type PosSaleType = "cash" | "card" | "transfer";
export type PosDocumentType = "invoice" | "delivery";
export type PosSaleStatus = "paid" | "cancelled";
export type PosSessionStatus = "open" | "closed";

export type PosSessionDto = {
  id: number;
  status: PosSessionStatus;
  opened_at: string;
  opening_cash: string;
  closed_at: string | null;
  closing_cash_counted: string | null;
  cashbox: {
    id: number | null;
    code: string | null;
    name: string | null;
  };
  opened_by: {
    id: number | null;
    name: string | null;
    dealer_id?: number | null;
    branch_code?: string | null;
    branch_name?: string | null;
    region_code?: string | null;
    region_name?: string | null;
  };
  created_at: string;
  updated_at: string;
};

export type PosSaleItemDto = {
  id: number;
  product_id: number;
  sku: string | null;
  oem: string | null;
  name: string | null;
  brand: string | null;
  qty: string;
  unit_price: string;
  vat_rate: string;
  line_total: string;
  unit_price_vat_included?: string | null;
  line_total_vat_included?: string | null;
};

export type PosPaymentDto = {
  id: number;
  method: PosSaleType;
  amount: string;
  meta_json: Record<string, unknown> | null;
  created_at: string;
};

export type PosExpenseDto = {
  id: number;
  pos_session_id: number;
  expense_date: string | null;
  category: string;
  amount: string;
  currency: string;
  note: string | null;
  source_system?: "b2b" | "logo" | string | null;
  source_label?: string | null;
  cashbox: {
    id: number | null;
    code: string | null;
    name: string | null;
  };
  created_by: {
    id: number | null;
    name: string | null;
  };
  logo_sync_status?: string | null;
  logo_sync_error?: string | null;
  logo_external_ref?: string | null;
  logo_last_synced_at?: string | null;
  created_at: string;
};

export type PosSaleListItemDto = {
  id: number;
  receipt_no: string;
  status: PosSaleStatus;
  sale_type: PosSaleType;
  document_type: PosDocumentType;
  subtotal: string;
  discount_total: string;
  vat_total: string;
  grand_total: string;
  customer: {
    id: number | null;
    code: string | null;
    title: string | null;
  };
  cashbox: {
    id: number | null;
    code: string | null;
    name: string | null;
  };
  created_by: {
    id: number | null;
    name: string | null;
  };
  logo_sync_status?: string | null;
  logo_sync_error?: string | null;
  logo_external_ref?: string | null;
  logo_last_synced_at?: string | null;
  created_at: string;
};

export type PosSaleDto = {
  id: number;
  receipt_no: string;
  status: PosSaleStatus;
  sale_type: PosSaleType;
  document_type: PosDocumentType;
  subtotal: string;
  discount_total: string;
  vat_total: string;
  grand_total: string;
  customer: {
    id: number | null;
    code: string | null;
    title: string | null;
  };
  session: {
    id: number | null;
    status: PosSessionStatus | null;
    opened_at: string | null;
    cashbox: {
      id: number | null;
      code: string | null;
      name: string | null;
    };
  };
  created_by: {
    id: number | null;
    name: string | null;
  };
  items: PosSaleItemDto[];
  payments: PosPaymentDto[];
  logo_sync_status?: string | null;
  logo_sync_error?: string | null;
  logo_external_ref?: string | null;
  logo_last_synced_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type PosLogoSyncSummary = {
  total: number;
  queued: number;
  processing: number;
  synced: number;
  failed: number;
  missing: number;
};

export type PosDayEndReport = {
  filters: {
    pos_session_id: number | null;
    cashbox_id: number | null;
    date: string | null;
    date_from: string | null;
    date_to: string | null;
  };
  session: {
    id: number;
    status: PosSessionStatus;
    opened_at: string;
    closed_at: string | null;
    opening_cash: string;
    closing_cash_counted: string | null;
    cashbox: {
      id: number | null;
      code: string | null;
      name: string | null;
    };
    opened_by: {
      id: number | null;
      name: string | null;
    };
  } | null;
  summary: {
    sale_count: number;
    paid_count: number;
    cancelled_count: number;
    document_count: {
      invoice: number;
      delivery: number;
    };
    cash_total: string;
    vat_total: string;
    vat_total_cancelled: string;
    grand_total: string;
    grand_total_cancelled: string;
    expense_count: number;
    expense_total: string;
    cash_expense_total: string;
    bank_expense_total: string;
    bank_deposit_total: string;
    expected_cash: string | null;
    net_total: string;
  };
  totals_by_method: Array<{
    method: PosSaleType | "check" | "note" | "factory_cc";
    payment_count: number;
    total_amount: string;
  }>;
  expenses: {
    count: number;
    total_amount: string;
    by_category: Array<{
      category: string;
      expense_count: number;
      total_amount: string;
    }>;
    recent: PosExpenseDto[];
  };
  report_tables?: {
    normal_sales: Array<{
      id: number;
      receipt_no: string | null;
      customer_code: string | null;
      customer_name: string | null;
      sale_type: PosSaleType;
      document_type: "invoice" | "delivery";
      payment_method: PosSaleType;
      is_warehouse_sale?: boolean;
      grand_total: string;
      created_by_name?: string | null;
      warehouse_name?: string | null;
      items?: Array<{
        product_code: string | null;
        product_name: string | null;
        quantity: string;
        unit_price: string;
        line_total: string;
        unit_price_vat_included?: string | null;
        line_total_vat_included?: string | null;
        warehouse_name?: string | null;
      }>;
      created_at: string | null;
    }>;
    cash_sales: Array<{
      id: number;
      receipt_no: string | null;
      customer_code: string | null;
      customer_name: string | null;
      sale_type: PosSaleType;
      document_type: "invoice" | "delivery";
      payment_method: PosSaleType;
      is_warehouse_sale?: boolean;
      grand_total: string;
      created_by_name?: string | null;
      warehouse_name?: string | null;
      items?: Array<{
        product_code: string | null;
        product_name: string | null;
        quantity: string;
        unit_price: string;
        line_total: string;
        unit_price_vat_included?: string | null;
        line_total_vat_included?: string | null;
        warehouse_name?: string | null;
      }>;
      created_at: string | null;
    }>;
    card_sales: Array<{
      id: number;
      receipt_no: string | null;
      customer_code: string | null;
      customer_name: string | null;
      sale_type: PosSaleType;
      document_type: "invoice" | "delivery";
      payment_method: PosSaleType;
      is_warehouse_sale?: boolean;
      grand_total: string;
      created_by_name?: string | null;
      warehouse_name?: string | null;
      items?: Array<{
        product_code: string | null;
        product_name: string | null;
        quantity: string;
        unit_price: string;
        line_total: string;
        unit_price_vat_included?: string | null;
        line_total_vat_included?: string | null;
        warehouse_name?: string | null;
      }>;
      created_at: string | null;
    }>;
    cash_collections: Array<{
      id: number;
      reference_no: string | null;
      customer_code: string | null;
      customer_name: string | null;
      method: string;
      collection_channel?: string | null;
      day_end_bucket?: string;
      amount: string;
      date: string | null;
      created_at: string | null;
    }>;
    card_collections: Array<{
      id: number;
      reference_no: string | null;
      customer_code: string | null;
      customer_name: string | null;
      method: string;
      collection_channel?: string | null;
      day_end_bucket?: string;
      amount: string;
      date: string | null;
      created_at: string | null;
    }>;
    transfer_collections?: Array<{
      id: number;
      reference_no: string | null;
      customer_code: string | null;
      customer_name: string | null;
      method: string;
      collection_channel?: string | null;
      day_end_bucket?: string;
      amount: string;
      date: string | null;
      created_at: string | null;
    }>;
    check_collections?: Array<{
      id: number;
      reference_no: string | null;
      customer_code: string | null;
      customer_name: string | null;
      method: string;
      collection_channel?: string | null;
      day_end_bucket?: string;
      amount: string;
      date: string | null;
      created_at: string | null;
    }>;
    note_collections?: Array<{
      id: number;
      reference_no: string | null;
      customer_code: string | null;
      customer_name: string | null;
      method: string;
      collection_channel?: string | null;
      day_end_bucket?: string;
      amount: string;
      date: string | null;
      created_at: string | null;
    }>;
    factory_card_collections?: Array<{
      id: number;
      reference_no: string | null;
      customer_code: string | null;
      customer_name: string | null;
      method: string;
      collection_channel?: string | null;
      day_end_bucket?: string;
      amount: string;
      date: string | null;
      created_at: string | null;
    }>;
  };
  cancelled: {
    count: number;
    total_amount: string;
  };
  logo_sync: {
    sales: PosLogoSyncSummary;
    expenses: PosLogoSyncSummary;
    collections: PosLogoSyncSummary;
  };
  generated_at: string;
};

export type WarehouseReadyOrderItem = {
  id: number;
  order_no: string;
  dealer_id: number;
  customer_id: number;
  status: string;
  ordered_at: string | null;
  approved_at: string | null;
  currency: string;
  grand_total: string;
  customer: {
    id: number | null;
    code: string | null;
    title: string | null;
  };
  created_by?: {
    id: number | null;
    name: string | null;
    role_slugs?: string[];
  };
  salesperson?: {
    id: number | null;
    name: string | null;
  };
  origin?: {
    source: string | null;
    source_label: string | null;
    panel: string | null;
    panel_label: string | null;
    warehouse_dispatch: boolean;
    checkout_summary: {
      mode: "detailed" | "excluded" | "included";
      code: string;
      label: string;
    } | null;
    sales_price_type?: string | null;
    sales_price_type_label?: string | null;
    payment_method?: string | null;
    shipping_method: string | null;
    note: string | null;
    document_type?: string | null;
    document_label?: string | null;
    transfer_status?: string | null;
    transfer_source_warehouse_code?: string | null;
    transfer_source_warehouse_name?: string | null;
    transfer_target_warehouse_code?: string | null;
    transfer_target_warehouse_name?: string | null;
  };
  invoice?: {
    id: number | null;
    reference_no: string | null;
    description: string | null;
    created_at: string | null;
    created_by: {
      id: number | null;
      name: string | null;
    };
  };
  items_summary?: {
    item_count: number;
    total_quantity: number;
  };
  logo_stock_summary?: {
    source: "logo" | string;
    stock_covered_quantity: number;
    missing_quantity: number;
    low_stock_count: number;
    missing_stock_count: number;
    updated_at: string | null;
  };
  logo_warehouse_options?: Array<{
    warehouse_id: number | null;
    warehouse_code: string | null;
    warehouse_name: string;
    available_total: number;
    stock_covered_quantity: number;
    missing_quantity: number;
    order_quantity: number;
    item_count: number;
    is_active: boolean;
  }>;
  preferred_warehouse_code?: string | null;
  shipment?: {
    id: number;
    status: string;
  } | null;
};

export type CustomerBrandDiscount = {
  brand_id: number;
  discount_1: string | number;
  discount_2: string | number;
  discount_3: string | number;
};

export type FinanceDefinitionDto = {
  id: number;
  type: "bank" | "pos_device" | "card_type" | "factory" | "expense_category" | "shipping_rule";
  code: string;
  name: string;
  logo_code: string | null;
  logo_name: string | null;
  meta: Record<string, unknown> | null;
  sort_order: number;
  is_active: boolean;
};

export type CustomerComplaintResponse = {
  data: {
    id: number;
    status: string;
    sent_at: string | null;
  };
  message?: string;
};

export type WarehouseShipmentItemDto = {
  id: number;
  order_item_id: number;
  product_id: number;
  sku: string | null;
  oem: string | null;
  name: string | null;
  shelf_address?: string | null;
  ordered_qty: number;
  shipped_qty: number;
  remaining_qty: number;
  unit_price: string;
  vat_rate: string;
  line_total_shipped: string;
  logo_stock?: {
    available_total: number;
    reserved_total: number;
    updated_at: string | null;
  };
};

export type WarehouseStaffUser = {
  id: number;
  dealer_id: number | null;
  name: string;
  username?: string | null;
  email: string;
  phone: string | null;
  branch_code?: string | null;
  branch_name?: string | null;
  roles: Array<{
    id: number;
    name: string;
    slug: string;
  }>;
};

export type WarehouseShelfProduct = {
  id: number;
  product_code: string;
  product_name: string;
  brand?: string | null;
  oem?: string | null;
  oem_codes?: string[];
  competitor_codes: string[];
  warehouse_code: string;
  warehouse_name: string;
  shelf_address?: string | null;
  shelf_updated_at?: string | null;
  shelf_updated_by?: string | null;
  editable: boolean;
  logo_ref?: string | null;
  logo_status?: {
    status?: string | null;
    error?: string | null;
    updated_at?: string | null;
  } | null;
};

export type WarehouseShelfResponse = {
  data: WarehouseShelfProduct[];
  warehouse: {
    code: string;
    name: string;
    editable: boolean;
  };
  warehouses?: Array<{
    code: string;
    name: string;
    editable: boolean;
  }>;
  can_choose_warehouse?: boolean;
};

export type CollectionApprovalRecord = {
  id: number;
  customer_id: number;
  customer_code: string | null;
  customer_name: string | null;
  method: "check" | "note";
  method_label: string;
  amount: string;
  currency: string;
  reference_no: string | null;
  document_no: string | null;
  due_date: string | null;
  valor_days: number | string | null;
  sender_name: string | null;
  sender_username: string | null;
  created_at: string | null;
};

export type WarehouseShipmentState = {
  shipment: {
    id: number;
    shipment_no: string;
    status: string;
    order_id: number;
    warehouse_id: number;
    carrier_name: string | null;
    tracking_no: string | null;
    note: string | null;
    shipped_at: string | null;
    logo_sync_status?: string | null;
    logo_sync_error?: string | null;
    logo_external_ref?: string | null;
    logo_last_synced_at?: string | null;
    created_at: string;
    updated_at: string;
    order: {
      id: number | null;
      order_no: string | null;
      status: string | null;
      currency?: string | null;
      grand_total?: string | number | null;
      customer: {
        id: number | null;
        code: string | null;
        title: string | null;
        city?: string | null;
        district?: string | null;
        address?: string | null;
        phone?: string | null;
      };
    };
    warehouse: {
      id: number | null;
      code: string | null;
      name: string | null;
    };
    origin?: {
      document_type?: "warehouse_transfer" | "shipment_invoice" | string | null;
      document_label?: string | null;
      transfer_status?: string | null;
      transfer_source_warehouse_code?: string | null;
      transfer_source_warehouse_name?: string | null;
      transfer_target_warehouse_code?: string | null;
      transfer_target_warehouse_name?: string | null;
    };
  };
  remaining_items: WarehouseShipmentItemDto[];
  shipped_items: WarehouseShipmentItemDto[];
  totals: {
    ordered_qty_total: number;
    shipped_qty_total: number;
    remaining_qty_total: number;
    sent_amount: string;
    gonderilen_tutar: string;
  };
  recent_scans: Array<{
    id: number;
    product_id: number;
    barcode: string;
    qty: number;
    scanned_at: string;
    scanned_by: {
      id: number | null;
      name: string | null;
    };
  }>;
  message?: string;
  gonderilen_tutar?: string;
  logo_document_type?: "warehouse_transfer" | "shipment_invoice" | string | null;
};

export type PurchaseReceiptItemPayload = {
  product_code?: string | null;
  product_name: string;
  expected_quantity: number;
  accepted_quantity: number;
  note?: string | null;
  warehouse_code?: string | null;
  warehouse_name?: string | null;
  shelf_address?: string | null;
  current_stock?: number | null;
  new_total_stock?: number | null;
};

export type PurchaseReceiptRecord = {
  id: number;
  receipt_no: string;
  document_no: string | null;
  supplier_name: string | null;
  warehouse_code: string | null;
  warehouse_name: string | null;
  received_at: string | null;
  note: string | null;
  status: string;
  logo_sync_status?: string | null;
  logo_sync_error?: string | null;
  logo_external_ref?: string | null;
  logo_last_synced_at?: string | null;
  items: Array<PurchaseReceiptItemPayload & { id: number }>;
};

const CONFIGURED_API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
const LOGIN_PATH = "/login";
const LOGIN_VERSION = "20260605-login-fast";
const API_REQUEST_TIMEOUT_MS = 20_000;

function stripTrailingApiSegment(base: string): string {
  return base.replace(/\/api\/?$/i, "").replace(/\/$/, "");
}

function buildLoginUrl(next?: string | null): string {
  const search = new URLSearchParams();
  search.set("v", LOGIN_VERSION);

  if (next) {
    search.set("next", next);
  }

  return `${LOGIN_PATH}?${search.toString()}`;
}

let unauthorizedRedirectInFlight = false;

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function getApiBase(): string {
  try {
    const url = new URL(CONFIGURED_API_BASE);

    if (typeof window === "undefined") {
      return stripTrailingApiSegment(url.toString());
    }

    const appHost = window.location.hostname;

    if (isLoopbackHost(url.hostname)) {
      if (!isLoopbackHost(appHost)) {
        return `${window.location.origin}/backend`;
      }

      if (url.hostname !== appHost) {
        url.hostname = appHost;
        return stripTrailingApiSegment(url.toString());
      }
    }

    if (!isLoopbackHost(appHost) && url.pathname === "/") {
      return `${window.location.origin}/backend`;
    }

    return stripTrailingApiSegment(url.toString());
  } catch {
    if (typeof window !== "undefined" && !isLoopbackHost(window.location.hostname)) {
      return `${window.location.origin}/backend`;
    }

    return stripTrailingApiSegment(CONFIGURED_API_BASE);
  }
}

export function resolveApiBaseUrl(): string {
  return getApiBase();
}

function handleUnauthorizedRedirect() {
  if (typeof window === "undefined" || unauthorizedRedirectInFlight) {
    return;
  }

  const currentPath = window.location.pathname;
  if (currentPath.startsWith(LOGIN_PATH)) {
    return;
  }

  unauthorizedRedirectInFlight = true;
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(buildLoginUrl(next));
}

function isHtmlResponse(contentType: string): boolean {
  return contentType.toLowerCase().includes("text/html");
}

async function readResponsePreview(response: Response): Promise<string> {
  return (await response.clone().text().catch(() => "")).slice(0, 240).trim();
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const apiBase = getApiBase();
  const method = (init?.method ?? "GET").toUpperCase();
  const isFormDataBody = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const sanctumHeaders = getSanctumHeaders(method);
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), API_REQUEST_TIMEOUT_MS);
  const requestSignal = init?.signal;
  const abortController = new AbortController();
  const abortRequest = () => abortController.abort();

  if (isFormDataBody) {
    delete sanctumHeaders["Content-Type"];
  }

  requestSignal?.addEventListener("abort", abortRequest, { once: true });
  timeoutController.signal.addEventListener("abort", abortRequest, { once: true });

  let response: Response;

  try {
    response = await fetch(`${apiBase}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        ...sanctumHeaders,
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
      signal: abortController.signal,
    });
  } catch (error) {
    if (timeoutController.signal.aborted && !requestSignal?.aborted) {
      throw new ApiClientError("İstek zaman aşımına uğradı. Lütfen tekrar deneyin.", 408);
    }

    if (error instanceof TypeError) {
      throw new ApiClientError("Sunucuya ulaşılamadı. Bağlantıyı kontrol edip tekrar deneyin.", 0);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
    requestSignal?.removeEventListener("abort", abortRequest);
    timeoutController.signal.removeEventListener("abort", abortRequest);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isJsonResponse = contentType.toLowerCase().includes("application/json");

  if (!response.ok) {
    const maybeJson = isJsonResponse
      ? ((await response.json().catch(() => null)) as ApiErrorPayload | null)
      : null;
    const fallbackMessage = `Request failed: ${response.status}`;
    const firstErrorMessage = maybeJson?.errors
      ? (() => {
          const firstKey = Object.keys(maybeJson.errors)[0];
          const firstError = firstKey ? maybeJson.errors[firstKey]?.[0] : null;
          return firstError ?? null;
        })()
      : null;

    const message = firstErrorMessage ?? maybeJson?.message ?? fallbackMessage;

    if (response.status === 401) {
      handleUnauthorizedRedirect();
    }

    throw new ApiClientError(message, response.status, maybeJson ?? undefined);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  if (!isJsonResponse) {
    if (isHtmlResponse(contentType)) {
      const preview = await readResponsePreview(response);

      if (response.url.includes(LOGIN_PATH) || preview.toLowerCase().includes("<!doctype html")) {
        handleUnauthorizedRedirect();
        throw new ApiClientError("Oturum sayfasına yönlendirildi. Lütfen tekrar giriş yapın.", 401);
      }
    }

    throw new ApiClientError(
      `API JSON yerine ${contentType || "bilinmeyen"} döndürdü.`,
      response.status || 500
    );
  }

  return (await response.json()) as T;
}

function toSearch(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  const encodeQueryValue = (value: unknown): string => {
    if (typeof value === "boolean") {
      return value ? "1" : "0";
    }

    return String(value);
  };

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => search.append(`${key}[]`, encodeQueryValue(item)));
      return;
    }

    search.set(key, encodeQueryValue(value));
  });

  const query = search.toString();
  return query ? `?${query}` : "";
}

export async function ensureCsrfCookie(): Promise<void> {
  const apiBase = getApiBase();
  const response = await fetch(`${apiBase}/sanctum/csrf-cookie`, {
    credentials: "include",
    headers: getSanctumCsrfHeaders(),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new ApiClientError("Oturum doğrulaması başlatılamadı. Lütfen tekrar deneyin.", response.status || 500);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (isHtmlResponse(contentType)) {
    throw new ApiClientError("Oturum doğrulaması API yerine HTML döndürdü. Lütfen sayfayı yenileyin.", 500);
  }
}

export async function login(payload: {
  username: string;
  password: string;
  remember?: boolean;
}): Promise<{ user: ApiUser }> {
  return apiFetch<{ user: ApiUser }>("/api/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function logout(): Promise<void> {
  return apiFetch<void>("/api/logout", {
    method: "POST",
  });
}

export async function getMe(): Promise<{ user: ApiUser }> {
  return apiFetch<{ user: ApiUser }>("/api/me");
}

export async function listUserNotes(params?: { status?: "open" | "done" | "all" }): Promise<UserNotesResponse> {
  return apiFetch<UserNotesResponse>(`/api/notes${toSearch(params ?? {})}`);
}

export async function createUserNote(payload: {
  title: string;
  body?: string | null;
  priority?: UserNotePriority;
  status?: UserNoteStatus;
  is_pinned?: boolean;
  due_date?: string | null;
}): Promise<{ data: UserNote }> {
  return apiFetch<{ data: UserNote }>("/api/notes", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateUserNote(
  noteId: number,
  payload: Partial<{
    title: string;
    body: string | null;
    priority: UserNotePriority;
    status: UserNoteStatus;
    is_pinned: boolean;
    due_date: string | null;
  }>
): Promise<{ data: UserNote }> {
  return apiFetch<{ data: UserNote }>(`/api/notes/${noteId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function deleteUserNote(noteId: number): Promise<{ message: string }> {
  return apiFetch<{ message: string }>(`/api/notes/${noteId}`, {
    method: "DELETE",
  });
}

export async function updateProfile(payload: {
  username: string;
  avatar_url?: string | null;
  current_password?: string;
  new_password?: string;
}): Promise<{ user: ApiUser }> {
  return apiFetch<{ user: ApiUser }>("/api/profile", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function getContext(): Promise<{
  context: {
    customer: CustomerSummary | null;
  };
}> {
  return apiFetch("/api/context");
}

export async function setContextCustomer(customerId: number): Promise<{
  context: {
    customer: CustomerSummary | null;
  };
}> {
  return apiFetch("/api/context/customer", {
    method: "POST",
    body: JSON.stringify({ customer_id: customerId }),
  });
}

export async function clearContextCustomer(): Promise<{
  context: {
    customer: null;
  };
}> {
  return apiFetch("/api/context/customer", {
    method: "DELETE",
  });
}

export async function listCustomers(params: {
  q?: string;
  has_cart?: boolean;
  has_order_balance?: boolean;
  price_group?: string;
  source_system?: "logo" | "b2b";
  selection_mode?: boolean;
  fast?: boolean;
  summary?: "count";
  cursor?: string;
  limit?: number;
  cache_bust?: number;
}) {
  return apiFetch<CursorResponse<CustomerListItem> & { meta?: CustomerListMeta }>(`/api/customers${toSearch(params)}`);
}

export async function listPosCustomers(params?: {
  q?: string;
  cursor?: string;
  limit?: number;
  source_system?: "logo" | "b2b";
  specode4?: string;
}) {
  return apiFetch<CursorResponse<CustomerListItem>>(
    `/api/pos/customers${toSearch({ source_system: "logo", ...(params ?? {}) })}`
  );
}

export async function searchProducts(params: {
  q?: string;
  brand_id?: number;
  category_id?: number;
  kod1?: string;
  kod2?: string;
  kod3?: string;
  specode4?: string;
  specode5?: string;
  stok_turu?: string;
  vehicle_id?: number;
  in_stock?: boolean;
  sort?: "price_asc" | "price_desc" | "stock_desc";
  limit?: number;
  cursor?: string;
  page?: number;
  dealer_id?: number;
  customer_id?: number;
  include_equivalents?: boolean;
}, init?: RequestInit) {
  return apiFetch<CursorResponse<ProductSearchItem>>(`/api/products/search${toSearch(params)}`, init);
}

export async function getProductPreviousPurchases(productCode: string, params: {
  customer_id?: number;
  limit?: number;
}) {
  return apiFetch<ProductPreviousPurchasesResponse>(
    `/api/products/previous-purchases${toSearch({ ...params, product_code: productCode })}`
  );
}

export async function searchPosProductsQuick(params: {
  q: string;
  limit?: number;
  dealer_id?: number;
  customer_id?: number;
  in_stock?: boolean;
  code_only?: boolean;
}) {
  return apiFetch<{
    data: ProductSearchItem[];
    limit: number;
    search_backend: "pos_quick";
  }>(`/api/pos/products/quick-search${toSearch(params)}`);
}

export async function getProductFilterOptions(params?: {
  scope?: "full" | "search" | "brands";
}) {
  return apiFetch<ProductFilterOptionsResponse>(`/api/products/filter-options${toSearch(params ?? {})}`);
}

export async function getCatalogNewProducts(params: {
  cursor?: string;
  days?: number;
  limit?: number;
  dealer_id?: number;
}) {
  return apiFetch<CursorResponse<ProductSearchItem>>(`/api/catalog/new-products${toSearch(params)}`);
}

export async function getCatalogHotProducts(params: {
  cursor?: string;
  limit?: number;
  dealer_id?: number;
}) {
  return apiFetch<CursorResponse<ProductSearchItem>>(`/api/catalog/hot-products${toSearch(params)}`);
}

export async function getCart(params?: { customer_id?: number; dealer_id?: number }) {
  return apiFetch<CartResponse>(`/api/cart${toSearch(params ?? {})}`);
}

export async function upsertCartItem(payload: {
  product_id: number;
  quantity: number;
  customer_id?: number;
  dealer_id?: number;
  shipping_method?: string;
  warehouse_transfer?: boolean;
  order_note?: string;
  campaign_key?: string | null;
}) {
  return apiFetch<CartResponse>("/api/cart/items", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export type BulkCartItemResult = {
  row: number;
  product_code: string;
  resolved_code?: string | null;
  product_id?: number;
  quantity: number;
  status: "added" | "not_found" | "failed";
  message: string;
};

export type BulkCartItemsResponse = {
  summary: {
    received: number;
    added: number;
    failed: number;
  };
  results: BulkCartItemResult[];
  cart: CartResponse | null;
};

export async function bulkUpsertCartItems(payload: {
  items: Array<{ product_code: string; quantity: number }>;
  customer_id?: number;
  dealer_id?: number;
  shipping_method?: string;
  warehouse_transfer?: boolean;
  order_note?: string;
}) {
  return apiFetch<BulkCartItemsResponse>("/api/cart/items/bulk", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function deleteCartItem(itemId: number) {
  return apiFetch<void>(`/api/cart/items/${itemId}`, {
    method: "DELETE",
  });
}

export async function createOrder(payload?: {
  customer_id?: number;
  cart_id?: number;
  dealer_id?: number;
  note?: string;
  checkout_summary_mode?: "detailed" | "excluded" | "included";
  item_checkout_summary_modes?: Record<number | string, "detailed" | "excluded" | "included">;
  checkout_grand_total?: number;
  shipping_fee_amount?: number;
  selected_product_ids?: number[];
  payment_method?: string;
  sales_price_type?: string;
  warehouse_transfer_request?: boolean;
  shipping_target_warehouse_code?: string | null;
  shipping_target_warehouse_name?: string | null;
  transfer_source_warehouse_code?: string | null;
  transfer_source_warehouse_name?: string | null;
  transfer_target_warehouse_code?: string | null;
  transfer_target_warehouse_name?: string | null;
}) {
  return apiFetch<OrderCreateResponse>("/api/orders", {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });
}

export async function getOrderDetail(orderId: number) {
  return apiFetch<OrderDetailResponse>(`/api/orders/${orderId}`);
}

export async function updateWarehouseOrderItem(
  orderId: number,
  itemId: number,
  payload: {
    quantity: number;
  }
) {
  return apiFetch<OrderDetailResponse>(`/api/warehouse/orders/${orderId}/items/${itemId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function listOrders(params?: {
  q?: string;
  status?: string;
  statuses?: string[];
  dealer_id?: number;
  customer_id?: number;
  date?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
  cursor?: string;
}) {
  return apiFetch<OrderListResponse>(`/api/orders${toSearch(params ?? {})}`);
}

export async function listReturnRequests(params?: {
  q?: string;
  dealer_id?: number;
  customer_id?: number;
  status?: string;
  statuses?: string[];
  type?: "return" | "damaged" | "faulty";
  types?: Array<"return" | "damaged" | "faulty">;
  limit?: number;
  cursor?: string;
}) {
  return apiFetch<ReturnRequestListResponse>(`/api/returns${toSearch(params ?? {})}`);
}

export async function createReturnRequest(payload: {
  order_id: number;
  order_item_id: number;
  request_type: "return" | "damaged" | "faulty";
  reason_code: string;
  reason_note?: string;
  quantity: number;
}) {
  return apiFetch<{ data: ReturnRequestListItem }>("/api/returns", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateReturnRequestStatus(
  returnRequestId: number,
  payload: {
    status: "submitted" | "reviewing" | "approved" | "rejected" | "completed";
    resolution_note?: string;
  }
) {
  return apiFetch<{ data: ReturnRequestListItem }>(`/api/returns/${returnRequestId}/status`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function listCustomerCardRequests(params?: {
  q?: string;
  dealer_id?: number;
  status?: string;
  statuses?: Array<"submitted" | "reviewing" | "approved" | "rejected">;
  limit?: number;
  cursor?: string;
}) {
  return apiFetch<CustomerCardRequestListResponse>(`/api/customer-card-requests${toSearch(params ?? {})}`);
}

export async function listCustomerCardSalespeople(params?: { dealer_id?: number }) {
  return apiFetch<{ data: CustomerCardSalesperson[] }>(`/api/customer-card-salespeople${toSearch(params ?? {})}`);
}

export async function createCustomerCardRequest(payload: {
  dealer_id?: number;
  salesperson_user_id?: number;
  company_name: string;
  contact_name: string;
  phone: string;
  email?: string;
  customer_kind?: "person" | "company";
  logo_special_code?: string;
  logo_authorization_code?: string;
  auto_convert?: boolean;
  city: string;
  district?: string;
  tax_office?: string;
  tax_number?: string;
  address?: string;
  note?: string;
}) {
  return apiFetch<{ data: CustomerCardRequestListItem; customer: CreatedCustomerCardCustomer | null }>("/api/customer-card-requests", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function convertCustomerCardRequestToCustomer(customerCardRequestId: number) {
  return apiFetch<{ data: CustomerCardRequestListItem; customer: CreatedCustomerCardCustomer }>(
    `/api/customer-card-requests/${customerCardRequestId}/convert`,
    {
      method: "POST",
    }
  );
}

export async function uploadCustomerCardRequestAttachment(
  customerCardRequestId: number,
  payload: {
    attachment_type: "photo" | "tax_plate" | "tax_certificate" | "trade_registry" | "other";
    note?: string;
    file: File;
  }
) {
  const formData = new FormData();
  formData.set("attachment_type", payload.attachment_type);
  if (payload.note?.trim()) {
    formData.set("note", payload.note.trim());
  }
  formData.set("file", payload.file);

  return apiFetch<{ data: CustomerCardRequestListItem }>(
    `/api/customer-card-requests/${customerCardRequestId}/attachments`,
    {
      method: "POST",
      body: formData,
    }
  );
}

export async function createCustomerComplaint(payload: {
  subject: string;
  message: string;
  attachment?: File | null;
}) {
  const formData = new FormData();
  formData.set("subject", payload.subject);
  formData.set("message", payload.message);
  if (payload.attachment) {
    formData.set("attachment", payload.attachment);
  }

  return apiFetch<CustomerComplaintResponse>("/api/customer-complaints", {
    method: "POST",
    body: formData,
  });
}

export async function updateCustomerCardRequestStatus(
  customerCardRequestId: number,
  payload: {
    status: "submitted" | "reviewing" | "approved" | "rejected";
    review_note?: string;
  }
) {
  return apiFetch<{ data: CustomerCardRequestListItem }>(
    `/api/customer-card-requests/${customerCardRequestId}/status`,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
    }
  );
}

export async function getAdminDashboardOverview() {
  return apiFetch<AdminDashboardOverview>("/api/admin/dashboard/overview");
}

export async function getModeratorOverview(params?: ModeratorOverviewParams) {
  return apiFetch<ModeratorOverviewResponse>(`/api/moderator/overview${toSearch(params ?? {})}`);
}

export async function listCustomerUsers(params?: { q?: string; limit?: number }) {
  return apiFetch<CustomerUsersResponse>(`/api/customer-users${toSearch(params ?? {})}`);
}

export async function createCustomerUser(customerId: number, payload: {
  password?: string;
  is_active?: boolean;
  menu_permissions?: string[];
  feature_permissions?: string[];
  special_discount_rate?: number | null;
  allowed_brand_ids?: number[];
  brand_discounts?: CustomerBrandDiscount[];
}) {
  return apiFetch<{ data: CustomerUserRecord }>(`/api/customer-users/${customerId}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function createModeratorUser(payload: {
  dealer_id?: number | null;
  customer_scope?: "dealer" | "region" | "branch" | "assigned";
  region_code?: string | null;
  region_name?: string | null;
  branch_code?: string | null;
  branch_name?: string | null;
  logo_customer_specode4?: string | null;
  logo_cashbox_code?: string | null;
  logo_cashbox_name?: string | null;
  logo_expense_account_code?: string | null;
  logo_expense_account_name?: string | null;
  name: string;
  username: string;
  email?: string | null;
  phone?: string;
  password: string;
  is_active?: boolean;
  role_slugs?: string[];
  menu_permissions: string[];
  feature_permissions?: string[];
}) {
  return apiFetch<{ data: ModeratorUserRecord }>("/api/moderator/users", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateModeratorUser(
  userId: number,
  payload: {
    dealer_id?: number | null;
    customer_scope?: "dealer" | "region" | "branch" | "assigned";
    region_code?: string | null;
    region_name?: string | null;
    branch_code?: string | null;
    branch_name?: string | null;
    logo_customer_specode4?: string | null;
    logo_cashbox_code?: string | null;
    logo_cashbox_name?: string | null;
    logo_expense_account_code?: string | null;
    logo_expense_account_name?: string | null;
    name?: string;
    username?: string;
    email?: string | null;
    phone?: string | null;
    password?: string;
    is_active?: boolean;
    role_slugs?: string[];
    menu_permissions?: string[];
    feature_permissions?: string[];
  }
) {
  return apiFetch<{ data: ModeratorUserRecord }>(`/api/moderator/users/${userId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function resetModeratorUserPassword(userId: number, password: string) {
  return apiFetch<{ data: ModeratorUserRecord }>(`/api/moderator/users/${userId}/reset-password`, {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export async function deleteModeratorUser(userId: number) {
  return apiFetch<{ message: string }>(`/api/moderator/users/${userId}`, {
    method: "DELETE",
  });
}

export async function createModeratorCustomer(payload: {
  dealer_id: number;
  salesperson_user_id?: number | null;
  region_code?: string | null;
  region_name?: string | null;
  branch_code?: string | null;
  branch_name?: string | null;
  code: string;
  name: string;
  contact_name?: string;
  email?: string;
  phone?: string;
  city?: string;
  district?: string;
  tax_office?: string;
  tax_number?: string;
  credit_limit?: number;
  special_discount_rate?: number | null;
  is_active?: boolean;
  address?: string;
  iban?: string;
}) {
  return apiFetch<{ data: ModeratorCustomerRecord }>(`/api/moderator/customers`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateModeratorCustomer(
  customerId: number,
  payload: {
    dealer_id?: number;
    salesperson_user_id?: number | null;
    region_code?: string | null;
    region_name?: string | null;
    branch_code?: string | null;
    branch_name?: string | null;
    code?: string;
    name?: string;
    contact_name?: string | null;
    email?: string | null;
    phone?: string | null;
    city?: string | null;
    district?: string | null;
    tax_office?: string | null;
    tax_number?: string | null;
    credit_limit?: number;
    special_discount_rate?: number | null;
    is_active?: boolean;
    address?: string | null;
    iban?: string | null;
  }
) {
  return apiFetch<{ data: ModeratorCustomerRecord }>(`/api/moderator/customers/${customerId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function listCustomerLedger(
  customerId: number,
  params?: {
    date_from?: string;
    date_to?: string;
    type?: LedgerEntryType;
    collection_method?: CollectionMethodFilter;
    exclude_types?: LedgerEntryType[];
    per_page?: number;
    page?: number;
  }
) {
  return apiFetch<PaginatedResponse<LedgerEntryDto>>(
    `/api/customers/${customerId}/ledger${toSearch(params ?? {})}`
  );
}

export async function listCustomerCollections(
  customerId: number,
  params?: {
    method?: "cash" | "transfer" | "check" | "note" | "cc" | "factory_cc" | "invoice";
    date_from?: string;
    date_to?: string;
    per_page?: number;
    page?: number;
    include_summary?: boolean;
    compact?: boolean;
  }
) {
  return apiFetch<CustomerCollectionsResponse>(
    `/api/customers/${customerId}/collections${toSearch(params ?? {})}`
  );
}

export async function updateModeratorSystemSettings(payload: {
  complaint_mail_to?: string;
  batum_exchange_rate?: string;
  batum_exchange_multiplier?: string;
  virtual_pos?: VirtualPosSettingsPayload;
}) {
  return apiFetch<{ message: string; system_settings: ModeratorOverviewResponse["system_settings"] }>("/api/moderator/system-settings", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export type VirtualPosPaymentResponse = {
  payment: {
    status: "ready";
    reference: string;
    amount: string;
    currency: string;
    installment: number;
    description: string | null;
    customer: {
      id: number;
      code: string;
      title: string;
    };
  };
  provider: {
    mode: "test" | "live";
    integration: "nestpay_3d_pay_hosting";
    method: "POST";
    gateway_url: string;
    payload: Record<string, string | number | null> & {
      clientid: string;
      oid: string;
      amount: string;
      currency: string;
      taksit: string;
      okUrl: string;
      failUrl: string;
      islemtipi: string;
      storetype: string;
      lang: string;
      rnd: string;
      hashAlgorithm: string;
      encoding: string;
      hash: string;
      BillToName?: string;
      BillToCompany?: string;
      BillToCustomerId?: string;
    };
    meta?: {
      merchant_no: string;
      username: string;
      reference: string;
      amount: string;
      currency: string;
      installment: number;
      customer_code: string;
      customer_title: string;
      description: string;
    };
  };
};

export async function startVirtualPosPayment(payload: {
  customer_id: number;
  amount: number;
  currency?: string;
  installment: number;
  description?: string;
}) {
  return apiFetch<VirtualPosPaymentResponse>("/api/virtual-pos/payments", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function listCollectionApprovals() {
  return apiFetch<{ data: CollectionApprovalRecord[] }>("/api/collections/approvals");
}

export async function listFinanceDefinitions(
  type?: FinanceDefinitionDto["type"],
  includeInactive = false,
  scope?: "turkey" | "batum"
) {
  return apiFetch<{ data: FinanceDefinitionDto[] }>(
    `/api/finance-definitions${toSearch({
      ...(type ? { type } : {}),
      include_inactive: includeInactive || undefined,
      scope,
    })}`
  );
}

// ── Kampanya Tipleri ──────────────────────────────────────────────────────────

export type CampaignDto = {
  id: number;
  code: string;
  name: string;
  description?: string | null;
  customer_group?: string | null;
  target_quantity: number;
  starts_at?: string | null;
  ends_at?: string | null;
  is_active: boolean;
  product_skus: string[];
};

export type CampaignProgressDto = {
  campaign_id: number;
  code: string;
  name: string;
  description?: string | null;
  target_quantity: number;
  cart_quantity: number;
  progress_pct: number;
  is_completed: boolean;
  remaining: number;
  discount_percent?: number | null;
  starts_at?: string | null;
  ends_at?: string | null;
  product_skus: string[];
};

/**
 * Müşterinin grubuna ait aktif kampanyaları listeler.
 */
export async function fetchCampaigns(customerId?: number) {
  const qs = customerId !== undefined ? `?customer_id=${customerId}` : "";
  return apiFetch<{ data: CampaignDto[] }>(`/api/campaigns${qs}`);
}

/**
 * Müşterinin aktif sepetine göre kampanya ilerlemesini döner.
 */
export async function fetchCampaignProgress(customerId: number) {
  return apiFetch<{ data: CampaignProgressDto[] }>(
    `/api/customers/${customerId}/campaign-progress`
  );
}

export async function createFinanceDefinition(payload: {
  type: FinanceDefinitionDto["type"];
  code: string;
  name: string;
  logo_code?: string | null;
  logo_name?: string | null;
  meta?: Record<string, unknown> | null;
  sort_order?: number;
  is_active?: boolean;
}) {
  return apiFetch<{ data: FinanceDefinitionDto }>("/api/admin/finance-definitions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function fetchNextCollectionSequence(type: string) {
  return apiFetch<{ next_sequence: string }>(`/api/collections/next-sequence?type=${encodeURIComponent(type)}`);
}

export async function updateFinanceDefinition(
  id: number,
  payload: Omit<FinanceDefinitionDto, "id">
) {
  return apiFetch<{ data: FinanceDefinitionDto }>(`/api/admin/finance-definitions/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function createCustomerCollection(
  customerId: number,
  payload: {
    method: "cash" | "transfer" | "check" | "note" | "cc";
    amount: number;
    currency?: string;
    date?: string;
    note?: string;
    reference_no?: string;
    reference_fields?: Record<string, string | number | boolean>;
    meta?: Record<string, unknown>;
  }
) {
  return apiFetch<{ collection: CollectionRecord }>(`/api/customers/${customerId}/collections`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateCustomerCollection(
  customerId: number,
  collectionId: number,
  payload: {
    method: "cash" | "transfer" | "check" | "note" | "cc";
    amount: number;
    currency?: string;
    date?: string;
    note?: string;
    reference_no?: string;
    reference_fields?: Record<string, string | number | boolean>;
    meta?: Record<string, unknown>;
  }
) {
  return apiFetch<{ collection: CollectionRecord }>(
    `/api/customers/${customerId}/collections/${collectionId}`,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
    }
  );
}

export async function deleteCustomerCollection(customerId: number, collectionId: number) {
  return apiFetch<void>(`/api/customers/${customerId}/collections/${collectionId}`, {
    method: "DELETE",
  });
}

export async function sendCustomerCollection(customerId: number, collectionId: number) {
  return apiFetch<{ collection: CollectionRecord; message?: string }>(
    `/api/customers/${customerId}/collections/${collectionId}/send`,
    {
      method: "POST",
    }
  );
}

export async function sendCustomerCollections(customerId: number, collectionIds: number[]) {
  return apiFetch<{
    summary: {
      received: number;
      queued: number;
      skipped: number;
    };
    message?: string;
  }>(`/api/customers/${customerId}/collections/send`, {
    method: "POST",
    body: JSON.stringify({ collection_ids: collectionIds }),
  });
}

export async function getReportCustomerBalances(params?: {
  dealer_id?: number;
  customer_id?: number;
  q?: string;
  date_to?: string;
  has_balance?: boolean;
  min_balance?: number;
  max_balance?: number;
  per_page?: number;
  async?: boolean;
}) {
  return apiFetch<Record<string, unknown> | ReportQueueResponse>(
    `/api/reports/customer-balances${toSearch(params ?? {})}`
  );
}

export async function getReportOrderBalances(params?: {
  dealer_id?: number;
  customer_id?: number;
  q?: string;
  date_from?: string;
  date_to?: string;
  statuses?: string[];
  per_page?: number;
  page?: number;
  async?: boolean;
}) {
  return apiFetch<Record<string, unknown> | ReportQueueResponse>(
    `/api/reports/order-balances${toSearch(params ?? {})}`
  );
}

export async function getReportCollections(params?: {
  dealer_id?: number;
  customer_id?: number;
  collector_id?: number;
  method?: "cash" | "transfer" | "check" | "note" | "cc" | "factory_cc";
  q?: string;
  top?: 10 | 20 | 50;
  date_from?: string;
  date_to?: string;
  page?: number;
  per_page?: number;
  async?: boolean;
}) {
  return apiFetch<Record<string, unknown> | ReportQueueResponse>(
    `/api/reports/collections${toSearch(params ?? {})}`
  );
}

export async function getReportSales(params?: {
  dealer_id?: number;
  customer_id?: number;
  date_from?: string;
  date_to?: string;
  breakdown?: "product" | "brand" | "customer";
  q?: string;
  statuses?: string[];
  per_page?: number;
  async?: boolean;
}) {
  return apiFetch<Record<string, unknown> | ReportQueueResponse>(
    `/api/reports/sales${toSearch(params ?? {})}`
  );
}

export async function getLogoDashboardStats(params?: {
  dealer_id?: number;
  date_from?: string;
  date_to?: string;
}) {
  return apiFetch<Record<string, unknown>>(`/api/reports/logo-dashboard${toSearch(params ?? {})}`);
}

export type TcmbMarketRate = {
  code: string;
  label: string;
  unit: number;
  name: string;
  forex_buying: string | null;
  forex_selling: string | null;
  banknote_buying: string | null;
  banknote_selling: string | null;
  available: boolean;
  note: string | null;
};

export type TcmbMarketRatesResponse = {
  source: string;
  source_url: string;
  source_date: string | null;
  updated_at: string;
  rates: TcmbMarketRate[];
};

export async function getTcmbMarketRates() {
  return apiFetch<TcmbMarketRatesResponse>("/api/market-rates/tcmb");
}

export async function getReportRun(runId: number) {
  return apiFetch<ReportRunResponse>(`/api/reports/runs/${runId}`);
}

export async function getCurrentPosSession(params?: { cashbox_id?: number }) {
  return apiFetch<{ data: PosSessionDto | null }>(`/api/pos/sessions/current${toSearch(params ?? {})}`);
}

export async function getCurrentPosSessions(params?: { cashbox_id?: number }) {
  return apiFetch<{ data: PosSessionDto[] }>(
    `/api/pos/sessions/current${toSearch({ ...(params ?? {}), all: true })}`
  );
}

export async function openPosSession(payload: { cashbox_id?: number; opening_cash: number }) {
  return apiFetch<{ data: PosSessionDto }>("/api/pos/sessions/open", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function closePosSession(payload: {
  cashbox_id?: number;
  closing_cash_counted: number;
  note?: string;
}) {
  return apiFetch<{ data: PosSessionDto; note?: string | null }>("/api/pos/sessions/close", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function listPosExpenses(params?: {
  pos_session_id?: number;
  cashbox_id?: number;
  date?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
}) {
  return apiFetch<{ data: PosExpenseDto[]; limit: number }>(`/api/pos/expenses${toSearch(params ?? {})}`);
}

export async function createPosExpense(payload: {
  pos_session_id?: number;
  finance_definition_id?: number;
  amount: number;
  category: string;
  logo_expense_account_code?: string;
  logo_expense_account_name?: string;
  note?: string;
  expense_date?: string;
  meta?: Record<string, unknown>;
}) {
  return apiFetch<{ data: PosExpenseDto }>("/api/pos/expenses", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function createPosSale(payload: {
  pos_session_id: number;
  customer_id: number;
  sale_type: PosSaleType;
  document_type: PosDocumentType;
  discount_total?: number;
  receipt_no?: string;
  items: Array<{
    product_id: number;
    qty: number;
    unit_price: number;
    vat_rate?: number;
    line_total?: number;
  }>;
  payments: Array<{
    method: PosSaleType;
    amount: number;
    meta_json?: Record<string, unknown>;
  }>;
}) {
  return apiFetch<{ data: PosSaleDto }>("/api/pos/sales", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function cancelPosSale(posSaleId: number, payload?: { note?: string }) {
  return apiFetch<{ data: PosSaleDto }>(`/api/pos/sales/${posSaleId}/cancel`, {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });
}

export async function updatePosSale(
  posSaleId: number,
  payload: {
    sale_type: PosSaleType;
    discount_total?: number;
    receipt_no?: string;
    items: Array<{
      id: number;
      qty: number;
      unit_price: number;
      vat_rate?: number;
      line_total?: number;
    }>;
    payments: Array<{
      method: PosSaleType;
      amount: number;
      meta_json?: Record<string, unknown>;
    }>;
  }
) {
  return apiFetch<{ data: PosSaleDto }>(`/api/pos/sales/${posSaleId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function deletePosSale(posSaleId: number) {
  return apiFetch<{ message: string }>(`/api/pos/sales/${posSaleId}`, {
    method: "DELETE",
  });
}

export async function listPosSales(params?: {
  q?: string;
  pos_session_id?: number;
  cashbox_id?: number;
  status?: PosSaleStatus;
  document_type?: PosDocumentType;
  date_from?: string;
  date_to?: string;
  cursor?: string;
  limit?: number;
}) {
  return apiFetch<CursorResponse<PosSaleListItemDto>>(`/api/pos/sales${toSearch(params ?? {})}`);
}

export async function getPosDeliveryBalance(customerId?: number | null) {
  return apiFetch<{ data: { count: number; amount: string; source: "logo" | "b2b"; synced_at: string | null } }>(
    `/api/pos/sales/delivery-balance${toSearch({ customer_id: customerId ?? undefined })}`
  );
}

export async function getPosSale(posSaleId: number) {
  return apiFetch<{ data: PosSaleDto }>(`/api/pos/sales/${posSaleId}`);
}

export async function getPosDayEndReport(params?: {
  pos_session_id?: number;
  cashbox_id?: number;
  date?: string;
  date_from?: string;
  date_to?: string;
}) {
  return apiFetch<{ data: PosDayEndReport }>(`/api/pos/reports/day-end${toSearch(params ?? {})}`);
}

export async function approveCustomerCollection(customerId: number, collectionId: number) {
  return apiFetch<{ collection: CollectionRecord; message?: string }>(
    `/api/customers/${customerId}/collections/${collectionId}/approve`,
    {
      method: "POST",
    }
  );
}

export async function rejectCustomerCollection(customerId: number, collectionId: number, reason?: string) {
  return apiFetch<{ collection: CollectionRecord; message?: string }>(
    `/api/customers/${customerId}/collections/${collectionId}/reject`,
    {
      method: "POST",
      body: JSON.stringify({ reason }),
    }
  );
}

export async function savePosDayEnd(params?: {
  pos_session_id?: number;
  cashbox_id?: number;
  date?: string;
  date_from?: string;
  date_to?: string;
}) {
  return apiFetch<{
    data: PosDayEndReport & {
      day_end_export?: {
        status: string;
        cash_amount: string;
        card_amount: string;
        external_ref?: string | null;
        last_error?: string | null;
      };
    };
  }>("/api/pos/reports/day-end/save", {
    method: "POST",
    body: JSON.stringify(params ?? {}),
  });
}

export async function listWarehouseReadyOrders(params?: {
  q?: string;
  date?: string;
  date_from?: string;
  date_to?: string;
  dealer_id?: number;
  customer_id?: number;
  salesperson_user_id?: number;
  cursor?: string;
  limit?: number;
}) {
  return apiFetch<CursorResponse<WarehouseReadyOrderItem>>(
    `/api/warehouse/orders/ready${toSearch(params ?? {})}`
  );
}

export async function bulkCancelWarehouseOrders(orderIds: number[]) {
  return apiFetch<{ message: string; cancelled: number }>("/api/warehouse/orders/bulk-cancel", {
    method: "POST",
    body: JSON.stringify({ order_ids: orderIds }),
  });
}

export async function listWarehouseStaff() {
  return apiFetch<{ data: WarehouseStaffUser[] }>("/api/warehouse/staff");
}

export async function listWarehouseShelves(params?: {
  q?: string;
  warehouse_code?: string;
  include_equivalents?: boolean;
  limit?: number;
}) {
  return apiFetch<WarehouseShelfResponse>(`/api/warehouse/shelves${toSearch(params ?? {})}`);
}

export async function updateWarehouseShelf(
  productId: number,
  payload: {
    warehouse_code: string;
    shelf_address?: string | null;
    oem_codes?: string[];
    competitor_codes?: string[];
  }
) {
  return apiFetch<{ data: WarehouseShelfProduct; message?: string }>(`/api/warehouse/shelves/${productId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function createWarehouseShipment(payload: {
  order_id: number;
  warehouse_id?: number;
  warehouse_code?: string;
  warehouse_name?: string;
  assigned_user_id?: number;
}) {
  return apiFetch<{ data: WarehouseShipmentState }>("/api/warehouse/shipments", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function createPurchaseReceipt(payload: {
  dealer_id?: number | null;
  document_no?: string | null;
  supplier_name?: string | null;
  warehouse_code?: string | null;
  warehouse_name?: string | null;
  received_at: string;
  note?: string | null;
  items: PurchaseReceiptItemPayload[];
}) {
  return apiFetch<{ data: PurchaseReceiptRecord; message?: string }>("/api/purchase-receipts", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function listPurchaseReceipts(params?: {
  status?: string;
  warehouse_transfers?: boolean;
  limit?: number;
}) {
  const search = new URLSearchParams();
  if (params?.status) {
    search.set("status", params.status);
  }
  if (params?.warehouse_transfers !== undefined) {
    search.set("warehouse_transfers", params.warehouse_transfers ? "1" : "0");
  }
  if (params?.limit) {
    search.set("limit", String(params.limit));
  }

  const suffix = search.toString() ? `?${search.toString()}` : "";
  return apiFetch<{ data: PurchaseReceiptRecord[] }>(`/api/purchase-receipts${suffix}`);
}

export async function getPurchaseReceipt(receiptId: number | string) {
  return apiFetch<{ data: PurchaseReceiptRecord }>(`/api/purchase-receipts/${receiptId}`);
}

export async function approvePurchaseReceipt(
  receiptId: number | string,
  items?: Array<{ id: number; accepted_quantity: number }>,
) {
  return apiFetch<{ data: PurchaseReceiptRecord; message?: string }>(
    `/api/purchase-receipts/${receiptId}/approve`,
    {
      method: "POST",
      body: JSON.stringify(items ? { items } : {}),
    }
  );
}

export async function getWarehouseShipment(shipmentId: number | string) {
  return apiFetch<{ data: WarehouseShipmentState }>(`/api/warehouse/shipments/${shipmentId}`);
}

export async function getWarehouseShipmentInvoicePrintHtml(shipmentId: number | string): Promise<string> {
  const response = await fetch(`${getApiBase()}/api/warehouse/shipments/${shipmentId}/print/invoice`, {
    credentials: "include",
    headers: {
      ...getSanctumHeaders("GET"),
      Accept: "text/html,application/xhtml+xml",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    if (response.status === 401) {
      handleUnauthorizedRedirect();
    }

    const message = (await response.text().catch(() => "")).trim();
    throw new ApiClientError(message || `Request failed: ${response.status}`, response.status);
  }

  return response.text();
}

export async function createWarehouseShipmentInvoiceShareLink(shipmentId: number | string) {
  return apiFetch<{ url: string; expires_at: string }>(
    `/api/warehouse/shipments/${shipmentId}/print/invoice/share-link`,
    {
      method: "POST",
    }
  );
}

export async function scanWarehouseShipment(
  shipmentId: number | string,
  payload: { barcode: string; qty?: number }
) {
  return apiFetch<{ data: WarehouseShipmentState }>(
    `/api/warehouse/shipments/${shipmentId}/scan`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );
}

export async function returnWarehouseShipmentItem(
  shipmentId: number | string,
  payload: { item_id: number; qty?: number }
) {
  return apiFetch<{ data: WarehouseShipmentState }>(
    `/api/warehouse/shipments/${shipmentId}/return-item`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );
}

export async function returnAllWarehouseShipmentItems(shipmentId: number | string) {
  return apiFetch<{ data: WarehouseShipmentState }>(`/api/warehouse/shipments/${shipmentId}/return-all`, {
    method: "POST",
  });
}

export async function addWarehouseShipmentItem(
  shipmentId: number | string,
  payload: {
    product_id: number;
    quantity: number;
    unit_net_price?: number | string | null;
    tax_rate?: number | string | null;
  }
) {
  return apiFetch<{ data: WarehouseShipmentState }>(
    `/api/warehouse/shipments/${shipmentId}/add-item`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );
}

export async function updateWarehouseShipmentItemQuantity(
  shipmentId: number | string,
  itemId: number,
  payload: { quantity: number }
) {
  return apiFetch<{ data: WarehouseShipmentState }>(
    `/api/warehouse/shipments/${shipmentId}/items/${itemId}/quantity`,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
    }
  );
}

export async function deleteWarehouseShipmentItem(
  shipmentId: number | string,
  itemId: number
) {
  return apiFetch<{ data: WarehouseShipmentState }>(
    `/api/warehouse/shipments/${shipmentId}/items/${itemId}`,
    {
      method: "DELETE",
    }
  );
}

export async function finalizeWarehouseShipment(
  shipmentId: number | string,
  payload?: {
    carrier_name?: string;
    tracking_no?: string;
    note?: string;
  }
) {
  return apiFetch<{ data: WarehouseShipmentState }>(
    `/api/warehouse/shipments/${shipmentId}/finalize`,
    {
      method: "POST",
      body: JSON.stringify(payload ?? {}),
    }
  );
}

export type AppNotificationDto = {
  id: number;
  type: string;
  title: string;
  body: string | null;
  url: string | null;
  status: "unread" | "read" | "archived";
  meta: Record<string, unknown> | null;
  created_at: string | null;
  read_at: string | null;
  archived_at: string | null;
};

export type AppNotificationsResponse = {
  data: AppNotificationDto[];
  unread_count: number;
};

export async function listNotifications(params?: { status?: "active" | "unread" | "read" | "all"; limit?: number }) {
  const search = new URLSearchParams();
  if (params?.status) {
    search.set("status", params.status);
  }
  if (params?.limit) {
    search.set("limit", String(params.limit));
  }

  const query = search.toString();

  return apiFetch<AppNotificationsResponse>(`/api/notifications${query ? `?${query}` : ""}`);
}

export async function markNotificationRead(notificationId: number | string) {
  return apiFetch<{ data: AppNotificationDto }>(`/api/notifications/${notificationId}/read`, {
    method: "PATCH",
  });
}

export async function markAllNotificationsRead() {
  return apiFetch<{ updated_count: number; unread_count: number }>("/api/notifications/read-all", {
    method: "PATCH",
  });
}

export async function archiveNotification(notificationId: number | string) {
  return apiFetch<{ data: AppNotificationDto }>(`/api/notifications/${notificationId}/archive`, {
    method: "PATCH",
  });
}

export async function archiveAllNotifications() {
  return apiFetch<{ archived_count: number; unread_count: number }>("/api/notifications", {
    method: "DELETE",
  });
}
