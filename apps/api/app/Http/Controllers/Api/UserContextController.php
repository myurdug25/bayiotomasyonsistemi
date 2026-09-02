<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Context\StoreCustomerContextRequest;
use App\Http\Resources\CustomerSelectionResource;
use App\Models\Customer;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Validation\ValidationException;

class UserContextController extends Controller
{
    public function show(): JsonResponse
    {
        /** @var User $user */
        $user = auth()->user();
        $user->loadMissing([
            'selectedCustomer:id,dealer_id,salesperson_user_id,region_code,region_name,branch_code,branch_name,source_system,source_reference,code,name,contact_name,email,city,district,phone,tax_office,tax_number,credit_limit,is_active,meta,last_synced_at',
            'selectedCustomer.salesperson:id,username,name,email,phone,avatar_url,branch_code,branch_name,region_code,region_name',
        ]);

        $customer = $this->lockedCustomerForCustomerUser($user) ?? $user->selectedCustomer;
        if ($customer && ! $user->can('selectContext', $customer)) {
            if ($user->hasRole('customer')) {
                $customer = $this->lockedCustomerForCustomerUser($user, forceRefresh: true);
            } else {
                $user->forceFill([
                    'selected_customer_id' => null,
                ])->save();
                $customer = null;
            }
        }

        return response()->json([
            'context' => [
                'customer' => $this->formatCustomer($customer),
            ],
        ]);
    }

