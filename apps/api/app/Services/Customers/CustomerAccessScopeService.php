<?php

namespace App\Services\Customers;

use App\Models\Customer;
use App\Models\User;
use Closure;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\DB;

class CustomerAccessScopeService
{
    public function hasUnrestrictedCustomerAccess(User $user): bool
    {
        return ! $this->shouldRestrictCustomerAccess($user);
    }

    public function applyToCustomerQuery(
        Builder $query,
        User $user,
        string $table = 'customers',
        bool $selectionMode = false
    ): Builder {
        if (! $this->shouldRestrictCustomerAccess($user)) {
            return $query;
        }

        if ($this->hasRestrictedAdministrativeCustomerAccess($user)) {
            $this->applyLogoCustomerFilters($query, $user, $table);
            $this->excludeBatumCustomers($query, $user, $table);

            return $query;
        }

        if ($user->dealer_id === null) {
            return $query->whereRaw('1 = 0');
        }

        $query->where("{$table}.dealer_id", (int) $user->dealer_id);
        $this->applyLogoCustomerFilters($query, $user, $table);
        $this->excludeBatumCustomers($query, $user, $table);

        if ($this->hasLogoCustomerFilter($user) && ! $this->shouldCombineLogoFilterWithBranchScope($user)) {
            return $query;
        }

        $selectedCustomerId = $this->shouldUseStrictBranchCustomerList($user) ? null : $this->selectedCustomerId($user);

        return match ($user->effectiveCustomerScope()) {
            'assigned' => $this->applyScopedVisibility(
                $query,
                $table,
                $selectedCustomerId,
                fn (Builder $builder) => $builder->where("{$table}.salesperson_user_id", (int) $user->id),
            ),
            'region' => $this->applyScopedVisibility(
                $query,
                $table,
                $selectedCustomerId,
                fn (Builder $builder) => $this->applyRegionScope($builder, $table, $user->region_code),
            ),
            'branch' => $this->applyScopedVisibility(
                $query,
                $table,
                $selectedCustomerId,
                fn (Builder $builder) => $this->applyBranchScope($builder, $table, $user),
            ),
            default => $query,
        };
    }

    public function applyToCustomerOwnedQuery($query, User $user, string $customerIdColumn = 'customer_id')
    {
        if (! $this->shouldRestrictCustomerAccess($user)) {
            return $query;
        }

        return $query->whereIn($customerIdColumn, $this->accessibleCustomerIdsQuery($user));
    }

    public function accessibleCustomerIdsQuery(User $user): Builder
    {
        return $this->applyToCustomerQuery(
            Customer::query()->select('customers.id'),
            $user
        );
    }

    public function canAccessCustomer(User $user, Customer $customer): bool
    {
        if (! $this->shouldRestrictCustomerAccess($user)) {
            return true;
        }

        if ($this->hasRestrictedAdministrativeCustomerAccess($user)) {
            return $this->matchesLogoCustomerFilters($user, $customer)
                && (! $this->shouldExcludeBatumCustomers($user) || ! $this->isLogoBatumCustomer($customer));
        }

        if ($user->dealer_id === null || (int) $user->dealer_id !== (int) $customer->dealer_id) {
            return false;
        }

        if (! $this->matchesLogoCustomerFilters($user, $customer)) {
            return false;
        }

        if ($this->shouldExcludeBatumCustomers($user) && $this->isLogoBatumCustomer($customer)) {
            return false;
        }

        if ($user->hasRole('salesperson') && $this->hasLogoCustomerFilter($user)) {
            return true;
        }

        if ($this->selectedCustomerId($user) === (int) $customer->id) {
            return true;
        }

        return match ($user->effectiveCustomerScope()) {
            'assigned' => (int) $customer->salesperson_user_id === (int) $user->id,
            'region' => $this->sameCode($user->region_code, $customer->region_code),
            'branch' => $this->sameCode($user->branch_code, $customer->branch_code)
                || $this->canAccessLogoBatumCustomer($user, $customer)
                || $this->canAccessUnassignedLogoCustomer($user, $customer),
            default => true,
        };
    }

