<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Resources\CustomerResource;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\Role;
use App\Models\User;
use App\Support\CustomerFeaturePermissions;
use App\Support\MenuPermissions;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Rules\Password;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\Response;

class ModeratorManagementController extends Controller
{
    public function overview(Request $request): JsonResponse
    {
        $user = $request->user();
        $this->ensureModeratorRole($user);
        $includeCustomers = $request->boolean('include_customers', true);
        $customerLimit = $request->has('customer_limit')
            ? min(max($request->integer('customer_limit'), 0), 200)
            : null;
        $customerSearch = trim((string) $request->query('customer_q', ''));

        $dealers = Dealer::query()
            ->select(['id', 'code', 'name', 'email', 'phone', 'is_active'])
            ->withCount('users')
            ->withCount([
                'customers' => fn ($query) => $query->where('source_system', 'logo'),
            ])
            ->withCount([
                'users as salespeople_count' => fn ($query) => $query->whereHas(
                    'roles',
                    fn ($roleQuery) => $roleQuery->where('slug', 'salesperson')
                ),
            ])
            ->orderBy('name')
            ->get();

        $roles = $this->availableRoles($user)
            ->map(fn (Role $role) => [
                'id' => $role->id,
                'slug' => $role->slug,
                'name' => $role->name,
            ])
            ->values();

        $users = User::query()
            ->select([
                'id',
                'dealer_id',
                'customer_scope',
                'region_code',
                'region_name',
                'branch_code',
                'branch_name',
                'logo_customer_specode4',
                'logo_cashbox_code',
                'logo_cashbox_name',
                'logo_expense_account_code',
                'logo_expense_account_name',
                'selected_customer_id',
                'name',
                'username',
                'email',
                'phone',
                'is_active',
                'menu_permissions',
                'feature_permissions',
                'created_at',
            ])
            ->with([
                'dealer:id,code,name',
                'selectedCustomer:id,code,name',
                'roles:id,name,slug',
            ])
            ->withCount('assignedCustomers')
            ->orderBy('name')
            ->get();

        $customerSummaryQuery = Customer::query()->where('source_system', 'logo');
        $customers = Collection::empty();

        if ($includeCustomers) {
            $customerListQuery = Customer::query()
                ->select([
                    'id',
                    'dealer_id',
                    'salesperson_user_id',
                    'region_code',
                    'region_name',
                    'branch_code',
                    'branch_name',
                    'source_system',
                    'source_reference',
                    'sync_status',
                    'sync_error',
                    'code',
                    'name',
                    'contact_name',
                    'email',
                    'phone',
                    'city',
                    'district',
                    'tax_office',
                    'tax_number',
                    'credit_limit',
                    'is_active',
                    'meta',
                    'last_synced_at',
                    'created_at',
                ])
                ->where('source_system', 'logo')
                ->when($customerSearch !== '', function ($query) use ($customerSearch): void {
                    $like = '%'.str_replace(['%', '_'], ['\\%', '\\_'], $customerSearch).'%';

                    $query->where(function ($searchQuery) use ($like): void {
                        $searchQuery
                            ->whereLike('code', $like, caseSensitive: false)
                            ->orWhereLike('name', $like, caseSensitive: false)
                            ->orWhereLike('contact_name', $like, caseSensitive: false)
                            ->orWhereLike('phone', $like, caseSensitive: false)
                            ->orWhereLike('city', $like, caseSensitive: false)
                            ->orWhereLike('district', $like, caseSensitive: false);
                    });
                })
                ->with([
                    'dealer:id,code,name',
                    'salesperson:id,dealer_id,name,email,phone',
                ])
                ->orderBy('name');

            if ($customerLimit !== null) {
                $customerListQuery->limit($customerLimit);
            }

            $customers = $customerListQuery->get();
        }

        $salespeople = $users
            ->filter(fn (User $listedUser) => $listedUser->roles->contains('slug', 'salesperson'))
            ->values();

        return response()->json([
            'summary' => [
                'users_total' => $users->count(),
                'active_users_total' => $users->where('is_active', true)->count(),
                'customers_total' => (clone $customerSummaryQuery)->count(),
                'active_customers_total' => (clone $customerSummaryQuery)->where('is_active', true)->count(),
                'salespeople_total' => $salespeople->count(),
                'assigned_customers_total' => (clone $customerSummaryQuery)->whereNotNull('salesperson_user_id')->count(),
                'unassigned_customers_total' => (clone $customerSummaryQuery)->whereNull('salesperson_user_id')->count(),
            ],
            'roles' => $roles,
            'menu_permissions' => MenuPermissions::definitions(),
            'feature_permissions' => CustomerFeaturePermissions::definitions(),
            'dealers' => $dealers->map(fn (Dealer $dealer) => [
                'id' => $dealer->id,
                'code' => $dealer->code,
                'name' => $dealer->name,
                'email' => $dealer->email,
                'phone' => $dealer->phone,
                'is_active' => (bool) $dealer->is_active,
                'users_count' => (int) $dealer->users_count,
                'customers_count' => (int) $dealer->customers_count,
                'salespeople_count' => (int) ($dealer->salespeople_count ?? 0),
            ])->values(),
            'users' => $users->map(fn (User $listedUser) => $this->serializeUser($listedUser))->values(),
            'customers' => $customers->map(fn (Customer $customer) => $this->serializeCustomer($customer))->values(),
        ]);
    }

