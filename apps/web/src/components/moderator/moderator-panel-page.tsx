"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChart3,
  BookOpen,
  Building2,
  CheckCircle2,
  ClipboardList,
  CreditCard,
  Eye,
  EyeOff,
  FileText,
  LayoutDashboard,
  Loader2,
  PackageCheck,
  PackageSearch,
  Pencil,
  Phone,
  ReceiptText,
  RotateCcw,
  Search,
  ShieldCheck,
  ShoppingCart,
  Store,
  Trash2,
  Truck,
  UserCog,
  UserPlus,
  UserRoundCog,
  UsersRound,
  WalletCards,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  createModeratorCustomer,
  deleteModeratorUser,
  createModeratorUser,
  getModeratorOverview,
  type ModeratorCustomerRecord,
  type CustomerUserFeaturePermissionOption,
  type ModeratorMenuPermissionOption,
  type ModeratorRoleOption,
  type ModeratorUserRecord,
  resetModeratorUserPassword,
  updateModeratorCustomer,
  updateModeratorSystemSettings,
  updateModeratorUser,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type UserFormState = {
  dealer_id: string;
  customer_scope: "dealer" | "region" | "branch" | "assigned";
  region_code: string;
  region_name: string;
  branch_code: string;
  branch_name: string;
  logo_customer_specode4: string;
  logo_cashbox_code: string;
  logo_cashbox_name: string;
  logo_expense_account_code: string;
  logo_expense_account_name: string;
  name: string;
  username: string;
  phone: string;
  password: string;
  password_confirmation: string;
  role_slugs: string[];
  menu_permissions: string[];
  feature_permissions: string[];
  is_active: boolean;
};

type CustomerFormState = {
  dealer_id: string;
  salesperson_user_id: string;
  region_code: string;
  region_name: string;
  branch_code: string;
  branch_name: string;
  code: string;
  name: string;
  contact_name: string;
  email: string;
  phone: string;
  city: string;
  district: string;
  tax_office: string;
  tax_number: string;
  credit_limit: string;
  special_discount_rate: string;
  address: string;
  iban: string;
  is_active: boolean;
};

const EMPTY_USER_FORM: UserFormState = {
  dealer_id: "",
  customer_scope: "dealer",
  region_code: "",
  region_name: "",
  branch_code: "",
  branch_name: "",
  logo_customer_specode4: "",
  logo_cashbox_code: "",
  logo_cashbox_name: "",
  logo_expense_account_code: "",
  logo_expense_account_name: "",
  name: "",
  username: "",
  phone: "",
  password: "",
  password_confirmation: "",
  role_slugs: [],
  menu_permissions: [],
  feature_permissions: [],
  is_active: true,
};

const EMPTY_CUSTOMER_FORM: CustomerFormState = {
  dealer_id: "",
  salesperson_user_id: "",
  region_code: "",
  region_name: "",
  branch_code: "",
  branch_name: "",
  code: "",
  name: "",
  contact_name: "",
  email: "",
  phone: "",
  city: "",
  district: "",
  tax_office: "",
  tax_number: "",
  credit_limit: "0",
  special_discount_rate: "",
  address: "",
  iban: "",
  is_active: true,
};

const EMPTY_USERS: ModeratorUserRecord[] = [];
const EMPTY_CUSTOMERS: ModeratorCustomerRecord[] = [];
const EMPTY_ROLES: ModeratorRoleOption[] = [];
const EMPTY_MENU_PERMISSIONS: ModeratorMenuPermissionOption[] = [];
const EMPTY_FEATURE_PERMISSIONS: CustomerUserFeaturePermissionOption[] = [];
const WAREHOUSE_STOCK_PERMISSION_PREFIX = "search.stock.warehouse.";

type PermissionTemplate = {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  accentClassName: string;
  roleSlugs: string[];
  customerScope?: CustomerScope;
  permissions: string[];
};

const MENU_PERMISSION_ICONS: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard,
  notes: FileText,
  search: PackageSearch,
  catalogs: BookOpen,
  cart: ShoppingCart,
  orders: ClipboardList,
  customers: UsersRound,
  "customer-users": UserRoundCog,
  "new-customer-card": UserPlus,
  ledger: WalletCards,
  collections: ReceiptText,
  reports: BarChart3,
  returns: RotateCcw,
  pos: Store,
  "pos-expenses": ReceiptText,
  "pos-day-end": BarChart3,
  "virtual-pos": CreditCard,
  "delivery-notes": FileText,
  warehouse: Truck,
  moderator: UserCog,
  extra: PackageCheck,
};

const BASE_PERMISSION_TEMPLATES: PermissionTemplate[] = [
  {
    id: "platform-admin",
    title: "Platform Yöneticisi",
    description: "Tüm operasyon, kullanıcı yönetimi ve raporlama ekranları.",
    icon: ShieldCheck,
    accentClassName: "border-[#fed7aa] bg-[#fff7ed] text-[#c2410c]",
    roleSlugs: ["admin"],
    permissions: [],
  },
  {
    id: "dealer-admin",
    title: "Bayi Yöneticisi",
    description: "B2B müşteri hesabı, sipariş, sepet, katalog ve sanal pos erişimi.",
    icon: Store,
    accentClassName: "border-[#bfdbfe] bg-[#eff6ff] text-[#1d4ed8]",
    roleSlugs: ["dealer_admin"],
    permissions: ["dashboard", "notes", "search", "catalogs", "cart", "orders", "returns", "extra", "virtual-pos", "delivery-notes"],
  },
  {
    id: "moderator",
    title: "Moderatör",
    description: "Kullanıcı ve cari yönetimi için moderatör paneli erişimi.",
    icon: UserCog,
    accentClassName: "border-[#d9f99d] bg-[#f7fee7] text-[#4d7c0f]",
    roleSlugs: ["moderator"],
    permissions: ["moderator"],
  },
  {
    id: "salesperson",
    title: "Plasiyer",
    description: "Müşteri seçimi, ürün arama, sepet, sipariş, tahsilat ve rapor akışı.",
    icon: UsersRound,
    accentClassName: "border-[#ddd6fe] bg-[#f5f3ff] text-[#6d28d9]",
    roleSlugs: ["salesperson"],
    customerScope: "assigned",
    permissions: ["dashboard", "notes", "search", "catalogs", "cart", "customers", "new-customer-card", "ledger", "collections", "reports", "orders", "returns", "extra", "virtual-pos"],
  },
  {
    id: "warehouse",
    title: "Depo",
    description: "Depo siparişleri, sevkiyat ve hazırlama ekranı.",
    icon: Truck,
    accentClassName: "border-[#bbf7d0] bg-[#f0fdf4] text-[#15803d]",
    roleSlugs: ["warehouse"],
    permissions: ["warehouse"],
  },
  {
    id: "point",
    title: "Point / Hızlı Satış",
    description: "Hızlı satış, gün sonu ve irsaliye döküm ekranları.",
    icon: Store,
    accentClassName: "border-[#fecdd3] bg-[#fff1f2] text-[#be123c]",
    roleSlugs: ["point"],
    permissions: ["notes", "pos", "delivery-notes"],
  },
  {
    id: "cashier",
    title: "Kasiyer",
    description: "Point satış ve gün sonu işlemleri için kasiyer erişimi.",
    icon: ReceiptText,
    accentClassName: "border-[#fed7aa] bg-[#fff7ed] text-[#c2410c]",
    roleSlugs: ["cashier"],
    permissions: ["notes", "pos", "delivery-notes"],
  },
  {
    id: "b2b-point",
    title: "B2B + Hızlı Satış",
    description: "Bayi B2B ekranları ile point satış ekranlarını birlikte açar.",
    icon: CreditCard,
    accentClassName: "border-[#bae6fd] bg-[#f0f9ff] text-[#0369a1]",
    roleSlugs: ["dealer_admin", "point"],
    permissions: ["dashboard", "notes", "search", "catalogs", "cart", "orders", "returns", "extra", "virtual-pos", "delivery-notes", "pos"],
  },
];

type ModeratorPanelView =
  | "create-user"
  | "create-customer"
  | "manage-users"
  | "manage-customers";

type CustomerScope = "dealer" | "region" | "branch" | "assigned";

function formatMoney(value: string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "0,00 TRY";
  }

  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    minimumFractionDigits: 2,
  }).format(numeric);
}

function customerScopeLabel(scope: CustomerScope) {
  return (
    {
      dealer: "Bayi Geneli",
      region: "Bölge",
      branch: "Şube",
      assigned: "Atanmış Cari",
    } as Record<CustomerScope, string>
  )[scope];
}

function menuSelectionRequiresDealer(menuPermissions: string[]) {
  return menuPermissions.some((permission) => permission !== "moderator");
}

function normalizeScopeForMenus(menuPermissions: string[], scope: CustomerScope): CustomerScope {
  if (!menuSelectionRequiresDealer(menuPermissions) || scope === "assigned") {
    return "dealer";
  }

  return scope;
}

function toggleMenuPermission(menuPermissions: string[], key: string) {
  if (menuPermissions.includes(key)) {
    return menuPermissions.filter((permission) => permission !== key);
  }

  return [...menuPermissions, key];
}

function featureDefaultsForMenus(menuPermissions: string[], featureOptions: CustomerUserFeaturePermissionOption[]) {
  const menus = new Set(menuPermissions);

  return featureOptions
    .filter((feature) => menus.has(feature.menu_key))
    .map((feature) => feature.key);
}

function reconcileFeaturePermissions(
  menuPermissions: string[],
  featurePermissions: string[],
  featureOptions: CustomerUserFeaturePermissionOption[]
) {
  const available = new Set(featureOptions.map((feature) => feature.key));
  const enabledMenus = new Set(menuPermissions);

  return featurePermissions.filter((permission) => {
    if (!available.has(permission)) {
      return false;
    }

    const option = featureOptions.find((feature) => feature.key === permission);

    return option ? enabledMenus.has(option.menu_key) : false;
  });
}

function toggleFeaturePermission(featurePermissions: string[], key: string) {
  if (featurePermissions.includes(key)) {
    return featurePermissions.filter((permission) => permission !== key);
  }

  return [...featurePermissions, key];
}

function toggleRoleSlug(roleSlugs: string[], slug: string) {
  if (roleSlugs.includes(slug)) {
    return roleSlugs.filter((roleSlug) => roleSlug !== slug);
  }

  return [...roleSlugs, slug];
}

function normalizeScopeForRoles(roleSlugs: string[], menuPermissions: string[], scope: CustomerScope): CustomerScope {
  if (roleSlugs.includes("salesperson")) {
    return "assigned";
  }

  return normalizeScopeForMenus(menuPermissions, scope);
}

function menuPermissionLabel(key: string, options: ModeratorMenuPermissionOption[]) {
  return options.find((option) => option.key === key)?.label ?? key;
}

function menuPermissionIcon(key: string) {
  return MENU_PERMISSION_ICONS[key] ?? ShieldCheck;
}

function buildPermissionTemplates(options: ModeratorMenuPermissionOption[], availableRoleSlugs: string[]) {
  const availableKeys = new Set(options.map((option) => option.key));
  const availableRoles = new Set(availableRoleSlugs);
  const allPermissions = options.map((option) => option.key);

  return BASE_PERMISSION_TEMPLATES.map((template) => {
    const permissions =
      template.id === "platform-admin"
        ? allPermissions
        : template.permissions.filter((permission) => availableKeys.has(permission));

    return { ...template, permissions };
  }).filter((template) => template.permissions.length > 0 && template.roleSlugs.every((roleSlug) => availableRoles.has(roleSlug)));
}