    public function canSelectCustomer(User $user, Customer $customer): bool
    {
        if (! $this->shouldRestrictCustomerAccess($user)) {
            return true;
        }

        if ($this->hasRestrictedAdministrativeCustomerAccess($user)) {
            return $this->matchesLogoCustomerFilters($user, $customer)
                && (! $this->shouldExcludeBatumCustomers($user) || ! $this->isLogoBatumCustomer($customer));
        }

        if ($user->dealer_id === null || (int) $user->dealer_id !== (int) $customer->dealer_id) {
            return false;
        }

        if ($user->hasRole('salesperson')) {
            return $this->matchesLogoCustomerFilters($user, $customer);
        }

        return $this->canAccessCustomer($user, $customer);
    }

    private function applyScopedVisibility(
        Builder $query,
        string $table,
        ?int $selectedCustomerId,
        Closure $scope
    ): Builder {
        return $query->where(function (Builder $builder) use ($scope, $table, $selectedCustomerId): void {
            $scope($builder);

            if ($selectedCustomerId !== null) {
                $builder->orWhere("{$table}.id", $selectedCustomerId);
            }
        });
    }

    private function applyRegionScope(Builder $query, string $table, ?string $regionCode): Builder
    {
        $normalized = $this->normalizeCode($regionCode);

        if ($normalized === null) {
            return $query->whereRaw('1 = 0');
        }

        return $query->where("{$table}.region_code", $normalized);
    }

    private function applyBranchScope(Builder $query, string $table, User $user): Builder
    {
        $normalized = $this->normalizeCode($user->branch_code);

        if ($normalized === null) {
            return $query->whereRaw('1 = 0');
        }

        return $query->where(function (Builder $builder) use ($table, $normalized, $user): void {
            $builder->where("{$table}.branch_code", $normalized);

            if ($this->usesLogoBatumBranchScope($user)) {
                $builder->orWhere(fn (Builder $logoBuilder) => $this->applyLogoBatumScope($logoBuilder, $table));
            } elseif ($this->canPointUseUnassignedLogoCustomers($user)) {
                $builder->orWhere(fn (Builder $logoBuilder) => $this->applyLogoBranchLocationScope($logoBuilder, $table, $normalized));
            }
        });
    }

    private function applyLogoBranchLocationScope(Builder $query, string $table, string $branchCode): Builder
    {
        $values = $this->caseVariants([$branchCode]);
        $cyphValues = $this->caseVariants([$branchCode, "120-{$branchCode}"]);

        return $query
            ->where("{$table}.source_system", 'logo')
            ->where(function (Builder $branchBuilder) use ($table): void {
                $branchBuilder
                    ->whereNull("{$table}.branch_code")
                    ->orWhere("{$table}.branch_code", '');
            })
            ->where(function (Builder $locationBuilder) use ($table, $values, $cyphValues): void {
                $locationBuilder
                    ->whereIn("{$table}.city", $values)
                    ->orWhereIn("{$table}.district", $values)
                    ->orWhereIn("{$table}.region_code", $values)
                    ->orWhereIn("{$table}.region_name", $values)
                    ->orWhereIn("{$table}.meta->integrations->logo->payload->cyphcode", $cyphValues)
                    ->orWhereIn("{$table}.meta->integrations->logo->payload->raw->CYPHCODE", $cyphValues)
                    ->orWhereIn("{$table}.meta->integrations->logo->payload->city", $values)
                    ->orWhereIn("{$table}.meta->integrations->logo->payload->province", $values)
                    ->orWhereIn("{$table}.meta->integrations->logo->payload->raw->CITY", $values)
                    ->orWhereIn("{$table}.meta->integrations->logo->payload->raw->IL", $values)
                    ->orWhereIn("{$table}.meta->integrations->logo->payload->raw->PROVINCE", $values);
            });
    }

    private function excludeBatumCustomers(Builder $query, User $user, string $table): Builder
    {
        if (! $this->shouldExcludeBatumCustomers($user)) {
            return $query;
        }

        return $query->whereNot(fn (Builder $builder) => $this->applyBatumCustomerScope($builder, $table));
    }