    public function storeUser(Request $request): JsonResponse
    {
        $actor = $request->user();
        $this->ensureModeratorRole($actor);

        if (is_string($request->input('username'))) {
            $request->merge(['username' => $this->normalizeUsername($request->input('username'))]);
        }

        $validated = $request->validate([
            'dealer_id' => ['nullable', 'integer', 'exists:dealers,id'],
            'customer_scope' => ['nullable', 'string', Rule::in(['dealer', 'region', 'branch', 'assigned'])],
            'region_code' => ['nullable', 'string', 'max:64'],
            'region_name' => ['nullable', 'string', 'max:120'],
            'branch_code' => ['nullable', 'string', 'max:64'],
            'branch_name' => ['nullable', 'string', 'max:120'],
            'logo_customer_specode4' => ['nullable', 'string', 'max:64'],
            'logo_cashbox_code' => ['nullable', 'string', 'max:64'],
            'logo_cashbox_name' => ['nullable', 'string', 'max:128'],
            'logo_expense_account_code' => ['nullable', 'string', 'max:64'],
            'logo_expense_account_name' => ['nullable', 'string', 'max:180'],
            'name' => ['required', 'string', 'max:255'],
            'username' => ['required', 'string', 'max:64', 'regex:/^[a-z0-9._-]+$/', 'unique:users,username'],
            'email' => ['nullable', 'email', 'max:255', 'unique:users,email'],
            'phone' => ['required', 'string', 'regex:/^05\d{9}$/'],
            'password' => $this->moderatorPasswordRules(required: true),
            'is_active' => ['sometimes', 'boolean'],
            'role_slugs' => ['nullable', 'array'],
            'role_slugs.*' => ['string'],
            'menu_permissions' => ['nullable', 'array'],
            'menu_permissions.*' => ['string', Rule::in(MenuPermissions::keys())],
            'feature_permissions' => ['nullable', 'array'],
            'feature_permissions.*' => ['string', Rule::in(CustomerFeaturePermissions::keys())],
        ], [
            'username.unique' => 'Bu kullanıcı adı zaten başka bir hesap tarafından kullanılıyor.',
            'username.regex' => 'Kullanıcı adı boşluk veya Türkçe karakter içeremez. Sadece küçük harf, rakam ve _, -, . kullanabilirsiniz.',
            'email.unique' => 'Bu e-posta adresi zaten kullanılıyor.',
            'phone.regex' => 'Geçerli telefon numarası giriniz.',
        ]);

        $menuPermissions = collect(MenuPermissions::normalize($validated['menu_permissions'] ?? []));
        $featurePermissions = CustomerFeaturePermissions::normalize(
            $validated['feature_permissions'] ?? CustomerFeaturePermissions::defaultsForMenus($menuPermissions)
        );
        $roleSlugs = $this->normalizedRoleSlugs($validated, $menuPermissions);

        $this->ensureAllowedMenuPermissions($actor, $menuPermissions);
        $this->ensureAllowedRoleSlugs($actor, $roleSlugs);
        $dealerId = $this->validatedDealerId($validated, $roleSlugs);
        $customerScope = $this->validatedCustomerScope($validated, $roleSlugs);
        $territory = $this->territoryPayload($validated);

        $user = DB::transaction(function () use ($validated, $menuPermissions, $featurePermissions, $roleSlugs, $dealerId, $customerScope, $territory) {
            $createdUser = User::query()->create([
                'dealer_id' => $dealerId,
                'customer_scope' => $customerScope,
                'region_code' => $territory['region_code'],
                'region_name' => $territory['region_name'],
                'branch_code' => $territory['branch_code'],
                'branch_name' => $territory['branch_name'],
                'logo_customer_specode4' => $this->normalizedCodeField($validated, 'logo_customer_specode4'),
                'logo_cashbox_code' => $this->normalizedCodeField($validated, 'logo_cashbox_code'),
                'logo_cashbox_name' => $this->normalizedLabelField($validated, 'logo_cashbox_name'),
                'logo_expense_account_code' => $this->normalizedCodeField($validated, 'logo_expense_account_code'),
                'logo_expense_account_name' => $this->normalizedLabelField($validated, 'logo_expense_account_name'),
                'selected_customer_id' => null,
                'name' => $validated['name'],
                'username' => $this->normalizeUsername($validated['username']),
                'email' => $validated['email'] ?? null,
                'phone' => $validated['phone'] ?? null,
                'password' => Hash::make($validated['password']),
                'is_active' => (bool) ($validated['is_active'] ?? true),
                'menu_permissions' => $menuPermissions->values()->all(),
                'feature_permissions' => $featurePermissions,
            ]);

            $roleIds = Role::query()
                ->whereIn('slug', $roleSlugs->all())
                ->pluck('id');

            $createdUser->roles()->sync($roleIds);

            return $createdUser->fresh([
                'dealer:id,code,name',
                'selectedCustomer:id,code,name',
                'roles:id,name,slug',
            ])->loadCount('assignedCustomers');
        });

        return response()->json([
            'data' => $this->serializeUser($user),
        ], Response::HTTP_CREATED);
    }