function PermissionTemplateCard({
  template,
  permissionOptions,
  onApply,
}: {
  template: PermissionTemplate;
  permissionOptions: ModeratorMenuPermissionOption[];
  onApply: () => void;
}) {
  const TemplateIcon = template.icon;

  return (
    <article className="flex min-h-[300px] flex-col rounded-lg border border-[var(--brand-border)] bg-[var(--surface)] p-4 shadow-sm transition hover:border-[var(--brand-primary)] hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <span className={cn("inline-flex h-12 w-12 items-center justify-center rounded-lg border", template.accentClassName)}>
          <TemplateIcon className="h-6 w-6" />
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--brand-accent-soft)] px-3 py-1 text-xs font-black text-[var(--brand-primary)]">
          <FileText className="h-3.5 w-3.5" />
          {template.permissions.length} sayfa
        </span>
      </div>

      <div className="mt-4">
        <h3 className="text-lg font-black tracking-tight text-[var(--brand-primary-strong)]">{template.title}</h3>
        <p className="mt-1 min-h-[40px] text-sm font-medium leading-5 text-[var(--muted-foreground)]">
          {template.description}
        </p>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {template.permissions.map((permission) => {
          const PermissionIcon = menuPermissionIcon(permission);

          return (
            <span
              key={`${template.id}-${permission}`}
              className="inline-flex min-w-0 items-center gap-2 rounded-lg border border-[var(--brand-border)] bg-[var(--surface-soft)] px-2.5 py-2 text-xs font-extrabold text-[var(--brand-primary-strong)]"
            >
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--surface)] text-[var(--brand-primary)]">
                <PermissionIcon className="h-4 w-4" />
              </span>
              <span className="truncate">{menuPermissionLabel(permission, permissionOptions)}</span>
            </span>
          );
        })}
      </div>

      <Button type="button" className="mt-auto h-11 rounded-lg font-black" onClick={onApply}>
        <CheckCircle2 className="h-4 w-4" />
        Şablonu Kullan
      </Button>
    </article>
  );
}

function territoryNameFromCode(code: string, fallback: string) {
  const normalizedCode = code.trim();

  if (normalizedCode === "") {
    return "";
  }

  const normalizedFallback = fallback.trim();

  return normalizedFallback !== "" ? normalizedFallback : normalizedCode;
}

