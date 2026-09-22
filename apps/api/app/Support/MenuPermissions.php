<?php

namespace App\Support;

use App\Models\User;

final class MenuPermissions
{
    /**
     * @return array<int, array{key:string,label:string,href:string}>
     */
    public static function definitions(): array
    {
        return [
            ['key' => 'dashboard', 'label' => 'Kontrol Paneli', 'href' => '/dashboard'],
            ['key' => 'notes', 'label' => 'Notlar', 'href' => '/notes'],
            ['key' => 'search', 'label' => 'Ürün Arama', 'href' => '/search'],
            ['key' => 'campaigns', 'label' => 'Kampanyalar', 'href' => '/campaigns'],
            ['key' => 'catalogs', 'label' => 'Kataloglar', 'href' => '/catalogs'],
            ['key' => 'cart', 'label' => 'Sepet', 'href' => '/cart'],
            ['key' => 'orders', 'label' => 'Siparişler', 'href' => '/orders'],
            ['key' => 'customer-complaints', 'label' => 'Dilek / Şikayet', 'href' => '/dilek-sikayet'],
            ['key' => 'customers', 'label' => 'Müşteriler', 'href' => '/customers'],
            ['key' => 'customer-users', 'label' => 'Müşteri Kullanıcı', 'href' => '/customer-users'],
            ['key' => 'personnel-tracking', 'label' => 'Personel Takip', 'href' => '/personel-takip'],
            ['key' => 'new-customer-card', 'label' => 'Yeni Cari Kart', 'href' => '/new-customer-card'],
            ['key' => 'ledger', 'label' => 'Cari Hesap', 'href' => '/ledger'],
            ['key' => 'collections', 'label' => 'Tahsilat', 'href' => '/collections'],
            ['key' => 'reports', 'label' => 'Raporlama Merkezi', 'href' => '/reports'],
            ['key' => 'returns', 'label' => 'İade / Arıza', 'href' => '/returns'],
            ['key' => 'pos', 'label' => 'Hızlı Satış', 'href' => '/pos'],
            ['key' => 'pos-expenses', 'label' => 'POS Masraf', 'href' => '/pos/expenses'],
            ['key' => 'pos-day-end', 'label' => 'POS Gün Sonu', 'href' => '/pos/day-end'],
            ['key' => 'warehouse', 'label' => 'Depo', 'href' => '/warehouse'],
            ['key' => 'rack-addresses', 'label' => 'Ürünler', 'href' => '/warehouse/rack-addresses'],
            ['key' => 'moderator', 'label' => 'Moderatör', 'href' => '/moderator'],
            ['key' => 'extra', 'label' => 'Satınalma / Mal Kabul', 'href' => '/mal-kabul'],
            ['key' => 'virtual-pos', 'label' => 'Sanal Pos', 'href' => '/virtual-pos'],
            ['key' => 'delivery-notes', 'label' => 'İrsaliye Döküm', 'href' => '/irsaliye-dokum'],
        ];
    }

    /**
     * @return list<string>
     */
    public static function keys(): array
    {
        return array_map(
            fn (array $definition): string => $definition['key'],
            self::definitions()
        );
    }

    /**
     * @param  iterable<mixed>  $permissions
     * @return list<string>
     */
    public static function normalize(iterable $permissions): array
    {
        $allowed = array_flip(self::keys());
        $normalized = [];

        foreach ($permissions as $permission) {
            if (! is_string($permission)) {
                continue;
            }

            $key = trim($permission);
            if ($key === '' || ! isset($allowed[$key]) || in_array($key, $normalized, true)) {
                continue;
            }

            $normalized[] = $key;
        }

        return $normalized;
    }

    /**
     * @param  iterable<string>  $roleSlugs
     * @return list<string>
     */
    public static function fromRoles(iterable $roleSlugs): array
    {
        $roles = [];
        foreach ($roleSlugs as $roleSlug) {
            $roles[] = $roleSlug;
        }

        if (
            in_array('admin', $roles, true)
            || in_array('global', $roles, true)
            || in_array('global_user', $roles, true)
        ) {
            return self::keys();
        }

        $permissions = [];

        if (in_array('dealer_admin', $roles, true)) {
            $permissions = array_merge($permissions, [
                'dashboard',
                'notes',
                'search',
                'catalogs',
                'cart',
                'orders',
                'returns',
                'extra',
                'virtual-pos',
                'delivery-notes',
            ]);
        }

        if (in_array('salesperson', $roles, true)) {
            $permissions = array_merge($permissions, [
                'dashboard',
                'notes',
                'search',
                'catalogs',
                'cart',
                'customers',
                'new-customer-card',
                'ledger',
                'collections',
                'reports',
                'orders',
                'returns',
                'extra',
                'virtual-pos',
            ]);
        }

        if (in_array('warehouse', $roles, true)) {
            $permissions[] = 'warehouse';
        }

        if (in_array('moderator', $roles, true)) {
            $permissions[] = 'moderator';
            $permissions[] = 'customer-users';
        }

        if (in_array('accounting', $roles, true) || in_array('muhasebe', $roles, true)) {
            $permissions = array_merge($permissions, [
                'dashboard',
                'customers',
                'ledger',
                'collections',
                'reports',
            ]);
        }

        if (in_array('point', $roles, true) || in_array('cashier', $roles, true)) {
            $permissions[] = 'pos';
            $permissions[] = 'notes';
            $permissions[] = 'delivery-notes';
        }

        if (in_array('point', $roles, true)) {
            $permissions[] = 'new-customer-card';
        }

        if (in_array('customer', $roles, true)) {
            $permissions = array_merge($permissions, [
                'dashboard',
                'notes',
                'search',
                'catalogs',
                'cart',
                'orders',
                'ledger',
                'customer-complaints',
            ]);
        }

        return self::normalize($permissions);
    }

    /**
     * @param  iterable<string>  $permissions
     * @return list<string>
     */
    public static function rolesForPermissions(iterable $permissions): array
    {
        $permissions = self::normalize($permissions);
        $roles = [];
        $dealerScopedMenus = [
            'dashboard',
            'notes',
            'search',
            'catalogs',
            'cart',
            'orders',
            'customer-complaints',
            'customers',
            'new-customer-card',
            'ledger',
            'collections',
            'reports',
            'returns',
            'rack-addresses',
            'extra',
            'virtual-pos',
            'delivery-notes',
        ];

        if (count(array_intersect($permissions, $dealerScopedMenus)) > 0) {
            $roles[] = 'dealer_admin';
        }

        if (
            in_array('pos', $permissions, true)
            || in_array('pos-expenses', $permissions, true)
            || in_array('pos-day-end', $permissions, true)
        ) {
            $roles[] = 'point';
        }

        if (in_array('warehouse', $permissions, true) || in_array('rack-addresses', $permissions, true)) {
            $roles[] = 'warehouse';
        }

        if (in_array('moderator', $permissions, true)) {
            $roles[] = 'moderator';
        }

        if (in_array('customer-users', $permissions, true)) {
            $roles[] = 'moderator';
        }

        return array_values(array_unique($roles));
    }

    /**
     * @return list<string>
     */
    public static function forUser(User $user): array
    {
        if ($user->menu_permissions !== null) {
            return is_array($user->menu_permissions) ? self::normalize($user->menu_permissions) : [];
        }

        $roleSlugs = $user->relationLoaded('roles')
            ? $user->roles->pluck('slug')->all()
            : $user->roles()->pluck('slug')->all();

        return self::fromRoles($roleSlugs);
    }
}
