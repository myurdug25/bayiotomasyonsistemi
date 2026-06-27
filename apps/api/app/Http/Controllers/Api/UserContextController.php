<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Context\StoreCustomerContextRequest;
use App\Http\Resources\CustomerSelectionResource;
use App\Models\Customer;
use App\Models\User;
use Illuminate\Http\JsonResponse;

class UserContextController extends Controller
{
    public function show(): JsonResponse
    {
        /** @var User $user */
        $user = auth()->user();
        $user->loadMissing([
            'selectedCustomer:id,dealer_id,salesperson_user_id,region_code,region_name,branch_code,branch_name,source_system,source_reference,code,name,contact_name,email,city,district,phone,tax_office,tax_number,credit_limit,is_active,meta,last_synced_at',
            'selectedCustomer.salesperson:id,name,email,phone,avatar_url',
        ]);

        $customer = $user->selectedCustomer;
        if ($customer && ! $user->can('selectContext', $customer)) {
            $user->forceFill([
                'selected_customer_id' => null,
            ])->save();
            $customer = null;
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
            ->with('salesperson:id,name,email,phone')
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
            'meta' => is_array($customer->meta) ? $customer->meta : null,
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
            'salesperson' => $customer->salesperson ? [
                'id' => $customer->salesperson->id,
                'name' => $customer->salesperson->name,
                'email' => $customer->salesperson->email,
                'phone' => $customer->salesperson->phone,
                'avatar_url' => $customer->salesperson->avatar_url,
            ] : null,
        ];
    }
}
