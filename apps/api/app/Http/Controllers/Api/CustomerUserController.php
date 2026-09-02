<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Brand;
use App\Models\Customer;
use App\Models\Role;
use App\Models\User;
use App\Services\Users\UserPermissionService;
use App\Support\CustomerFeaturePermissions;
use App\Support\MenuPermissions;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Rules\Password;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\Response;

class CustomerUserController extends Controller
{
    private const CUSTOMER_DEFAULT_MENU_PERMISSIONS = [
        'dashboard',
        'notes',
        'search',
        'catalogs',
        'cart',
        'orders',
        'ledger',
    ];

    public function index(Request $request): JsonResponse
    {
        $this->ensureCampaignVisibilityForCustomerUsers();

        $validated = $request->validate([
            'q' => ['nullable', 'string', 'max:120'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:100'],
        ]);

        $search = trim((string) ($validated['q'] ?? ''));
        $limit = min((int) ($validated['limit'] ?? 50), 100);

        $customerUsers = User::query()
            ->select(['id', 'selected_customer_id', 'username', 'is_active', 'menu_permissions', 'feature_permissions', 'permissions_updated_at'])
            ->whereNotNull('selected_customer_id')
            ->whereHas('roles', fn (Builder $query) => $query->where('slug', 'customer'))
            ->get()
            ->keyBy('selected_customer_id');

        $customerUsersByUsername = User::query()
            ->select(['id', 'selected_customer_id', 'username', 'is_active', 'menu_permissions', 'feature_permissions', 'permissions_updated_at'])
            ->whereHas('roles', fn (Builder $query) => $query->where('slug', 'customer'))
            ->get()
            ->keyBy(fn (User $user): string => mb_strtolower((string) $user->username));

        $query = Customer::query()
            ->select(['id', 'dealer_id', 'code', 'name', 'is_active', 'meta'])
            ->where('is_active', true);

        if ($search !== '') {
            $query->where(function (Builder $builder) use ($search): void {
                $builder
                    ->whereLike('code', "{$search}%", caseSensitive: false)
                    ->orWhereLike('name', "%{$search}%", caseSensitive: false);
            });
        }

        $totalCount = (clone $query)->count();

        $customers = $query
            ->orderBy('code')
            ->orderBy('id')
            ->limit($limit)
            ->get();

        return response()->json([
            'data' => $customers
                ->map(function (Customer $customer) use ($customerUsers, $customerUsersByUsername): array {
                    $username = $this->usernameFromCustomerCode($customer->code);

                    return $this->serializeCustomerUserRow(
                        $customer,
                        $customerUsers->get($customer->id) ?? $customerUsersByUsername->get(mb_strtolower($username))
                    );
                })
                ->values(),
            'total_count' => $totalCount,
            'limit' => $limit,
            'menu_permissions' => $this->customerMenuPermissionOptions(),
            'feature_permissions' => CustomerFeaturePermissions::definitions(),
            'default_menu_permissions' => self::CUSTOMER_DEFAULT_MENU_PERMISSIONS,
            'brands' => Brand::query()
                ->where('is_active', true)
                ->orderBy('name')
                ->get(['id', 'name'])
                ->map(fn (Brand $brand): array => ['id' => (int) $brand->id, 'name' => (string) $brand->name])
                ->values(),
        ]);
    }

    public function store(Request $request, Customer $customer): JsonResponse
    {
        if (! $customer->is_active) {
            throw ValidationException::withMessages([
                'customer_id' => ['Pasif cari için müşteri kullanıcısı açılamaz.'],
            ]);
        }

        $managedMenuPermissions = $this->customerManagedMenuPermissions();

        $validated = $request->validate([
            'password' => ['nullable', 'string', 'max:255', Password::min(6)],
            'is_active' => ['sometimes', 'boolean'],
            'menu_permissions' => ['nullable', 'array'],
            'menu_permissions.*' => ['string', Rule::in($managedMenuPermissions)],
            'feature_permissions' => ['nullable', 'array'],
            'feature_permissions.*' => ['string', Rule::in(CustomerFeaturePermissions::keys())],
            'special_discount_rate' => ['nullable', 'numeric', 'min:0', 'max:100'],
            'allowed_brand_ids' => ['nullable', 'array'],
            'allowed_brand_ids.*' => ['integer', 'distinct', Rule::exists('brands', 'id')->where('is_active', true)],
            'brand_discounts' => ['nullable', 'array'],
            'brand_discounts.*.brand_id' => ['required', 'integer', 'distinct', Rule::exists('brands', 'id')->where('is_active', true)],
            'brand_discounts.*.discount_1' => ['nullable', 'numeric', 'min:0', 'max:100'],
            'brand_discounts.*.discount_2' => ['nullable', 'numeric', 'min:0', 'max:100'],
            'brand_discounts.*.discount_3' => ['nullable', 'numeric', 'min:0', 'max:100'],
        ]);

        $username = $this->usernameFromCustomerCode($customer->code);

        if ($username === '') {
            throw ValidationException::withMessages([
                'username' => ['Cari kodundan kullanıcı adı oluşturulamadı.'],
            ]);
        }

        $user = DB::transaction(function () use ($customer, $username, $validated): User {
            $menuPermissions = array_key_exists('menu_permissions', $validated)
                ? MenuPermissions::normalize($validated['menu_permissions'])
                : self::CUSTOMER_DEFAULT_MENU_PERMISSIONS;
            $featurePermissions = array_key_exists('feature_permissions', $validated)
                ? CustomerFeaturePermissions::normalize($validated['feature_permissions'])
                : CustomerFeaturePermissions::defaultsForMenus($menuPermissions);

            $customerRole = Role::query()->firstOrCreate(
                ['slug' => 'customer'],
                ['name' => 'Müşteri']
            );

            $existingUser = User::query()
                ->where('selected_customer_id', $customer->id)
                ->whereHas('roles', fn (Builder $query) => $query->where('slug', 'customer'))
                ->first();

            if (! ($existingUser instanceof User)) {
                $existingUser = User::query()
                    ->whereRaw('LOWER(username) = ?', [mb_strtolower($username)])
                    ->whereHas('roles', fn (Builder $query) => $query->where('slug', 'customer'))
                    ->first();
            }

            $duplicateUsername = User::query()
                ->whereRaw('LOWER(username) = ?', [mb_strtolower($username)])
                ->when($existingUser instanceof User, fn (Builder $query) => $query->whereKeyNot($existingUser->id))
                ->exists();

            if ($duplicateUsername) {
                throw ValidationException::withMessages([
                    'username' => ["{$username} kullanıcı adı başka bir kullanıcıda kayıtlı."],
                ]);
            }

            $user = $existingUser instanceof User ? $existingUser : new User;
            $password = trim((string) ($validated['password'] ?? ''));
            if ($password === '' && ! ($existingUser instanceof User)) {
                $password = Str::password(10, symbols: false);
            }

            $attributes = [
                'dealer_id' => $customer->dealer_id,
                'customer_scope' => 'assigned',
                'region_code' => $customer->region_code,
                'region_name' => $customer->region_name,
                'branch_code' => $customer->branch_code,
                'branch_name' => $customer->branch_name,
                'selected_customer_id' => $customer->id,
                'name' => $customer->name,
                'username' => $username,
                'email' => $customer->email,
                'phone' => $customer->phone,
                'is_active' => (bool) ($validated['is_active'] ?? true),
                'menu_permissions' => $menuPermissions,
                'feature_permissions' => $featurePermissions,
                'last_activity_at' => (bool) ($validated['is_active'] ?? true)
                    ? now()
                    : $user->last_activity_at,
            ];

            if ($password !== '') {
                $attributes['password'] = Hash::make($password);
            }

            $user->fill($attributes);
            $user->save();
            $user->roles()->sync([$customerRole->id]);
            app(UserPermissionService::class)->markChanged($user);

            if (array_key_exists('special_discount_rate', $validated)) {
                $this->updateCustomerDiscount($customer, $validated['special_discount_rate']);
            }
            $this->updateCustomerBrandSettings(
                $customer,
                $validated['allowed_brand_ids'] ?? null,
                $validated['brand_discounts'] ?? null,
                array_key_exists('allowed_brand_ids', $validated),
                array_key_exists('brand_discounts', $validated),
            );

            return $user->fresh(['selectedCustomer:id,code,name']) ?? $user;
        });

        return response()->json([
            'data' => $this->serializeCustomerUserRow($customer->fresh() ?? $customer, $user),
        ], Response::HTTP_CREATED);
    }

    private function serializeCustomerUserRow(Customer $customer, ?User $user): array
    {
        return [
            'id' => $customer->id,
            'code' => $customer->code,
            'name' => $customer->name,
            'username' => $this->usernameFromCustomerCode($customer->code),
            'special_discount_rate' => $this->specialDiscountRate($customer),
            'allowed_brand_ids' => data_get($customer->meta, 'customer_user.allowed_brand_ids'),
            'brand_discounts' => data_get($customer->meta, 'customer_user.brand_discounts', []),
            'user' => $user instanceof User ? [
                'id' => $user->id,
                'username' => $user->username,
                'is_active' => (bool) $user->is_active,
                'menu_permissions' => app(UserPermissionService::class)->menuPermissions($user),
                'feature_permissions' => app(UserPermissionService::class)->featurePermissions($user),
                'permissions_updated_at' => $user->permissions_updated_at?->toJSON(),
            ] : null,
        ];
    }

    private function ensureCampaignVisibilityForCustomerUsers(): void
    {
        User::query()
            ->select(['id', 'menu_permissions', 'feature_permissions', 'permissions_updated_at'])
            ->whereHas('roles', fn (Builder $query) => $query->where('slug', 'customer'))
            ->chunkById(100, function ($users): void {
                foreach ($users as $user) {
                    $menuPermissions = MenuPermissions::forUser($user);

                    if (! in_array('search', $menuPermissions, true) && ! in_array('catalogs', $menuPermissions, true)) {
                        continue;
                    }

                    $featurePermissions = $user->feature_permissions !== null && is_array($user->feature_permissions)
                        ? CustomerFeaturePermissions::normalize($user->feature_permissions)
                        : CustomerFeaturePermissions::defaultsForMenus($menuPermissions);
                    $nextFeaturePermissions = $featurePermissions;

                    if (in_array('search', $menuPermissions, true) && ! in_array('search.campaigns', $nextFeaturePermissions, true)) {
                        $nextFeaturePermissions[] = 'search.campaigns';
                    }

                    if (in_array('catalogs', $menuPermissions, true) && ! in_array('catalogs.hot_products', $nextFeaturePermissions, true)) {
                        $nextFeaturePermissions[] = 'catalogs.hot_products';
                    }

                    if ($nextFeaturePermissions === $featurePermissions) {
                        continue;
                    }

                    $user->forceFill([
                        'feature_permissions' => array_values($nextFeaturePermissions),
                    ])->save();
                    app(UserPermissionService::class)->markChanged($user);
                }
            });
    }

    /**
     * @return array<int, array{key:string,label:string,href:string}>
     */
    private function customerMenuPermissionOptions(): array
    {
        $allowed = array_flip($this->customerManagedMenuPermissions());

        return array_values(array_filter(
            MenuPermissions::definitions(),
            fn (array $definition): bool => isset($allowed[$definition['key']])
        ));
    }

    /**
     * Customer accounts may be granted every operational page individually.
     * User-management pages stay excluded to prevent privilege escalation.
     *
     * @return list<string>
     */
    private function customerManagedMenuPermissions(): array
    {
        return array_values(array_diff(
            MenuPermissions::keys(),
            ['moderator', 'customer-users']
        ));
    }

    private function specialDiscountRate(Customer $customer): ?string
    {
        $rate = data_get($customer->meta, 'special_discount_rate');

        if (! is_numeric($rate)) {
            return null;
        }

        return number_format(max(0.0, min(100.0, (float) $rate)), 2, '.', '');
    }

    private function updateCustomerDiscount(Customer $customer, mixed $rate): void
    {
        $meta = is_array($customer->meta) ? $customer->meta : [];

        if ($rate === null || $rate === '') {
            unset($meta['special_discount_rate']);
        } else {
            $meta['special_discount_rate'] = number_format(max(0.0, min(100.0, (float) $rate)), 2, '.', '');
        }

        $customer->forceFill(['meta' => $meta])->save();
    }

    private function updateCustomerBrandSettings(
        Customer $customer,
        mixed $allowedBrandIds,
        mixed $brandDiscounts,
        bool $updateAllowed,
        bool $updateDiscounts,
    ): void {
        if (! $updateAllowed && ! $updateDiscounts) {
            return;
        }

        $meta = is_array($customer->meta) ? $customer->meta : [];
        $settings = is_array(data_get($meta, 'customer_user')) ? data_get($meta, 'customer_user') : [];

        if ($updateAllowed) {
            $settings['allowed_brand_ids'] = array_values(array_unique(array_map('intval', is_array($allowedBrandIds) ? $allowedBrandIds : [])));
        }

        if ($updateDiscounts) {
            $settings['brand_discounts'] = collect(is_array($brandDiscounts) ? $brandDiscounts : [])
                ->map(fn (array $row): array => [
                    'brand_id' => (int) $row['brand_id'],
                    'discount_1' => number_format((float) ($row['discount_1'] ?? 0), 2, '.', ''),
                    'discount_2' => number_format((float) ($row['discount_2'] ?? 0), 2, '.', ''),
                    'discount_3' => number_format((float) ($row['discount_3'] ?? 0), 2, '.', ''),
                ])
                ->values()
                ->all();
        }

        data_set($meta, 'customer_user', $settings);
        $customer->forceFill(['meta' => $meta])->save();
    }

    private function usernameFromCustomerCode(?string $code): string
    {
        $username = mb_strtolower(trim((string) $code));
        $username = preg_replace('/\s+/', '-', $username) ?? '';
        $username = preg_replace('/[^a-z0-9._-]+/', '-', $username) ?? '';
        $username = trim($username, '.-_');

        return $username;
    }
}
