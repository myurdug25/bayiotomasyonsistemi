<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Customer;
use App\Models\IntegrationSyncState;
use App\Models\Product;
use App\Models\ProductCodeAlias;
use App\Models\User;
use App\Support\CustomerFeaturePermissions;
use App\Support\MenuPermissions;
use App\Support\OperationalUserRoster;
use App\Support\Warehouse\WarehouseBranchResolver;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Arr;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

class WarehouseShelfController extends Controller
{
    private const WAREHOUSES = [
        '0' => 'ERZURUM POINT',
        '1' => 'ERZURUM DEPO',
        '2' => 'TRABZON DEPO',
        '3' => 'SAMSUN DEPO',
        '4' => 'BATUM DEPO',
    ];

    private const WAREHOUSE_RAF_COLUMNS = [
        '0' => 'RAF250',
        '1' => 'RAF25',
        '2' => 'RAF61',
        '3' => 'RAF55',
        '4' => 'RAF995',
    ];

    public function __construct(private readonly WarehouseBranchResolver $branchResolver) {}

    public function index(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'q' => ['nullable', 'string', 'max:120'],
            'warehouse_code' => ['nullable', 'string', Rule::in(array_keys(self::WAREHOUSES))],
            'include_equivalents' => ['nullable', 'boolean'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:80'],
        ]);

        $user = $request->user();
        abort_unless($this->canAccessRackAddresses($user), 403, 'Raf adresi güncelleme yetkiniz yok.');

        $warehouseOptions = $this->allowedWarehouseOptions($user);

        $warehouseCode = $this->resolveRequestedWarehouseCode($user, $validated['warehouse_code'] ?? null, $warehouseOptions);
        $queryText = trim((string) ($validated['q'] ?? ''));
        $includeEquivalents = $request->boolean('include_equivalents');
        $limit = (int) ($validated['limit'] ?? 40);

        $productsQuery = Product::query()
            ->with(['brand:id,name', 'codeAliases:id,product_id,code,code_type,brand_name,source'])
            ->where('is_active', true)
            ->orderBy('sku')
            ->limit($limit);

        if ($queryText !== '') {
            $productsQuery->where(function (Builder $query) use ($queryText): void {
                $like = '%'.$queryText.'%';
                $query
                    ->where('sku', 'like', $like)
                    ->orWhere('name', 'like', $like)
                    ->orWhere('oem_code', 'like', $like)
                    ->orWhereHas('codeAliases', fn (Builder $aliasQuery) => $aliasQuery->where('code', 'like', $like));

                $this->orWhereMetaTextLike($query, $queryText);
            });
        }

        $this->applyProductSpecialCodeVisibility($productsQuery, $includeEquivalents);

        $products = $productsQuery
            ->get()
            ->map(fn (Product $product): array => $this->mapProduct($product, $warehouseCode))
            ->values();