    public function updateUser(Request $request, User $user): JsonResponse
    {
        $actor = $request->user();
        $this->ensureModeratorRole($actor);
        $this->ensureCanManageUser($actor, $user);

        if (is_string($request->input('username'))) {
            $request->merge(['username' => $this->normalizeUsername($request->input('username'))]);
        }

        $validated = $request->validate([
            'dealer_id' => ['nullable', 'integer', 'exists:dealers,id'],
            'customer_scope' => ['nullable', 'string', Rule::in(['dealer', 'region', 'branch', 'assigned'])],
            'region_code' => ['nullable', 'string', 'max:64'],
            'region_name' => ['nullable', 'string', 'max:120'],
            'branch_code' => ['nullable', 'string', 'max:64'],
            'branch_name' => ['nullable', 'string', 'max:120'],
            'logo_customer_specode4' => ['nullable', 'string', 'max:64'],
            'logo_cashbox_code' => ['nullable', 'string', 'max:64'],
            'logo_cashbox_name' => ['nullable', 'string', 'max:128'],
            'logo_expense_account_code' => ['nullable', 'string', 'max:64'],
            'logo_expense_account_name' => ['nullable', 'string', 'max:180'],
            'name' => ['sometimes', 'string', 'max:255'],
            'username' => ['sometimes', 'string', 'max:64', 'regex:/^[a-z0-9._-]+$/', Rule::unique('users', 'username')->ignore($user->id)],
            'email' => ['nullable', 'email', 'max:255', Rule::unique('users', 'email')->ignore($user->id)],
            'phone' => ['nullable', 'string', 'regex:/^05\d{9}$/'],
            'password' => $this->moderatorPasswordRules(required: false),
            'is_active' => ['sometimes', 'boolean'],
            'role_slugs' => ['nullable', 'array'],
            'role_slugs.*' => ['string'],
            'menu_permissions' => ['nullable', 'array'],
            'menu_permissions.*' => ['string', Rule::in(MenuPermissions::keys())],
            'feature_permissions' => ['nullable', 'array'],
            'feature_permissions.*' => ['string', Rule::in(CustomerFeaturePermissions::keys())],
        ], [
            'username.unique' => 'Bu kullanıcı adı zaten başka bir hesap tarafından kullanılıyor.',
            'username.regex' => 'Kullanıcı adı boşluk veya Türkçe karakter içeremez. Sadece küçük harf, rakam ve _, -, . kullanabilirsiniz.',
            'email.unique' => 'Bu e-posta adresi zaten kullanılıyor.',
            'phone.regex' => 'Geçerli telefon numarası giriniz.',
        ]);

        $updatedUser = DB::transaction(function () use ($actor, $user, $validated) {
            $nextMenuPermissions = array_key_exists('menu_permissions', $validated) && is_array($validated['menu_permissions'])
                ? collect(MenuPermissions::normalize($validated['menu_permissions'] ?? []))
                : collect(MenuPermissions::forUser($user));

            $nextRoleSlugs = array_key_exists('role_slugs', $validated) && is_array($validated['role_slugs'])
                ? $this->normalizedRoleSlugs($validated, $nextMenuPermissions)
                : (
                    array_key_exists('menu_permissions', $validated) && is_array($validated['menu_permissions'])
                        ? collect(MenuPermissions::rolesForPermissions($nextMenuPermissions->all()))
                        : $user->roles()->pluck('slug')->values()
                );
            $nextFeaturePermissions = array_key_exists('feature_permissions', $validated) && is_array($validated['feature_permissions'])
                ? CustomerFeaturePermissions::normalize($validated['feature_permissions'] ?? [])
                : CustomerFeaturePermissions::forUser($user);

            if ($actor->hasRole('admin') && $user->hasRole('admin') && ! $nextRoleSlugs->contains('admin')) {
                $nextRoleSlugs->push('admin');
            }

            $this->ensureAllowedMenuPermissions($actor, $nextMenuPermissions);
            $this->ensureAllowedRoleSlugs($actor, $nextRoleSlugs);
            $dealerId = $this->validatedDealerId($validated, $nextRoleSlugs, $user->dealer_id);
            $customerScope = $this->validatedCustomerScope($validated, $nextRoleSlugs, $user->customer_scope);
            $territory = $this->territoryPayload($validated, [
                'region_code' => $user->region_code,
                'region_name' => $user->region_name,
                'branch_code' => $user->branch_code,
                'branch_name' => $user->branch_name,
            ]);

            $user->fill([
                'dealer_id' => $dealerId,
                'customer_scope' => $customerScope,
                'region_code' => $territory['region_code'],
                'region_name' => $territory['region_name'],
                'branch_code' => $territory['branch_code'],
                'branch_name' => $territory['branch_name'],
                'logo_customer_specode4' => $this->normalizedCodeField(
                    $validated,
                    'logo_customer_specode4',
                    $user->logo_customer_specode4
                ),
                'logo_cashbox_code' => $this->normalizedCodeField(
                    $validated,
                    'logo_cashbox_code',
                    $user->logo_cashbox_code
                ),
                'logo_cashbox_name' => $this->normalizedLabelField(
                    $validated,
                    'logo_cashbox_name',
                    $user->logo_cashbox_name
                ),
                'logo_expense_account_code' => $this->normalizedCodeField(
                    $validated,
                    'logo_expense_account_code',
                    $user->logo_expense_account_code
                ),
                'logo_expense_account_name' => $this->normalizedLabelField(
                    $validated,
                    'logo_expense_account_name',
                    $user->logo_expense_account_name
                ),
                'name' => $validated['name'] ?? $user->name,
                'username' => array_key_exists('username', $validated)
                    ? $this->normalizeUsername($validated['username'])
                    : $user->username,
                'email' => array_key_exists('email', $validated) ? ($validated['email'] ?? null) : $user->email,
                'phone' => array_key_exists('phone', $validated) ? ($validated['phone'] ?? null) : $user->phone,
                'is_active' => array_key_exists('is_active', $validated)
                    ? (bool) $validated['is_active']
                    : $user->is_active,
                'menu_permissions' => $nextMenuPermissions->values()->all(),
                'feature_permissions' => $nextFeaturePermissions,
            ]);

            if (! empty($validated['password'])) {
                $user->password = Hash::make($validated['password']);
            }

            $user->save();

            $roleIds = Role::query()
                ->whereIn('slug', $nextRoleSlugs->all())
                ->pluck('id');
            $user->roles()->sync($roleIds);

            if (! $nextRoleSlugs->contains('salesperson')) {
                Customer::query()
                    ->where('salesperson_user_id', $user->id)
                    ->update(['salesperson_user_id' => null]);
            } elseif ($dealerId !== null) {
                Customer::query()
                    ->where('salesperson_user_id', $user->id)
                    ->where('dealer_id', '!=', $dealerId)
                    ->update(['salesperson_user_id' => null]);
            }

            $user->load('roles:id,name,slug');

            if ($user->selected_customer_id !== null) {
                $selectedCustomer = Customer::query()->find($user->selected_customer_id);
                if (! $selectedCustomer instanceof Customer || ! $user->canAccessCustomer($selectedCustomer)) {
                    $user->selected_customer_id = null;
                    $user->save();
                }
            }

            return $user->fresh([
                'dealer:id,code,name',
                'selectedCustomer:id,code,name',
                'roles:id,name,slug',
            ])->loadCount('assignedCustomers');
        });

        return response()->json([
            'data' => $this->serializeUser($updatedUser),
        ]);
    }

