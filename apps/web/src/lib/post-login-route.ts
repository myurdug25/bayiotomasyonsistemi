type RoleLike = {
  slug?: string | null;
};

type UserLike = {
  roles?: RoleLike[] | null;
  menu_permissions?: string[] | null;
};

export const USER_CONTEXT_STORAGE_KEYS = [
  "powersa:selected_customer",
  "last_route",
  "previousPath",
  "redirectAfterLogin",
  "lastRoute",
  "lastPath",
  "selectedCustomer",
  "selected_customer",
  "customerContext",
  "branchContext",
  "warehouseContext",
  "priceGroupContext",
] as const;

export function clearUserContextStorage() {
  if (typeof window === "undefined") {
    return;
  }

  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (const key of USER_CONTEXT_STORAGE_KEYS) {
      storage.removeItem(key);
    }

    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (!key) {
        continue;
      }

      if (
        key.startsWith("last_route") ||
        key.startsWith("previousPath") ||
        key.startsWith("redirectAfterLogin") ||
        key.startsWith("powersa:selected_customer")
      ) {
        storage.removeItem(key);
      }
    }
  }
}

export function resolvePostLoginRoute(user: UserLike | null | undefined): string {
  const roleSlugs = Array.isArray(user?.roles) ? user.roles.map((role) => role.slug).filter(Boolean) : [];
  const hasRole = (slug: string) => roleSlugs.includes(slug);
  const privileged = hasRole("admin") || hasRole("dealer_admin") || hasRole("salesperson");
  const warehouseOnly = hasRole("warehouse") && !privileged;
  const pointOnly = (hasRole("point") || hasRole("cashier")) && !privileged && !hasRole("warehouse");

  if (pointOnly) {
    return "/pos";
  }

  if (warehouseOnly) {
    return "/warehouse";
  }

  return "/dashboard";
}