        return response()->json([
            'data' => $products,
            'warehouse' => [
                'code' => $warehouseCode,
                'name' => self::WAREHOUSES[$warehouseCode] ?? 'DEPO',
                'editable' => $this->canManageWarehouse($user, $warehouseCode),
            ],
            'warehouses' => $warehouseOptions,
            'can_choose_warehouse' => $user instanceof User && $this->canChooseWarehouseForShelves($user),
        ]);
    }

    public function update(Request $request, Product $product): JsonResponse
    {
        $validated = $request->validate([
            'warehouse_code' => ['required', 'string', Rule::in(array_keys(self::WAREHOUSES))],
            'shelf_address' => ['nullable', 'string', 'max:80'],
            'oem_codes' => ['nullable', 'array', 'max:24'],
            'oem_codes.*' => ['nullable', 'string', 'max:80'],
            'competitor_codes' => ['nullable', 'array', 'max:48'],
            'competitor_codes.*' => ['nullable', 'string', 'max:80'],
        ]);

        $user = $request->user();
        $warehouseCode = (string) $validated['warehouse_code'];

        abort_unless($this->canAccessRackAddresses($user), 403, 'Raf adresi güncelleme yetkiniz yok.');
        abort_unless($this->canManageWarehouse($user, $warehouseCode), 403, 'Bu raf adresini düzenleme yetkiniz yok.');

        $shelfAddress = trim((string) ($validated['shelf_address'] ?? ''));
        $shelfAddress = $shelfAddress === '' ? null : $shelfAddress;
        $oemCodes = array_key_exists('oem_codes', $validated)
            ? $this->normalizeCodeList($validated['oem_codes'])
            : null;
        $competitorCodes = array_key_exists('competitor_codes', $validated)
            ? $this->normalizeCodeList($validated['competitor_codes'])
            : null;

        DB::transaction(function () use ($product, $user, $warehouseCode, $shelfAddress, $oemCodes, $competitorCodes): void {
            $meta = $this->withShelfAddress($product->meta ?? [], $warehouseCode, $shelfAddress);

            Arr::set($meta, 'integrations.logo.shelf_update_pending_at', now()->toIso8601String());
            Arr::set($meta, 'integrations.logo.shelf_update_user_id', $user?->id);
            Arr::set($meta, 'integrations.logo.shelf_update_user_name', $user?->name);
            Arr::set($meta, 'integrations.logo.shelf_update_username', $user?->username);
            Arr::set($meta, 'integrations.logo.product_identity_update_pending_at', now()->toIso8601String());
            Arr::set($meta, 'integrations.logo.product_identity_update_user_id', $user?->id);

            $fill = ['meta' => $meta];
            if (is_array($oemCodes)) {
                $fill['oem_code'] = $oemCodes[0] ?? null;
            }

            $product->forceFill($fill)->save();

            if (is_array($oemCodes)) {
                $this->replaceProductAliases($product, 'oem', $oemCodes, $user);
            }

            if (is_array($competitorCodes)) {
                $this->replaceProductAliases($product, 'competitor', $competitorCodes, $user);
            }

            $payload = [
                'export_key' => "B2B-PRODUCT-SHELF-{$product->id}-{$warehouseCode}",
                'product_id' => (int) $product->id,
                'product_code' => (string) $product->sku,
                'product_external_ref' => $this->stringOrNull(Arr::get($meta, 'integrations.logo.external_ref')),
                'warehouse_code' => $warehouseCode,
                'warehouse_name' => self::WAREHOUSES[$warehouseCode] ?? null,
                'shelf_address' => $shelfAddress,
                'oem_code' => $oemCodes[0] ?? $this->stringOrNull($product->oem_code),
                'oem_codes' => $oemCodes,
                'competitor_codes' => $competitorCodes,
                'requested_by_user_id' => $user?->id,
                'requested_by_user_name' => $user?->name,
                'requested_at' => now()->toIso8601String(),
            ];

            IntegrationSyncState::query()->updateOrCreate(
                [
                    'system' => 'logo',
                    'domain' => 'product-shelves',
                    'direction' => 'outbound',
                    'entity_type' => Product::class,
                    'entity_id' => (int) $product->id,
                ],
                [
                    'dealer_id' => is_numeric($user?->dealer_id) ? (int) $user->dealer_id : null,
                    'customer_id' => null,
                    'external_ref' => null,
                    'status' => 'queued',
                    'last_error' => null,
                    'last_synced_at' => null,
                    'payload_hash' => hash('sha256', json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: ''),
                    'meta' => $payload,
                ]
            );
        });

        $fresh = Product::query()
            ->with(['brand:id,name', 'codeAliases:id,product_id,code,code_type,brand_name,source'])
            ->findOrFail($product->id);

        return response()->json([
            'data' => $this->mapProduct($fresh, $warehouseCode),
            'message' => 'Raf adresi kaydedildi ve Logo güncelleme kuyruğuna alındı.',
        ]);
    }

    /**
     * @param  list<array{code:string,name:string,editable:bool}>  $warehouseOptions
     */
    private function resolveRequestedWarehouseCode(?User $user, ?string $requestedCode, array $warehouseOptions): string
    {
        if ($warehouseOptions === []) {
            return '1';
        }

        $requestedCode = $this->normalizeWarehouseRequestCode($requestedCode);
        $allowedCodes = array_column($warehouseOptions, 'code');

        if ($user instanceof User && $this->canChooseWarehouseForShelves($user) && $requestedCode !== null) {
            return $requestedCode;
        }

        if ($user instanceof User && ! $this->canChooseWarehouseForShelves($user)) {
            return (string) $warehouseOptions[0]['code'];
        }

        if ($requestedCode !== null && in_array($requestedCode, $allowedCodes, true)) {
            return $requestedCode;
        }

        $pointWarehouseCode = $this->resolvePointWarehouseCode($user);
        if ($pointWarehouseCode !== null && in_array($pointWarehouseCode, $allowedCodes, true)) {
            return $pointWarehouseCode;
        }

        $branchCode = $this->branchResolver->resolveBranchCode($user);
        if ($branchCode === 'BATUM') {
            return in_array('4', $allowedCodes, true) ? '4' : (string) $warehouseOptions[0]['code'];
        }

        $target = $this->branchResolver->targetWarehouse($user);
        $targetCode = $this->stringOrNull($target['code'] ?? null);

        if ($targetCode !== null && in_array($targetCode, $allowedCodes, true)) {
            return $targetCode;
        }

        return (string) $warehouseOptions[0]['code'];
    }

    private function normalizeWarehouseRequestCode(?string $value): ?string
    {
        $normalized = preg_replace('/[^A-Z0-9]+/', '', Str::upper(Str::ascii(trim((string) $value)))) ?? '';

        if ($normalized === '') {
            return null;
        }

        if (array_key_exists($normalized, self::WAREHOUSES)) {
            return $normalized;
        }

        return match (true) {
            str_contains($normalized, 'ERZURUMPOINT') => '0',
            str_contains($normalized, 'ERZURUMDEPO') => '1',
            str_contains($normalized, 'TRABZON') => '2',
            str_contains($normalized, 'SAMSUN') => '3',
            str_contains($normalized, 'BATUM') => '4',
            default => null,
        };
    }

    private function canManageWarehouse(?User $user, string $warehouseCode): bool
    {
        if (! $user instanceof User) {
            return false;
        }

        if ($this->canChooseWarehouseForShelves($user)) {
            return true;
        }

        return in_array($warehouseCode, $this->primaryWarehouseCodesForUser($user), true);
    }

    /**
     * @return list<array{code:string,name:string,editable:bool}>
     */
    private function allowedWarehouseOptions(?User $user): array
    {
        if (! $user instanceof User) {
            return [];
        }

        if ($this->canChooseWarehouseForShelves($user)) {
            return $this->warehouseOptionsForCodes(array_keys(self::WAREHOUSES), $user);
        }

        $codes = $this->primaryWarehouseCodesForUser($user);

        return $this->warehouseOptionsForCodes($codes, $user);
    }

    /**
     * Normal kullanıcı raf ekranında tek depoya kilitlenir. Admin hariç
     * cross-branch raf seçimi yoktur; böylece Trabzon/Samsun/Batum/Erzurum rafları karışmaz.
     *
     * @return list<string>
     */
    private function primaryWarehouseCodesForUser(User $user): array
    {
        $identity = $this->normalizedUserIdentity($user);
        $cashboxWarehouseCode = $this->warehouseCodeFromCashbox($user);

        if (str_contains($identity, 'TRABZON') || str_contains($identity, '10002')) {
            return ['2'];
        }

        if (str_contains($identity, 'SAMSUN') || str_contains($identity, '10003')) {
            return ['3'];
        }

        if (str_contains($identity, 'BATUM') || str_contains($identity, '10004')) {
            return ['4'];
        }

        if (in_array($cashboxWarehouseCode, ['2', '3', '4'], true)) {
            return [$cashboxWarehouseCode];
        }

        if ((str_contains($identity, 'POINT') || str_contains($identity, 'HIZLISATIS')) && ! str_contains($identity, 'DEPO')) {
            return ['0'];
        }

        if (str_contains($identity, 'ERZURUM') || str_starts_with($identity, 'ERZ') || str_contains($identity, '10001')) {
            return ['1'];
        }

        $rosterWarehouseCode = $this->warehouseCodeFromOperationalRoster($user);
        if ($rosterWarehouseCode !== null) {
            return [$rosterWarehouseCode];
        }

        $customerWarehouseCode = $this->warehouseCodeFromSelectedCustomer($user);
        if ($customerWarehouseCode !== null) {
            return [$customerWarehouseCode];
        }

        $permissionCodes = $this->singleWarehouseCodeFromFeaturePermissions($user);
        if ($permissionCodes !== []) {
            return $permissionCodes;
        }

        $branchCode = $this->branchResolver->resolveBranchCode($user)
            ?? $this->inferBranchCodeFromUserIdentity($user);

        return match ($branchCode) {
            'TRABZON' => ['2'],
            'SAMSUN' => ['3'],
            'BATUM' => ['4'],
            'ERZURUM' => ['1'],
            default => $cashboxWarehouseCode !== null
                ? [$cashboxWarehouseCode]
                : ['1'],
        };
    }

    private function warehouseCodeFromOperationalRoster(User $user): ?string
    {
        $username = mb_strtolower(trim((string) $user->username), 'UTF-8');
        if ($username === '') {
            return null;
        }

        foreach (OperationalUserRoster::users() as $definition) {
            if (mb_strtolower((string) ($definition['username'] ?? ''), 'UTF-8') !== $username) {
                continue;
            }

            return $this->warehouseCodeFromBranchValue($definition['branch_code'] ?? null);
        }

        return null;
    }

    private function warehouseCodeFromSelectedCustomer(User $user): ?string
    {
        $customer = $user->selectedCustomer;
        if (! $customer instanceof Customer) {
            return null;
        }

        return $this->warehouseCodeFromBranchValue($customer->branch_code)
            ?? $this->warehouseCodeFromBranchValue($customer->branch_name)
            ?? $this->warehouseCodeFromBranchValue($customer->region_code)
            ?? $this->warehouseCodeFromBranchValue($customer->region_name);
    }

    private function warehouseCodeFromBranchValue(mixed $value): ?string
    {
        $normalized = preg_replace('/[^A-Z0-9]+/', '', Str::upper(Str::ascii(trim((string) $value)))) ?? '';

        return match (true) {
            str_contains($normalized, 'TRABZON') => '2',
            str_contains($normalized, 'SAMSUN') => '3',
            str_contains($normalized, 'BATUM') => '4',
            str_contains($normalized, 'ERZURUM'), str_starts_with($normalized, 'ERZ') => '1',
            default => null,
        };
    }

    /**
     * @return list<string>
     */
    private function singleWarehouseCodeFromFeaturePermissions(User $user): array
    {
        $permissionCodes = $this->warehouseCodesFromFeaturePermissions($user);

        return count($permissionCodes) === 1
            ? [array_values($permissionCodes)[0]]
            : [];
    }

    /**
     * @return list<string>
     */
    private function fallbackWarehouseCodesForRackUser(User $user): array
    {
        $permissionCodes = $this->singleWarehouseCodeFromFeaturePermissions($user);
        if ($permissionCodes !== []) {
            return $permissionCodes;
        }

        $identity = $this->normalizedUserIdentity($user);

        if (str_contains($identity, 'TRABZON')) {
            return ['2'];
        }

        if (str_contains($identity, 'SAMSUN')) {
            return ['3'];
        }

        if (str_contains($identity, 'BATUM')) {
            return ['4'];
        }

        if (str_contains($identity, 'POINT') || str_contains($identity, 'HIZLISATIS')) {
            return ['0'];
        }

        if ($user->hasAnyRole(['warehouse', 'point']) || $this->canAccessRackAddresses($user)) {
            return ['1'];
        }

        return [];
    }

    private function normalizedUserIdentity(User $user): string
    {
        return preg_replace('/[^A-Z0-9]+/', '', Str::upper(Str::ascii(implode(' ', array_filter([
            $user->username,
            $user->email,
            $user->name,
            $user->branch_code,
            $user->branch_name,
            $user->region_code,
            $user->region_name,
            $user->logo_cashbox_code,
            $user->logo_cashbox_name,
        ], fn ($value): bool => is_scalar($value) && trim((string) $value) !== ''))))) ?? '';
    }

    private function warehouseCodeFromCashbox(User $user): ?string
    {
        $cashboxCode = preg_replace('/[^0-9]+/', '', (string) $user->logo_cashbox_code) ?? '';

        if ($cashboxCode === '') {
            return null;
        }

        if (str_starts_with($cashboxCode, '10001007')) {
            return '0';
        }

        return match (true) {
            str_starts_with($cashboxCode, '10002') => '2',
            str_starts_with($cashboxCode, '10003') => '3',
            str_starts_with($cashboxCode, '10004') => '4',
            str_starts_with($cashboxCode, '10001') => '1',
            default => null,
        };
    }

    private function canChooseWarehouseForShelves(User $user): bool
    {
        if (! $user->hasAnyRole(['admin', 'dealer_admin'])) {
            return false;
        }

        if ($user->hasAnyRole(['warehouse', 'point', 'customer', 'salesperson'])) {
            return false;
        }

        $identity = $this->normalizedUserIdentity($user);
        if ($identity === '') {
            return true;
        }

        $operationalNeedles = [
            'ERZURUMDEPO',
            'ERZDEPO',
            'TRABZONDEPO',
            'SAMSUNDEPO',
            'BATUMDEPO',
            'ERZURUMPOINT',
            'TRABZONPOINT',
            'SAMSUNPOINT',
            'BATUMPOINT',
            'HIZLISATIS',
            'HIZLISATIŞ',
        ];

        foreach ($operationalNeedles as $needle) {
            if (str_contains($identity, $needle)) {
                return false;
            }
        }

        return true;
    }

    private function inferBranchCodeFromUserIdentity(User $user): ?string
    {
        $identity = Str::upper(Str::ascii(implode(' ', array_filter([
            $user->username,
            $user->email,
            $user->name,
            $user->branch_code,
            $user->branch_name,
            $user->region_code,
            $user->region_name,
        ], fn ($value): bool => is_scalar($value) && trim((string) $value) !== ''))));
        $identity = preg_replace('/[^A-Z0-9]+/', '', $identity) ?? '';

        if ($identity === '') {
            return null;
        }

        return match (true) {
            str_contains($identity, 'TRABZON') => 'TRABZON',
            str_contains($identity, 'SAMSUN') => 'SAMSUN',
            str_contains($identity, 'BATUM') => 'BATUM',
            str_contains($identity, 'ERZURUM'),
            str_starts_with($identity, 'ERZ') => 'ERZURUM',
            default => null,
        };
    }

    /**
     * @return list<string>
     */
    private function warehouseCodesFromFeaturePermissions(User $user): array
    {
        $permissions = array_flip(CustomerFeaturePermissions::forUser($user));
        $mapping = [
            'search.stock.warehouse.erzurum_point' => '0',
            'search.stock.warehouse.erzurum_depo' => '1',
            'search.stock.warehouse.trabzon' => '2',
            'search.stock.warehouse.samsun' => '3',
            'search.stock.warehouse.batum' => '4',
        ];

        $codes = [];
        foreach ($mapping as $permission => $code) {
            if (isset($permissions[$permission])) {
                $codes[] = $code;
            }
        }

        return array_values(array_unique($codes));
    }

    /**
     * @param  list<string>  $codes
     * @return list<array{code:string,name:string,editable:bool}>
     */
    private function warehouseOptionsForCodes(array $codes, ?User $user): array
    {
        $codes = array_map(static fn ($code): string => (string) $code, $codes);
        $ordered = [];
        foreach (array_keys(self::WAREHOUSES) as $rawCode) {
            $code = (string) $rawCode;
            if (! in_array($code, $codes, true)) {
                continue;
            }

            $ordered[] = [
                'code' => $code,
                'name' => self::WAREHOUSES[$code],
                'editable' => $this->canManageWarehouse($user, $code),
            ];
        }

        return $ordered;
    }

    private function canAccessRackAddresses(?User $user): bool
    {
        if (! $user instanceof User) {
            return false;
        }

        if ($user->hasAnyRole(['admin'])) {
            return true;
        }

        $menuPermissions = array_flip(MenuPermissions::forUser($user));
        if (isset($menuPermissions['rack-addresses'])) {
            return true;
        }

        $featurePermissions = array_flip(CustomerFeaturePermissions::forUser($user));

        return isset($featurePermissions['rack-addresses.update']);
    }

    private function resolvePointWarehouseCode(?User $user): ?string
    {
        if (! $user instanceof User) {
            return null;
        }

        $identity = mb_strtoupper(implode(' ', array_filter([
            $user->username,
            $user->branch_code,
            $user->branch_name,
            $user->region_code,
            $user->region_name,
        ], fn ($value): bool => is_scalar($value) && trim((string) $value) !== '')), 'UTF-8');

        return match (true) {
            str_contains($identity, 'TRABZON') => '2',
            str_contains($identity, 'SAMSUN') => '3',
            str_contains($identity, 'BATUM') => '4',
            str_contains($identity, 'HIZLISATIS'),
            str_contains($identity, 'HIZLI SATIS'),
            str_contains($identity, 'HIZLI SATIŞ'),
            str_contains($identity, 'POINT') => '0',
            default => null,
        };
    }

    private function mapProduct(Product $product, string $warehouseCode): array
    {
        $aliases = $product->codeAliases instanceof Collection
            ? $product->codeAliases
            : collect();

        $oemCodes = collect([$this->stringOrNull($product->oem_code)])
            ->merge(
                $aliases
                    ->filter(fn (ProductCodeAlias $alias): bool => (string) $alias->code_type === 'oem')
                    ->pluck('code')
            )
            ->filter()
            ->unique()
            ->values()
            ->all();

        $competitorCodes = $aliases
            ->filter(fn (ProductCodeAlias $alias): bool => in_array((string) $alias->code_type, ['competitor', 'rakip', 'muadil', 'substitute', 'equivalent'], true))
            ->pluck('code')
            ->filter()
            ->unique()
            ->values()
            ->all();

        $meta = $product->meta ?? [];

        return [
            'id' => (int) $product->id,
            'product_code' => (string) $product->sku,
            'product_name' => (string) $product->name,
            'brand' => $product->brand?->name,
            'oem' => $this->stringOrNull($product->oem_code)
                ?? $this->firstString($meta, ['oem', 'oem_code', 'integrations.logo.payload.oem', 'integrations.logo.payload.oem_code']),
            'oem_codes' => $oemCodes,
            'competitor_codes' => $competitorCodes,
            'warehouse_code' => $warehouseCode,
            'warehouse_name' => self::WAREHOUSES[$warehouseCode] ?? 'DEPO',
            'shelf_address' => $this->resolveShelfAddress($meta, $warehouseCode),
            'shelf_updated_at' => $this->stringOrNull(Arr::get($meta, 'integrations.logo.shelf_update_pending_at')),
            'shelf_updated_by' => $this->stringOrNull(Arr::get($meta, 'integrations.logo.shelf_update_user_name'))
                ?? $this->stringOrNull(Arr::get($meta, 'integrations.logo.shelf_update_username'))
                ?? $this->shelfUpdateUserFallback($meta),
            'editable' => true,
            'logo_ref' => $this->stringOrNull(Arr::get($meta, 'integrations.logo.external_ref')),
            'logo_status' => $this->latestProductSyncStatus($product),
        ];
    }

    /**
     * @param  mixed  $values
     * @return list<string>
     */
    private function normalizeCodeList(mixed $values): array
    {
        $seen = [];
        $result = [];

        foreach ((array) $values as $value) {
            $code = $this->stringOrNull($value);
            if ($code === null) {
                continue;
            }

            $key = Str::upper(Str::ascii(preg_replace('/\s+/', '', $code) ?? $code));
            if ($key === '' || isset($seen[$key])) {
                continue;
            }

            $seen[$key] = true;
            $result[] = $code;
        }

        return $result;
    }

    /**
     * @param  list<string>  $codes
     */
    private function replaceProductAliases(Product $product, string $type, array $codes, ?User $user): void
    {
        ProductCodeAlias::query()
            ->where('product_id', $product->id)
            ->where('source', 'bos')
            ->where('code_type', $type)
            ->delete();

        foreach ($codes as $code) {
            $normalizedCode = preg_replace('/[^A-Z0-9]+/', '', Str::upper(Str::ascii($code))) ?? '';
            if ($normalizedCode === '') {
                continue;
            }

            ProductCodeAlias::query()->updateOrCreate(
                [
                    'product_id' => $product->id,
                    'normalized_code' => $normalizedCode,
                    'code_type' => $type,
                    'source' => 'bos',
                ],
                [
                    'code' => $code,
                    'brand_name' => null,
                    'meta' => [
                        'updated_from' => 'warehouse_product_management',
                        'updated_by_user_id' => $user?->id,
                        'updated_by_user_name' => $user?->name,
                        'updated_at' => now()->toIso8601String(),
                    ],
                ]
            );
        }
    }

    private function latestProductSyncStatus(Product $product): ?array
    {
        $state = IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', 'product-shelves')
            ->where('direction', 'outbound')
            ->where('entity_type', Product::class)
            ->where('entity_id', $product->id)
            ->latest('updated_at')
            ->first();

        if (! $state instanceof IntegrationSyncState) {
            return null;
        }

        return [
            'status' => $state->status,
            'error' => $state->last_error,
            'updated_at' => $state->updated_at?->toIso8601String(),
        ];
    }

    /**
     * @param  array<string, mixed>  $meta
     */
    private function shelfUpdateUserFallback(array $meta): ?string
    {
        $userId = $this->stringOrNull(Arr::get($meta, 'integrations.logo.shelf_update_user_id'));

        return $userId === null ? null : "Kullanıcı #{$userId}";
    }

    private function applyProductSpecialCodeVisibility(Builder $query, bool $includeEquivalents): void
    {
        $allowedCodes = $includeEquivalents ? ['E', 'H'] : ['E'];
        $paths = [
            'specode4',
            'integrations.logo.payload.specode4',
            'integrations.logo.payload.raw.SPECODE4',
        ];

        $query->where(function (Builder $specialCodeQuery) use ($paths, $allowedCodes): void {
            foreach ($paths as $path) {
                $placeholders = implode(',', array_fill(0, count($allowedCodes), '?'));
                $specialCodeQuery->orWhereRaw(
                    $this->normalizedJsonValueSql('products.meta', $path).' in ('.$placeholders.')',
                    $allowedCodes
                );
            }
        });
    }

    private function quoteJsonPath(string $path): string
    {
        return "'$.".str_replace("'", "\\'", $path)."'";
    }

    private function normalizedJsonValueSql(string $column, string $path): string
    {
        $driver = DB::connection()->getDriverName();

        if ($driver === 'pgsql') {
            $pgPath = str_replace('.', ',', $path);
            $expression = sprintf("%s#>>'{%s}'", $column, $pgPath);
        } else {
            $expression = sprintf('JSON_EXTRACT(%s, %s)', $column, $this->quoteJsonPath($path));

            if ($driver !== 'sqlite') {
                $expression = sprintf('JSON_UNQUOTE(%s)', $expression);
            }
        }

        return sprintf('UPPER(TRIM(%s))', $expression);
    }

    /**
     * @param  array<string, mixed>  $meta
     */
    private function resolveShelfAddress(array $meta, string $warehouseCode): ?string
    {
        $rafColumn = self::WAREHOUSE_RAF_COLUMNS[$warehouseCode] ?? null;
        $rafCandidates = $this->rafFieldCandidates($rafColumn);
        $warehouses = Arr::get($meta, 'integrations.logo.payload.logo_stock.warehouses');
        if (is_array($warehouses)) {
            foreach ($warehouses as $warehouse) {
                if (! is_array($warehouse)) {
                    continue;
                }

                $code = $this->stringOrNull($warehouse['warehouse_code'] ?? $warehouse['code'] ?? $warehouse['invenno'] ?? null);
                if ($code !== $warehouseCode) {
                    continue;
                }

                $value = $this->firstCaseInsensitiveString($warehouse, $rafCandidates);
                if ($value !== null) {
                    return $value;
                }

                $value = $this->firstString($warehouse, ['shelf_address', 'raf_address', 'raf_adresi', 'shelf', 'raf']);
                if ($value !== null) {
                    return $value;
                }
            }
        }

        if ($rafColumn !== null) {
            $paths = [];
            foreach ($rafCandidates as $candidate) {
                $paths[] = $candidate;
                $paths[] = "integrations.logo.payload.{$candidate}";
                $paths[] = "integrations.logo.payload.raw.{$candidate}";
                $paths[] = "integrations.logo.payload.logo_product.{$candidate}";
                $paths[] = "integrations.logo.product_card.{$candidate}";
                $paths[] = "logo_product.{$candidate}";
                $paths[] = "raw.{$candidate}";
            }

            $value = $this->firstCaseInsensitiveString($meta, $paths);

            if ($value !== null) {
                return $value;
            }

            foreach ($rafCandidates as $candidate) {
                $value = $this->recursiveStringByKey($meta, $candidate);
                if ($value !== null) {
                    return $value;
                }
            }
        }

        if ($warehouseCode !== '1') {
            return null;
        }

        return $this->firstString($meta, [
            'shelf_address',
            'raf_address',
            'raf_adresi',
            'integrations.logo.payload.shelf_address',
            'integrations.logo.payload.raf_address',
            'integrations.logo.payload.raf_adresi',
        ]);
    }

    /**
     * @return list<string>
     */
    private function rafFieldCandidates(?string $rafColumn): array
    {
        if ($rafColumn === null) {
            return [];
        }

        $suffix = preg_replace('/\D+/', '', $rafColumn) ?? '';
        $candidates = [$rafColumn];

        if ($suffix !== '') {
            $candidates = array_merge($candidates, [
                "RAF{$suffix}",
                "RAF_{$suffix}",
                "RAFADRESI{$suffix}",
                "RAF_ADRESI_{$suffix}",
                "SHELF_ADDRESS{$suffix}",
                "LOCATION{$suffix}",
                "LOCATION_CODE{$suffix}",
            ]);
        }

        return array_values(array_unique($candidates));
    }

    /**
     * @param  array<string, mixed>  $meta
     * @return array<string, mixed>
     */
    private function withShelfAddress(array $meta, string $warehouseCode, ?string $shelfAddress): array
    {
        $rafColumn = self::WAREHOUSE_RAF_COLUMNS[$warehouseCode] ?? null;
        $warehouses = Arr::get($meta, 'integrations.logo.payload.logo_stock.warehouses');
        $warehouses = is_array($warehouses) ? array_values($warehouses) : [];
        $found = false;

        foreach ($warehouses as $index => $warehouse) {
            if (! is_array($warehouse)) {
                continue;
            }

            $code = $this->stringOrNull($warehouse['warehouse_code'] ?? $warehouse['code'] ?? $warehouse['invenno'] ?? null);
            if ($code !== $warehouseCode) {
                continue;
            }

            $warehouse['warehouse_code'] = $warehouseCode;
            $warehouse['warehouse_name'] = self::WAREHOUSES[$warehouseCode] ?? ($warehouse['warehouse_name'] ?? null);
            $warehouse['shelf_address'] = $shelfAddress;
            $warehouse['raf_adresi'] = $shelfAddress;
            if ($rafColumn !== null) {
                $warehouse[$rafColumn] = $shelfAddress;
            }
            $warehouses[$index] = $warehouse;
            $found = true;
            break;
        }

        if (! $found) {
            $warehouses[] = [
                'warehouse_code' => $warehouseCode,
                'warehouse_name' => self::WAREHOUSES[$warehouseCode] ?? null,
                'shelf_address' => $shelfAddress,
                'raf_adresi' => $shelfAddress,
            ];

            if ($rafColumn !== null) {
                $warehouses[array_key_last($warehouses)][$rafColumn] = $shelfAddress;
            }
        }

        Arr::set($meta, 'integrations.logo.payload.logo_stock.warehouses', $warehouses);

        if ($rafColumn !== null) {
            Arr::set($meta, "integrations.logo.payload.{$rafColumn}", $shelfAddress);
            Arr::set($meta, "integrations.logo.payload.raw.{$rafColumn}", $shelfAddress);
            $meta[$rafColumn] = $shelfAddress;
        }

        if ($warehouseCode === '1') {
            Arr::set($meta, 'integrations.logo.payload.shelf_address', $shelfAddress);
            Arr::set($meta, 'integrations.logo.payload.raf_adresi', $shelfAddress);
            $meta['shelf_address'] = $shelfAddress;
            $meta['raf_adresi'] = $shelfAddress;
        }

        return $meta;
    }

    private function orWhereMetaTextLike(Builder $query, string $search): void
    {
        $driver = DB::connection()->getDriverName();
        $needle = '%'.mb_strtolower($search, 'UTF-8').'%';

        if ($driver === 'pgsql') {
            $query->orWhereRaw('LOWER(CAST(meta AS TEXT)) LIKE ?', [$needle]);

            return;
        }

        $query->orWhereRaw('LOWER(CAST(meta AS CHAR)) LIKE ?', [$needle]);
    }

    /**
     * @param  array<string, mixed>  $source
     * @param  list<string>  $paths
     */
    private function firstString(array $source, array $paths): ?string
    {
        foreach ($paths as $path) {
            $value = $this->stringOrNull(Arr::get($source, $path));
            if ($value !== null) {
                return $value;
            }
        }

        return null;
    }

    /**
     * @param  array<string, mixed>  $source
     * @param  list<string>  $paths
     */
    private function firstCaseInsensitiveString(array $source, array $paths): ?string
    {
        foreach ($paths as $path) {
            $parts = explode('.', $path);
            $value = $source;

            foreach ($parts as $part) {
                if (! is_array($value)) {
                    $value = null;
                    break;
                }

                $matchedKey = null;
                foreach (array_keys($value) as $key) {
                    if (Str::lower((string) $key) === Str::lower($part)) {
                        $matchedKey = $key;
                        break;
                    }
                }

                if ($matchedKey === null) {
                    $value = null;
                    break;
                }

                $value = $value[$matchedKey];
            }

            $string = $this->stringOrNull($value);
            if ($string !== null) {
                return $string;
            }
        }

        return null;
    }

    /**
     * @param  array<string, mixed>  $source
     */
    private function recursiveStringByKey(array $source, string $targetKey): ?string
    {
        $target = Str::lower($targetKey);

        foreach ($source as $key => $value) {
            if (Str::lower((string) $key) === $target) {
                $string = $this->stringOrNull($value);
                if ($string !== null) {
                    return $string;
                }
            }

            if (is_array($value)) {
                $string = $this->recursiveStringByKey($value, $targetKey);
                if ($string !== null) {
                    return $string;
                }
            }
        }

        return null;
    }

    private function stringOrNull(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $string = trim((string) $value);

        return $string === '' ? null : $string;
    }
}