    public function resetUserPassword(Request $request, User $user): JsonResponse
    {
        $actor = $request->user();
        $this->ensureModeratorRole($actor);
        $this->ensureCanManageUser($actor, $user);

        $validated = $request->validate([
            'password' => $this->moderatorPasswordRules(required: true),
        ]);

        $user->forceFill([
            'password' => Hash::make($validated['password']),
        ])->save();

        return response()->json([
            'data' => $this->serializeUser($user->fresh([
                'dealer:id,code,name',
                'selectedCustomer:id,code,name',
                'roles:id,name,slug',
            ])->loadCount('assignedCustomers')),
        ]);
    }

    public function destroyUser(Request $request, User $user): JsonResponse
    {
        $actor = $request->user();
        $this->ensureModeratorRole($actor);
        $this->ensureCanManageUser($actor, $user);

        if ((int) $actor->id === (int) $user->id) {
            throw ValidationException::withMessages([
                'user' => ['Kendi hesabınızı silemezsiniz.'],
            ]);
        }

        $blockingReason = $this->userDeleteBlockingReason($user);

        if ($blockingReason !== null) {
            throw ValidationException::withMessages([
                'user' => [$blockingReason],
            ]);
        }

        DB::transaction(function () use ($user): void {
            Customer::query()
                ->where('salesperson_user_id', $user->id)
                ->update(['salesperson_user_id' => null]);

            if ($user->selected_customer_id !== null) {
                User::query()
                    ->where('selected_customer_id', $user->selected_customer_id)
                    ->whereKeyNot($user->id)
                    ->update(['selected_customer_id' => null]);
            }

            $user->roles()->detach();
            $user->delete();
        });

        return response()->json([
            'message' => 'Kullanıcı silindi.',
        ]);
    }

