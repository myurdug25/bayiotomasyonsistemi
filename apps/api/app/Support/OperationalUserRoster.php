<?php

namespace App\Support;

final class OperationalUserRoster
{
    /**
     * @return list<array{
     *     username:string,
     *     name:string,
     *     roles:list<string>,
     *     menu_permissions:list<string>,
     *     region_code:?string,
     *     region_name:?string,
     *     branch_code:?string,
     *     branch_name:?string,
     *     customer_scope:?string,
     *     logo_customer_specode4:?string
     * }>
     */
    public static function users(): array
    {
        return [
            self::admin('admin', 'Admin'),

            self::dealerAdmin('dealer_admin', 'Bayi Yöneticisi'),
            self::moderator('moderator', 'Moderatör'),
            self::salesperson('salesperson', 'Plasiyer', null, null),
            self::warehouse('warehouse', 'Depo Kullanıcısı', null, null),
            self::point('point', 'Point Bayi', null, null),

            self::salesperson('ahmet.arac', 'AHMET ARAÇ', 'ERZURUM', 'Erzurum', 'A'),
            self::salesperson('huseyin.ozguney', 'HÜSEYİN ÖZGÜNEY', 'ERZURUM', 'Erzurum', 'B'),
            self::salesperson('mehmet.aksoy', 'MEHMET AKSOY', 'ERZURUM', 'Erzurum', 'C'),
            self::salesperson('erzurum.merkez', 'ERZURUM MERKEZ', 'ERZURUM', 'Erzurum', 'D'),
            self::salesperson('erz.merkez', 'ERZURUM MERKEZ', 'ERZURUM', 'Erzurum'),
            self::admin('mudur.erzurum', 'Erzurum Müdür', 'A,B,C,D'),
            self::branchDealerAdmin('satinalma', 'SATINALMA', 'ERZURUM', 'Erzurum'),
            self::branchDealerAdmin('satis', 'SATIŞ', 'ERZURUM', 'Erzurum'),

            self::salesperson('emre.kalayci', 'EMRE KALAYCI', 'TRABZON', 'Trabzon', 'E'),
            self::salesperson('ahmet.cantufekci', 'AHMET CANTÜFEKCİ', 'TRABZON', 'Trabzon', 'F'),
            self::salesperson('trabzon.merkez', 'TRABZON MERKEZ', 'TRABZON', 'Trabzon'),

            self::salesperson('samet.gorpuz', 'SAMET GÖRPÜZ', 'SAMSUN', 'Samsun', 'I'),
            self::salesperson('adem.canbakis', 'ADEM CANBAKIŞ', 'SAMSUN', 'Samsun', 'G'),
            self::salesperson('samsun.merkez', 'SAMSUN MERKEZ', 'SAMSUN', 'Samsun'),

            self::point('erzurum.point', 'ERZURUM POINT HIZLI SATIŞ', 'ERZURUM', 'Erzurum'),
            self::point('erzurum.hizlisatis', 'ERZURUM HIZLI SATIŞ', 'ERZURUM', 'Erzurum', 'dealer', 'D'),
            self::point('trabzon.point', 'TRABZON POINT HIZLI SATIŞ', 'TRABZON', 'Trabzon', 'branch', 'L'),
            self::point('samsun.point', 'SAMSUN POINT HIZLI SATIŞ', 'SAMSUN', 'Samsun', 'branch', 'J'),
            self::b2bPoint('batum', 'BATUM B2B VE HIZLI SATIŞ', 'BATUM', 'Batum', 'K'),

            self::salesperson('mehmet.atacan', 'MEHMET ATACAN', 'BATUM', 'Batum'),
            self::salesperson('tugay.buyukkal', 'TUGAY BÜYÜKKAL', 'BATUM', 'Batum', 'E,F,I,G,J,L'),
            self::salesperson('turgay.buyukkal', 'TURGAY BÜYÜKKAL', 'BATUM', 'Batum', 'E,F,I,G,J,L'),

            self::dealerAdmin('ornek.musteri', 'Ornek Musteri'),
            self::dealerAdmin('bayi.admin', 'Bayi Yöneticisi'),
            self::warehouse('depo', 'Depo Kullanıcısı', null, null),
            self::warehouse('erz.depo', 'ERZURUM DEPO', 'ERZURUM', 'Erzurum', 'dealer'),
            self::point('hizli.satis', 'Hızlı Satış', null, null),
            self::cashier('kasiyer', 'Kasiyer'),
            self::dealerAdmin('musteri.demo', 'Müşteri Demo'),
        ];
    }

    /**
     * @return list<string>
     */
    public static function usernames(): array
    {
        return array_map(
            fn (array $user): string => $user['username'],
            self::users()
        );
    }