    private function applyLogoBatumScope(Builder $query, string $table): Builder
    {
        return $query
            ->where("{$table}.source_system", 'logo')
            ->where(function (Builder $builder) use ($table): void {
                $builder
                    ->whereIn("{$table}.meta->integrations->logo->payload->cyphcode", $this->caseVariants(['120-BATUM']))
                    ->orWhereIn("{$table}.meta->integrations->logo->payload->raw->CYPHCODE", $this->caseVariants(['120-BATUM']))
                    ->orWhereIn("{$table}.meta->integrations->logo->payload->town", $this->caseVariants(['BATUMI']))
                    ->orWhereIn("{$table}.meta->integrations->logo->payload->raw->TOWN", $this->caseVariants(['BATUMI']))
                    ->orWhereIn("{$table}.meta->integrations->logo->payload->raw->CITY", $this->caseVariants(['BATUMI']))
                    ->orWhereIn("{$table}.meta->integrations->logo->payload->raw->TAXOFFICE", $this->caseVariants(['BATUM']))
                    ->orWhereIn("{$table}.meta->integrations->logo->payload->raw->INCHARGE", $this->caseVariants(['BATUM']));
            });
    }

    private function applyBatumCustomerScope(Builder $query, string $table): Builder
    {
        $batumValues = $this->caseVariants(['BATUM', 'BATUMI']);
        $batumCypValues = $this->caseVariants(['120-BATUM']);

        if (DB::connection($query->getModel()->getConnectionName())->getDriverName() === 'mysql') {
            return $query
                ->where(function (Builder $builder) use ($table, $batumValues, $batumCypValues): void {
                    $this->whereCoalescedIn($builder, "{$table}.city", $batumValues);
                    $this->orWhereCoalescedIn($builder, "{$table}.district", $batumValues);
                    $this->orWhereCoalescedIn($builder, "{$table}.region_code", $batumValues);
                    $this->orWhereCoalescedIn($builder, "{$table}.region_name", $batumValues);
                    $this->orWhereCoalescedIn($builder, "{$table}.branch_code", $batumValues);
                    $this->orWhereMysqlJsonTextIn($builder, $table, '$.integrations.logo.payload.cyphcode', $batumCypValues);
                    $this->orWhereMysqlJsonTextIn($builder, $table, '$.integrations.logo.payload.raw.CYPHCODE', $batumCypValues);
                    $this->orWhereMysqlJsonTextIn($builder, $table, '$.integrations.logo.payload.town', $batumValues);
                    $this->orWhereMysqlJsonTextIn($builder, $table, '$.integrations.logo.payload.raw.TOWN', $batumValues);
                    $this->orWhereMysqlJsonTextIn($builder, $table, '$.integrations.logo.payload.raw.CITY', $batumValues);
                    $this->orWhereMysqlJsonTextIn($builder, $table, '$.integrations.logo.payload.raw.TAXOFFICE', $batumValues);
                    $this->orWhereMysqlJsonTextIn($builder, $table, '$.integrations.logo.payload.raw.INCHARGE', $batumValues);
                });
        }

        return $query
            ->where(function (Builder $builder) use ($table, $batumValues, $batumCypValues): void {
                $builder
                    ->whereIn("{$table}.city", $batumValues)
                    ->orWhereIn("{$table}.district", $batumValues)
                    ->orWhereIn("{$table}.region_code", $batumValues)
                    ->orWhereIn("{$table}.region_name", $batumValues)
                    ->orWhereIn("{$table}.branch_code", $batumValues)
                    ->orWhereIn("{$table}.meta->integrations->logo->payload->cyphcode", $batumCypValues)
                    ->orWhereIn("{$table}.meta->integrations->logo->payload->raw->CYPHCODE", $batumCypValues)
                    ->orWhereIn("{$table}.meta->integrations->logo->payload->town", $batumValues)
                    ->orWhereIn("{$table}.meta->integrations->logo->payload->raw->TOWN", $batumValues)
                    ->orWhereIn("{$table}.meta->integrations->logo->payload->raw->CITY", $batumValues)
                    ->orWhereIn("{$table}.meta->integrations->logo->payload->raw->TAXOFFICE", $batumValues)
                    ->orWhereIn("{$table}.meta->integrations->logo->payload->raw->INCHARGE", $batumValues);
            });
    }

    /**
     * @param  list<string>  $values
     */
    private function whereCoalescedIn(Builder $query, string $column, array $values): Builder
    {
        return $query->whereIn(DB::raw("COALESCE({$column}, '')"), $values);
    }

    /**
     * @param  list<string>  $values
     */
    private function orWhereCoalescedIn(Builder $query, string $column, array $values): Builder
    {
        return $query->orWhereIn(DB::raw("COALESCE({$column}, '')"), $values);
    }