    public function storeCustomer(Request $request): JsonResponse
    {
        $actor = $request->user();
        $this->ensureModeratorRole($actor);

        $validated = $request->validate([
            'dealer_id' => ['required', 'integer', 'exists:dealers,id'],
            'salesperson_user_id' => ['nullable', 'integer', 'exists:users,id'],
            'region_code' => ['nullable', 'string', 'max:64'],
            'region_name' => ['nullable', 'string', 'max:120'],
            'branch_code' => ['nullable', 'string', 'max:64'],
            'branch_name' => ['nullable', 'string', 'max:120'],
            'code' => [
                'required',
                'string',
                'max:64',
                Rule::unique('customers', 'code')->where(
                    fn ($query) => $query->where('dealer_id', (int) $request->input('dealer_id'))
                ),
            ],
            'name' => ['required', 'string', 'max:255'],
            'contact_name' => ['nullable', 'string', 'max:255'],
            'email' => ['nullable', 'email', 'max:255'],
            'phone' => ['nullable', 'string', 'max:32'],
            'city' => ['nullable', 'string', 'max:120'],
            'district' => ['nullable', 'string', 'max:120'],
            'tax_office' => ['nullable', 'string', 'max:255'],
            'tax_number' => ['nullable', 'string', 'max:32'],
            'credit_limit' => ['nullable', 'numeric', 'min:0'],
            'special_discount_rate' => ['nullable', 'numeric', 'min:0', 'max:100'],
            'is_active' => ['sometimes', 'boolean'],
            'address' => ['nullable', 'string'],
            'iban' => ['nullable', 'string', 'max:64'],
        ]);

        $salespersonId = $this->validatedSalespersonId(
            dealerId: (int) $validated['dealer_id'],
            salespersonUserId: isset($validated['salesperson_user_id']) ? (int) $validated['salesperson_user_id'] : null
        );
        $salesperson = $salespersonId !== null ? User::query()->find($salespersonId) : null;
        $territory = $this->territoryPayload($validated, [
            'region_code' => $salesperson?->region_code,
            'region_name' => $salesperson?->region_name,
            'branch_code' => $salesperson?->branch_code,
            'branch_name' => $salesperson?->branch_name,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => (int) $validated['dealer_id'],
            'salesperson_user_id' => $salespersonId,
            'region_code' => $territory['region_code'],
            'region_name' => $territory['region_name'],
            'branch_code' => $territory['branch_code'],
            'branch_name' => $territory['branch_name'],
            'source_system' => 'b2b',
            'sync_status' => 'pending',
            'sync_error' => null,
            'code' => $validated['code'],
            'name' => $validated['name'],
            'contact_name' => $validated['contact_name'] ?? null,
            'email' => $validated['email'] ?? null,
            'phone' => $validated['phone'] ?? null,
            'city' => $validated['city'] ?? null,
            'district' => $validated['district'] ?? null,
            'tax_office' => $validated['tax_office'] ?? null,
            'tax_number' => $validated['tax_number'] ?? null,
            'credit_limit' => $validated['credit_limit'] ?? 0,
            'is_active' => (bool) ($validated['is_active'] ?? true),
            'meta' => $this->mergeCustomerMeta(null, $validated),
        ]);

        $customer->loadMissing([
            'dealer:id,code,name',
            'salesperson:id,dealer_id,name,email,phone',
        ]);

        return response()->json([
            'data' => $this->serializeCustomer($customer),
            'customer' => new CustomerResource($customer),
        ], Response::HTTP_CREATED);
    }

    public function updateCustomer(Request $request, Customer $customer): JsonResponse
    {
        $actor = $request->user();
        $this->ensureModeratorRole($actor);

        $validated = $request->validate([
            'dealer_id' => ['sometimes', 'integer', 'exists:dealers,id'],
            'salesperson_user_id' => ['nullable', 'integer', 'exists:users,id'],
            'region_code' => ['nullable', 'string', 'max:64'],
            'region_name' => ['nullable', 'string', 'max:120'],
            'branch_code' => ['nullable', 'string', 'max:64'],
            'branch_name' => ['nullable', 'string', 'max:120'],
            'code' => [
                'sometimes',
                'string',
                'max:64',
                Rule::unique('customers', 'code')->where(
                    fn ($query) => $query->where('dealer_id', (int) $request->input('dealer_id', $customer->dealer_id))
                )->ignore($customer->id),
            ],
            'name' => ['sometimes', 'string', 'max:255'],
            'contact_name' => ['nullable', 'string', 'max:255'],
            'email' => ['nullable', 'email', 'max:255'],
            'phone' => ['nullable', 'string', 'max:32'],
            'city' => ['nullable', 'string', 'max:120'],
            'district' => ['nullable', 'string', 'max:120'],
            'tax_office' => ['nullable', 'string', 'max:255'],
            'tax_number' => ['nullable', 'string', 'max:32'],
            'credit_limit' => ['nullable', 'numeric', 'min:0'],
            'special_discount_rate' => ['nullable', 'numeric', 'min:0', 'max:100'],
            'is_active' => ['sometimes', 'boolean'],
            'address' => ['nullable', 'string'],
            'iban' => ['nullable', 'string', 'max:64'],
        ]);

        $dealerId = (int) ($validated['dealer_id'] ?? $customer->dealer_id);
        $salespersonId = array_key_exists('salesperson_user_id', $validated)
            ? $this->validatedSalespersonId(
                dealerId: $dealerId,
                salespersonUserId: $validated['salesperson_user_id'] !== null
                    ? (int) $validated['salesperson_user_id']
                    : null
            )
            : $customer->salesperson_user_id;
        $salesperson = $salespersonId !== null ? User::query()->find($salespersonId) : null;
        $territory = $this->territoryPayload($validated, [
            'region_code' => $customer->region_code ?? $salesperson?->region_code,
            'region_name' => $customer->region_name ?? $salesperson?->region_name,
            'branch_code' => $customer->branch_code ?? $salesperson?->branch_code,
            'branch_name' => $customer->branch_name ?? $salesperson?->branch_name,
        ]);

        $customer->fill([
            'dealer_id' => $dealerId,
            'salesperson_user_id' => $salespersonId,
            'region_code' => $territory['region_code'],
            'region_name' => $territory['region_name'],
            'branch_code' => $territory['branch_code'],
            'branch_name' => $territory['branch_name'],
            'source_system' => $customer->source_system !== 'logo'
                ? ($customer->source_system ?: 'b2b')
                : $customer->source_system,
            'sync_status' => $customer->source_system !== 'logo'
                ? 'pending'
                : $customer->sync_status,
            'sync_error' => $customer->source_system !== 'logo'
                ? null
                : $customer->sync_error,
            'code' => $validated['code'] ?? $customer->code,
            'name' => $validated['name'] ?? $customer->name,
            'contact_name' => array_key_exists('contact_name', $validated)
                ? ($validated['contact_name'] ?? null)
                : $customer->contact_name,
            'email' => array_key_exists('email', $validated) ? ($validated['email'] ?? null) : $customer->email,
            'phone' => array_key_exists('phone', $validated) ? ($validated['phone'] ?? null) : $customer->phone,
            'city' => array_key_exists('city', $validated) ? ($validated['city'] ?? null) : $customer->city,
            'district' => array_key_exists('district', $validated) ? ($validated['district'] ?? null) : $customer->district,
            'tax_office' => array_key_exists('tax_office', $validated)
                ? ($validated['tax_office'] ?? null)
                : $customer->tax_office,
            'tax_number' => array_key_exists('tax_number', $validated)
                ? ($validated['tax_number'] ?? null)
                : $customer->tax_number,
            'credit_limit' => array_key_exists('credit_limit', $validated)
                ? ($validated['credit_limit'] ?? 0)
                : $customer->credit_limit,
            'is_active' => array_key_exists('is_active', $validated)
                ? (bool) $validated['is_active']
                : $customer->is_active,
            'meta' => $this->mergeCustomerMeta($customer->meta, $validated),
        ])->save();

        User::query()
            ->where('selected_customer_id', $customer->id)
            ->get()
            ->each(function (User $listedUser) use ($customer): void {
                if (! $listedUser->canAccessCustomer($customer)) {
                    $listedUser->forceFill(['selected_customer_id' => null])->save();
                }
            });

        $customer->loadMissing([
            'dealer:id,code,name',
            'salesperson:id,dealer_id,name,email,phone',
        ]);

        return response()->json([
            'data' => $this->serializeCustomer($customer->fresh([
                'dealer:id,code,name',
                'salesperson:id,dealer_id,name,email,phone',
            ])),
            'customer' => new CustomerResource($customer->fresh()),
        ]);
    }

