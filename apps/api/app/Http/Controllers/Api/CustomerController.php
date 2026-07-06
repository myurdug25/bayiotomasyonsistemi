<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Customer\CustomerIndexRequest;
use App\Http\Requests\Customer\StoreCustomerRequest;
use App\Http\Requests\Customer\UpdateCustomerRequest;
use App\Http\Resources\CustomerResource;
use App\Http\Resources\CustomerSelectionResource;
use App\Models\Customer;
use App\Models\LedgerEntry;
use App\Models\User;
use App\Services\Customers\CustomerAccessScopeService;
use App\Services\Integrations\Logo\LogoWritePublisher;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class CustomerController extends Controller
{
    public function index(CustomerIndexRequest $request, CustomerAccessScopeService $customerAccessScope)
    {
        $this->authorize('viewAny', Customer::class);

        $user = $request->user();
        $validated = $request->validated();
        $limit = min((int) ($validated['limit'] ?? $validated['per_page'] ?? 25), 50);
        $search = trim((string) ($validated['q'] ?? $validated['search'] ?? ''));
        $selectionMode = (bool) ($validated['selection_mode'] ?? false);
        $fastMode = (bool) ($validated['fast'] ?? false)
            && ! $request->boolean('has_cart')
            && ! $request->boolean('has_balance_due')
            && ! $request->boolean('has_order_balance');

        $baseQuery = Customer::query()->where('is_active', true);

        $customerAccessScope->applyToCustomerQuery($baseQuery, $user, 'customers', $selectionMode);

        if (! empty($validated['source_system'])) {
            $baseQuery->where('customers.source_system', (string) $validated['source_system']);
        }

        if (! empty($validated['specode4'])) {
            $specode4Values = array_values(
                array_unique([
                    trim((string) $validated['specode4']),
                    strtolower(trim((string) $validated['specode4'])),
                    strtoupper(trim((string) $validated['specode4'])),
                ])
            );

            $baseQuery->where(function ($builder) use ($specode4Values): void {
                $builder
                    ->whereIn('customers.meta->integrations->logo->payload->specode4', $specode4Values)
                    ->orWhereIn('customers.meta->integrations->logo->payload->raw->specode4', $specode4Values)
                    ->orWhereIn('customers.meta->integrations->logo->payload->raw->SPECODE4', $specode4Values);
            });
        }

        if ($search !== '') {
            $baseQuery->where(function ($builder) use ($search) {
                $builder->whereLike('customers.code', "{$search}%", caseSensitive: false)
                    ->orWhereLike('customers.name', "%{$search}%", caseSensitive: false);
            });
        }

        if ($request->has('has_cart')) {
            if ($request->boolean('has_cart')) {
                $baseQuery->whereHas('carts', fn ($q) => $q->where('status', 'draft'));
            } else {
                $baseQuery->whereDoesntHave('carts', fn ($q) => $q->where('status', 'draft'));
            }
        }

        if ($request->has('has_balance_due')) {
            if ($request->boolean('has_balance_due')) {
                $baseQuery->whereIn('customers.id', $this->balanceDueCustomerIdsSubquery(true));
            } else {
                $baseQuery->whereNotIn('customers.id', $this->balanceDueCustomerIdsSubquery(true));
            }
        }

        if ($request->has('has_order_balance')) {
            if ($request->boolean('has_order_balance')) {
                $baseQuery->whereIn('customers.id', $this->balanceDueCustomerIdsSubquery(true, true));
            } else {
                $baseQuery->whereNotIn('customers.id', $this->balanceDueCustomerIdsSubquery(true, true));
            }
        }

        if (($validated['summary'] ?? null) === 'count') {
            return response()->json([
                'data' => [],
                'next_cursor' => null,
                'prev_cursor' => null,
                'limit' => $limit,
                'total_count' => (clone $baseQuery)->count('customers.id'),
            ]);
        }

        $totalCount = $fastMode ? null : (clone $baseQuery)->count('customers.id');

        $query = (clone $baseQuery);

        if ($fastMode) {
            $query
                ->select([
                    'customers.id',
                    'customers.dealer_id',
                    'customers.code',
                    'customers.name',
                    'customers.city',
                    'customers.district',
                    'customers.phone',
                    'customers.region_code',
                    'customers.region_name',
                    'customers.branch_code',
                    'customers.branch_name',
                    'customers.source_system',
                    'customers.source_reference',
                    'customers.meta',
                    'customers.last_synced_at',
                ])
                ->selectSub($this->balanceDueSubquery(), 'total_balance_due')
                ->selectSub($this->orderBalanceDueSubquery(), 'order_balance_due')
                ->withExists([
                    'carts as has_draft_cart' => fn ($q) => $q->where('status', 'draft'),
                ]);
        } else {
            $query
                ->select('customers.*')
                ->selectSub($this->balanceDueSubquery(), 'total_balance_due')
                ->selectSub($this->orderBalanceDueSubquery(), 'order_balance_due')
                ->withExists([
                    'carts as has_draft_cart' => fn ($q) => $q->where('status', 'draft'),
                ]);
        }

        $customers = $query
            ->orderByRaw("CASE WHEN customers.source_system = 'b2b' AND customers.sync_status IS NOT NULL THEN 0 WHEN customers.source_system = 'logo' THEN 1 ELSE 2 END ASC")
            ->orderBy('customers.code')
            ->orderBy('customers.id')
            ->cursorPaginate(
                perPage: $limit,
                columns: ['*'],
                cursorName: 'cursor',
                cursor: $validated['cursor'] ?? null
            );

        return response()->json([
            'data' => collect($customers->items())
                ->map(fn (Customer $customer) => (new CustomerSelectionResource($customer))->toArray($request))
                ->values(),
            'next_cursor' => $customers->nextCursor()?->encode(),
            'prev_cursor' => $customers->previousCursor()?->encode(),
            'limit' => $limit,
            'total_count' => $totalCount,
        ]);
    }

    public function show(Customer $customer)
    {
        $this->authorize('view', $customer);

        return new CustomerResource($customer);
    }

    public function store(StoreCustomerRequest $request, LogoWritePublisher $logoWritePublisher)
    {
        $this->authorize('create', Customer::class);

        $data = $request->validated();
        $user = $request->user();

        if (! $user->hasAnyRole(['admin', 'moderator'])) {
            $data['dealer_id'] = $user->dealer_id;
        }

        $salesperson = $this->validatedSalesperson(
            dealerId: isset($data['dealer_id']) ? (int) $data['dealer_id'] : null,
            salespersonUserId: isset($data['salesperson_user_id']) ? (int) $data['salesperson_user_id'] : null
        );

        $data['source_system'] = 'b2b';
        $data['sync_status'] = 'pending';
        $data['sync_error'] = null;
        $data['salesperson_user_id'] = $salesperson?->id;
        $data = array_merge($data, $this->territoryAttributes($data, $user, $salesperson));

        $customer = DB::transaction(function () use ($data, $logoWritePublisher) {
            $customer = Customer::create($data);
            $logoWritePublisher->queueCustomerCreate($customer);

            return $customer;
        });

        return (new CustomerResource($customer))->response()->setStatusCode(201);
    }

    public function update(UpdateCustomerRequest $request, Customer $customer, LogoWritePublisher $logoWritePublisher)
    {
        $this->authorize('update', $customer);

        $attributes = $request->validated();
        $dealerId = isset($attributes['dealer_id']) ? (int) $attributes['dealer_id'] : (int) $customer->dealer_id;
        $salesperson = array_key_exists('salesperson_user_id', $attributes)
            ? $this->validatedSalesperson(
                dealerId: $dealerId,
                salespersonUserId: $attributes['salesperson_user_id'] !== null
                    ? (int) $attributes['salesperson_user_id']
                    : null
            )
            : $customer->salesperson;

        if ($customer->source_system !== 'logo') {
            $attributes['source_system'] = $customer->source_system ?: 'b2b';
            $attributes['sync_status'] = 'pending';
            $attributes['sync_error'] = null;
        }

        $attributes['salesperson_user_id'] = array_key_exists('salesperson_user_id', $attributes)
            ? $salesperson?->id
            : $customer->salesperson_user_id;
        $attributes = array_merge(
            $attributes,
            $this->territoryAttributes(
                array_merge($customer->only(['region_code', 'region_name', 'branch_code', 'branch_name']), $attributes),
                null,
                $salesperson
            )
        );

        DB::transaction(function () use ($customer, $attributes, $logoWritePublisher): void {
            $customer->fill($attributes)->save();

            if ($customer->source_system !== 'logo') {
                $logoWritePublisher->queueCustomerUpdate($customer);
            }
        });

        return new CustomerResource($customer->fresh());
    }

    public function destroy(Customer $customer): Response
    {
        $this->authorize('delete', $customer);

        $customer->delete();

        return response()->noContent();
    }

    private function balanceDueSubquery()
    {
        return LedgerEntry::query()
            ->effectiveForCustomerBalance()
            ->selectRaw(
                "COALESCE(SUM(COALESCE(debit, CASE WHEN entry_type = 'debit' THEN amount ELSE 0 END) - COALESCE(credit, CASE WHEN entry_type = 'credit' THEN amount ELSE 0 END)), 0)"
            )
            ->whereColumn('ledger_entries.customer_id', 'customers.id');
    }

    private function orderBalanceDueSubquery()
    {
        return LedgerEntry::query()
            ->effectiveForCustomerBalance()
            ->selectRaw(
                "COALESCE(SUM(COALESCE(debit, CASE WHEN entry_type = 'debit' THEN amount ELSE 0 END) - COALESCE(credit, CASE WHEN entry_type = 'credit' THEN amount ELSE 0 END)), 0)"
            )
            ->whereColumn('ledger_entries.customer_id', 'customers.id')
            ->whereNotNull('ledger_entries.order_id');
    }

    private function balanceDueCustomerIdsSubquery(bool $onlyDue = true, bool $orderOnly = false)
    {
        $query = LedgerEntry::query()
            ->effectiveForCustomerBalance()
            ->select('customer_id')
            ->groupBy('customer_id');

        if ($orderOnly) {
            $query->whereNotNull('order_id');
        }

        if ($onlyDue) {
            $query->havingRaw(
                "SUM(COALESCE(debit, CASE WHEN entry_type = 'debit' THEN amount ELSE 0 END) - COALESCE(credit, CASE WHEN entry_type = 'credit' THEN amount ELSE 0 END)) > 0"
            );
        }

        return $query;
    }

    private function validatedSalesperson(?int $dealerId, ?int $salespersonUserId): ?User
    {
        if ($salespersonUserId === null) {
            return null;
        }

        if ($dealerId === null) {
            throw ValidationException::withMessages([
                'salesperson_user_id' => ['Cariye plasiyer atamak için önce dealer_id belirlenmelidir.'],
            ]);
        }

        $salesperson = User::query()
            ->with('roles:id,slug')
            ->whereKey($salespersonUserId)
            ->where('dealer_id', $dealerId)
            ->first();

        if (! $salesperson instanceof User || ! $salesperson->roles->contains('slug', 'salesperson')) {
            throw ValidationException::withMessages([
                'salesperson_user_id' => ['Seçilen plasiyer bu bayi için geçerli değil.'],
            ]);
        }

        return $salesperson;
    }

    /**
     * @param  array<string, mixed>  $attributes
     * @return array<string, string|null>
     */
    private function territoryAttributes(array $attributes, ?User $actor = null, ?User $salesperson = null): array
    {
        $regionCodeSource = array_key_exists('region_code', $attributes)
            ? $attributes['region_code']
            : ($salesperson?->region_code ?? $actor?->region_code ?? null);
        $regionNameSource = array_key_exists('region_name', $attributes)
            ? $attributes['region_name']
            : ($salesperson?->region_name ?? $actor?->region_name ?? null);
        $branchCodeSource = array_key_exists('branch_code', $attributes)
            ? $attributes['branch_code']
            : ($salesperson?->branch_code ?? $actor?->branch_code ?? null);
        $branchNameSource = array_key_exists('branch_name', $attributes)
            ? $attributes['branch_name']
            : ($salesperson?->branch_name ?? $actor?->branch_name ?? null);

        $regionCode = $this->normalizeCode(
            $regionCodeSource
        );
        $regionName = $this->normalizeLabel(
            $regionNameSource
        );
        $branchCode = $this->normalizeCode(
            $branchCodeSource
        );
        $branchName = $this->normalizeLabel(
            $branchNameSource
        );

        return [
            'region_code' => $regionCode,
            'region_name' => $regionName,
            'branch_code' => $branchCode,
            'branch_name' => $branchName,
        ];
    }

    private function normalizeCode(mixed $value): ?string
    {
        $normalized = trim((string) $value);

        if ($normalized === '') {
            return null;
        }

        return mb_strtoupper($normalized);
    }

    private function normalizeLabel(mixed $value): ?string
    {
        $normalized = trim((string) $value);

        return $normalized !== '' ? $normalized : null;
    }
}