    /**
     * @return list<array{code:string,name:string}>
     */
    public static function warehouses(): array
    {
        return [
            ['code' => '0', 'name' => 'ERZURUM POINT'],
            ['code' => '1', 'name' => 'ERZURUM DEPO'],
            ['code' => '2', 'name' => 'TRABZON DEPO'],
            ['code' => '3', 'name' => 'SAMSUN DEPO'],
            ['code' => '4', 'name' => 'BATUM DEPO'],
        ];
    }

    /**
     * @return array{
     *     username:string,
     *     name:string,
     *     roles:list<string>,
     *     menu_permissions:list<string>,
     *     region_code:?string,
     *     region_name:?string,
     *     branch_code:?string,
     *     branch_name:?string,
     *     customer_scope:?string,
     *     logo_customer_specode4:?string
     * }
     */
    private static function admin(string $username, string $name, ?string $logoCustomerSpecode4 = null): array
    {
        return self::definition(
            $username,
            $name,
            ['admin'],
            MenuPermissions::fromRoles(['admin']),
            null,
            null,
            null,
            $logoCustomerSpecode4
        );
    }

    /**
     * @return array<string, mixed>
     */
    private static function point(
        string $username,
        string $name,
        ?string $branchCode,
        ?string $branchName,
        string $customerScope = 'branch',
        ?string $logoCustomerSpecode4 = null
    ): array {
        return self::definition(
            $username,
            $name,
            ['point'],
            MenuPermissions::fromRoles(['point']),
            $branchCode,
            $branchName,
            $customerScope,
            $logoCustomerSpecode4
        );
    }

    /**
     * @return array<string, mixed>
     */
    private static function b2bPoint(
        string $username,
        string $name,
        ?string $branchCode,
        ?string $branchName,
        ?string $logoCustomerSpecode4 = null
    ): array
    {
        return self::definition(
            $username,
            $name,
            ['dealer_admin', 'point'],
            MenuPermissions::normalize([
                ...MenuPermissions::fromRoles(['dealer_admin']),
                ...MenuPermissions::fromRoles(['point']),
            ]),
            $branchCode,
            $branchName,
            'branch',
            $logoCustomerSpecode4
        );
    }

    /**
     * @return array<string, mixed>
     */
    private static function salesperson(
        string $username,
        string $name,
        ?string $branchCode,
        ?string $branchName,
        ?string $logoCustomerSpecode4 = null
    ): array {
        return self::definition(
            $username,
            $name,
            ['salesperson'],
            MenuPermissions::fromRoles(['salesperson']),
            $branchCode,
            $branchName,
            'assigned',
            $logoCustomerSpecode4
        );
    }

    /**
     * @return array<string, mixed>
     */
    private static function dealerAdmin(string $username, string $name): array
    {
        return self::definition($username, $name, ['dealer_admin'], MenuPermissions::fromRoles(['dealer_admin']), null, null, 'dealer');
    }

    /**
     * @return array<string, mixed>
     */
    private static function branchDealerAdmin(string $username, string $name, ?string $branchCode, ?string $branchName): array
    {
        return self::definition($username, $name, ['dealer_admin'], MenuPermissions::fromRoles(['dealer_admin']), $branchCode, $branchName, 'branch');
    }

    /**
     * @return array<string, mixed>
     */
    private static function moderator(string $username, string $name): array
    {
        return self::definition($username, $name, ['moderator'], MenuPermissions::fromRoles(['moderator']), null, null, 'dealer');
    }

    /**
     * @return array<string, mixed>
     */
    private static function cashier(string $username, string $name): array
    {
        return self::definition($username, $name, ['cashier'], MenuPermissions::fromRoles(['cashier']), null, null, 'dealer');
    }

    /**
     * @return array<string, mixed>
     */
    private static function warehouse(
        string $username,
        string $name,
        ?string $branchCode,
        ?string $branchName,
        string $customerScope = 'branch'
    ): array
    {
        return self::definition($username, $name, ['warehouse'], MenuPermissions::fromRoles(['warehouse']), $branchCode, $branchName, $customerScope);
    }

    /**
     * @param  list<string>  $roles
     * @param  list<string>  $menuPermissions
     * @return array<string, mixed>
     */
    private static function definition(
        string $username,
        string $name,
        array $roles,
        array $menuPermissions,
        ?string $branchCode,
        ?string $branchName,
        ?string $customerScope,
        ?string $logoCustomerSpecode4 = null
    ): array {
        return [
            'username' => $username,
            'name' => $name,
            'roles' => $roles,
            'menu_permissions' => $menuPermissions,
            'region_code' => $branchCode,
            'region_name' => $branchName,
            'branch_code' => $branchCode,
            'branch_name' => $branchName,
            'customer_scope' => $customerScope,
            'logo_customer_specode4' => $logoCustomerSpecode4,
        ];
    }
}
