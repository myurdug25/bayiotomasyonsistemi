<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Customer;
use App\Models\Role;
use App\Models\User;
use App\Support\CustomerFeaturePermissions;
use App\Support\MenuPermissions;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
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

    private const CUSTOMER_MANAGED_MENU_PERMISSIONS = [
        'dashboard',
        'notes',
        'search',
        'catalogs',
        'cart',
        'orders',
        'ledger',
        'reports',
        'returns',
    ];

    public function index(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'q' => ['nullable', 'string', 'max:120'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:100'],
        ]);

        $search = trim((string) ($validated['q'] ?? ''));
        $limit = min((int) ($validated['limit'] ?? 50), 100);

        $customerUsers = User::query()
            ->select(['id', 'selected_customer_id', 'username', 'is_active', 'menu_permissions', 'feature_permissions'])
            ->whereNotNull('selected_customer_id')
            ->whereHas('roles', fn (Builder $query) => $query->where('slug', 'customer'))
            ->get()
            ->keyBy('selected_customer_id');

        $query = Customer::query()
            ->select(['id', 'dealer_id', 'code', 'name', 'is_active', 'meta'])
            ->where('is_active', true);

        if ($search !== '') {
            $query->where(function (Builder $builder) use ($search): void {
                $builder
                    ->where('code', 'ilike', "{$search}%")
                    ->orWhere('name', 'ilike', "%{$search}%");
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
                ->map(fn (Customer $customer): array => $this->serializeCustomerUserRow($customer, $customerUsers->get($customer->id)))
                ->values(),
            'total_count' => $totalCount,
            'limit' => $limit,
            'menu_permissions' => $this->customerMenuPermissionOptions(),
            'feature_permissions' => CustomerFeaturePermissions::definitions(),
            'default_menu_permissions' => self::CUSTOMER_DEFAULT_MENU_PERMISSIONS,
        ]);
    }

    public function store(Request $request, Customer $customer): JsonResponse
    {
        if (! $customer->is_active) {
            throw ValidationException::withMessages([
                'customer_id' => ['Pasif cari için müşteri kullanıcısı açılamaz.'],
            ]);
        }

        $validated = $request->validate([
            'password' => ['nullable', 'string', 'max:255', Password::min(6)],
            'is_active' => ['sometimes', 'boolean'],
            'menu_permissions' => ['nullable', 'array', 'min:1'],
            'menu_permissions.*' => ['string', Rule::in(self::CUSTOMER_MANAGED_MENU_PERMISSIONS)],
            'feature_permissions' => ['nullable', 'array'],
            'feature_permissions.*' => ['string', Rule::in(CustomerFeaturePermissions::keys())],
            'special_discount_rate' => ['nullable', 'numeric', 'min:0', 'max:100'],
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
                throw ValidationException::withMessages([
                    'password' => ['Yeni müşteri kullanıcısı için şifre zorunlu.'],
                ]);
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
            ];

            if ($password !== '') {
                $attributes['password'] = Hash::make($password);
            }

            $user->fill($attributes);
            $user->save();
            $user->roles()->sync([$customerRole->id]);

            if (array_key_exists('special_discount_rate', $validated)) {
                $this->updateCustomerDiscount($customer, $validated['special_discount_rate']);
            }

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
            'user' => $user instanceof User ? [
                'id' => $user->id,
                'username' => $user->username,
                'is_active' => (bool) $user->is_active,
                'menu_permissions' => MenuPermissions::forUser($user),
                'feature_permissions' => CustomerFeaturePermissions::forUser($user),
            ] : null,
        ];
    }

    /**
     * @return array<int, array{key:string,label:string,href:string}>
     */
    private function customerMenuPermissionOptions(): array
    {
        $allowed = array_flip(self::CUSTOMER_MANAGED_MENU_PERMISSIONS);

        return array_values(array_filter(
            MenuPermissions::definitions(),
            fn (array $definition): bool => isset($allowed[$definition['key']])
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

    private function usernameFromCustomerCode(?string $code): string
    {
        $username = mb_strtolower(trim((string) $code));
        $username = preg_replace('/\s+/', '-', $username) ?? '';
        $username = preg_replace('/[^a-z0-9._-]+/', '-', $username) ?? '';
        $username = trim($username, '.-_');

        return $username;
    }
}