    private function ensureModeratorRole(User $user): void
    {
        if (! $user->hasAnyRole(['admin', 'moderator'])) {
            abort(Response::HTTP_FORBIDDEN, 'You are not allowed to access moderator management.');
        }
    }

    private function ensureCanManageUser(User $actor, User $managedUser): void
    {
        if ($actor->hasRole('admin')) {
            return;
        }

        if ($managedUser->roles()->whereIn('slug', ['admin', 'moderator'])->exists()) {
            abort(Response::HTTP_FORBIDDEN, 'Moderator can only manage non-admin users.');
        }
    }

    /**
     * @return Collection<int, Role>
     */
    private function availableRoles(User $user): Collection
    {
        $query = Role::query()
            ->orderBy('name');

        if (! $user->hasRole('admin')) {
            $query->whereNotIn('slug', ['admin', 'moderator']);
        }

        /** @var Collection<int, Role> $roles */
        $roles = $query->get();

        return $roles;
    }

    /**
     * @param  Collection<int, string>  $roleSlugs
     */
    private function ensureAllowedRoleSlugs(User $actor, Collection $roleSlugs): void
    {
        $availableRoleSlugs = $this->availableRoles($actor)->pluck('slug');

        if ($roleSlugs->diff($availableRoleSlugs)->isNotEmpty()) {
            throw ValidationException::withMessages([
                'role_slugs' => ['Seçilen kullanıcı tipi bu kullanıcı için uygun değil.'],
            ]);
        }
    }

    /**
     * @param  Collection<int, string>  $menuPermissions
     */
    private function ensureAllowedMenuPermissions(User $actor, Collection $menuPermissions): void
    {
        $availablePermissions = collect(MenuPermissions::keys());

        if (! $actor->hasRole('admin')) {
            $availablePermissions = $availablePermissions->reject(fn (string $key) => $key === 'moderator');
        }

        if ($menuPermissions->diff($availablePermissions)->isNotEmpty()) {
            throw ValidationException::withMessages([
                'menu_permissions' => ['Seçilen menü yetkileri bu kullanıcı için uygun değil.'],
            ]);
        }
    }

    /**
     * @param  array<string, mixed>  $validated
     * @param  Collection<int, string>  $menuPermissions
     * @return Collection<int, string>
     */
    private function normalizedRoleSlugs(array $validated, Collection $menuPermissions): Collection
    {
        if (! array_key_exists('role_slugs', $validated)) {
            return collect(MenuPermissions::rolesForPermissions($menuPermissions->all()));
        }

        return collect($validated['role_slugs'])
            ->filter(fn (mixed $roleSlug): bool => is_string($roleSlug))
            ->map(fn (string $roleSlug): string => trim($roleSlug))
            ->filter()
            ->unique()
            ->values();
    }

    private function validatedDealerId(array $validated, Collection $roleSlugs, ?int $fallbackDealerId = null): ?int
    {
        if ($roleSlugs->contains('admin')) {
            return null;
        }

        return array_key_exists('dealer_id', $validated)
            ? ($validated['dealer_id'] !== null ? (int) $validated['dealer_id'] : null)
            : $fallbackDealerId;
    }