function createdAtTime(user: ModeratorUserRecord) {
  const timestamp = Date.parse(user.created_at ?? "");

  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatDateTime(value: string | null) {
  if (!value) {
    return "Tarih yok";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Tarih yok";
  }

  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function userRecordToForm(user: ModeratorUserRecord): UserFormState {
  return {
    dealer_id: String(user.dealer_id ?? ""),
    customer_scope: user.customer_scope ?? "dealer",
    region_code: user.region_code ?? "",
    region_name: user.region_name ?? "",
    branch_code: user.branch_code ?? "",
    branch_name: user.branch_name ?? "",
    logo_customer_specode4: user.logo_customer_specode4 ?? "",
    logo_cashbox_code: user.logo_cashbox_code ?? "",
    logo_cashbox_name: user.logo_cashbox_name ?? "",
    logo_expense_account_code: user.logo_expense_account_code ?? "",
    logo_expense_account_name: user.logo_expense_account_name ?? "",
    name: user.name,
    username: user.username,
    phone: user.phone ?? "",
    password: "",
    password_confirmation: "",
    role_slugs: user.roles.map((role) => role.slug),
    menu_permissions: user.menu_permissions ?? [],
    feature_permissions: user.feature_permissions ?? [],
    is_active: user.is_active,
  };
}

function normalizeTurkishMobilePhone(value: string) {
  return value.replace(/\D/g, "").slice(0, 11);
}

function isValidTurkishMobilePhone(value: string) {
  return /^05\d{9}$/.test(value.trim());
}

function normalizeUserSearch(value: string) {
  return value.trim().toLocaleLowerCase("tr-TR");
}

function userMatchesSearch(
  user: ModeratorUserRecord,
  query: string,
  permissionOptions: ModeratorMenuPermissionOption[]
) {
  if (query === "") {
    return true;
  }

  const searchableText = [
    user.name,
    user.username,
    user.phone,
    user.dealer.name,
    user.dealer.code,
    user.region_code,
    user.region_name,
    user.branch_code,
    user.branch_name,
    customerScopeLabel(user.customer_scope),
    ...user.roles.map((role) => role.name),
    ...user.menu_permissions.map((permission) => menuPermissionLabel(permission, permissionOptions)),
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("tr-TR");

  return searchableText.includes(query);
}

export function ModeratorPanelPage({ view }: { view: ModeratorPanelView }) {
  const queryClient = useQueryClient();
  const [userForm, setUserForm] = useState<UserFormState>(EMPTY_USER_FORM);
  const [customerForm, setCustomerForm] = useState<CustomerFormState>(EMPTY_CUSTOMER_FORM);
  const [customerDrafts, setCustomerDrafts] = useState<Record<number, Partial<CustomerFormState>>>({});
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [permissionTemplatesOpen, setPermissionTemplatesOpen] = useState(false);
  const [userModalOpen, setUserModalOpen] = useState(view === "create-user");
  const [editingUserId, setEditingUserId] = useState<number | null>(null);
  const [userSearch, setUserSearch] = useState("");
  const [showUserPassword, setShowUserPassword] = useState(false);
  const [customerSearch, setCustomerSearch] = useState("");
  const [complaintMailToDraft, setComplaintMailToDraft] = useState<string | null>(null);
  const [batumExchangeRateDraft, setBatumExchangeRateDraft] = useState<string | null>(null);
  const trimmedCustomerSearch = customerSearch.trim();
  const overviewParams = useMemo(
    () => ({
      include_customers: view === "manage-customers",
      customer_limit: view === "manage-customers" ? 80 : undefined,
      customer_q: view === "manage-customers" ? trimmedCustomerSearch : undefined,
    }),
    [trimmedCustomerSearch, view]
  );
  const overviewQuery = useQuery({
    queryKey: ["moderator", "overview", overviewParams],
    queryFn: () => getModeratorOverview(overviewParams),
    staleTime: 30_000,
  });
  const complaintMailTo = complaintMailToDraft ?? overviewQuery.data?.system_settings.complaint_mail_to ?? "";
  const batumExchangeRate = batumExchangeRateDraft ?? overviewQuery.data?.system_settings.batum_exchange_rate ?? "17.0000";
  const normalizedBatumExchangeRate = batumExchangeRate.trim().replace(",", ".");
  const canSaveSystemSettings =
    complaintMailTo.trim() !== "" &&
    normalizedBatumExchangeRate !== "" &&
    Number(normalizedBatumExchangeRate) > 0 &&
    Number.isFinite(Number(normalizedBatumExchangeRate));

  const dealers = overviewQuery.data?.dealers ?? [];
  const roleOptions = overviewQuery.data?.roles ?? EMPTY_ROLES;
  const menuPermissionOptions = overviewQuery.data?.menu_permissions ?? EMPTY_MENU_PERMISSIONS;
  const featurePermissionOptions = overviewQuery.data?.feature_permissions ?? EMPTY_FEATURE_PERMISSIONS;
  const warehouseStockFeatureOptions = useMemo(
    () => featurePermissionOptions.filter((feature) => feature.key.startsWith(WAREHOUSE_STOCK_PERMISSION_PREFIX)),
    [featurePermissionOptions]
  );
  const availableRoleSlugs = useMemo(() => roleOptions.map((role) => role.slug), [roleOptions]);
  const permissionTemplates = useMemo(
    () => buildPermissionTemplates(menuPermissionOptions, availableRoleSlugs),
    [availableRoleSlugs, menuPermissionOptions]
  );
  const users = overviewQuery.data?.users ?? EMPTY_USERS;
  const customers = overviewQuery.data?.customers ?? EMPTY_CUSTOMERS;
  const summary = overviewQuery.data?.summary ?? {
    users_total: 0,
    active_users_total: 0,
    customers_total: 0,
    active_customers_total: 0,
    salespeople_total: 0,
    assigned_customers_total: 0,
    unassigned_customers_total: 0,
  };
  const salespeople = useMemo(
    () => users.filter((user) => user.roles.some((role) => role.slug === "salesperson")),
    [users]
  );
  const usersByCreation = useMemo(
    () =>
      [...users].sort((left, right) => {
        const createdAtDiff = createdAtTime(right) - createdAtTime(left);

        if (createdAtDiff !== 0) {
          return createdAtDiff;
        }

        return right.id - left.id;
      }),
    [users]
  );
  const normalizedUserSearch = useMemo(() => normalizeUserSearch(userSearch), [userSearch]);
  const filteredUsers = useMemo(
    () =>
      usersByCreation.filter((user) =>
        userMatchesSearch(user, normalizedUserSearch, menuPermissionOptions)
      ),
    [menuPermissionOptions, normalizedUserSearch, usersByCreation]
  );
  const editingUser = useMemo(
    () => users.find((user) => user.id === editingUserId) ?? null,
    [editingUserId, users]
  );

  useEffect(() => {
    const root = document.documentElement;
    const syncTheme = () => setIsDarkMode(root.dataset.uiTheme === "dark");

    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["data-ui-theme"] });

    return () => observer.disconnect();
  }, []);

  const systemSettingsMutation = useMutation({
    mutationFn: () =>
      updateModeratorSystemSettings({
        complaint_mail_to: complaintMailTo.trim(),
        batum_exchange_rate: batumExchangeRate.trim(),
      }),
    onSuccess: async (response) => {
      toast.success(response.message);
      setComplaintMailToDraft(response.system_settings.complaint_mail_to);
      setBatumExchangeRateDraft(response.system_settings.batum_exchange_rate);
      await queryClient.invalidateQueries({ queryKey: ["moderator", "overview"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Sistem ayarı kaydedilemedi."),
  });

  const sectionClassName = "dashboard-panel-card rounded-[18px] p-6 lg:p-7";
  const iconCardClassName = cn(
    "dashboard-panel-soft inline-flex h-12 w-12 items-center justify-center rounded-[14px] text-[var(--brand-primary)]"
  );
  const selectClassName = cn(
    "h-12 w-full rounded-xl border px-4 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--ring)]",
    isDarkMode
      ? "border-[var(--brand-border)] bg-[var(--surface-soft)] text-[var(--foreground)]"
      : "border-[var(--brand-border)] bg-[var(--surface)] text-[var(--foreground)]"
  );
  const statCardClassName = "dashboard-panel-soft rounded-[16px] px-4 py-3.5";
  const tableShellClassName = "dashboard-panel-soft overflow-hidden rounded-[18px]";
  const tableHeadClassName = cn(
    isDarkMode ? "bg-[var(--surface-soft)] text-[var(--muted-foreground)]" : "bg-[#f4f8f5] text-[var(--muted-foreground)]"
  );
  const tableRowClassName = cn(
    "border-t border-[var(--brand-border)] align-top transition-colors",
    isDarkMode ? "hover:bg-[var(--surface-soft)]" : "hover:bg-[#fbfdfb]"
  );
  const compactMenuPillClassName = "rounded-full border border-[var(--brand-border)] bg-[var(--surface)] px-2 py-0.5 text-[10px] font-semibold leading-4 text-[var(--brand-primary-strong)]";
  const userModalToneClassName = isDarkMode
    ? "border-[#284436] bg-[#0f1712] text-[#dde7df] shadow-[0_30px_80px_-36px_rgba(0,0,0,0.9)]"
    : "border-[var(--brand-border)] bg-[var(--surface)] text-[var(--foreground)]";
  const userModalHeaderClassName = isDarkMode
    ? "border-[#274234] bg-[#121d17]"
    : "border-[var(--brand-border)] bg-[var(--surface)]";
  const userModalInputClassName = isDarkMode
    ? "h-11 rounded-xl border-[#314f3f] bg-[#111c16] text-[#eef6f0] placeholder:text-[#7f9387] focus-visible:ring-[#6ea37d]/30"
    : "h-11 rounded-xl border-[var(--brand-border)] bg-[var(--surface)]";
  const userModalSelectClassName = cn(
    selectClassName,
    isDarkMode
      ? "h-11 rounded-xl border-[#314f3f] bg-[#111c16] text-[#eef6f0] focus:ring-[#6ea37d]/30"
      : "h-11 rounded-xl"
  );
  const userModalSoftClassName = isDarkMode
    ? "border-[#314f3f] bg-[#111c16]"
    : "border-[var(--brand-border)] bg-[var(--surface-soft)]";
  const userModalPermissionClassName = (checked: boolean) =>
    cn(
      "flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition",
      checked
        ? isDarkMode
          ? "border-[#7fac8b] bg-[#1b2b22] text-[#eef6f0]"
          : "border-[var(--brand-primary)] bg-[var(--surface)] text-[var(--brand-primary-strong)]"
        : isDarkMode
          ? "border-[#2f493b] bg-[#0f1914] text-[#a9b9ae] hover:border-[#7fac8b]"
          : "border-[var(--brand-border)] bg-[var(--surface)] text-[var(--muted-foreground)] hover:border-[var(--brand-primary)]"
    );

  const invalidateOverview = async () => {
    await queryClient.invalidateQueries({ queryKey: ["moderator", "overview"] });
  };

  const createUserMutation = useMutation({
    mutationFn: createModeratorUser,
    onSuccess: async () => {
      toast.success("Kullanıcı oluşturuldu.");
      setUserForm(EMPTY_USER_FORM);
      setEditingUserId(null);
      setUserModalOpen(false);
      await invalidateOverview();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Kullanıcı oluşturulamadı.");
    },
  });

  const updateUserMutation = useMutation({
    mutationFn: ({ userId, payload }: { userId: number; payload: Parameters<typeof updateModeratorUser>[1] }) =>
      updateModeratorUser(userId, payload),
    onSuccess: async () => {
      toast.success("Kullanıcı güncellendi.");
      setUserForm(EMPTY_USER_FORM);
      setEditingUserId(null);
      setUserModalOpen(false);
      await invalidateOverview();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Kullanıcı güncellenemedi.");
    },
  });

  const resetUserPasswordMutation = useMutation({
    mutationFn: ({ userId, password }: { userId: number; password: string }) =>
      resetModeratorUserPassword(userId, password),
    onSuccess: async () => {
      toast.success("Şifre güncellendi.");
      await invalidateOverview();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Şifre güncellenemedi.");
    },
  });

  const deleteUserMutation = useMutation({
    mutationFn: deleteModeratorUser,
    onSuccess: async () => {
      toast.success("Kullanıcı silindi.");
      await invalidateOverview();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Kullanıcı silinemedi.");
    },
  });

  const createCustomerMutation = useMutation({
    mutationFn: createModeratorCustomer,
    onSuccess: async () => {
      toast.success("Cari oluşturuldu.");
      setCustomerForm(EMPTY_CUSTOMER_FORM);
      await invalidateOverview();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Cari oluşturulamadı.");
    },
  });

  const updateCustomerMutation = useMutation({
    mutationFn: ({
      customerId,
      payload,
    }: {
      customerId: number;
      payload: Parameters<typeof updateModeratorCustomer>[1];
    }) => updateModeratorCustomer(customerId, payload),
    onSuccess: async () => {
      toast.success("Cari güncellendi.");
      await invalidateOverview();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Cari güncellenemedi.");
    },
  });

  const userRoleRequiresDealer =
    !userForm.role_slugs.includes("admin") &&
    userForm.role_slugs.some((roleSlug) => roleSlug !== "moderator");
  const userMenuRequiresDealer =
    userRoleRequiresDealer ||
    (userForm.role_slugs.length === 0 && menuSelectionRequiresDealer(userForm.menu_permissions));
  const effectiveUserName = userForm.name.trim() || editingUser?.name?.trim() || "";
  const effectiveUsername = userForm.username.trim() || editingUser?.username?.trim() || "";
  const editingPasswordValid =
    userForm.password.trim() === "" ||
    (userForm.password.trim().length >= 6 &&
      (userForm.password_confirmation.trim() === "" || userForm.password === userForm.password_confirmation));
  const canCreateUser =
    userForm.name.trim() !== "" &&
    userForm.username.trim() !== "" &&
    isValidTurkishMobilePhone(userForm.phone.trim()) &&
    userForm.password.length >= 6 &&
    userForm.password === userForm.password_confirmation;
  const isEditingUser = editingUser !== null;
  const canSubmitUserModal =
    effectiveUserName !== "" &&
    effectiveUsername !== "" &&
    (!userMenuRequiresDealer || userForm.dealer_id !== "") &&
    (isEditingUser || isValidTurkishMobilePhone(userForm.phone.trim())) &&
    (isEditingUser
      ? editingPasswordValid
      : userForm.password.length >= 6 && userForm.password === userForm.password_confirmation);
  const applyPermissionTemplate = (template: PermissionTemplate) => {
    setUserForm((prev) => ({
      ...prev,
      dealer_id: menuSelectionRequiresDealer(template.permissions) ? prev.dealer_id : "",
      customer_scope: template.customerScope ?? normalizeScopeForRoles(template.roleSlugs, template.permissions, prev.customer_scope),
      role_slugs: template.roleSlugs,
      menu_permissions: template.permissions,
      feature_permissions: featureDefaultsForMenus(template.permissions, featurePermissionOptions),
    }));
    setPermissionTemplatesOpen(false);
    toast.success(`${template.title} şablonu uygulandı.`);
  };
  const createCustomerSalespeople = salespeople.filter(
    (user) => String(user.dealer_id ?? "") === customerForm.dealer_id
  );
  const openCreateUserModal = () => {
    setEditingUserId(null);
    setUserForm(EMPTY_USER_FORM);
    setShowUserPassword(false);
    setUserModalOpen(true);
  };
  const openEditUserModal = (user: ModeratorUserRecord) => {
    setEditingUserId(user.id);
    setUserForm(userRecordToForm(user));
    setShowUserPassword(false);
    setUserModalOpen(true);
  };
  const closeUserModal = (open: boolean) => {
    setUserModalOpen(open);

    if (!open) {
      setEditingUserId(null);
      setUserForm(EMPTY_USER_FORM);
      setShowUserPassword(false);
    }
  };
  const submitUserModal = async () => {
    if (!canSubmitUserModal) {
      if (userMenuRequiresDealer && userForm.dealer_id === "") {
        toast.error("Seçtiğiniz rol veya yetkiler bir bayiye bağlı çalışmayı gerektiriyor. Lütfen 'Bayi' alanından bir bayi seçin.");
      } else if (effectiveUserName === "" || effectiveUsername === "") {
        toast.error("Ad ve kullanıcı adı zorunludur.");
      } else if (!isEditingUser && userForm.password.length < 6) {
        toast.error("Yeni kullanıcı için şifre en az 6 karakter olmalı.");
      } else if (isEditingUser && userForm.password.trim() !== "" && userForm.password.trim().length < 6) {
        toast.error("Yeni şifre en az 6 karakter olmalı.");
      } else if (!isEditingUser && userForm.password !== userForm.password_confirmation) {
        toast.error("Şifre ve şifre tekrar aynı olmalı.");
      } else if (isEditingUser && userForm.password_confirmation.trim() !== "" && userForm.password !== userForm.password_confirmation) {
        toast.error("Şifre ve şifre tekrar aynı olmalı.");
      } else if (!isEditingUser && !isValidTurkishMobilePhone(userForm.phone.trim())) {
        toast.error("❌ Geçerli telefon numarası giriniz");
      } else {
        toast.error(
          isEditingUser
            ? "Ad ve kullanıcı adı zorunludur."
            : "Ad, kullanıcı adı ve şifre (en az 6 karakter) zorunludur."
        );
      }
      return;
    }

    if (!isEditingUser && !isValidTurkishMobilePhone(userForm.phone.trim())) {
      toast.error("❌ Geçerli telefon numarası giriniz");
      return;
    }

    if (userForm.password !== userForm.password_confirmation) {
      toast.error("Şifre ve şifre tekrar aynı olmalı.");
      return;
    }

    const payload = {
      dealer_id: userMenuRequiresDealer && userForm.dealer_id !== "" ? Number(userForm.dealer_id) : null,
      customer_scope: normalizeScopeForRoles(userForm.role_slugs, userForm.menu_permissions, userForm.customer_scope),
      region_code: userForm.region_code.trim() || null,
      region_name: territoryNameFromCode(userForm.region_code, userForm.region_name) || null,
      branch_code: userForm.branch_code.trim() || null,
      branch_name: territoryNameFromCode(userForm.branch_code, userForm.branch_name) || null,
      logo_customer_specode4: userForm.logo_customer_specode4.trim() || null,
      logo_cashbox_code: userForm.logo_cashbox_code.trim() || null,
      logo_cashbox_name: userForm.logo_cashbox_name.trim() || null,
      logo_expense_account_code: userForm.logo_expense_account_code.trim() || null,
      logo_expense_account_name: userForm.logo_expense_account_name.trim() || null,
      name: effectiveUserName,
      username: effectiveUsername,
      email: null,
      phone: userForm.phone.trim() || null,
      role_slugs: userForm.role_slugs,
      menu_permissions: userForm.menu_permissions,
      feature_permissions: reconcileFeaturePermissions(
        userForm.menu_permissions,
        userForm.feature_permissions,
        featurePermissionOptions
      ),
      is_active: userForm.is_active,
    };

    if (isEditingUser) {
      const password = userForm.password.trim();
      const updatePayload: Parameters<typeof updateModeratorUser>[1] = { ...payload };

      if (password.length >= 6) {
        updatePayload.password = password;
      }

      if (userForm.phone.trim() !== "" && !isValidTurkishMobilePhone(userForm.phone.trim())) {
        delete updatePayload.phone;
      }

      updateUserMutation.mutate({
        userId: editingUser.id,
        payload: updatePayload,
      });

      return;
    }

    createUserMutation.mutate({
      ...payload,
      phone: userForm.phone.trim() || undefined,
      password: userForm.password,
    });
  };

  const getCustomerDraft = (customer: ModeratorCustomerRecord) => {
    const draft = customerDrafts[customer.id];
    return {
      dealer_id: draft?.dealer_id ?? String(customer.dealer_id),
      salesperson_user_id: draft?.salesperson_user_id ?? String(customer.salesperson_user_id ?? ""),
      region_code: draft?.region_code ?? (customer.region_code ?? ""),
      region_name: draft?.region_name ?? (customer.region_name ?? ""),
      branch_code: draft?.branch_code ?? (customer.branch_code ?? ""),
      branch_name: draft?.branch_name ?? (customer.branch_name ?? ""),
      code: draft?.code ?? customer.code,
      name: draft?.name ?? customer.name,
      contact_name: draft?.contact_name ?? (customer.contact_name ?? ""),
      email: draft?.email ?? (customer.email ?? ""),
      phone: draft?.phone ?? (customer.phone ?? ""),
      city: draft?.city ?? (customer.city ?? ""),
      district: draft?.district ?? (customer.district ?? ""),
      tax_office: draft?.tax_office ?? (customer.tax_office ?? ""),
      tax_number: draft?.tax_number ?? (customer.tax_number ?? ""),
      credit_limit: draft?.credit_limit ?? customer.credit_limit,
      special_discount_rate: draft?.special_discount_rate ?? (customer.special_discount_rate ?? ""),
      address: draft?.address ?? (customer.address ?? ""),
      iban: draft?.iban ?? (customer.iban ?? ""),
      is_active: draft?.is_active ?? customer.is_active,
    };
  };

  if (overviewQuery.isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-[var(--muted-foreground)]">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Moderatör paneli yükleniyor...
      </div>
    );
  }

  if (overviewQuery.isError || !overviewQuery.data) {
    return (
      <div
        className={cn(
          "rounded-[28px] border p-6 text-sm",
          isDarkMode ? "border-red-900/60 bg-red-950/35 text-red-200" : "border-red-200 bg-red-50 text-red-700"
        )}
      >
        {overviewQuery.error instanceof Error
          ? overviewQuery.error.message
          : "Moderatör paneli yüklenemedi."}
      </div>
    );
  }

  return (
    <div className="moderator-panel-page mx-auto w-full max-w-[1540px] space-y-4">
      <Dialog open={permissionTemplatesOpen} onOpenChange={setPermissionTemplatesOpen}>
        <DialogContent className="max-h-[88vh] max-w-[1180px] overflow-hidden rounded-[20px] p-0">
          <DialogHeader className="mb-0 border-b border-[var(--brand-border)] px-5 py-4 sm:px-6">
            <div className="flex items-center gap-3 pr-10">
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-[var(--brand-accent-soft)] text-[var(--brand-primary)]">
                <ShieldCheck className="h-5 w-5" />
              </span>
              <div>
                <DialogTitle className="text-xl font-black text-[var(--brand-primary-strong)]">
                  Yetki Şablonları
                </DialogTitle>
                <DialogDescription className="mt-1 font-medium">
                  Rol bazlı hazır erişimleri ikonlu kartlardan seçip yeni kullanıcı formuna taşıyın.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="max-h-[calc(88vh-96px)] overflow-y-auto p-5 sm:p-6">
            <div className="grid gap-4 lg:grid-cols-2">
              {permissionTemplates.map((template) => (
                <PermissionTemplateCard
                  key={template.id}
                  template={template}
                  permissionOptions={menuPermissionOptions}
                  onApply={() => applyPermissionTemplate(template)}
                />
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={userModalOpen} onOpenChange={closeUserModal}>
        <DialogContent 
          className={cn("max-h-[90vh] max-w-[980px] overflow-hidden rounded-[20px] p-0", userModalToneClassName)}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogHeader className={cn("mb-0 border-b px-5 py-4 sm:px-6", userModalHeaderClassName)}>
            <div className="flex items-center gap-3 pr-10">
              <span
                className={cn(
                  "inline-flex h-11 w-11 items-center justify-center rounded-lg",
                  isDarkMode ? "bg-[#1d3126] text-[#9bc8aa]" : "bg-[var(--brand-accent-soft)] text-[var(--brand-primary)]"
                )}
              >
                {isEditingUser ? <Pencil className="h-5 w-5" /> : <UserPlus className="h-5 w-5" />}
              </span>
              <div>
                <DialogTitle className={cn("text-xl font-black", isDarkMode ? "text-[#eef6f0]" : "text-[var(--brand-primary-strong)]")}>
                  {isEditingUser ? "Kullanıcıyı Düzenle" : "Kullanıcı Oluştur"}
                </DialogTitle>
                <DialogDescription className={cn("mt-1 font-medium", isDarkMode ? "text-[#9fb2a6]" : "text-[var(--muted-foreground)]")}>
                  Temel bilgileri, bayi kapsamını ve menü erişimlerini tek yerden yönetin.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className={cn("max-h-[calc(90vh-148px)] overflow-y-auto px-5 py-5 sm:px-6", isDarkMode ? "bg-[#0f1712]" : "bg-[var(--surface)]")}>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2 text-sm">
                <span className={cn("font-semibold", isDarkMode ? "text-[#dce9df]" : "text-[var(--brand-primary-strong)]")}>Ad Soyad</span>
                <Input
                  className={userModalInputClassName}
                  value={userForm.name}
                  onChange={(event) => setUserForm((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="Ad soyad"
                />
              </label>
              <label className="space-y-2 text-sm">
                <span className={cn("font-semibold", isDarkMode ? "text-[#dce9df]" : "text-[var(--brand-primary-strong)]")}>Kullanıcı Adı</span>
                <Input
                  className={userModalInputClassName}
                  value={userForm.username}
                  onChange={(event) => setUserForm((prev) => ({ ...prev, username: event.target.value }))}
                  placeholder="plasiyer.ahmet"
                />
              </label>
              <label className="space-y-2 text-sm">
                <span className={cn("font-semibold", isDarkMode ? "text-[#dce9df]" : "text-[var(--brand-primary-strong)]")}>Telefon</span>
                <Input
                  className={userModalInputClassName}
                  value={userForm.phone}
                  onChange={(event) => setUserForm((prev) => ({ ...prev, phone: normalizeTurkishMobilePhone(event.target.value) }))}
                  placeholder="05XXXXXXXXX"
                  inputMode="numeric"
                  maxLength={11}
                  autoComplete="off"
                  name="moderator-new-user-phone"
                />
              </label>
              <label className="space-y-2 text-sm">
                <span className={cn("font-semibold", isDarkMode ? "text-[#dce9df]" : "text-[var(--brand-primary-strong)]")}>
                  {isEditingUser ? "Yeni Şifre" : "Şifre"}
                </span>
                <div className="relative">
                  <Input
                    className={cn(userModalInputClassName, "pr-11")}
                    type={showUserPassword ? "text" : "password"}
                    value={userForm.password}
                    onChange={(event) => setUserForm((prev) => ({ ...prev, password: event.target.value }))}
                    placeholder={isEditingUser ? "Değişmeyecekse boş bırakın" : "En az 6 karakter"}
                    autoComplete="new-password"
                    name="moderator-new-user-password"
                  />
                  <button
                    type="button"
                    aria-label={showUserPassword ? "Şifreyi gizle" : "Şifreyi göster"}
                    onClick={() => setShowUserPassword((previous) => !previous)}
                    className={cn(
                      "absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md transition-colors",
                      isDarkMode
                        ? "text-[#a9b9ae] hover:bg-[#1b2b21] hover:text-[#dce9df]"
                        : "text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                    )}
                  >
                    {showUserPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </label>
              <label className="space-y-2 text-sm">
                <span className={cn("font-semibold", isDarkMode ? "text-[#dce9df]" : "text-[var(--brand-primary-strong)]")}>
                  {isEditingUser ? "Yeni Şifre Tekrar" : "Şifre Tekrar"}
                </span>
                <Input
                  className={userModalInputClassName}
                  type={showUserPassword ? "text" : "password"}
                  value={userForm.password_confirmation}
                  onChange={(event) => setUserForm((prev) => ({ ...prev, password_confirmation: event.target.value }))}
                  placeholder={isEditingUser ? "Şifre yazdıysanız tekrar edin" : "Şifreyi tekrar girin"}
                  autoComplete="new-password"
                  name="moderator-new-user-password-confirmation"
                />
              </label>

              <label className="space-y-2 text-sm">
                <span className={cn("font-semibold", isDarkMode ? "text-[#dce9df]" : "text-[var(--brand-primary-strong)]")}>Bayi</span>
                <select
                  className={userModalSelectClassName}
                  value={userForm.dealer_id}
                  disabled={!userMenuRequiresDealer}
                  onChange={(event) => setUserForm((prev) => ({ ...prev, dealer_id: event.target.value }))}
                >
                  <option value="">{userMenuRequiresDealer ? "Bayi seçin" : "Global kullanıcı"}</option>
                  {dealers.map((dealer) => (
                    <option key={dealer.id} value={dealer.id}>
                      {dealer.code ? `${dealer.code} · ${dealer.name}` : dealer.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-2 text-sm">
                <span className={cn("font-semibold", isDarkMode ? "text-[#dce9df]" : "text-[var(--brand-primary-strong)]")}>Cari Görünürlüğü</span>
                <select
                  className={userModalSelectClassName}
                  value={userForm.customer_scope}
                  disabled={!userMenuRequiresDealer}
                  onChange={(event) =>
                    setUserForm((prev) => ({
                      ...prev,
                      customer_scope: normalizeScopeForRoles(prev.role_slugs, prev.menu_permissions, event.target.value as CustomerScope),
                    }))
                  }
                >
                  <option value="dealer">{customerScopeLabel("dealer")}</option>
                  <option value="assigned">{customerScopeLabel("assigned")}</option>
                  <option value="region">{customerScopeLabel("region")}</option>
                  <option value="branch">{customerScopeLabel("branch")}</option>
                </select>
              </label>
              <label className="space-y-2 text-sm">
                <span className={cn("font-semibold", isDarkMode ? "text-[#dce9df]" : "text-[var(--brand-primary-strong)]")}>Bölge Kodu</span>
                <Input
                  className={userModalInputClassName}
                  value={userForm.region_code}
                  onChange={(event) =>
                    setUserForm((prev) => ({
                      ...prev,
                      region_code: event.target.value,
                      region_name: territoryNameFromCode(event.target.value, prev.region_name),
                    }))
                  }
                  placeholder="KARADENIZ"
                />
              </label>
              <label className="space-y-2 text-sm">
                <span className={cn("font-semibold", isDarkMode ? "text-[#dce9df]" : "text-[var(--brand-primary-strong)]")}>Şube Kodu</span>
                <Input
                  className={userModalInputClassName}
                  value={userForm.branch_code}
                  onChange={(event) =>
                    setUserForm((prev) => ({
                      ...prev,
                      branch_code: event.target.value,
                      branch_name: territoryNameFromCode(event.target.value, prev.branch_name),
                    }))
                  }
                  placeholder="TRABZON"
                />
              </label>
              <label className="space-y-2 text-sm">
                <span className={cn("font-semibold", isDarkMode ? "text-[#dce9df]" : "text-[var(--brand-primary-strong)]")}>Logo Özel Kod4</span>
                <Input
                  className={userModalInputClassName}
                  value={userForm.logo_customer_specode4}
                  onChange={(event) => setUserForm((prev) => ({ ...prev, logo_customer_specode4: event.target.value }))}
                  placeholder="F2 / F3"
                />
              </label>
              <label className="space-y-2 text-sm">
                <span className={cn("font-semibold", isDarkMode ? "text-[#dce9df]" : "text-[var(--brand-primary-strong)]")}>LOGO Kasa Kodu</span>
                <Input
                  className={userModalInputClassName}
                  value={userForm.logo_cashbox_code}
                  onChange={(event) => setUserForm((prev) => ({ ...prev, logo_cashbox_code: event.target.value }))}
                  placeholder="100.01.002"
                />
              </label>
              <label className="space-y-2 text-sm md:col-span-2">
                <span className={cn("font-semibold", isDarkMode ? "text-[#dce9df]" : "text-[var(--brand-primary-strong)]")}>LOGO Kasa Adı</span>
                <Input
                  className={userModalInputClassName}
                  value={userForm.logo_cashbox_name}
                  onChange={(event) => setUserForm((prev) => ({ ...prev, logo_cashbox_name: event.target.value }))}
                  placeholder="ERZURUM MERKEZ KASASI"
                />
              </label>
              <label className="space-y-2 text-sm">
                <span className={cn("font-semibold", isDarkMode ? "text-[#dce9df]" : "text-[var(--brand-primary-strong)]")}>LOGO Gider Hesap Kodu</span>
                <Input className={userModalInputClassName} value={userForm.logo_expense_account_code} onChange={(event) => setUserForm((prev) => ({ ...prev, logo_expense_account_code: event.target.value }))} placeholder="760.25.033" />
              </label>
              <label className="space-y-2 text-sm">
                <span className={cn("font-semibold", isDarkMode ? "text-[#dce9df]" : "text-[var(--brand-primary-strong)]")}>LOGO Gider Hesap Adı</span>
                <Input className={userModalInputClassName} value={userForm.logo_expense_account_name} onChange={(event) => setUserForm((prev) => ({ ...prev, logo_expense_account_name: event.target.value }))} />
              </label>

              <div className={cn("space-y-3 rounded-2xl border p-3 md:col-span-2", userModalSoftClassName)}>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className={cn("text-sm font-semibold", isDarkMode ? "text-[#dce9df]" : "text-[var(--brand-primary-strong)]")}>Kullanıcı Rolleri</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {roleOptions.map((role) => {
                    const checked = userForm.role_slugs.includes(role.slug);

                    return (
                      <label
                        key={`edit-user-role-${role.slug}`}
                        className={userModalPermissionClassName(checked)}
                      >
                        <input
                          className={isDarkMode ? "accent-[#7fac8b]" : "accent-[var(--brand-primary)]"}
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setUserForm((prev) => {
                              const nextRoleSlugs = toggleRoleSlug(prev.role_slugs, role.slug);
                              const nextCustomerScope = normalizeScopeForRoles(nextRoleSlugs, prev.menu_permissions, prev.customer_scope);

                              return {
                                ...prev,
                                role_slugs: nextRoleSlugs,
                                dealer_id: nextRoleSlugs.includes("admin") || nextRoleSlugs.every((roleSlug) => roleSlug === "moderator") ? "" : prev.dealer_id,
                                customer_scope: nextCustomerScope,
                              };
                            })
                          }
                        />
                        {role.name}
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className={cn("space-y-3 rounded-2xl border p-3 md:col-span-2", userModalSoftClassName)}>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className={cn("text-sm font-semibold", isDarkMode ? "text-[#dce9df]" : "text-[var(--brand-primary-strong)]")}>Erişeceği Menüler</span>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      className={cn(
                        "h-10 rounded-xl px-4 text-sm font-extrabold",
                        isDarkMode && "border border-[#6f9d7d] bg-[#20372a] text-[#eef6f0] hover:bg-[#294634]"
                      )}
                      variant={isDarkMode ? "outline" : "secondary"}
                      onClick={() => setPermissionTemplatesOpen(true)}
                    >
                      <ShieldCheck className="h-4 w-4" />
                      Şablonlar
                    </Button>
                    <Button
                      type="button"
                      className={cn("h-10 rounded-xl px-4 text-sm font-extrabold", isDarkMode && "border-[#365b46] bg-[#121d17] text-[#dce9df] hover:bg-[#1a2b21]")}
                      variant="outline"
                      onClick={() =>
                        setUserForm((prev) => {
                          const nextPermissions = menuPermissionOptions.map((permission) => permission.key);

                          return {
                            ...prev,
                            menu_permissions: nextPermissions,
                            feature_permissions: featureDefaultsForMenus(nextPermissions, featurePermissionOptions),
                            customer_scope: normalizeScopeForRoles(prev.role_slugs, nextPermissions, prev.customer_scope),
                          };
                        })
                      }
                    >
                      Tümünü seç
                    </Button>
                    <Button
                      type="button"
                      className={cn("h-10 rounded-xl px-4 text-sm font-extrabold", isDarkMode && "border-[#365b46] bg-[#121d17] text-[#dce9df] hover:bg-[#1a2b21]")}
                      variant="outline"
                      onClick={() =>
                        setUserForm((prev) => ({
                          ...prev,
                          dealer_id: "",
                          customer_scope: "dealer",
                          role_slugs: [],
                          menu_permissions: [],
                          feature_permissions: [],
                        }))
                      }
                    >
                      Temizle
                    </Button>
                  </div>
                </div>

                <div className="grid max-h-[220px] gap-2 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
                  {menuPermissionOptions.map((permission) => {
                    const checked = userForm.menu_permissions.includes(permission.key);

                    return (
                      <label
                        key={`user-modal-${permission.key}`}
                        className={userModalPermissionClassName(checked)}
                      >
                        <input
                          className={isDarkMode ? "accent-[#7fac8b]" : "accent-[var(--brand-primary)]"}
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setUserForm((prev) => {
                              const nextPermissions = toggleMenuPermission(prev.menu_permissions, permission.key);

                              return {
                                ...prev,
                                menu_permissions: nextPermissions,
                                feature_permissions: checked
                                  ? reconcileFeaturePermissions(nextPermissions, prev.feature_permissions, featurePermissionOptions)
                                  : featureDefaultsForMenus(nextPermissions, featurePermissionOptions),
                                dealer_id: menuSelectionRequiresDealer(nextPermissions) ? prev.dealer_id : "",
                                customer_scope: normalizeScopeForRoles(prev.role_slugs, nextPermissions, prev.customer_scope),
                              };
                            })
                          }
                        />
                        {permission.label}
                      </label>
                    );
                  })}
	                </div>
	              </div>

              {warehouseStockFeatureOptions.length > 0 ? (
                <div className={cn("space-y-3 rounded-2xl border p-3 md:col-span-2", userModalSoftClassName)}>
                  <span className={cn("text-sm font-semibold", isDarkMode ? "text-[#dce9df]" : "text-[var(--brand-primary-strong)]")}>Depo Stok Kolonları</span>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {warehouseStockFeatureOptions.map((feature) => {
                      const searchMenuEnabled = userForm.menu_permissions.includes("search");
                      const stockEnabled = userForm.feature_permissions.includes("search.stock");
                      const disabled = !searchMenuEnabled || !stockEnabled;
                      const checked = !disabled && userForm.feature_permissions.includes(feature.key);

                      return (
                        <label
                          key={`user-modal-feature-${feature.key}`}
                          className={cn(userModalPermissionClassName(checked), disabled && "cursor-not-allowed opacity-55")}
                        >
                          <input
                            className={isDarkMode ? "accent-[#7fac8b]" : "accent-[var(--brand-primary)]"}
                            type="checkbox"
                            checked={checked}
                            disabled={disabled}
                            onChange={() =>
                              setUserForm((prev) => ({
                                ...prev,
                                feature_permissions: toggleFeaturePermission(prev.feature_permissions, feature.key),
                              }))
                            }
                          />
                          {feature.label}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ) : null}

	              <label className={cn("flex items-center gap-2 text-sm font-medium md:col-span-2", isDarkMode ? "text-[#dce9df]" : "text-[var(--brand-primary-strong)]")}>
	                <input
                  className={isDarkMode ? "accent-[#7fac8b]" : "accent-[var(--brand-primary)]"}
                  type="checkbox"
                  checked={userForm.is_active}
                  onChange={(event) => setUserForm((prev) => ({ ...prev, is_active: event.target.checked }))}
                />
                Kullanıcı aktif olsun
              </label>
            </div>
          </div>

          <DialogFooter className={cn("mt-0 border-t px-5 py-4 sm:px-6", userModalHeaderClassName)}>
            <Button
              type="button"
              variant="outline"
              className={cn(isDarkMode && "border-[#365b46] bg-[#121d17] text-[#dce9df] hover:bg-[#1a2b21]")}
              onClick={() => closeUserModal(false)}
            >
              Vazgeç
            </Button>
            <Button
              type="button"
              onClick={() => {
                void submitUserModal();
              }}
              disabled={
                createUserMutation.isPending ||
                updateUserMutation.isPending ||
                resetUserPasswordMutation.isPending
              }
            >
              {createUserMutation.isPending || updateUserMutation.isPending || resetUserPasswordMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              {isEditingUser ? "Değişiklikleri Kaydet" : "Kullanıcı Oluştur"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <section className="dashboard-panel-card rounded-[18px] p-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(260px,1fr)_220px_auto] lg:items-end">
          <label className="space-y-2 text-sm">
            <span className="font-extrabold text-[var(--brand-primary-strong)]">Dilek / Şikayet E-posta Adresi</span>
            <Input
              type="email"
              value={complaintMailTo}
              onChange={(event) => setComplaintMailToDraft(event.target.value)}
              placeholder="farukcelik@gucsa.com.tr"
            />
          </label>
          <label className="space-y-2 text-sm">
            <span className="font-extrabold text-[var(--brand-primary-strong)]">Batum Kuru</span>
            <div className="relative">
              <Input
                type="number"
                inputMode="decimal"
                min="0.0001"
                step="0.0001"
                value={batumExchangeRate}
                onChange={(event) => setBatumExchangeRateDraft(event.target.value.replace(",", "."))}
                placeholder="17.0000"
                className="pr-20"
              />
              <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-xs font-extrabold text-[var(--muted-foreground)]">
                TL / GEL
              </span>
            </div>
          </label>
          <Button
            type="button"
            className="h-10 rounded-xl px-5 text-sm font-extrabold"
            disabled={systemSettingsMutation.isPending || !canSaveSystemSettings}
            onClick={() => systemSettingsMutation.mutate()}
          >
            {systemSettingsMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Kur ve E-posta Ayarını Kaydet
          </Button>
        </div>
      </section>

      {view === "create-user" ? (
        <section id="moderator-create-user" className={sectionClassName}>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Ad Soyad</span>
              <Input
                value={userForm.name}
                onChange={(event) => setUserForm((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="Ad soyad"
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">LOGO Gider Hesap Kodu</span>
              <Input value={userForm.logo_expense_account_code} onChange={(event) => setUserForm((prev) => ({ ...prev, logo_expense_account_code: event.target.value }))} placeholder="760.25.033" />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">LOGO Gider Hesap Adı</span>
              <Input value={userForm.logo_expense_account_name} onChange={(event) => setUserForm((prev) => ({ ...prev, logo_expense_account_name: event.target.value }))} />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Kullanıcı Adı</span>
              <Input
                value={userForm.username}
                onChange={(event) => setUserForm((prev) => ({ ...prev, username: event.target.value }))}
                placeholder="plasiyer.ahmet"
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Telefon</span>
              <Input
                value={userForm.phone}
                onChange={(event) => setUserForm((prev) => ({ ...prev, phone: normalizeTurkishMobilePhone(event.target.value) }))}
                placeholder="05XXXXXXXXX"
                inputMode="numeric"
                maxLength={11}
                autoComplete="off"
                name="moderator-inline-new-user-phone"
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Şifre</span>
              <Input
                type="password"
                value={userForm.password}
                onChange={(event) => setUserForm((prev) => ({ ...prev, password: event.target.value }))}
                placeholder="En az 6 karakter"
                autoComplete="new-password"
                name="moderator-inline-new-user-password"
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Şifre Tekrar</span>
              <Input
                type="password"
                value={userForm.password_confirmation}
                onChange={(event) => setUserForm((prev) => ({ ...prev, password_confirmation: event.target.value }))}
                placeholder="Şifreyi tekrar girin"
                autoComplete="new-password"
                name="moderator-inline-new-user-password-confirmation"
              />
            </label>
            <div className="space-y-2 text-sm md:col-span-2 xl:col-span-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <span className="font-semibold text-[var(--brand-primary-strong)]">Kullanıcı Tipi</span>
                <Button
                  type="button"
                  className="h-11 rounded-2xl px-5 text-sm font-extrabold"
                  variant="secondary"
                  onClick={() => setPermissionTemplatesOpen(true)}
                >
                  <ShieldCheck className="h-4 w-4" />
                  Hazır Şablon
                </Button>
              </div>
              <div className="grid gap-2 rounded-2xl border border-[var(--brand-border)] bg-[var(--surface-soft)] p-3 sm:grid-cols-2 lg:grid-cols-3">
                {roleOptions.map((role) => {
                  const checked = userForm.role_slugs.includes(role.slug);

                  return (
                    <label
                      key={`create-user-role-${role.slug}`}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition",
                        checked
                          ? "border-[var(--brand-primary)] bg-[var(--surface)] text-[var(--brand-primary-strong)]"
                          : "border-[var(--brand-border)] bg-[var(--surface)] text-[var(--muted-foreground)] hover:border-[var(--brand-primary)]"
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setUserForm((prev) => {
                            const nextRoleSlugs = toggleRoleSlug(prev.role_slugs, role.slug);
                            const nextCustomerScope = normalizeScopeForRoles(nextRoleSlugs, prev.menu_permissions, prev.customer_scope);

                            return {
                              ...prev,
                              role_slugs: nextRoleSlugs,
                              dealer_id: nextRoleSlugs.includes("admin") || nextRoleSlugs.every((roleSlug) => roleSlug === "moderator") ? "" : prev.dealer_id,
                              customer_scope: nextCustomerScope,
                            };
                          })
                        }
                      />
                      {role.name}
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="space-y-2 text-sm md:col-span-2">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <span className="font-semibold text-[var(--brand-primary-strong)]">Erişeceği Menüler</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    className="h-11 rounded-2xl px-5 text-sm font-extrabold"
                    variant="secondary"
                    onClick={() => setPermissionTemplatesOpen(true)}
                  >
                    <ShieldCheck className="h-4 w-4" />
                    Yetki Şablonları
                  </Button>
                  <Button
                    type="button"
                    className="h-11 rounded-2xl px-5 text-sm font-extrabold"
                    variant="outline"
                    onClick={() =>
                      setUserForm((prev) => {
                        const nextPermissions = menuPermissionOptions.map((permission) => permission.key);

                        return {
                          ...prev,
                          menu_permissions: nextPermissions,
                          feature_permissions: featureDefaultsForMenus(nextPermissions, featurePermissionOptions),
                          customer_scope: normalizeScopeForRoles(prev.role_slugs, nextPermissions, prev.customer_scope),
                        };
                      })
                    }
                  >
                    Tümünü seç
                  </Button>
                  <Button
                    type="button"
                    className="h-11 rounded-2xl px-5 text-sm font-extrabold"
                    variant="outline"
                    onClick={() =>
                      setUserForm((prev) => ({
                        ...prev,
                        dealer_id: "",
                        customer_scope: "dealer",
                        role_slugs: [],
                        menu_permissions: [],
                        feature_permissions: [],
                      }))
                    }
                  >
                    Temizle
                  </Button>
                </div>
              </div>
              <div className="grid gap-2 rounded-2xl border border-[var(--brand-border)] bg-[var(--surface-soft)] p-3 sm:grid-cols-2 lg:grid-cols-3">
                {menuPermissionOptions.map((permission) => {
                  const checked = userForm.menu_permissions.includes(permission.key);

                  return (
                    <label
                      key={permission.key}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition",
                        checked
                          ? "border-[var(--brand-primary)] bg-[var(--surface)] text-[var(--brand-primary-strong)]"
                          : "border-[var(--brand-border)] bg-[var(--surface)] text-[var(--muted-foreground)] hover:border-[var(--brand-primary)]"
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setUserForm((prev) => {
                            const nextPermissions = toggleMenuPermission(prev.menu_permissions, permission.key);

                            return {
                              ...prev,
                              menu_permissions: nextPermissions,
                              feature_permissions: checked
                                ? reconcileFeaturePermissions(nextPermissions, prev.feature_permissions, featurePermissionOptions)
                                : featureDefaultsForMenus(nextPermissions, featurePermissionOptions),
                              dealer_id: menuSelectionRequiresDealer(nextPermissions) ? prev.dealer_id : "",
                              customer_scope: normalizeScopeForRoles(prev.role_slugs, nextPermissions, prev.customer_scope),
                            };
                          })
                        }
                      />
                      {permission.label}
                    </label>
                  );
                })}
              </div>
            </div>
            {warehouseStockFeatureOptions.length > 0 ? (
              <div className="space-y-2 text-sm md:col-span-2">
                <span className="font-semibold text-[var(--brand-primary-strong)]">Depo Stok Kolonları</span>
                <div className="grid gap-2 rounded-2xl border border-[var(--brand-border)] bg-[var(--surface-soft)] p-3 sm:grid-cols-2 lg:grid-cols-3">
                  {warehouseStockFeatureOptions.map((feature) => {
                    const searchMenuEnabled = userForm.menu_permissions.includes("search");
                    const stockEnabled = userForm.feature_permissions.includes("search.stock");
                    const disabled = !searchMenuEnabled || !stockEnabled;
                    const checked = !disabled && userForm.feature_permissions.includes(feature.key);

                    return (
                      <label
                        key={`create-user-feature-${feature.key}`}
                        className={cn(
                          "flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition",
                          checked
                            ? "border-[var(--brand-primary)] bg-[var(--surface)] text-[var(--brand-primary-strong)]"
                            : "border-[var(--brand-border)] bg-[var(--surface)] text-[var(--muted-foreground)] hover:border-[var(--brand-primary)]",
                          disabled && "cursor-not-allowed opacity-55"
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={() =>
                            setUserForm((prev) => ({
                              ...prev,
                              feature_permissions: toggleFeaturePermission(prev.feature_permissions, feature.key),
                            }))
                          }
                        />
                        {feature.label}
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Bayi</span>
              <select
                className={selectClassName}
                value={userForm.dealer_id}
                disabled={!userMenuRequiresDealer}
                onChange={(event) => setUserForm((prev) => ({ ...prev, dealer_id: event.target.value }))}
              >
                <option value="">{userMenuRequiresDealer ? "Bayi seçin" : "-"}</option>
                {dealers.map((dealer) => (
                  <option key={dealer.id} value={dealer.id}>
                    {dealer.code ? `${dealer.code} · ${dealer.name}` : dealer.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Cari Görünürlüğü</span>
              <select
                className={selectClassName}
                value={userForm.customer_scope}
                disabled={!userMenuRequiresDealer}
                onChange={(event) =>
                  setUserForm((prev) => ({
                    ...prev,
                    customer_scope: normalizeScopeForRoles(prev.role_slugs, prev.menu_permissions, event.target.value as CustomerScope),
                  }))
                }
              >
                <option value="dealer">{customerScopeLabel("dealer")}</option>
                <option value="assigned">{customerScopeLabel("assigned")}</option>
                <option value="region">{customerScopeLabel("region")}</option>
                <option value="branch">{customerScopeLabel("branch")}</option>
              </select>
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Bölge Kodu</span>
              <Input
                value={userForm.region_code}
                onChange={(event) =>
                  setUserForm((prev) => ({
                    ...prev,
                    region_code: event.target.value,
                    region_name: territoryNameFromCode(event.target.value, prev.region_name),
                  }))
                }
                placeholder="KARADENIZ"
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Şube Kodu</span>
              <Input
                value={userForm.branch_code}
                onChange={(event) =>
                  setUserForm((prev) => ({
                    ...prev,
                    branch_code: event.target.value,
                    branch_name: territoryNameFromCode(event.target.value, prev.branch_name),
                  }))
                }
                placeholder="TRABZON"
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Logo Özel Kod4</span>
              <Input
                value={userForm.logo_customer_specode4}
                onChange={(event) => setUserForm((prev) => ({ ...prev, logo_customer_specode4: event.target.value }))}
                placeholder="F2 / F3"
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">LOGO Kasa Kodu</span>
              <Input
                value={userForm.logo_cashbox_code}
                onChange={(event) => setUserForm((prev) => ({ ...prev, logo_cashbox_code: event.target.value }))}
                placeholder="100.01.002"
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">LOGO Kasa Adı</span>
              <Input
                value={userForm.logo_cashbox_name}
                onChange={(event) => setUserForm((prev) => ({ ...prev, logo_cashbox_name: event.target.value }))}
                placeholder="ERZURUM MERKEZ KASASI"
              />
            </label>
          </div>

          <label className="mt-4 flex items-center gap-2 text-sm font-medium text-[var(--brand-primary-strong)]">
            <input
              type="checkbox"
              checked={userForm.is_active}
              onChange={(event) => setUserForm((prev) => ({ ...prev, is_active: event.target.checked }))}
            />
            Kullanıcı aktif olsun
          </label>

          <div className="mt-5 flex justify-end">
            <Button
              onClick={() => {
                if (!canCreateUser) {
                  toast.error("Ad, kullanıcı adı, şifre, kullanıcı tipi, menü seçimi ve gerekiyorsa bayi alanını doldurun.");
                  return;
                }

                if (!isValidTurkishMobilePhone(userForm.phone.trim())) {
                  toast.error("❌ Geçerli telefon numarası giriniz");
                  return;
                }

    if (!isEditingUser && userForm.password !== userForm.password_confirmation) {
      toast.error("Şifre ve şifre tekrar aynı olmalı.");
      return;
    }

    if (isEditingUser && userForm.password_confirmation.trim() !== "" && userForm.password !== userForm.password_confirmation) {
      toast.error("Şifre ve şifre tekrar aynı olmalı.");
      return;
    }

                createUserMutation.mutate({
                  dealer_id: userMenuRequiresDealer && userForm.dealer_id !== "" ? Number(userForm.dealer_id) : null,
                  customer_scope: normalizeScopeForRoles(userForm.role_slugs, userForm.menu_permissions, userForm.customer_scope),
                  region_code: userForm.region_code.trim() || null,
                  region_name: territoryNameFromCode(userForm.region_code, userForm.region_name) || null,
                  branch_code: userForm.branch_code.trim() || null,
                  branch_name: territoryNameFromCode(userForm.branch_code, userForm.branch_name) || null,
                  logo_customer_specode4: userForm.logo_customer_specode4.trim() || null,
                  logo_cashbox_code: userForm.logo_cashbox_code.trim() || null,
                  logo_cashbox_name: userForm.logo_cashbox_name.trim() || null,
                  logo_expense_account_code: userForm.logo_expense_account_code.trim() || null,
                  logo_expense_account_name: userForm.logo_expense_account_name.trim() || null,
                  name: userForm.name.trim(),
                  username: userForm.username.trim(),
                  email: null,
                  phone: userForm.phone.trim() || undefined,
                  password: userForm.password,
                  role_slugs: userForm.role_slugs,
                  menu_permissions: userForm.menu_permissions,
                  feature_permissions: reconcileFeaturePermissions(
                    userForm.menu_permissions,
                    userForm.feature_permissions,
                    featurePermissionOptions
                  ),
                  is_active: userForm.is_active,
                });
              }}
              disabled={createUserMutation.isPending}
            >
              {createUserMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Kullanıcıyı Kaydet
            </Button>
          </div>

          <div className="mt-7 border-t border-[var(--brand-border)] pt-5">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-lg font-black text-[var(--brand-primary-strong)]">Kullanıcı Listesi</h2>
                <p className="text-sm text-[var(--muted-foreground)]">
                  Oluşturulan kullanıcılar en yeni kayıt üstte olacak şekilde burada görünür.
                </p>
              </div>
              <Link
                href="/moderator/users"
                className="inline-flex h-10 items-center justify-center rounded-xl border border-[var(--brand-border)] bg-[var(--surface)] px-4 text-sm font-extrabold text-[var(--brand-primary-strong)] transition hover:border-[var(--brand-primary)] hover:bg-[var(--surface-soft)]"
              >
                Tümünü Yönet
              </Link>
            </div>

            <div className={tableShellClassName}>
              <div className="max-h-[430px] overflow-y-auto">
                {usersByCreation.length > 0 ? (
                  <div className="divide-y divide-[var(--brand-border)]">
                    {usersByCreation.map((listedUser) => {
                      const roleText =
                        listedUser.roles.map((role) => role.name).filter(Boolean).join(", ") || "Rol yok";
                      const permissionText =
                        listedUser.menu_permissions
                          .slice(0, 3)
                          .map((permission) => menuPermissionLabel(permission, menuPermissionOptions))
                          .join(", ") || "Menü yok";

                      return (
                        <div
                          key={`created-user-${listedUser.id}`}
                          className="grid gap-3 px-4 py-3 text-sm md:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center"
                        >
                          <div className="min-w-0">
                            <p className="truncate font-black text-[var(--brand-primary-strong)]">
                              {listedUser.name}
                            </p>
                            <p className="mt-0.5 truncate text-xs font-semibold text-[var(--muted-foreground)]">
                              {listedUser.username}
                            </p>
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                              Rol
                            </p>
                            <p className="mt-0.5 truncate font-semibold text-[var(--brand-primary-strong)]">
                              {roleText}
                            </p>
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                              Bayi / Menü
                            </p>
                            <p className="mt-0.5 truncate font-semibold text-[var(--brand-primary-strong)]">
                              {listedUser.dealer.name ?? "Global"}
                            </p>
                            <p className="mt-0.5 truncate text-xs text-[var(--muted-foreground)]">
                              {permissionText}
                              {listedUser.menu_permissions.length > 3
                                ? ` +${listedUser.menu_permissions.length - 3}`
                                : ""}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 md:justify-end">
                            <span
                              className={cn(
                                "inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold",
                                listedUser.is_active
                                  ? isDarkMode
                                    ? "bg-[#193024] text-[#9ad3ae]"
                                    : "bg-[#ebf8ef] text-[#1a7f3e]"
                                  : isDarkMode
                                    ? "bg-[#301e24] text-[#f1a9b5]"
                                    : "bg-[#f5efef] text-[#9a5252]"
                              )}
                            >
                              {listedUser.is_active ? "Aktif" : "Pasif"}
                            </span>
                            <span className="text-xs font-semibold text-[var(--muted-foreground)]">
                              {formatDateTime(listedUser.created_at)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="px-4 py-8 text-center text-sm font-semibold text-[var(--muted-foreground)]">
                    Henüz kullanıcı yok.
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {view === "create-customer" ? (
        <section id="moderator-create-customer" className={sectionClassName}>
          <div className="mb-5 flex items-center gap-3">
            <span className={iconCardClassName}>
              <Building2 className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-lg font-black text-[var(--brand-primary-strong)]">Cari Oluştur</h2>
              <p className="text-sm text-[var(--muted-foreground)]">
                Yeni cariyi açın ve ilk atamayı doğrudan plasiyere verin.
              </p>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Bayi</span>
              <select
                className={selectClassName}
                value={customerForm.dealer_id}
                onChange={(event) =>
                  setCustomerForm((prev) => ({
                    ...prev,
                    dealer_id: event.target.value,
                    salesperson_user_id: "",
                  }))
                }
              >
                <option value="">Bayi seçin</option>
                {dealers.map((dealer) => (
                  <option key={dealer.id} value={dealer.id}>
                    {dealer.code ? `${dealer.code} · ${dealer.name}` : dealer.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Plasiyer</span>
              <select
                className={selectClassName}
                value={customerForm.salesperson_user_id}
                onChange={(event) =>
                  setCustomerForm((prev) => {
                    const nextSalespersonId = event.target.value;
                    const salesperson = createCustomerSalespeople.find(
                      (user) => String(user.id) === nextSalespersonId
                    );

                    return {
                      ...prev,
                      salesperson_user_id: nextSalespersonId,
                      region_code: salesperson?.region_code ?? prev.region_code,
                      region_name:
                        territoryNameFromCode(salesperson?.region_code ?? "", salesperson?.region_name ?? "") ||
                        prev.region_name,
                      branch_code: salesperson?.branch_code ?? prev.branch_code,
                      branch_name:
                        territoryNameFromCode(salesperson?.branch_code ?? "", salesperson?.branch_name ?? "") ||
                        prev.branch_name,
                    };
                  })
                }
              >
                <option value="">Atama yok</option>
                {createCustomerSalespeople.map((salesperson) => (
                  <option key={salesperson.id} value={salesperson.id}>
                    {salesperson.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Bölge Kodu</span>
              <Input
                value={customerForm.region_code}
                onChange={(event) =>
                  setCustomerForm((prev) => ({
                    ...prev,
                    region_code: event.target.value,
                    region_name: territoryNameFromCode(event.target.value, prev.region_name),
                  }))
                }
                placeholder="KARADENIZ"
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Şube Kodu</span>
              <Input
                value={customerForm.branch_code}
                onChange={(event) =>
                  setCustomerForm((prev) => ({
                    ...prev,
                    branch_code: event.target.value,
                    branch_name: territoryNameFromCode(event.target.value, prev.branch_name),
                  }))
                }
                placeholder="TRABZON"
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Cari Kod</span>
              <Input
                value={customerForm.code}
                onChange={(event) => setCustomerForm((prev) => ({ ...prev, code: event.target.value }))}
                placeholder="130-..."
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Ünvan</span>
              <Input
                value={customerForm.name}
                onChange={(event) => setCustomerForm((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="Firma / cari ünvanı"
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Yetkili</span>
              <Input
                value={customerForm.contact_name}
                onChange={(event) => setCustomerForm((prev) => ({ ...prev, contact_name: event.target.value }))}
                placeholder="Yetkili kişi"
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Telefon</span>
              <Input
                value={customerForm.phone}
                onChange={(event) => setCustomerForm((prev) => ({ ...prev, phone: event.target.value }))}
                placeholder="05xx..."
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">E-Posta</span>
              <Input
                value={customerForm.email}
                onChange={(event) => setCustomerForm((prev) => ({ ...prev, email: event.target.value }))}
                placeholder="mail@example.test"
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Kredi Limiti</span>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={customerForm.credit_limit}
                onChange={(event) => setCustomerForm((prev) => ({ ...prev, credit_limit: event.target.value }))}
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Özel İskonto (%)</span>
              <Input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={customerForm.special_discount_rate}
                onChange={(event) => setCustomerForm((prev) => ({ ...prev, special_discount_rate: event.target.value }))}
                placeholder="Örn. 10"
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Şehir</span>
              <Input
                value={customerForm.city}
                onChange={(event) => setCustomerForm((prev) => ({ ...prev, city: event.target.value }))}
                placeholder="Şehir"
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">İlçe</span>
              <Input
                value={customerForm.district}
                onChange={(event) => setCustomerForm((prev) => ({ ...prev, district: event.target.value }))}
                placeholder="İlçe"
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Vergi Dairesi</span>
              <Input
                value={customerForm.tax_office}
                onChange={(event) => setCustomerForm((prev) => ({ ...prev, tax_office: event.target.value }))}
                placeholder="Vergi dairesi"
              />
            </label>
            <label className="space-y-2 text-sm">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Vergi No</span>
              <Input
                value={customerForm.tax_number}
                onChange={(event) => setCustomerForm((prev) => ({ ...prev, tax_number: event.target.value }))}
                placeholder="Vergi numarası"
              />
            </label>
            <label className="space-y-2 text-sm md:col-span-2">
              <span className="font-semibold text-[var(--brand-primary-strong)]">IBAN</span>
              <Input
                value={customerForm.iban}
                onChange={(event) => setCustomerForm((prev) => ({ ...prev, iban: event.target.value }))}
                placeholder="TR..."
              />
            </label>
            <label className="space-y-2 text-sm md:col-span-2">
              <span className="font-semibold text-[var(--brand-primary-strong)]">Adres</span>
              <Textarea
                value={customerForm.address}
                onChange={(event) => setCustomerForm((prev) => ({ ...prev, address: event.target.value }))}
                placeholder="Açık adres"
                className="min-h-[88px]"
              />
            </label>
          </div>

          <label className="mt-4 flex items-center gap-2 text-sm font-medium text-[var(--brand-primary-strong)]">
            <input
              type="checkbox"
              checked={customerForm.is_active}
              onChange={(event) => setCustomerForm((prev) => ({ ...prev, is_active: event.target.checked }))}
            />
            Cari aktif olsun
          </label>

          <div className="mt-5 flex justify-end">
            <Button
              onClick={() => {
                createCustomerMutation.mutate({
                  dealer_id: Number(customerForm.dealer_id),
                  salesperson_user_id:
                    customerForm.salesperson_user_id !== ""
                      ? Number(customerForm.salesperson_user_id)
                      : null,
                  region_code: customerForm.region_code.trim() || null,
                  region_name: territoryNameFromCode(customerForm.region_code, customerForm.region_name) || null,
                  branch_code: customerForm.branch_code.trim() || null,
                  branch_name: territoryNameFromCode(customerForm.branch_code, customerForm.branch_name) || null,
                  code: customerForm.code.trim(),
                  name: customerForm.name.trim(),
                  contact_name: customerForm.contact_name.trim() || undefined,
                  email: customerForm.email.trim() || undefined,
                  phone: customerForm.phone.trim() || undefined,
                  city: customerForm.city.trim() || undefined,
                  district: customerForm.district.trim() || undefined,
                  tax_office: customerForm.tax_office.trim() || undefined,
                  tax_number: customerForm.tax_number.trim() || undefined,
                  credit_limit: Number(customerForm.credit_limit || 0),
                  special_discount_rate:
                    customerForm.special_discount_rate.trim() !== ""
                      ? Number(customerForm.special_discount_rate)
                      : null,
                  address: customerForm.address.trim() || undefined,
                  iban: customerForm.iban.trim() || undefined,
                  is_active: customerForm.is_active,
                });
              }}
              disabled={createCustomerMutation.isPending}
            >
              {createCustomerMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Cariyi Kaydet
            </Button>
          </div>
        </section>
      ) : null}

      {view === "manage-users" ? (
        <section id="moderator-manage-users" className="moderator-users-section dashboard-panel-card rounded-[18px] p-3 lg:p-4">
          <div className="mb-3 flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
            <div className="moderator-user-stats grid gap-2 sm:grid-cols-3 xl:w-[620px]">
              {[
                ["Toplam", summary.users_total],
                ["Aktif", summary.active_users_total],
                ["Plasiyer", summary.salespeople_total],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="dashboard-panel-soft flex h-10 items-center justify-between rounded-xl px-3"
                >
                  <span className="text-[10px] font-black uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                    {label}
                  </span>
                  <span className="text-lg font-black leading-none text-[var(--brand-primary-strong)]">
                    {value}
                  </span>
                </div>
              ))}
            </div>
            <div className="moderator-user-actions flex flex-wrap gap-2 xl:justify-end">
              <Button
                type="button"
                className="h-9 rounded-xl px-3 text-xs font-extrabold"
                onClick={openCreateUserModal}
              >
                <UserPlus className="h-3.5 w-3.5" />
                Kullanıcı Oluştur
              </Button>
              <Button asChild variant="outline" className="h-9 rounded-xl px-3 text-xs font-extrabold">
                <Link href="/moderator/customers">
                  <Building2 className="h-3.5 w-3.5" />
                  Cari / Plasiyer Atama
                </Link>
              </Button>
              <Button asChild variant="outline" className="h-9 rounded-xl px-3 text-xs font-extrabold">
                <Link href="/moderator/finance">
                  <CreditCard className="h-3.5 w-3.5" />
                  Finans Tanımları
                </Link>
              </Button>
            </div>
          </div>

          <div
            className={cn(
              "mb-3 rounded-[16px] px-3 py-2 shadow-[0_14px_32px_-30px_rgba(10,32,20,0.34)]",
              isDarkMode
                ? "bg-[linear-gradient(180deg,var(--surface)_0%,var(--surface-soft)_100%)]"
                : "bg-[linear-gradient(180deg,#fbfdfb_0%,#f5f9f5_100%)]"
            )}
          >
            <div className="grid gap-2 lg:grid-cols-[minmax(280px,1fr)_auto] lg:items-center">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--brand-primary)]" />
                <Input
                  value={userSearch}
                  onChange={(event) => setUserSearch(event.target.value)}
                  placeholder="Ad, kullanıcı adı, telefon, bayi veya menü ara..."
                  className="admin-dashboard-input h-10 rounded-xl pl-9 pr-10 text-sm font-semibold"
                />
                {userSearch ? (
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition hover:bg-[var(--surface-soft)] hover:text-[var(--brand-primary-strong)]"
                    onClick={() => setUserSearch("")}
                    aria-label="Aramayı temizle"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
              <div className="flex h-10 items-center justify-between gap-2 rounded-xl bg-[var(--surface)] px-3 text-xs font-semibold text-[var(--muted-foreground)] lg:justify-end">
                <span>{filteredUsers.length} kullanıcı listeleniyor</span>
                {normalizedUserSearch ? (
                  <span className="rounded-full bg-[var(--brand-accent-soft)] px-2 py-0.5 text-[10px] font-black text-[var(--brand-primary)]">
                    Arama aktif
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          <div className={cn(tableShellClassName, "rounded-[14px] shadow-[0_18px_34px_-34px_rgba(10,32,20,0.32)]")}>
            <div className="overflow-x-auto">
              <table className="moderator-users-table w-full min-w-[980px] table-fixed text-[12px]">
                <colgroup>
                  <col className="w-[23%]" />
                  <col className="w-[18%]" />
                  <col className="w-[25%]" />
                  <col className="w-[10%]" />
                  <col className="w-[8%]" />
                  <col className="w-[16%]" />
                </colgroup>
                <thead className="bg-[linear-gradient(135deg,rgba(22,128,55,0.96)_0%,rgba(18,90,45,0.98)_52%,rgba(11,64,35,1)_100%)]">
                  <tr className="border-b border-emerald-300/35">
                    <th className="px-3 py-2 text-left text-[9px] font-bold uppercase tracking-[0.1em] text-white">
                      Kullanıcı
                    </th>
                    <th className="px-3 py-2 text-left text-[9px] font-bold uppercase tracking-[0.1em] text-white">
                      Bayi / Kapsam
                    </th>
                    <th className="px-3 py-2 text-left text-[9px] font-bold uppercase tracking-[0.1em] text-white">
                      Menüler
                    </th>
                    <th className="px-3 py-2 text-center text-[9px] font-bold uppercase tracking-[0.1em] text-white">
                      Atanan Cari
                    </th>
                    <th className="px-3 py-2 text-center text-[9px] font-bold uppercase tracking-[0.1em] text-white">
                      Durum
                    </th>
                    <th className="px-3 py-2 text-right text-[9px] font-bold uppercase tracking-[0.1em] text-white">
                      Aksiyon
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-xs font-semibold text-[var(--muted-foreground)]">
                        Kullanıcı bulunamadı.
                      </td>
                    </tr>
                  ) : null}

                  {filteredUsers.map((user) => {
                    const roleText =
                      user.roles.map((role) => role.name).filter(Boolean).join(", ") || "Rol yok";
                    const visiblePermissions = user.menu_permissions.slice(0, 3);

                    return (
                      <tr
                        key={user.id}
                        className={cn(
                          "border-b border-l-4 border-l-transparent transition-[background-color,border-color,box-shadow] duration-150",
                          isDarkMode
                            ? "border-[var(--brand-border)] bg-[var(--surface)] hover:border-l-[#8bd19f] hover:bg-[#1d3024]"
                            : "border-[#e7eee8] bg-white hover:border-l-[#2f7f56] hover:bg-[#e7f6eb]"
                        )}
                      >
                        <td className="px-3 py-2 align-middle">
                          <div className="min-w-0">
                            <p className="truncate text-[13px] font-extrabold leading-5 text-[var(--brand-primary-strong)]">
                              {user.name}
                            </p>
                            <div className="mt-0.5 flex min-w-0 flex-col gap-0.5 text-[10px] font-semibold leading-4 text-[var(--muted-foreground)]">
                              <span className="flex min-w-0 items-center gap-1.5">
                                <UserCog className="h-3 w-3 shrink-0" />
                                <span className="truncate">{user.username}</span>
                              </span>
                              <span className="flex min-w-0 items-center gap-1.5">
                                <Phone className="h-3 w-3 shrink-0" />
                                <span className="truncate">{user.phone || "Telefon yok"}</span>
                              </span>
                            </div>
                            <p className="mt-0.5 text-[10px] font-semibold leading-4 text-[var(--muted-foreground)]">
                              {formatDateTime(user.created_at)}
                            </p>
                          </div>
                        </td>
                        <td className="px-3 py-2 align-middle">
                          <p className="truncate text-[12px] font-extrabold leading-5 text-[var(--brand-primary-strong)]">
                            {user.dealer.name ?? "Global kullanıcı"}
                          </p>
                          <p className="truncate text-[10px] font-semibold leading-4 text-[var(--muted-foreground)]">
                            {user.dealer.code ?? roleText}
                          </p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <span className={compactMenuPillClassName}>{customerScopeLabel(user.customer_scope)}</span>
                            {user.region_code ? <span className={compactMenuPillClassName}>{user.region_code}</span> : null}
                            {user.branch_code ? <span className={compactMenuPillClassName}>{user.branch_code}</span> : null}
                          </div>
                        </td>
                        <td className="px-3 py-2 align-middle">
                          <div className="flex flex-wrap gap-1">
                            {visiblePermissions.length > 0 ? (
                              visiblePermissions.map((permission) => {
                                const PermissionIcon = menuPermissionIcon(permission);

                                return (
                                  <span key={`${user.id}-${permission}`} className={cn(compactMenuPillClassName, "inline-flex items-center gap-1")}>
                                    <PermissionIcon className="h-3 w-3" />
                                    {menuPermissionLabel(permission, menuPermissionOptions)}
                                  </span>
                                );
                              })
                            ) : (
                              <span className={compactMenuPillClassName}>Menü yok</span>
                            )}
                            {user.menu_permissions.length > 3 ? (
                              <span className={compactMenuPillClassName}>+{user.menu_permissions.length - 3}</span>
                            ) : null}
                          </div>
                          <p className="mt-1 line-clamp-1 text-[10px] font-semibold leading-4 text-[var(--muted-foreground)]">
                            {roleText}
                          </p>
                        </td>
                        <td className="px-3 py-2 text-center align-middle">
                          <div className="mx-auto inline-flex min-w-[54px] justify-center rounded-md border border-[var(--brand-border)] bg-[var(--surface-soft)] px-2 py-1">
                            <span className="text-[12px] font-black leading-4 text-[var(--brand-primary-strong)]">
                              {user.assigned_customers_count}
                            </span>
                          </div>
                          <p className="mx-auto mt-1 line-clamp-1 max-w-[100px] text-[10px] leading-4 text-[var(--muted-foreground)]">
                            {user.selected_customer.title ?? "Seçili cari yok"}
                          </p>
                        </td>
                        <td className="px-3 py-2 text-center align-middle">
                          <span
                            className={cn(
                              "inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold leading-4",
                              user.is_active
                                ? isDarkMode
                                  ? "bg-[#193024] text-[#9ad3ae]"
                                  : "bg-[#ebf8ef] text-[#1a7f3e]"
                                : isDarkMode
                                  ? "bg-[#301e24] text-[#f1a9b5]"
                                  : "bg-[#f5efef] text-[#9a5252]"
                            )}
                          >
                            {user.is_active ? "Aktif" : "Pasif"}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right align-middle">
                          <div className="flex justify-end gap-1.5">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-8 rounded-lg px-2.5 text-xs font-semibold"
                              onClick={() => openEditUserModal(user)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              Düzenle
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className={cn(
                                "h-8 rounded-lg px-2.5",
                                isDarkMode
                                  ? "border-red-900/60 text-red-200 hover:bg-red-950/40 hover:text-red-100"
                                  : "border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
                              )}
                              onClick={() => {
                                if (!window.confirm(`${user.name} kullanıcısını silmek istiyor musunuz?`)) {
                                  return;
                                }

                                deleteUserMutation.mutate(user.id);
                              }}
                              disabled={deleteUserMutation.isPending}
                              aria-label={`${user.name} kullanıcısını sil`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      {view === "manage-customers" ? (
        <section id="moderator-manage-customers" className={sectionClassName}>
        <div className="mb-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex items-center gap-3">
          <span className={iconCardClassName}>
            <Building2 className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-lg font-black text-[var(--brand-primary-strong)]">Cari Atamaları</h2>
            <p className="text-sm text-[var(--muted-foreground)]">
              Her cariyi doğrudan ilgili plasiyere bağlayın. Atanmayan cari plasiyer listesinde görünmez.
            </p>
          </div>
          </div>
          <div className="flex flex-wrap gap-2 xl:justify-end">
            <Button asChild className="h-9 rounded-xl px-3 text-xs font-extrabold">
              <Link href="/moderator/customers/new">
                <Building2 className="h-3.5 w-3.5" />
                Cari Oluştur
              </Link>
            </Button>
            <Button type="button" variant="outline" className="h-9 rounded-xl px-3 text-xs font-extrabold" onClick={openCreateUserModal}>
              <UserPlus className="h-3.5 w-3.5" />
              Kullanıcı Oluştur
            </Button>
          </div>
        </div>

        <div className="mb-5 grid gap-3 md:grid-cols-3">
          <div className={statCardClassName}>
            <p className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
              Toplam Cari
            </p>
            <p className="mt-2 text-3xl font-black tracking-tight text-[var(--brand-primary-strong)]">
              {summary.customers_total}
            </p>
          </div>
          <div className={statCardClassName}>
            <p className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
              Aktif Cari
            </p>
            <p className="mt-2 text-3xl font-black tracking-tight text-[var(--brand-primary-strong)]">
              {summary.active_customers_total}
            </p>
          </div>
          <div className={statCardClassName}>
            <p className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
              Atanmayan Cari
            </p>
            <p className="mt-2 text-3xl font-black tracking-tight text-[var(--brand-primary-strong)]">
              {summary.unassigned_customers_total}
            </p>
          </div>
        </div>

        <div className="mb-4 grid gap-3 xl:grid-cols-[minmax(280px,420px)_auto] xl:items-center xl:justify-between">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
            <Input
              value={customerSearch}
              onChange={(event) => setCustomerSearch(event.target.value)}
              placeholder="Cari kodu, unvan, şehir veya telefon ara"
              className="h-11 rounded-xl pl-9"
            />
          </label>
          <div className="text-xs font-extrabold text-[var(--muted-foreground)]">
            {overviewQuery.isFetching ? "Cariler yenileniyor..." : `${customers.length} / ${summary.customers_total} cari listeleniyor`}
          </div>
        </div>

        <div className={tableShellClassName}>
          <table className="w-full min-w-[1260px] text-sm">
            <thead className={tableHeadClassName}>
              <tr>
                <th className="px-4 py-3 text-left font-extrabold uppercase tracking-[0.12em]">Cari</th>
                <th className="px-4 py-3 text-left font-extrabold uppercase tracking-[0.12em]">Bayi</th>
                <th className="px-4 py-3 text-left font-extrabold uppercase tracking-[0.12em]">Plasiyer</th>
                <th className="px-4 py-3 text-left font-extrabold uppercase tracking-[0.12em]">İletişim</th>
                <th className="px-4 py-3 text-left font-extrabold uppercase tracking-[0.12em]">Bakiye</th>
                <th className="px-4 py-3 text-left font-extrabold uppercase tracking-[0.12em]">Özel İskonto</th>
                <th className="px-4 py-3 text-left font-extrabold uppercase tracking-[0.12em]">Durum</th>
                <th className="px-4 py-3 text-right font-extrabold uppercase tracking-[0.12em]">Aksiyon</th>
              </tr>
            </thead>
            <tbody>
              {customers.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-sm font-semibold text-[var(--muted-foreground)]">
                    Cari bulunamadı.
                  </td>
                </tr>
              ) : null}
              {customers.map((customer) => {
                const draft = getCustomerDraft(customer);
                const totalDue = customer.balance_summary?.total_due ?? customer.credit_limit;
                const balanceSource = customer.balance_source === "logo" ? "Logo bakiye" : "Bakiye";
                const rowSalespeople = salespeople.filter(
                  (salesperson) => String(salesperson.dealer_id ?? "") === draft.dealer_id
                );

                return (
                  <tr key={customer.id} className={tableRowClassName}>
                    <td className="px-4 py-4">
                      <p className="font-extrabold text-[var(--brand-primary-strong)]">{customer.code}</p>
                      <p className="mt-1 text-sm font-semibold text-[var(--foreground)]">{customer.name}</p>
                      <p className="mt-2 inline-flex rounded-full border border-[var(--brand-border)] px-2.5 py-1 text-[11px] font-bold text-[var(--muted-foreground)]">
                        Logo cari
                      </p>
                    </td>
                    <td className="px-4 py-4">
                      <select
                        className={selectClassName}
                        value={draft.dealer_id}
                        onChange={(event) =>
                          setCustomerDrafts((prev) => ({
                            ...prev,
                            [customer.id]: {
                              ...draft,
                              dealer_id: event.target.value,
                              salesperson_user_id: "",
                              region_code: "",
                              region_name: "",
                              branch_code: "",
                              branch_name: "",
                            },
                          }))
                        }
                      >
                        {dealers.map((dealer) => (
                          <option key={dealer.id} value={dealer.id}>
                            {dealer.code ? `${dealer.code} · ${dealer.name}` : dealer.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-4">
                      <select
                        className={selectClassName}
                        value={draft.salesperson_user_id}
                        onChange={(event) =>
                          setCustomerDrafts((prev) => {
                            const nextSalespersonId = event.target.value;
                            const salesperson = rowSalespeople.find(
                              (user) => String(user.id) === nextSalespersonId
                            );

                            return {
                              ...prev,
                              [customer.id]: {
                                ...draft,
                                salesperson_user_id: nextSalespersonId,
                                region_code: salesperson?.region_code ?? draft.region_code,
                                region_name:
                                  territoryNameFromCode(
                                    salesperson?.region_code ?? "",
                                    salesperson?.region_name ?? ""
                                  ) || draft.region_name,
                                branch_code: salesperson?.branch_code ?? draft.branch_code,
                                branch_name:
                                  territoryNameFromCode(
                                    salesperson?.branch_code ?? "",
                                    salesperson?.branch_name ?? ""
                                  ) || draft.branch_name,
                              },
                            };
                          })
                        }
                      >
                        <option value="">Atama yok</option>
                        {rowSalespeople.map((salesperson) => (
                          <option key={salesperson.id} value={salesperson.id}>
                            {salesperson.name}
                          </option>
                        ))}
                      </select>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <Input
                          value={draft.region_code}
                          onChange={(event) =>
                            setCustomerDrafts((prev) => ({
                              ...prev,
                              [customer.id]: {
                                ...draft,
                                region_code: event.target.value,
                                region_name: territoryNameFromCode(event.target.value, draft.region_name),
                              },
                            }))
                          }
                          placeholder="Bölge"
                        />
                        <Input
                          value={draft.branch_code}
                          onChange={(event) =>
                            setCustomerDrafts((prev) => ({
                              ...prev,
                              [customer.id]: {
                                ...draft,
                                branch_code: event.target.value,
                                branch_name: territoryNameFromCode(event.target.value, draft.branch_name),
                              },
                            }))
                          }
                          placeholder="Şube"
                        />
                      </div>
                      <p className="mt-2 text-xs text-[var(--muted-foreground)]">
                        {customer.salesperson.name ?? "Atanmadı"}
                      </p>
                    </td>
                    <td className="px-4 py-4">
                      <p className="font-semibold text-[var(--brand-primary-strong)]">
                        {customer.phone || "Telefon yok"}
                      </p>
                      <p className="text-xs text-[var(--muted-foreground)]">
                        {[customer.city, customer.district].filter(Boolean).join(" / ") || "Lokasyon yok"}
                      </p>
                    </td>
                    <td className="px-4 py-4">
                      <p className="font-semibold text-[var(--brand-primary-strong)]">
                        {formatMoney(totalDue)}
                      </p>
                      <p className="mt-1 text-xs text-[var(--muted-foreground)]">{balanceSource}</p>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min="0"
                          max="100"
                          step="0.01"
                          value={draft.special_discount_rate}
                          onChange={(event) =>
                            setCustomerDrafts((prev) => ({
                              ...prev,
                              [customer.id]: { ...draft, special_discount_rate: event.target.value },
                            }))
                          }
                          placeholder="0"
                          className="w-24"
                        />
                        <span className="text-sm font-black text-[var(--muted-foreground)]">%</span>
                      </div>
                      <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                        Sepette otomatik uygulanır
                      </p>
                    </td>
                    <td className="px-4 py-4">
                      <label className="flex items-center gap-2 text-sm font-medium text-[var(--brand-primary-strong)]">
                        <input
                          type="checkbox"
                          checked={draft.is_active}
                          onChange={(event) =>
                            setCustomerDrafts((prev) => ({
                              ...prev,
                              [customer.id]: { ...draft, is_active: event.target.checked },
                            }))
                          }
                        />
                        {draft.is_active ? "Aktif" : "Pasif"}
                      </label>
                    </td>
                    <td className="px-4 py-4 text-right">
                      <Button
                        size="sm"
                        onClick={() => {
                          updateCustomerMutation.mutate({
                            customerId: customer.id,
                            payload: {
                              dealer_id: Number(draft.dealer_id),
                              salesperson_user_id:
                                draft.salesperson_user_id !== "" ? Number(draft.salesperson_user_id) : null,
                              region_code: draft.region_code.trim() || null,
                              region_name: territoryNameFromCode(draft.region_code, draft.region_name) || null,
                              branch_code: draft.branch_code.trim() || null,
                              branch_name: territoryNameFromCode(draft.branch_code, draft.branch_name) || null,
                              special_discount_rate:
                                draft.special_discount_rate.trim() !== ""
                                  ? Number(draft.special_discount_rate)
                                  : null,
                              is_active: draft.is_active,
                            },
                          });
                        }}
                        disabled={updateCustomerMutation.isPending}
                      >
                        Kaydet
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </section>
      ) : null}
    </div>
  );
}