    public function setCustomer(StoreCustomerContextRequest $request): JsonResponse
    {
        /** @var User $user */
        $user = $request->user();
        $validated = $request->validated();

        $lockedCustomer = $this->lockedCustomerForCustomerUser($user);
        if ($lockedCustomer instanceof Customer && (int) $validated['customer_id'] !== (int) $lockedCustomer->id) {
            throw ValidationException::withMessages([
                'customer_id' => ['Müşteri kullanıcısı yalnızca kendi carisiyle işlem yapabilir.'],
            ]);
        }

        $customer = Customer::query()
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
                'code',
                'name',
                'contact_name',
                'email',
                'city',
                'district',
                'phone',
                'tax_office',
                'tax_number',
                'credit_limit',
                'is_active',
                'meta',
                'last_synced_at',
            ])
            ->with('salesperson:id,username,name,email,phone,avatar_url,branch_code,branch_name,region_code,region_name')
            ->findOrFail((int) $validated['customer_id']);

        $this->authorize('selectContext', $customer);

        $user->forceFill([
            'selected_customer_id' => $customer->id,
        ])->save();

        return response()->json([
            'context' => [
                'customer' => $this->formatCustomer($customer),
            ],
        ]);
    }

    public function clearCustomer(): JsonResponse
    {
        /** @var User $user */
        $user = auth()->user();

        if ($user->hasRole('customer')) {
            $customer = $this->lockedCustomerForCustomerUser($user);

            return response()->json([
                'context' => [
                    'customer' => $this->formatCustomer($customer),
                ],
            ]);
        }

        $user->forceFill([
            'selected_customer_id' => null,
        ])->save();

        return response()->json([
            'context' => [
                'customer' => null,
            ],
        ]);
    }

    private function formatCustomer(?Customer $customer): ?array
    {
        if (! $customer) {
            return null;
        }

        $selectionPayload = (new CustomerSelectionResource($customer))->toArray(request());
        $meta = is_array($customer->meta) ? $customer->meta : [];
        $manager = $this->resolveBranchManager($customer);
        if ($manager instanceof User) {
            $meta['manager_name'] = $manager->name;
            $meta['manager_phone'] = $manager->phone;
            $meta['manager_avatar_url'] = $manager->avatar_url;
        }

        return [
            'id' => $customer->id,
            'code' => $customer->code,
            'title' => $customer->name,
            'name' => $customer->name,
            'contact_name' => $customer->contact_name,
            'email' => $customer->email,
            'city' => $customer->city,
            'district' => $customer->district,
            'phone' => $customer->phone,
            'region_code' => $customer->region_code,
            'region_name' => $customer->region_name,
            'branch_code' => $customer->branch_code,
            'branch_name' => $customer->branch_name,
            'tax_office' => $customer->tax_office,
            'tax_number' => $customer->tax_number,
            'credit_limit' => $customer->credit_limit,
            'address' => is_array($customer->meta) ? ($customer->meta['address'] ?? $customer->meta['full_address'] ?? null) : null,
            'iban' => is_array($customer->meta) ? ($customer->meta['iban'] ?? null) : null,
            'meta' => $meta,
            'source_system' => $customer->source_system,
            'source_reference' => $customer->source_reference,
            'is_active' => (bool) $customer->is_active,
            'last_synced_at' => $customer->last_synced_at,
            'balance_summary' => $selectionPayload['balance_summary'] ?? [
                'total_due' => '0.00',
                'order_due' => '0.00',
                'currency' => 'TRY',
            ],
            'balance_source' => $selectionPayload['balance_source'] ?? 'b2b',
            'customer_user_feature_permissions' => $selectionPayload['customer_user_feature_permissions'] ?? null,
            'salesperson' => $customer->salesperson ? [
                'id' => $customer->salesperson->id,
                'name' => $customer->salesperson->name,
                'email' => $customer->salesperson->email,
                'phone' => $customer->salesperson->phone,
                'avatar_url' => $customer->salesperson->avatar_url,
            ] : null,
        ];
    }

    private function resolveBranchManager(Customer $customer): ?User
    {
        $branch = mb_strtoupper(implode(' ', array_filter([
            $customer->branch_code,
            $customer->branch_name,
            $customer->region_code,
            $customer->region_name,
            $customer->city,
            $customer->salesperson?->username,
            $customer->salesperson?->branch_code,
            $customer->salesperson?->branch_name,
            $customer->salesperson?->region_code,
            $customer->salesperson?->region_name,
        ])), 'UTF-8');

        $salespersonUsername = mb_strtolower(trim((string) $customer->salesperson?->username), 'UTF-8');
        $isErzurumSalesperson = in_array($salespersonUsername, [
            'ahmet.arac',
            'mehmet.aksoy',
            'hüseyin',
            'huseyin',
            'hüseyin.özgüney',
            'huseyin.ozguney',
        ], true);

        $username = match (true) {
            $isErzurumSalesperson, str_contains($branch, 'ERZURUM') => 'mudur.erzurum',
            str_contains($branch, 'TRABZON'), str_contains($branch, 'SAMSUN') => 'turgay.buyukkal',
            default => null,
        };

        if ($username === null) {
            return null;
        }

        return User::query()
            ->select(['id', 'username', 'name', 'phone', 'avatar_url'])
            ->whereRaw('LOWER(username) = ?', [mb_strtolower($username, 'UTF-8')])
            ->where('is_active', true)
            ->first();
    }

    private function lockedCustomerForCustomerUser(User $user, bool $forceRefresh = false): ?Customer
    {
        if (! $user->hasRole('customer')) {
            return null;
        }

        if (! $forceRefresh && $user->selectedCustomer instanceof Customer && $user->selectedCustomer->is_active) {
            return $user->selectedCustomer;
        }

        $username = mb_strtolower(trim((string) $user->username));
        $customer = Customer::query()
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
                'code',
                'name',
                'contact_name',
                'email',
                'city',
                'district',
                'phone',
                'tax_office',
                'tax_number',
                'credit_limit',
                'is_active',
                'meta',
                'last_synced_at',
            ])
            ->with('salesperson:id,username,name,email,phone,avatar_url,branch_code,branch_name,region_code,region_name')
            ->where('is_active', true)
            ->whereRaw('LOWER(code) = ?', [$username])
            ->first();

        if (! $customer instanceof Customer && $user->selected_customer_id !== null) {
            $customer = Customer::query()
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
                    'code',
                    'name',
                    'contact_name',
                    'email',
                    'city',
                    'district',
                    'phone',
                    'tax_office',
                    'tax_number',
                    'credit_limit',
                    'is_active',
                    'meta',
                    'last_synced_at',
                ])
                ->with('salesperson:id,username,name,email,phone,avatar_url,branch_code,branch_name,region_code,region_name')
                ->whereKey((int) $user->selected_customer_id)
                ->where('is_active', true)
                ->first();
        }

        if ($customer instanceof Customer && (int) $user->selected_customer_id !== (int) $customer->id) {
            $user->forceFill(['selected_customer_id' => $customer->id])->save();
        }

        return $customer;
    }
}
