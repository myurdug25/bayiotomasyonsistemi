<?php

namespace App\Http\Resources;

use App\Models\Customer;
use App\Models\User;
use App\Services\Users\UserPermissionService;
use App\Support\Pricing\CustomerPriceListResolver;
use App\Support\Pricing\DisplayCurrency;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class CustomerSelectionResource extends JsonResource
{
    /**
     * Transform the resource into an array.
     *
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        $meta = is_array($this->meta) ? $this->meta : [];
        $title = $this->resolveDisplayTitle($meta);
        $phone = $this->resolveDisplayPhone($meta);
        $city = $this->resolveDisplayLocation($meta, 'city');
        $district = $this->resolveDisplayLocation($meta, 'district');
        $user = $request->user();
        [$totalDue, $orderDue, $currency, $balanceSource] = $this->resolveBalanceSummary(
            $user instanceof User ? $user : null
        );

        return [
            'id' => $this->id,
            'dealer_id' => $this->dealer_id !== null ? (int) $this->dealer_id : null,
            'code' => $this->code,
            'title' => $title,
            'city' => $city,
            'district' => $district,
            'phone' => $phone,
            'region_code' => $this->region_code,
            'region_name' => $this->region_name,
            'branch_code' => $this->branch_code,
            'branch_name' => $this->branch_name,
            'source_system' => $this->source_system,
            'source_reference' => $this->source_reference,
            'price_group' => app(CustomerPriceListResolver::class)->resolveGroupCode($meta),
            'e_invoice_user' => $this->isLogoEInvoiceUser($meta),
            'last_synced_at' => $this->last_synced_at,
            'balance_summary' => [
                'total_due' => number_format($totalDue, 2, '.', ''),
                'order_due' => number_format($orderDue, 2, '.', ''),
                'currency' => $currency,
            ],
            'balance_source' => $balanceSource,
            'has_cart' => (bool) ($this->has_draft_cart ?? false),
            'customer_user_feature_permissions' => $request->is('api/context') || $request->is('api/context/customer')
                ? $this->customerUserFeaturePermissions($this->resource)
                : null,
        ];
    }

    /**
     * @param  array<string, mixed>  $meta
     */
    private function resolveDisplayTitle(array $meta): string
    {
        $current = $this->nullableLogoText($this->name) ?? '';
        $code = $this->nullableLogoText($this->code) ?? '';

        if ($current !== '' && ! $this->sameText($current, $code)) {
            return $current;
        }

        foreach ($this->logoTitlePaths() as $path) {
            $candidate = $this->nullableLogoText(data_get($meta, $path));

            if ($candidate !== null && ! $this->sameText($candidate, $code)) {
                return $candidate;
            }
        }

        return $current !== '' ? $current : $code;
    }

    /**
     * @return array<int, string>
     */
    private function logoTitlePaths(): array
    {
        return [
            'integrations.logo.payload.raw.DEFINITION_',
            'integrations.logo.payload.raw.DEFINITION',
            'integrations.logo.payload.raw.DESCRIPTION',
            'integrations.logo.payload.raw.DESC_',
            'integrations.logo.payload.raw.DESC',
            'integrations.logo.payload.raw.ACIKLAMA',
            'integrations.logo.payload.DEFINITION_',
            'integrations.logo.payload.DEFINITION',
            'integrations.logo.payload.description',
            'integrations.logo.payload.title',
        ];
    }

    private function sameText(string $left, string $right): bool
    {
        return mb_strtoupper(trim($left), 'UTF-8') === mb_strtoupper(trim($right), 'UTF-8');
    }

    private function nullableLogoText(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $normalized = trim((string) $value);

        if ($normalized === '') {
            return null;
        }

        return in_array(mb_strtoupper($normalized, 'UTF-8'), ['NULL', 'NIL', 'N/A', 'YOK', '-'], true)
            ? null
            : $normalized;
    }

    /**
     * @param  array<string, mixed>  $meta
     */
    private function isLogoEInvoiceUser(array $meta): bool
    {
        foreach ($this->logoEInvoiceUserPaths() as $path) {
            $value = data_get($meta, $path);

            if ($value !== null && $this->truthyLogoFlag($value)) {
                return true;
            }
        }

        return false;
    }

    /**
     * @return list<string>
     */
    private function logoEInvoiceUserPaths(): array
    {
        return [
            'integrations.logo.payload.e_invoice_user',
            'integrations.logo.payload.e_invoice',
            'integrations.logo.payload.e_fatura',
            'integrations.logo.payload.raw.EINVOICE',
            'integrations.logo.payload.raw.EINVOICEUSER',
            'integrations.logo.payload.raw.EINVOICE_USER',
            'integrations.logo.payload.raw.ACCEPTEINV',
            'integrations.logo.payload.raw.EFATURA',
            'integrations.logo.payload.raw.E_FATURA',
        ];
    }

    private function truthyLogoFlag(mixed $value): bool
    {
        if (is_bool($value)) {
            return $value;
        }

        if (is_int($value) || is_float($value)) {
            return (float) $value !== 0.0;
        }

        $normalized = trim((string) $value);
        if ($normalized === '') {
            return false;
        }

        return in_array(mb_strtoupper($normalized, 'UTF-8'), [
            '1',
            'TRUE',
            'YES',
            'EVET',
            'E',
            'ON',
            'AKTIF',
            'AKTİF',
        ], true);
    }

    /**
     * @param  array<string, mixed>  $meta
     */
    private function resolveDisplayPhone(array $meta): ?string
    {
        $current = $this->nullableLogoText($this->phone) ?? '';

        if ($current !== '') {
            return $current;
        }

        foreach ($this->logoPhonePaths() as $path) {
            $candidate = $this->nullableLogoText(data_get($meta, $path));

            if ($candidate !== null) {
                return $candidate;
            }
        }

        return null;
    }

    /**
     * @return array<int, string>
     */
    private function logoPhonePaths(): array
    {
        return [
            'integrations.logo.payload.raw.TELNRS1',
            'integrations.logo.payload.raw.TELNR1',
            'integrations.logo.payload.raw.PHONE',
            'integrations.logo.payload.raw.PHONE1',
            'integrations.logo.payload.raw.PHONE_1',
            'integrations.logo.payload.raw.TELEFON',
            'integrations.logo.payload.raw.TELEFON1',
            'integrations.logo.payload.raw.GSM',
            'integrations.logo.payload.raw.CEPTEL',
            'integrations.logo.payload.phone',
            'integrations.logo.payload.phone_1',
            'integrations.logo.payload.telephone',
            'integrations.logo.payload.mobile_phone',
        ];
    }

    /**
     * @param  array<string, mixed>  $meta
     */
    private function resolveDisplayLocation(array $meta, string $field): ?string
    {
        $current = $this->nullableLogoText($field === 'city' ? $this->city : $this->district) ?? '';

        if ($current !== '') {
            return $current;
        }

        foreach ($this->logoLocationPaths($field) as $path) {
            $candidate = $this->nullableLogoText(data_get($meta, $path));

            if ($candidate !== null) {
                return $candidate;
            }
        }

        return null;
    }

    /**
     * @return array<int, string>
     */
    private function logoLocationPaths(string $field): array
    {
        if ($field === 'city') {
            return [
                'integrations.logo.payload.raw.CITY',
                'integrations.logo.payload.raw.IL',
                'integrations.logo.payload.raw.PROVINCE',
                'integrations.logo.payload.city',
                'integrations.logo.payload.province',
            ];
        }

        return [
            'integrations.logo.payload.raw.TOWN',
            'integrations.logo.payload.raw.DISTRICT',
            'integrations.logo.payload.raw.ILCE',
            'integrations.logo.payload.raw.İLÇE',
            'integrations.logo.payload.raw.COUNTY',
            'integrations.logo.payload.district',
            'integrations.logo.payload.town',
        ];
    }

    /**
     * @return array{0: float, 1: float, 2: string, 3: string}
     */
    private function resolveBalanceSummary(?User $user): array
    {
        $meta = is_array($this->meta) ? $this->meta : [];
        $logoFinancials = data_get($meta, 'integrations.logo.financials', []);

        $ledgerTotal = isset($this->total_balance_due) ? (float) $this->total_balance_due : null;
        $ledgerOrder = isset($this->order_balance_due) ? (float) $this->order_balance_due : null;
        $logoTotal = is_numeric($logoFinancials['total_due'] ?? null) ? (float) $logoFinancials['total_due'] : null;
        $logoOrder = is_numeric($logoFinancials['order_due'] ?? null) ? (float) $logoFinancials['order_due'] : null;
        $logoCurrency = strtoupper((string) ($logoFinancials['currency'] ?? 'TRY'));

        $hasInternalBalances = abs((float) ($ledgerTotal ?? 0)) > 0.00001 || abs((float) ($ledgerOrder ?? 0)) > 0.00001;
        $canFallbackToLogo = $this->source_system === 'logo' && ! $hasInternalBalances && ($logoTotal !== null || $logoOrder !== null);

        if ($canFallbackToLogo) {
            return [
                (float) ($logoTotal ?? 0),
                (float) ($logoOrder ?? 0),
                $this->displayBalanceCurrency($logoCurrency !== '' ? $logoCurrency : 'TRY', $user),
                'logo',
            ];
        }

        return [
            (float) ($ledgerTotal ?? 0),
            (float) ($ledgerOrder ?? 0),
            $this->displayBalanceCurrency('TRY', $user),
            'b2b',
        ];
    }

    private function displayBalanceCurrency(string $currency, ?User $user): string
    {
        if ($this->usesLariCustomerDisplay($user)) {
            return 'GEL';
        }

        return DisplayCurrency::normalize($currency, $user);
    }

    private function usesLariCustomerDisplay(?User $user): bool
    {
        if (! $user instanceof User) {
            return false;
        }

        if ($this->normalizeUserCode($user->username) === 'TURGAY.BUYUKKAL') {
            return false;
        }

        return $this->normalizeUserCode($user->branch_code) === 'BATUM'
            || $this->normalizeUserCode($user->region_code) === 'BATUM';
    }

    private function normalizeUserCode(?string $value): ?string
    {
        $normalized = trim((string) $value);

        return $normalized !== '' ? mb_strtoupper($normalized, 'UTF-8') : null;
    }

    /**
     * Seçili cari için /customer-users ekranında tanımlanan özellikleri taşır.
     *
     * @return list<string>|null
     */
    private function customerUserFeaturePermissions(mixed $resource): ?array
    {
        if (! $resource instanceof Customer) {
            return null;
        }

        $username = $this->usernameFromCustomerCode($resource->code);
        $customerUser = User::query()
            ->select(['id', 'selected_customer_id', 'username', 'feature_permissions', 'permissions_updated_at'])
            ->whereHas('roles', fn (Builder $query) => $query->where('slug', 'customer'))
            ->where(function (Builder $query) use ($resource, $username): void {
                $query->where('selected_customer_id', $resource->id);

                if ($username !== '') {
                    $query->orWhereRaw('LOWER(username) = ?', [$username]);
                }
            })
            ->orderByRaw('CASE WHEN selected_customer_id = ? THEN 0 ELSE 1 END', [$resource->id])
            ->first();

        return $customerUser instanceof User
            ? app(UserPermissionService::class)->featurePermissions($customerUser)
            : null;
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