    /**
     * @param  list<string>  $values
     */
    private function orWhereMysqlJsonTextIn(Builder $query, string $table, string $path, array $values): Builder
    {
        return $query->orWhereIn(
            DB::raw("COALESCE(JSON_UNQUOTE(JSON_EXTRACT({$table}.meta, '{$path}')), '')"),
            $values
        );
    }

    private function applyLogoCustomerFilters(Builder $query, User $user, string $table): Builder
    {
        $logoSpecode4Values = $this->normalizeCodeList($user->logo_customer_specode4);

        if ($logoSpecode4Values === []) {
            return $query;
        }

        $queryValues = $this->caseVariants($logoSpecode4Values);

        return $query->where(function (Builder $builder) use ($table, $queryValues, $user): void {
            $builder
                ->where(function (Builder $b2bBuilder) use ($table, $user): void {
                    $b2bBuilder->where("{$table}.source_system", '!=', 'logo');

                    if ($user->hasRole('salesperson')) {
                        $b2bBuilder->where("{$table}.salesperson_user_id", (int) $user->id);
                    }
                })
                ->orWhere(function (Builder $logoBuilder) use ($table, $queryValues): void {
                    $this->whereLogoSpecode4In($logoBuilder, $table, $queryValues);
                })
                ->orWhere(function (Builder $assignedLogoBuilder) use ($table, $user): void {
                    $assignedLogoBuilder
                        ->where("{$table}.source_system", 'logo')
                        ->where("{$table}.salesperson_user_id", (int) $user->id);
                });
        });
    }

    /**
     * @param  list<string>  $queryValues
     */
    private function whereLogoSpecode4In(Builder $query, string $table, array $queryValues): Builder
    {
        if (DB::connection($query->getModel()->getConnectionName())->getDriverName() === 'mysql') {
            return $query->where(function ($q) use ($table, $queryValues) {
                $q->whereIn(DB::raw("JSON_UNQUOTE(JSON_EXTRACT({$table}.meta, '$.integrations.logo.payload.specode'))"), $queryValues)
                    ->orWhereIn(DB::raw("JSON_UNQUOTE(JSON_EXTRACT({$table}.meta, '$.integrations.logo.payload.raw.SPECODE'))"), $queryValues)
                    ->orWhereIn(DB::raw("JSON_UNQUOTE(JSON_EXTRACT({$table}.meta, '$.integrations.logo.payload.specode2'))"), $queryValues)
                    ->orWhereIn(DB::raw("JSON_UNQUOTE(JSON_EXTRACT({$table}.meta, '$.integrations.logo.payload.raw.SPECODE2'))"), $queryValues)
                    ->orWhereIn(DB::raw("JSON_UNQUOTE(JSON_EXTRACT({$table}.meta, '$.integrations.logo.payload.specode3'))"), $queryValues)
                    ->orWhereIn(DB::raw("JSON_UNQUOTE(JSON_EXTRACT({$table}.meta, '$.integrations.logo.payload.raw.SPECODE3'))"), $queryValues)
                    ->orWhereIn(DB::raw("JSON_UNQUOTE(JSON_EXTRACT({$table}.meta, '$.integrations.logo.payload.specode4'))"), $queryValues)
                    ->orWhereIn(DB::raw("JSON_UNQUOTE(JSON_EXTRACT({$table}.meta, '$.integrations.logo.payload.raw.SPECODE4'))"), $queryValues)
                    ->orWhereIn(DB::raw("JSON_UNQUOTE(JSON_EXTRACT({$table}.meta, '$.integrations.logo.payload.specode5'))"), $queryValues)
                    ->orWhereIn(DB::raw("JSON_UNQUOTE(JSON_EXTRACT({$table}.meta, '$.integrations.logo.payload.raw.SPECODE5'))"), $queryValues);
            });
        }

        return $query->where(function ($q) use ($table, $queryValues) {
            $q->whereIn("{$table}.meta->integrations->logo->payload->specode", $queryValues)
                ->orWhereIn("{$table}.meta->integrations->logo->payload->raw->SPECODE", $queryValues)
                ->orWhereIn("{$table}.meta->integrations->logo->payload->specode2", $queryValues)
                ->orWhereIn("{$table}.meta->integrations->logo->payload->raw->SPECODE2", $queryValues)
                ->orWhereIn("{$table}.meta->integrations->logo->payload->specode3", $queryValues)
                ->orWhereIn("{$table}.meta->integrations->logo->payload->raw->SPECODE3", $queryValues)
                ->orWhereIn("{$table}.meta->integrations->logo->payload->specode4", $queryValues)
                ->orWhereIn("{$table}.meta->integrations->logo->payload->raw->SPECODE4", $queryValues)
                ->orWhereIn("{$table}.meta->integrations->logo->payload->specode5", $queryValues)
                ->orWhereIn("{$table}.meta->integrations->logo->payload->raw->SPECODE5", $queryValues);
        });
    }

