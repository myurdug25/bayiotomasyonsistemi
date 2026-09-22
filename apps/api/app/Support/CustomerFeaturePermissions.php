<?php

namespace App\Support;

use App\Models\User;

final class CustomerFeaturePermissions
{
    /**
     * @return array<int, array{key:string,label:string,menu_key:string,codes:list<string>,names:list<string>}>
     */
    public static function stockWarehouseDefinitions(): array
    {
        return [
            [
                'key' => 'search.stock.warehouse.erzurum_depo',
                'label' => 'Erzurum Depo',
                'menu_key' => 'search',
                'codes' => ['1', '25'],
                'names' => ['erzurum', 'erzurum dep', 'erzurum depo', 'erz depo', 'depo'],
            ],
            [
                'key' => 'search.stock.warehouse.erzurum_point',
                'label' => 'Erzurum Point',
                'menu_key' => 'search',
                'codes' => ['0'],
                'names' => ['erzurum point', 'erz point', 'erz.point', 'point'],
            ],
            [
                'key' => 'search.stock.warehouse.trabzon',
                'label' => 'Trabzon Depo',
                'menu_key' => 'search',
                'codes' => ['2', '61'],
                'names' => ['trabzon dep', 'trabzon depo', 'trabzon', 'trb depo', 'trb'],
            ],
            [
                'key' => 'search.stock.warehouse.samsun',
                'label' => 'Samsun Depo',
                'menu_key' => 'search',
                'codes' => ['3', '55'],
                'names' => ['samsun depo', 'samsun', 'sam depo', 'sam'],
            ],
            [
                'key' => 'search.stock.warehouse.batum',
                'label' => 'Batum Depo',
                'menu_key' => 'search',
                'codes' => ['4'],
                'names' => ['batum depo', 'batum', 'batumi'],
            ],
        ];
    }

    /**
     * @return array<int, array{key:string,label:string,menu_key:string}>
     */
    public static function definitions(): array
    {
        return array_merge([
            ['key' => 'dashboard.summary', 'label' => 'Özet kutuları', 'menu_key' => 'dashboard'],
            ['key' => 'dashboard.reports', 'label' => 'Dashboard raporları', 'menu_key' => 'dashboard'],
            ['key' => 'search.prices', 'label' => 'Fiyatları gör', 'menu_key' => 'search'],
            ['key' => 'search.stock', 'label' => 'Stokları gör', 'menu_key' => 'search'],
            ['key' => 'search.add_to_cart', 'label' => 'Sepete ekle', 'menu_key' => 'search'],
            ['key' => 'search.product_detail', 'label' => 'Ürün detayları', 'menu_key' => 'search'],
            ['key' => 'search.campaigns', 'label' => 'Kampanyaları göster', 'menu_key' => 'search'],
            ['key' => 'catalogs.new_products', 'label' => 'Yeni ürünler', 'menu_key' => 'catalogs'],
            ['key' => 'catalogs.hot_products', 'label' => 'Kampanyalar', 'menu_key' => 'catalogs'],
            ['key' => 'cart.view', 'label' => 'Sepeti gör', 'menu_key' => 'cart'],
            ['key' => 'cart.checkout', 'label' => 'Sipariş gönder', 'menu_key' => 'cart'],
            ['key' => 'cart.payment.show', 'label' => 'Ödeme Şekli Alanını Göster', 'menu_key' => 'cart'],
            ['key' => 'cart.sale_type.detailed', 'label' => 'Satış tipi: 1-F', 'menu_key' => 'cart'],
            ['key' => 'cart.sale_type.excluded', 'label' => 'Satış tipi: 2-0', 'menu_key' => 'cart'],
            ['key' => 'cart.sale_type.included', 'label' => 'Satış tipi: 3-B', 'menu_key' => 'cart'],
            ['key' => 'orders.list', 'label' => 'Sipariş listesi', 'menu_key' => 'orders'],
            ['key' => 'orders.detail', 'label' => 'Sipariş detayı', 'menu_key' => 'orders'],
            ['key' => 'customer-complaints.create', 'label' => 'Dilek / Şikayet gönder', 'menu_key' => 'customer-complaints'],
            ['key' => 'ledger.balance', 'label' => 'Bakiye gör', 'menu_key' => 'ledger'],
            ['key' => 'ledger.movements', 'label' => 'Hareketleri gör', 'menu_key' => 'ledger'],
            ['key' => 'reports.customer_balance', 'label' => 'Cari bakiye raporu', 'menu_key' => 'reports'],
            ['key' => 'reports.order_balance', 'label' => 'Sipariş bakiye raporu', 'menu_key' => 'reports'],
            ['key' => 'returns.create', 'label' => 'İade / arıza oluştur', 'menu_key' => 'returns'],
            ['key' => 'returns.list', 'label' => 'İade / arıza listesi', 'menu_key' => 'returns'],
            ['key' => 'rack-addresses.update', 'label' => 'Ürün bilgisi güncelleme', 'menu_key' => 'rack-addresses'],
        ], array_map(
            fn (array $warehouse): array => [
                'key' => $warehouse['key'],
                'label' => $warehouse['label'],
                'menu_key' => $warehouse['menu_key'],
            ],
            self::stockWarehouseDefinitions()
        ));
    }