    /**
     * @param  array<string, mixed>  $validated
     * @param  Collection<int, string>  $roleSlugs
     */
    private function validatedCustomerScope(array $validated, Collection $roleSlugs, ?string $fallbackScope = null): string
    {
        if ($roleSlugs->contains('admin')) {
            return 'dealer';
        }

        if ($roleSlugs->contains('salesperson')) {
            return 'assigned';
        }

        if ($roleSlugs->contains('moderator') && $roleSlugs->count() === 1) {
            return 'dealer';
        }

        $scope = strtolower(trim((string) ($validated['customer_scope'] ?? $fallbackScope ?? 'dealer')));

        if (! in_array($scope, ['dealer', 'region', 'branch', 'assigned'], true)) {
            throw ValidationException::withMessages([
                'customer_scope' => ['Seçilen müşteri görünürlük tipi geçersiz.'],
            ]);
        }

        if ($scope === 'assigned') {
            throw ValidationException::withMessages([
                'customer_scope' => ['Assigned görünürlük sadece plasiyer rolü için kullanılabilir.'],
            ]);
        }

        $territory = $this->territoryPayload($validated);

        if ($scope === 'region' && $territory['region_code'] === null) {
            throw ValidationException::withMessages([
                'region_code' => ['Region görünürlüğü için region_code zorunludur.'],
            ]);
        }

        if ($scope === 'branch' && $territory['branch_code'] === null) {
            throw ValidationException::withMessages([
                'branch_code' => ['Branch görünürlüğü için branch_code zorunludur.'],
            ]);
        }

        return $scope;
    }

    private function validatedSalespersonId(int $dealerId, ?int $salespersonUserId): ?int
    {
        if ($salespersonUserId === null) {
            return null;
        }

        $salesperson = User::query()
            ->with('roles:id,slug')
            ->whereKey($salespersonUserId)
            ->where('dealer_id', $dealerId)
            ->first();

        if (
            ! $salesperson instanceof User
            || ! $salesperson->roles->contains('slug', 'salesperson')
        ) {
            throw ValidationException::withMessages([
                'salesperson_user_id' => ['Selected salesperson is invalid for this dealer.'],
            ]);
        }

        return $salesperson->id;
    }

    /**
     * @param  array<string, mixed>  $validated
     * @param  array<string, mixed>|null  $fallback
     * @return array{region_code:?string,region_name:?string,branch_code:?string,branch_name:?string}
     */
    private function territoryPayload(array $validated, ?array $fallback = null): array
    {
        return [
            'region_code' => $this->normalizedCodeField($validated, 'region_code', $fallback['region_code'] ?? null),
            'region_name' => $this->normalizedLabelField($validated, 'region_name', $fallback['region_name'] ?? null),
            'branch_code' => $this->normalizedCodeField($validated, 'branch_code', $fallback['branch_code'] ?? null),
            'branch_name' => $this->normalizedLabelField($validated, 'branch_name', $fallback['branch_name'] ?? null),
        ];
    }

    private function userDeleteBlockingReason(User $user): ?string
    {
        $hasOperationalRecords = DB::table('pos_sessions')->where('opened_by', $user->id)->exists()
            || DB::table('pos_sales')->where('created_by', $user->id)->exists()
            || DB::table('shipments')->where('created_by', $user->id)->exists()
            || DB::table('shipment_scans')->where('scanned_by', $user->id)->exists()
            || DB::table('customer_card_requests')->where('requested_by_user_id', $user->id)->exists()
            || DB::table('customer_card_requests')->where('reviewed_by_user_id', $user->id)->exists()
            || DB::table('customer_card_requests')->where('converted_by_user_id', $user->id)->exists()
            || DB::table('customer_card_request_attachments')->where('uploaded_by_user_id', $user->id)->exists()
            || DB::table('return_requests')->where('requested_by_user_id', $user->id)->exists()
            || DB::table('return_requests')->where('reviewed_by_user_id', $user->id)->exists();

        if ($hasOperationalRecords) {
            return 'Bu kullanıcıya bağlı operasyon kayıtları var. Silmek yerine pasife alın.';
        }

        return null;
    }

    /**
     * @param  array<string, mixed>|null  $existingMeta
     * @param  array<string, mixed>  $validated
     * @return array<string, mixed>|null
     */
    private function mergeCustomerMeta(?array $existingMeta, array $validated): ?array
    {
        $meta = is_array($existingMeta) ? $existingMeta : [];

        if (array_key_exists('address', $validated)) {
            $meta['address'] = $validated['address'] ?? null;
        }

        if (array_key_exists('iban', $validated)) {
            $meta['iban'] = $validated['iban'] ?? null;
        }

        if (array_key_exists('special_discount_rate', $validated)) {
            $discountRate = $validated['special_discount_rate'];
            $meta['special_discount_rate'] = $discountRate !== null && $discountRate !== ''
                ? number_format((float) $discountRate, 2, '.', '')
                : null;
        }

        return $meta === [] ? null : $meta;
    }

    /**
     * @param  array<string, mixed>  $validated
     */
    private function normalizedCodeField(array $validated, string $key, mixed $fallback = null): ?string
    {
        $value = array_key_exists($key, $validated) ? $validated[$key] : $fallback;
        $normalized = trim((string) $value);

        if ($normalized === '') {
            return null;
        }

        return mb_strtoupper($normalized);
    }