    private function matchesLogoCustomerFilters(User $user, Customer $customer): bool
    {
        $logoSpecode4Values = $this->normalizeCodeList($user->logo_customer_specode4);

        if ($logoSpecode4Values === []) {
            return true;
        }

        if ($user->hasRole('salesperson') && (int) $customer->salesperson_user_id === (int) $user->id) {
            return true;
        }

        if ($customer->source_system !== 'logo') {
            return ! $user->hasRole('salesperson');
        }

        $meta = is_array($customer->meta) ? $customer->meta : [];
        $customerSpecodes = array_filter([
            $this->normalizeCode(Arr::get($meta, 'integrations.logo.payload.specode') ?? Arr::get($meta, 'integrations.logo.payload.raw.SPECODE')),
            $this->normalizeCode(Arr::get($meta, 'integrations.logo.payload.specode2') ?? Arr::get($meta, 'integrations.logo.payload.raw.SPECODE2')),
            $this->normalizeCode(Arr::get($meta, 'integrations.logo.payload.specode3') ?? Arr::get($meta, 'integrations.logo.payload.raw.SPECODE3')),
            $this->normalizeCode(Arr::get($meta, 'integrations.logo.payload.specode4') ?? Arr::get($meta, 'integrations.logo.payload.raw.SPECODE4')),
            $this->normalizeCode(Arr::get($meta, 'integrations.logo.payload.specode5') ?? Arr::get($meta, 'integrations.logo.payload.raw.SPECODE5')),
        ]);

        return ! empty(array_intersect($customerSpecodes, $logoSpecode4Values));
    }

    private function hasLogoCustomerFilter(User $user): bool
    {
        return $this->normalizeCodeList($user->logo_customer_specode4) !== [];
    }

    private function canAccessUnassignedLogoCustomer(User $user, Customer $customer): bool
    {
        if ($this->usesLogoBatumBranchScope($user)) {
            return false;
        }

        return $this->canPointUseUnassignedLogoCustomers($user)
            && $customer->source_system === 'logo'
            && $this->normalizeCode($customer->branch_code) === null
            && $this->isLogoCustomerInUserBranch($user, $customer);
    }

    private function canAccessLogoBatumCustomer(User $user, Customer $customer): bool
    {
        return $this->usesLogoBatumBranchScope($user)
            && $this->isLogoBatumCustomer($customer);
    }

    private function usesLogoBatumBranchScope(User $user): bool
    {
        return $this->normalizeCode($user->branch_code) === 'BATUM';
    }

    private function isLogoBatumCustomer(Customer $customer): bool
    {
        foreach ([
            $customer->code,
            $customer->branch_code,
            $customer->region_code,
            $customer->city,
            $customer->district,
            $customer->name,
        ] as $value) {
            $normalized = $this->normalizeCode($value);

            if ($normalized === 'BATUM' || $normalized === 'BATUMI' || str_contains((string) $normalized, 'BATUM')) {
                return true;
            }
        }

        $meta = is_array($customer->meta) ? $customer->meta : [];
        $payload = Arr::get($meta, 'integrations.logo.payload', []);

        if (! is_array($payload)) {
            return false;
        }

        $cyphcode = $this->normalizeCode(
            Arr::get($payload, 'cyphcode')
            ?? Arr::get($payload, 'raw.CYPHCODE')
        );

        if ($cyphcode === '120-BATUM') {
            return true;
        }

        foreach ([
            Arr::get($payload, 'town'),
            Arr::get($payload, 'raw.TOWN'),
            Arr::get($payload, 'raw.CITY'),
        ] as $value) {
            if ($this->normalizeCode($value) === 'BATUMI') {
                return true;
            }
        }

        foreach ([
            Arr::get($payload, 'raw.TAXOFFICE'),
            Arr::get($payload, 'raw.INCHARGE'),
        ] as $value) {
            if ($this->normalizeCode($value) === 'BATUM') {
                return true;
            }
        }

        return false;
    }