    /**
     * @return list<string>
     */
    public static function stockWarehouseKeys(): array
    {
        return array_map(
            fn (array $definition): string => $definition['key'],
            self::stockWarehouseDefinitions()
        );
    }

    /**
     * @return list<string>
     */
    public static function keys(): array
    {
        return array_values(array_unique(array_merge(array_map(
            fn (array $definition): string => $definition['key'],
            self::definitions()
        ), self::legacyPaymentKeys())));
    }

    /**
     * Eski müşteri kayıtlarını kayıp yaşamadan okuyabilmek için kabul edilir,
     * fakat yönetim ekranında artık tek tek ödeme seçeneği olarak gösterilmez.
     *
     * @return list<string>
     */
    public static function legacyPaymentKeys(): array
    {
        return [
            'cart.payment.account',
            'cart.payment.cash',
            'cart.payment.transfer',
            'cart.payment.single_payment',
            'cart.payment.check',
            'cart.payment.note',
            'cart.payment.physical_pos',
        ];
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
     * @param  iterable<mixed>  $menuPermissions
     * @return list<string>
     */
    public static function defaultsForMenus(iterable $menuPermissions): array
    {
        $menus = array_flip(MenuPermissions::normalize($menuPermissions));

        return array_values(array_map(
            fn (array $definition): string => $definition['key'],
            array_filter(
                self::definitions(),
                fn (array $definition): bool => isset($menus[$definition['menu_key']])
                    && $definition['key'] !== 'cart.payment.show'
                    && ! str_starts_with($definition['key'], 'cart.sale_type.')
            )
        ));
    }

    /**
     * @return list<string>
     */
    public static function forUser(User $user): array
    {
        if ($user->feature_permissions !== null) {
            return is_array($user->feature_permissions)
                ? self::normalize($user->feature_permissions)
                : [];
        }

        return self::defaultsForMenus(MenuPermissions::forUser($user));
    }

    /**
     * @return list<string>
     */
    public static function checkoutSummaryModesForUser(User $user): array
    {
        $permissions = self::forUser($user);
        $permissionSet = array_flip($permissions);

        $modes = [];
        $mapping = [
            'cart.sale_type.detailed' => 'detailed',
            'cart.sale_type.excluded' => 'excluded',
            'cart.sale_type.included' => 'included',
        ];

        foreach ($mapping as $permission => $mode) {
            if (isset($permissionSet[$permission])) {
                $modes[] = $mode;
            }
        }

        return $modes;
    }
}