    /**
     * @param  array<string, mixed>  $validated
     */
    private function normalizedLabelField(array $validated, string $key, mixed $fallback = null): ?string
    {
        $value = array_key_exists($key, $validated) ? $validated[$key] : $fallback;
        $normalized = trim((string) $value);

        return $normalized !== '' ? $normalized : null;
    }

    /**
     * @return array<string, mixed>
     */
    private function serializeUser(User $user): array
    {
        return [
            'id' => $user->id,
            'dealer_id' => $user->dealer_id,
            'customer_scope' => $user->effectiveCustomerScope(),
            'region_code' => $user->region_code,
            'region_name' => $user->region_name,
            'branch_code' => $user->branch_code,
            'branch_name' => $user->branch_name,
            'logo_customer_specode4' => $user->logo_customer_specode4,
            'logo_cashbox_code' => $user->logo_cashbox_code,
            'logo_cashbox_name' => $user->logo_cashbox_name,
            'logo_expense_account_code' => $user->logo_expense_account_code,
            'logo_expense_account_name' => $user->logo_expense_account_name,
            'selected_customer_id' => $user->selected_customer_id,
            'name' => $user->name,
            'username' => $user->username,
            'email' => $user->email,
            'phone' => $user->phone,
            'is_active' => (bool) $user->is_active,
            'menu_permissions' => MenuPermissions::forUser($user),
            'feature_permissions' => CustomerFeaturePermissions::forUser($user),
            'created_at' => $user->created_at,
            'assigned_customers_count' => (int) ($user->assigned_customers_count ?? 0),
            'dealer' => [
                'id' => $user->dealer?->id,
                'code' => $user->dealer?->code,
                'name' => $user->dealer?->name,
            ],
            'selected_customer' => [
                'id' => $user->selectedCustomer?->id,
                'code' => $user->selectedCustomer?->code,
                'title' => $user->selectedCustomer?->name,
            ],
            'roles' => $user->roles->map(fn (Role $role) => [
                'id' => $role->id,
                'slug' => $role->slug,
                'name' => $role->name,
            ])->values(),
        ];
    }

    private function normalizeUsername(mixed $value): string
    {
        return Str::of((string) $value)
            ->lower()
            ->ascii()
            ->replaceMatches('/[^a-z0-9._-]+/', '.')
            ->replaceMatches('/[.]{2,}/', '.')
            ->trim('.-_')
            ->toString();
    }

    /**
     * Moderator-created operational users use the same minimum accepted by login
     * and customer-user management screens.
     */
    private function moderatorPasswordRules(bool $required): array
    {
        return [
            $required ? 'required' : 'nullable',
            'string',
            'max:255',
            Password::min(6),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function serializeCustomer(Customer $customer): array
    {
        $meta = is_array($customer->meta) ? $customer->meta : [];
        $logoFinancials = data_get($meta, 'integrations.logo.financials', []);
        $logoTotal = is_numeric($logoFinancials['total_due'] ?? null) ? (float) $logoFinancials['total_due'] : null;
        $logoOrder = is_numeric($logoFinancials['order_due'] ?? null) ? (float) $logoFinancials['order_due'] : null;
        $logoCurrency = strtoupper((string) ($logoFinancials['currency'] ?? 'TRY'));
        $specialDiscountRate = is_numeric($meta['special_discount_rate'] ?? null)
            ? number_format((float) $meta['special_discount_rate'], 2, '.', '')
            : null;

        return [
            'id' => $customer->id,
            'dealer_id' => $customer->dealer_id,
            'salesperson_user_id' => $customer->salesperson_user_id,
            'region_code' => $customer->region_code,
            'region_name' => $customer->region_name,
            'branch_code' => $customer->branch_code,
            'branch_name' => $customer->branch_name,
            'source_system' => $customer->source_system,
            'source_reference' => $customer->source_reference,
            'sync_status' => $customer->sync_status,
            'sync_error' => $customer->sync_error,
            'code' => $customer->code,
            'name' => $customer->name,
            'contact_name' => $customer->contact_name,
            'email' => $customer->email,
            'phone' => $customer->phone,
            'city' => $customer->city,
            'district' => $customer->district,
            'tax_office' => $customer->tax_office,
            'tax_number' => $customer->tax_number,
            'credit_limit' => number_format((float) $customer->credit_limit, 2, '.', ''),
            'special_discount_rate' => $specialDiscountRate,
            'balance_summary' => [
                'total_due' => number_format((float) ($logoTotal ?? 0), 2, '.', ''),
                'order_due' => number_format((float) ($logoOrder ?? 0), 2, '.', ''),
                'currency' => $logoCurrency !== '' ? $logoCurrency : 'TRY',
            ],
            'balance_source' => $customer->source_system === 'logo' ? 'logo' : 'b2b',
            'is_active' => (bool) $customer->is_active,
            'address' => $meta['address'] ?? null,
            'iban' => $meta['iban'] ?? null,
            'last_synced_at' => $customer->last_synced_at,
            'created_at' => $customer->created_at,
            'dealer' => [
                'id' => $customer->dealer?->id,
                'code' => $customer->dealer?->code,
                'name' => $customer->dealer?->name,
            ],
            'salesperson' => [
                'id' => $customer->salesperson?->id,
                'name' => $customer->salesperson?->name,
                'email' => $customer->salesperson?->email,
                'phone' => $customer->salesperson?->phone,
            ],
        ];
    }
}