    private function canPointUseUnassignedLogoCustomers(User $user): bool
    {
        return $user->hasAnyRole(['point', 'cashier']);
    }

    private function hasBatumExcludedCustomerScope(User $user): bool
    {
        return in_array($this->normalizeCode($user->username), ['MUDUR.ERZURUM', 'ERZ.DEPO'], true);
    }

    private function shouldExcludeBatumCustomers(User $user): bool
    {
        return $this->hasBatumExcludedCustomerScope($user);
    }

    private function hasRestrictedAdministrativeCustomerAccess(User $user): bool
    {
        return $user->hasAnyRole(['admin', 'moderator'])
            && $this->shouldRestrictCustomerAccess($user);
    }

    private function shouldRestrictCustomerAccess(User $user): bool
    {
        if (! $user->hasAnyRole(['admin', 'moderator'])) {
            return true;
        }

        return $this->hasLogoCustomerFilter($user) || $this->shouldExcludeBatumCustomers($user);
    }

    private function shouldCombineLogoFilterWithBranchScope(User $user): bool
    {
        return $user->hasAnyRole(['point', 'cashier'])
            && $user->effectiveCustomerScope() === 'branch'
            && $this->normalizeCode($user->branch_code) !== null;
    }

    private function shouldUseStrictBranchCustomerList(User $user): bool
    {
        return $this->shouldCombineLogoFilterWithBranchScope($user);
    }

    private function isLogoCustomerInUserBranch(User $user, Customer $customer): bool
    {
        $branchCode = $this->normalizeCode($user->branch_code);

        if ($branchCode === null) {
            return false;
        }

        foreach ([
            $customer->city,
            $customer->district,
            $customer->region_code,
            $customer->region_name,
        ] as $value) {
            if ($this->normalizeCode($value) === $branchCode) {
                return true;
            }
        }

        $meta = is_array($customer->meta) ? $customer->meta : [];
        $payload = Arr::get($meta, 'integrations.logo.payload', []);

        if (! is_array($payload)) {
            return false;
        }

        $cyphcode = $this->normalizeCode(
            Arr::get($payload, 'cyphcode')
            ?? Arr::get($payload, 'raw.CYPHCODE')
        );

        if ($cyphcode === $branchCode || $cyphcode === "120-{$branchCode}") {
            return true;
        }

        foreach ([
            Arr::get($payload, 'city'),
            Arr::get($payload, 'province'),
            Arr::get($payload, 'raw.CITY'),
            Arr::get($payload, 'raw.IL'),
            Arr::get($payload, 'raw.PROVINCE'),
        ] as $value) {
            if ($this->normalizeCode($value) === $branchCode) {
                return true;
            }
        }

        return false;
    }

    private function sameCode(?string $left, ?string $right): bool
    {
        $normalizedLeft = $this->normalizeCode($left);
        $normalizedRight = $this->normalizeCode($right);

        return $normalizedLeft !== null && $normalizedLeft === $normalizedRight;
    }

    private function normalizeCode(?string $value): ?string
    {
        $normalized = trim((string) $value);

        if ($normalized === '') {
            return null;
        }

        return mb_strtoupper($normalized);
    }

    /**
     * @return list<string>
     */
    private function normalizeCodeList(?string $value): array
    {
        $normalized = [];

        foreach (preg_split('/[,;|]+/', (string) $value) ?: [] as $entry) {
            $code = $this->normalizeCode($entry);

            if ($code !== null && ! in_array($code, $normalized, true)) {
                $normalized[] = $code;
            }
        }

        return $normalized;
    }

    /**
     * @param  list<string>  $values
     * @return list<string>
     */
    private function caseVariants(array $values): array
    {
        $variants = [];

        foreach ($values as $value) {
            foreach ([$value, strtolower($value)] as $variant) {
                if (! in_array($variant, $variants, true)) {
                    $variants[] = $variant;
                }
            }
        }

        return $variants;
    }

    private function selectedCustomerId(User $user): ?int
    {
        if (! is_numeric($user->selected_customer_id)) {
            return null;
        }

        $selectedCustomerId = (int) $user->selected_customer_id;

        return $selectedCustomerId > 0 ? $selectedCustomerId : null;
    }
}
