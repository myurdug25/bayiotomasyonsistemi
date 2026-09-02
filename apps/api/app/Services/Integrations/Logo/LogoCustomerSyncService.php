<?php

namespace App\Services\Integrations\Logo;

use App\Models\Customer;
use App\Models\Dealer;
use App\Models\User;
use App\Services\Integrations\IntegrationSyncStateService;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class LogoCustomerSyncService
{
    public function __construct(
        private readonly IntegrationSyncStateService $syncState
    ) {}

    /**
     * @param  array<string, mixed>  $payload
     * @return array<string, int>
     */
    public function sync(array $payload): array
    {
        $defaultDealer = $this->resolveDealer(
            $payload['dealer_id'] ?? null,
            $payload['dealer_code'] ?? null,
        );

        $summary = [
            'received' => count($payload['records'] ?? []),
            'created' => 0,
            'updated' => 0,
            'skipped' => 0,
            'stale_inactivated' => 0,
        ];

        $syncRunId = $this->nullableString($payload['sync_run_id'] ?? null);
        $sourceTable = $this->nullableString($payload['source_table'] ?? null);

        DB::transaction(function () use ($payload, $defaultDealer, $syncRunId, $sourceTable, &$summary): void {
            foreach ((array) ($payload['records'] ?? []) as $index => $record) {
                $dealer = $this->resolveDealer(
                    $record['dealer_id'] ?? null,
                    $record['dealer_code'] ?? null,
                    $defaultDealer,
                );

                if (! $dealer) {
                    throw ValidationException::withMessages([
                        "records.$index.dealer_id" => ['Cari icin eslesen bayi bulunamadi.'],
                    ]);
                }

                $externalReference = $this->nullableString($record['external_ref'] ?? null);
                $customerCode = $this->nullableString($record['code'] ?? null) ?? (string) $record['code'];
                $customer = $this->findCustomer(
                    $dealer,
                    $customerCode,
                    $externalReference,
                );

                $salespersonUserId = $customer?->salesperson_user_id;
                if (array_key_exists('salesperson_email', $record)) {
                    $salespersonUserId = $this->resolveSalespersonUserId(
                        $dealer,
                        $record['salesperson_email'] ?? null,
                        "records.$index.salesperson_email",
                    );
                } else {
                    $salespersonUserId = $this->resolveSalespersonUserIdFromLogoSpecode(
                        $dealer,
                        $record,
                        $salespersonUserId,
                    );
                }

                $creditLimit = array_key_exists('credit_limit', $record)
                    ? $record['credit_limit']
                    : (
                        Arr::get($record, 'meta.open_account_risk_limit')
                        ?? Arr::get($record, 'meta.risk.open_account_limit')
                        ?? Arr::get($record, 'meta.raw.OPEN_ACCOUNT_RISK_LIMIT')
                        ?? Arr::get($record, 'meta.raw.OPENACCOUNTRISKLIMIT')
                        ?? Arr::get($record, 'meta.raw.RISKLIMIT')
                        ?? Arr::get($record, 'meta.raw.RISKLIMIT1')
                        ?? Arr::get($record, 'meta.raw.RISK_LIMIT')
                        ?? Arr::get($record, 'meta.raw.RISK_LIMIT1')
                        ?? Arr::get($record, 'meta.raw.DBSLIMIT1')
                        ?? Arr::get($record, 'meta.raw.OPENACCRISKLIMIT')
                        ?? ($customer?->credit_limit ?? 0)
                    );

                $attributes = [
                    'dealer_id' => $dealer->id,
                    'salesperson_user_id' => $salespersonUserId,
                    'source_system' => 'logo',
                    'source_reference' => $externalReference ?? $customer?->source_reference,
                    'sync_status' => 'synced',
                    'sync_error' => null,
                    'code' => $customerCode,
                    'name' => $this->resolveCustomerName($record, $customerCode),
                    'contact_name' => $this->stringField($record, 'contact_name', $customer?->contact_name),
                    'email' => $this->stringField($record, 'email', $customer?->email),
                    'phone' => $this->resolvePhoneField($record, $customer?->phone),
                    'city' => $this->resolveLocationField($record, 'city', $customer?->city),
                    'district' => $this->resolveLocationField($record, 'district', $customer?->district),
                    'tax_office' => $this->stringField($record, 'tax_office', $customer?->tax_office),
                    'tax_number' => $this->stringField($record, 'tax_number', $customer?->tax_number),
                    'credit_limit' => $creditLimit,
                    'is_active' => array_key_exists('is_active', $record)
                        ? (bool) $record['is_active']
                        : ($customer?->is_active ?? true),
                    'meta' => $this->buildMeta($customer, $record, $externalReference, $syncRunId, $sourceTable),
                    'last_synced_at' => now(),
                ];

                if ($customer) {
                    $this->releaseSourceReferenceCollision($dealer, $customer, $externalReference);

                    $customer->fill($attributes)->save();
                    $this->syncState->record(
                        system: 'logo',
                        domain: 'customers',
                        direction: 'inbound',
                        entity: $customer,
                        externalRef: $attributes['source_reference'],
                        status: 'synced',
                        meta: [
                            'operation' => 'updated',
                            'sync_run_id' => $syncRunId,
                            'source_table' => $sourceTable,
                        ],
                        payload: $record,
                    );
                    $summary['updated']++;

                    continue;
                }

                $createdCustomer = Customer::query()->create($attributes);
                $this->syncState->record(
                    system: 'logo',
                    domain: 'customers',
                    direction: 'inbound',
                    entity: $createdCustomer,
                    externalRef: $attributes['source_reference'],
                    status: 'synced',
                    meta: [
                        'operation' => 'created',
                        'sync_run_id' => $syncRunId,
                        'source_table' => $sourceTable,
                    ],
                    payload: $record,
                );
                $summary['created']++;
            }
        });

        if ($this->shouldFinalizeFullSync($payload, $syncRunId)) {
            $summary['stale_inactivated'] = $this->inactivateStaleLogoCustomers($syncRunId);
        }

        return $summary;
    }

    /**
     * @param  array<string, mixed>  $record
     */
    private function resolveCustomerName(array $record, string $customerCode): string
    {
        $paths = [
            'meta.raw.DEFINITION_',
            'meta.raw.DEFINITION',
            'meta.raw.DESCRIPTION',
            'meta.raw.DESC_',
            'meta.raw.DESC',
            'meta.DEFINITION_',
            'meta.DEFINITION',
            'meta.description',
            'meta.title',
            'name',
        ];

        $code = trim($customerCode);
        $codeLikeFallback = null;

        foreach ($paths as $path) {
            $candidate = $this->nullableString(Arr::get($record, $path));

            if ($candidate === null) {
                continue;
            }

            if ($code !== '' && $this->sameText($candidate, $code)) {
                $codeLikeFallback ??= $candidate;

                continue;
            }

            return $candidate;
        }

        return $codeLikeFallback ?? $code ?: 'Logo Cari';
    }

    /**
     * @param  array<string, mixed>  $record
     */
    private function resolveLocationField(array $record, string $field, ?string $fallback): ?string
    {
        $paths = $field === 'city'
            ? [
                'city',
                'meta.raw.CITY',
                'meta.raw.IL',
                'meta.raw.PROVINCE',
                'meta.city',
                'meta.province',
            ]
            : [
                'district',
                'meta.raw.TOWN',
                'meta.raw.DISTRICT',
                'meta.raw.ILCE',
                'meta.raw.İLÇE',
                'meta.raw.COUNTY',
                'meta.district',
                'meta.town',
            ];

        foreach ($paths as $path) {
            $candidate = $this->nullableString(Arr::get($record, $path));

            if ($candidate !== null) {
                return $candidate;
            }
        }

        return $fallback;
    }

    private function resolveDealer(
        mixed $dealerId,
        mixed $dealerCode,
        ?Dealer $fallback = null,
    ): ?Dealer {
        if ($dealerId !== null && $dealerId !== '') {
            return Dealer::query()->find((int) $dealerId);
        }

        $normalizedDealerCode = $this->nullableString($dealerCode);
        if ($normalizedDealerCode !== null) {
            return Dealer::query()
                ->where('code', $normalizedDealerCode)
                ->first();
        }

        return $fallback;
    }

    private function findCustomer(
        Dealer $dealer,
        string $code,
        ?string $externalReference,
    ): ?Customer {
        $byCode = Customer::query()
            ->where('dealer_id', $dealer->id)
            ->where('code', $code)
            ->lockForUpdate()
            ->first();

        if ($byCode) {
            return $byCode;
        }

        if ($externalReference !== null) {
            $byExternalReference = Customer::query()
                ->where('dealer_id', $dealer->id)
                ->where('source_system', 'logo')
                ->where('source_reference', $externalReference)
                ->lockForUpdate()
                ->first();

            if ($byExternalReference) {
                return $byExternalReference;
            }

            $byLogoMetadataExternalReference = Customer::query()
                ->where('dealer_id', $dealer->id)
                ->where('meta->integrations->logo->external_ref', $externalReference)
                ->lockForUpdate()
                ->first();

            if ($byLogoMetadataExternalReference) {
                return $byLogoMetadataExternalReference;
            }
        }

        return null;
    }

    private function releaseSourceReferenceCollision(
        Dealer $dealer,
        Customer $customer,
        ?string $externalReference,
    ): void {
        if ($externalReference === null) {
            return;
        }

        Customer::query()
            ->where('dealer_id', $dealer->id)
            ->where('source_system', 'logo')
            ->where('source_reference', $externalReference)
            ->whereKeyNot($customer->getKey())
            ->lockForUpdate()
            ->update([
                'source_system' => 'logo-superseded',
                'sync_status' => 'superseded',
                'sync_error' => 'Superseded during Logo customer source reference remap.',
                'last_synced_at' => now(),
                'updated_at' => now(),
            ]);
    }

    private function resolveSalespersonUserId(
        Dealer $dealer,
        mixed $salespersonEmail,
        string $errorKey,
    ): ?int {
        $normalizedEmail = $this->nullableString($salespersonEmail);

        if ($normalizedEmail === null) {
            return null;
        }

        $salesperson = User::query()
            ->where('dealer_id', $dealer->id)
            ->whereRaw('LOWER(email) = ?', [mb_strtolower($normalizedEmail)])
            ->first();

        if (! $salesperson) {
            throw ValidationException::withMessages([
                $errorKey => ['Gonderilen salesperson_email icin bayi kullanicisi bulunamadi.'],
            ]);
        }

        return (int) $salesperson->id;
    }

    /**
     * @param  array<string, mixed>  $record
     */
    private function resolveSalespersonUserIdFromLogoSpecode(
        Dealer $dealer,
        array $record,
        ?int $fallbackUserId,
    ): ?int {
        $customerSpecodes = array_filter([
            $this->normalizeCode(Arr::get($record, 'meta.specode') ?? Arr::get($record, 'meta.raw.SPECODE')),
            $this->normalizeCode(Arr::get($record, 'meta.specode2') ?? Arr::get($record, 'meta.raw.SPECODE2')),
            $this->normalizeCode(Arr::get($record, 'meta.specode3') ?? Arr::get($record, 'meta.raw.SPECODE3')),
            $this->normalizeCode(Arr::get($record, 'meta.specode4') ?? Arr::get($record, 'meta.raw.SPECODE4')),
            $this->normalizeCode(Arr::get($record, 'meta.specode5') ?? Arr::get($record, 'meta.raw.SPECODE5')),
        ]);

        if (empty($customerSpecodes)) {
            return $fallbackUserId;
        }

        $matches = User::query()
            ->where('dealer_id', $dealer->id)
            ->where('is_active', true)
            ->whereNotNull('logo_customer_specode4')
            ->get(['id', 'logo_customer_specode4'])
            ->filter(fn (User $user): bool => count(array_intersect(
                $customerSpecodes,
                $this->normalizeCodeList($user->logo_customer_specode4)
            )) > 0)
            ->pluck('id')
            ->values();

        if ($matches->count() !== 1) {
            return $fallbackUserId;
        }

        return (int) $matches->first();
    }

    /**
     * @param  array<string, mixed>  $record
     * @return array<string, mixed>
     */
    private function buildMeta(
        ?Customer $customer,
        array $record,
        ?string $externalReference,
        ?string $syncRunId = null,
        ?string $sourceTable = null,
    ): array
    {
        $meta = is_array($customer?->meta) ? $customer->meta : [];

        if (array_key_exists('address', $record)) {
            $meta['address'] = $this->nullableString($record['address'] ?? null);
        }

        if (array_key_exists('iban', $record)) {
            $meta['iban'] = $this->nullableString($record['iban'] ?? null);
        }

        Arr::set($meta, 'integrations.logo.synced_at', now()->toIso8601String());

        if ($externalReference !== null) {
            Arr::set($meta, 'integrations.logo.external_ref', $externalReference);
        }

        if ($syncRunId !== null) {
            Arr::set($meta, 'integrations.logo.sync_run_id', $syncRunId);
        }

        if ($sourceTable !== null) {
            Arr::set($meta, 'integrations.logo.source_table', $sourceTable);
        }

        if (! empty($record['meta']) && is_array($record['meta'])) {
            Arr::set($meta, 'integrations.logo.payload', $record['meta']);
        }

        $eInvoiceUser = $this->resolveLogoEInvoiceUser($record);
        if ($eInvoiceUser !== null) {
            Arr::set($meta, 'integrations.logo.payload.e_invoice_user', $eInvoiceUser);
        }

        $financials = [];

        $netBalance = null;
        if (array_key_exists('balance_due', $record) && is_numeric($record['balance_due'])) {
            $netBalance = (float) $record['balance_due'];
            $financials['total_due'] = number_format($netBalance, 2, '.', '');
            $financials['net_balance'] = number_format($netBalance, 2, '.', '');
        } elseif (array_key_exists('balance', $record) && is_numeric($record['balance'])) {
            $netBalance = (float) $record['balance'];
            $financials['net_balance'] = number_format($netBalance, 2, '.', '');
        }

        if (array_key_exists('order_due', $record) && is_numeric($record['order_due'])) {
            $financials['order_due'] = number_format((float) $record['order_due'], 2, '.', '');
        }

        if (array_key_exists('balance_debit', $record) && is_numeric($record['balance_debit'])) {
            $financials['debit'] = number_format((float) $record['balance_debit'], 2, '.', '');
        }

        if (array_key_exists('balance_credit', $record) && is_numeric($record['balance_credit'])) {
            $financials['credit'] = number_format((float) $record['balance_credit'], 2, '.', '');
        }

        $direction = $this->nullableString($record['balance_direction'] ?? null);
        if ($direction === null && $netBalance !== null) {
            $direction = $netBalance > 0 ? 'debit' : ($netBalance < 0 ? 'credit' : 'zero');
        }
        if ($direction !== null) {
            $financials['direction'] = mb_strtolower($direction, 'UTF-8');
        }

        if (array_key_exists('currency', $record)) {
            $currency = $this->nullableString($record['currency'] ?? null);
            if ($currency !== null) {
                $financials['currency'] = strtoupper($currency);
            }
        }

        if ($financials !== []) {
            $financials['synced_at'] = now()->toIso8601String();
            Arr::set($meta, 'integrations.logo.financials', $financials);
        }

        return $meta;
    }

    /**
     * @param  array<string, mixed>  $record
     */
    private function resolveLogoEInvoiceUser(array $record): ?bool
    {
        $candidates = [
            Arr::get($record, 'e_invoice_user'),
            Arr::get($record, 'e_invoice'),
            Arr::get($record, 'e_fatura'),
            Arr::get($record, 'meta.e_invoice_user'),
            Arr::get($record, 'meta.e_invoice'),
            Arr::get($record, 'meta.e_fatura'),
            Arr::get($record, 'meta.raw.EINVOICE'),
            Arr::get($record, 'meta.raw.EINVOICEUSER'),
            Arr::get($record, 'meta.raw.EINVOICE_USER'),
            Arr::get($record, 'meta.raw.ACCEPTEINV'),
            Arr::get($record, 'meta.raw.EFATURA'),
            Arr::get($record, 'meta.raw.E_FATURA'),
        ];

        foreach ($candidates as $candidate) {
            if ($candidate !== null) {
                return $this->logoFlagToBool($candidate);
            }
        }

        return null;
    }

    private function logoFlagToBool(mixed $value): bool
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
     * @param  array<string, mixed>  $payload
     */
    private function shouldFinalizeFullSync(array $payload, ?string $syncRunId): bool
    {
        if ($syncRunId === null) {
            return false;
        }

        return filter_var($payload['is_full_sync'] ?? false, FILTER_VALIDATE_BOOLEAN)
            && filter_var($payload['is_final_batch'] ?? false, FILTER_VALIDATE_BOOLEAN);
    }

    private function inactivateStaleLogoCustomers(string $syncRunId): int
    {
        $inactivated = 0;

        Customer::query()
            ->where('source_system', 'logo')
            ->where('is_active', true)
            ->select(['id', 'source_reference', 'is_active', 'sync_status', 'meta'])
            ->chunkById(500, function ($customers) use ($syncRunId, &$inactivated): void {
                foreach ($customers as $customer) {
                    if (! $customer instanceof Customer) {
                        continue;
                    }

                    $logoExternalRef = $this->nullableString(data_get($customer->meta, 'integrations.logo.external_ref'))
                        ?? $this->nullableString($customer->source_reference);
                    if ($logoExternalRef === null) {
                        continue;
                    }

                    $customerSyncRunId = $this->nullableString(data_get($customer->meta, 'integrations.logo.sync_run_id'));
                    if ($customerSyncRunId === $syncRunId) {
                        continue;
                    }

                    $customer->forceFill([
                        'is_active' => false,
                        'sync_status' => 'stale',
                        'sync_error' => 'Logo full sync snapshot did not include this customer.',
                        'last_synced_at' => now(),
                    ])->save();

                    $inactivated++;
                }
            });

        return $inactivated;
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

    private function nullableString(mixed $value): ?string
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

    private function normalizeCode(mixed $value): ?string
    {
        $normalized = $this->nullableString($value);

        return $normalized !== null ? mb_strtoupper($normalized) : null;
    }

    private function sameText(string $left, string $right): bool
    {
        return mb_strtoupper(trim($left), 'UTF-8') === mb_strtoupper(trim($right), 'UTF-8');
    }

    /**
     * @param  array<string, mixed>  $record
     */
    private function stringField(array $record, string $key, ?string $fallback): ?string
    {
        if (! array_key_exists($key, $record)) {
            return $fallback;
        }

        return $this->nullableString($record[$key] ?? null);
    }

    /**
     * @param  array<string, mixed>  $record
     */
    private function resolvePhoneField(array $record, ?string $fallback): ?string
    {
        $paths = [
            'phone',
            'phone_1',
            'telephone',
            'mobile_phone',
            'meta.raw.TELNRS1',
            'meta.raw.TELNR1',
            'meta.raw.PHONE',
            'meta.raw.PHONE1',
            'meta.raw.PHONE_1',
            'meta.raw.TELEFON',
            'meta.raw.TELEFON1',
            'meta.raw.GSM',
            'meta.raw.CEPTEL',
            'meta.phone',
            'meta.phone_1',
            'meta.telephone',
            'meta.mobile_phone',
        ];

        foreach ($paths as $path) {
            $candidate = $this->nullableString(Arr::get($record, $path));

            if ($candidate !== null) {
                return $candidate;
            }
        }

        return $fallback;
    }
}
