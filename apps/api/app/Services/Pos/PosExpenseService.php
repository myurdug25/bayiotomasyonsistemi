<?php

namespace App\Services\Pos;

use App\Models\FinanceDefinition;
use App\Models\PosExpense;
use App\Models\PosSession;
use App\Models\User;
use App\Services\Integrations\IntegrationSyncStateService;
use App\Support\MenuPermissions;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class PosExpenseService
{
    private const POINT_CURRENCY = 'TRY';

    private const BATUM_POINT_CURRENCY = 'GEL';

    /**
     * @var array<string, array<string, array{code:string,name:string}>>
     */
    private const SALESPERSON_EXPENSE_ACCOUNT_CODES = [
        'AHMET ARAC' => [
            'maintenance' => ['code' => '760-25-025', 'name' => '34LV0224 FORD CUSTOM BAKIM-YIKAMA-SERVİS'],
            'fuel' => ['code' => '760-25-027', 'name' => '34LV0224 FORD CUSTOM YAKIT GİDERİ'],
            'travel' => ['code' => '760-25-033', 'name' => 'PAZARLAMA YOL GİDERLERİ KARS-ARDAHAN'],
        ],
        'MEHMET AKSOY' => [
            'maintenance' => ['code' => '760-25-016', 'name' => '34KM5868 FORD CUSTOM BAKIM-YIKAMA-SERVİS'],
            'fuel' => ['code' => '760-25-018', 'name' => '34KM5868 FORD CUSTOM YAKIT GİDERİ'],
            'travel' => ['code' => '760-25-034', 'name' => 'PAZARLAMA YOL GİDERLERİ ERZİNCAN-BAYBURT'],
        ],
        'HUSEYIN OZGUNEY' => [
            'maintenance' => ['code' => '760-25-001', 'name' => '25EG927 FORD CUSTOM BAKIM-YIKAMA-SERVİS'],
            'fuel' => ['code' => '760-25-003', 'name' => '25EG927 FORD CUSTOM YAKIT GİDERİ'],
            'travel' => ['code' => '760-25-032', 'name' => 'PAZARLAMA YOL GİDERLERİ AĞRI-IĞDIR'],
        ],
        'ADEM CAN BAKIS' => [
            'maintenance' => ['code' => '760-55-004', 'name' => '34PH4953 FORD CUSTOM BAKIM-YIKAMA-SERVİS'],
            'fuel' => ['code' => '760-55-006', 'name' => '34PH4953 FORD CUSTOM YAKIT GİDERİ'],
            'travel' => ['code' => '760-55-031', 'name' => 'PAZARLAMA YOL GİDERLERİ SAMSUN-ORDU'],
        ],
        'SAMET GURBUZ' => [
            'maintenance' => ['code' => '760-25-013', 'name' => '25DG302 DACIA DOKKER BAKIM-YIKAMA-SERVİS'],
            'fuel' => ['code' => '760-25-015', 'name' => '25DG302 DACIA DOKKER YAKIT GİDERİ'],
            'travel' => ['code' => '760-55-030', 'name' => 'PAZARLAMA YOL GİDERLERİ TOKAT-ÇORUM-AMASYA'],
        ],
        'AHMET CAN TUFEKCI' => [
            'maintenance' => ['code' => '760-61-007', 'name' => '34ND4776 FORD CUSTOM BAKIM-YIKAMA-SERVİS'],
            'fuel' => ['code' => '760-61-009', 'name' => '34ND4776 FORD CUSTOM YAKIT GİDERİ'],
            'travel' => ['code' => '760-61-031', 'name' => 'PAZARLAMA YOL GİDERLERİ GİRESUN-GÜMÜŞHANE'],
        ],
        'EMRE KALAYCI' => [
            'maintenance' => ['code' => '760-61-010', 'name' => '34SA0071 FORD CUSTOM BAKIM-YIKAMA-SERVİS'],
            'fuel' => ['code' => '760-61-012', 'name' => '34SA0071 FORD CUSTOM YAKIT GİDERİ'],
            'travel' => ['code' => '760-61-030', 'name' => 'PAZARLAMA YOL GİDERLERİ RİZE-ARTVİN'],
        ],
    ];

    /**
     * Kullanıcı adları Logo/listelerde bazen farklı yazılmış: Samet Görpüz,
     * Samet Gürbüz, bitişik Ahmetcan, Emra/Emre vb. Hepsi aynı gider
     * eşleşmesine düşmeli.
     *
     * @var array<string, string>
     */
    private const SALESPERSON_NAME_ALIASES = [
        'AHMETARAC' => 'AHMET ARAC',
        'MEHMETAKSOY' => 'MEHMET AKSOY',
        'HUSEYINOZGUNEY' => 'HUSEYIN OZGUNEY',
        'ADEMCANBAKIS' => 'ADEM CAN BAKIS',
        'ADEMCANBAKISI' => 'ADEM CAN BAKIS',
        'SAMETGURBUZ' => 'SAMET GURBUZ',
        'SAMETGURPUZ' => 'SAMET GURBUZ',
        'SAMETGORPUZ' => 'SAMET GURBUZ',
        'SAMETGORBUZ' => 'SAMET GURBUZ',
        'AHMETCANTUFEKCI' => 'AHMET CAN TUFEKCI',
        'EMREKALAYCI' => 'EMRE KALAYCI',
        'EMRAKALAYCI' => 'EMRE KALAYCI',
    ];

    /**
     * Logo kasa kodları. Moderatör ekranında kullanıcıya özel kasa tanımlıysa o
     * değer önceliklidir; bu tablo eksik tanımda güvenli fallback sağlar.
     *
     * @var array<string, array{code:string,name:string}>
     */
    private const USER_CASHBOX_CODES = [
        'AHMET ARAC' => ['code' => '100.01.002', 'name' => 'AHMET ARAÇ KASASI'],
        'MEHMET AKSOY' => ['code' => '100.01.003', 'name' => 'MEHMET KSOY KASASI'],
        'HUSEYIN OZGUNEY' => ['code' => '100.01.001', 'name' => 'ERZURUM MERKEZ KASASI'],
        'FARUK CELIK' => ['code' => '100.01.004', 'name' => 'FARUK ÇELİK KASASI'],
        'GOKHAN CELIK' => ['code' => '100.01.005', 'name' => 'GÖKHAN ÇELİK KASASI'],
        'ERCAN BAYRAM' => ['code' => '100.01.006', 'name' => 'ERCAN BAYRAM KASASI'],
        'ERZURUM POINT' => ['code' => '100.01.007', 'name' => 'ERZURUM POINT KASASI'],
        'TRABZON MERKEZ' => ['code' => '100.02.001', 'name' => 'TRABZON MERKEZ KASASI'],
        'EMRE KALAYCI' => ['code' => '100.02.002', 'name' => 'EMRE KALAYCI KASASI'],
        'AHMET CAN TUFEKCI' => ['code' => '100.02.003', 'name' => 'AHMETCAN TÜFEKÇİ KASASI'],
        'AHMETCAN TUFEKCI' => ['code' => '100.02.003', 'name' => 'AHMETCAN TÜFEKÇİ KASASI'],
        'TRABZON POINT' => ['code' => '100.02.004', 'name' => 'TRABZON POINT KASASI'],
        'TURGAY BUYUKKAL' => ['code' => '100.02.005', 'name' => 'TURGAY BÜYÜKKAL KASASI'],
        'SAMSUN MERKEZ' => ['code' => '100.03.001', 'name' => 'SAMSUN MERKEZ KASASI'],
        'ADEM CAN BAKIS' => ['code' => '100.03.002', 'name' => 'ADEM CANBAKIŞ KASASI'],
        'ADEM CANBAKIS' => ['code' => '100.03.002', 'name' => 'ADEM CANBAKIŞ KASASI'],
        'SAMET GURBUZ' => ['code' => '100.03.003', 'name' => 'PLASİYER SAMSUN KASASI'],
        'SEHIRICI SAMSUN' => ['code' => '100.03.004', 'name' => 'ŞEHİRİÇİ SAMSUN KASASI'],
        'BATUM' => ['code' => '100.04.001', 'name' => 'BATUM MERKEZ KASASI'],
    ];

    /**
     * @var array<string, string>
     */
    private const BATUM_EXPENSE_ACCOUNT_NAMES = [
        '196-00-001' => 'MAAŞ-AVANS NATA',
        '196-00-002' => 'MAAŞ-AVANS GIGA',
        '397-00-001' => 'KASA SAYIM VE TESLİM FAZLALARI BATUM',
        '612-00-001' => 'CARİLERDEN DÜŞÜLEN İSKONTOLAR BATUM',
        '760-00-001' => 'FC-025-FC TOYOTA PRIUS BAKIM-YIKAMA-SERVİS',
        '760-00-003' => 'FC-025-FC TOYOTA PRIUS YAKIT GİDERİ',
        '760-00-005' => 'FC-010-FC PORCHE BAKIM-YIKAMA-SERVİS-CEZA',
        '760-00-006' => 'FC-010-FC PORCHE YAKIT GİDERİ',
        '760-00-004' => 'PAZARLAMA YOL GİDERLERİ BATUM',
        '770-00-001' => 'ELEKTRİK GİDERİ BATUM',
        '770-00-002' => 'SU GİDERİ BATUM',
        '770-00-003' => 'TELEFON GİDERİ BATUM',
        '770-00-004' => 'SSK GİDERİ BATUM',
        '770-00-005' => 'İNTERNET-WINN GİDERİ BATUM',
        '770-00-009' => 'TEMİZLİK GİDERİ BATUM',
        '770-00-012' => 'DOĞALGAZ GİDERİ BATUM',
        '770-00-013' => 'KİRA GİDERİ BATUM',
        '770-00-014' => 'İŞYERİ BAKIM TAMİR GİDERİ BATUM',
        '770-00-018' => 'BANKA MASRAF KESİNTİLERİ',
        '770-00-019' => 'NAKLİYECİ GİDERİ BATUM',
        '770-00-021' => 'MUHASEBECİ GİDERİ BATUM',
        '770-00-024' => 'BATUM GÜMRÜK GİDERLERİ',
    ];

    public function __construct(
        private readonly IntegrationSyncStateService $syncState
    ) {}

    /**
     * @param  array<string, mixed>  $payload
     */
    public function create(User $user, array $payload): PosExpense
    {
        return DB::transaction(function () use ($user, $payload): PosExpense {
            // Plasiyer masrafları kullanıcı-kasa eşleşmesiyle çalışır; tarayıcıda
            // eski bir POS oturumu kalmış olsa bile başka kullanıcının oturum
            // kapsamına sokulup reddedilmemelidir.
            if ($user->hasRole('salesperson')) {
                return $this->createSalespersonExpense($user, $payload);
            }

            $session = PosSession::query()
                ->with(['openedBy', 'cashbox'])
                ->lockForUpdate()
                ->find((int) $payload['pos_session_id']);

            if (! $session instanceof PosSession || $session->status !== 'open') {
                throw ValidationException::withMessages([
                    'pos_session_id' => ['POS session not found or not open.'],
                ]);
            }

            $this->assertCanOperateSession($user, $session);
            $pointCurrency = $this->pointCurrency($session, $user);
            $definition = $this->resolveExpenseDefinition($payload);
            $accountOwner = $session->openedBy ?? $user;
            $mappedSalespersonAccount = $this->mappedSalespersonExpenseAccount($accountOwner, $definition->name, $definition->code);
            $mappedBatumAccount = $this->mappedBatumExpenseAccount($accountOwner, $definition->name, $definition->code, $definition->logo_code);
            $expenseAccountCode = $mappedBatumAccount['code'] ?? $mappedSalespersonAccount['code'] ?? $definition->logo_code;
            $expenseAccountName = $mappedBatumAccount['name'] ?? $mappedSalespersonAccount['name'] ?? $definition->logo_name;
            $logoCashbox = $this->resolveLogoCashboxForUser($accountOwner, $session);

            if (! filled($expenseAccountCode)) {
                throw ValidationException::withMessages([
                    'expense_account' => ['Bu gider kategorisi için Logo gider hesabı tanımlı değil.'],
                ]);
            }

            $expense = PosExpense::query()->create([
                'pos_session_id' => $session->id,
                'dealer_id' => (int) ($session->openedBy?->dealer_id ?? $user->dealer_id),
                'expense_date' => $payload['expense_date'] ?? now()->toDateString(),
                'category' => $definition->name,
                'amount' => number_format((float) $payload['amount'], 2, '.', ''),
                'currency' => $pointCurrency,
                'note' => filled($payload['note'] ?? null) ? trim((string) $payload['note']) : null,
                'created_by_user_id' => $user->id,
                'meta' => array_merge(is_array($payload['meta'] ?? null) ? $payload['meta'] : [], [
                    'scope' => data_get($payload, 'meta.scope'),
                    'finance_definition_id' => $definition->id,
                    'expense_category_code' => $definition->code,
                    'logo_expense_account_code' => $expenseAccountCode,
                    'logo_expense_account_name' => $expenseAccountName,
                    'logo_category_code' => $definition->logo_code,
                    'cashbox_code' => $logoCashbox['code'] ?? $session->cashbox?->code,
                    'cashbox_name' => $logoCashbox['name'] ?? $session->cashbox?->name,
                ]),
            ]);

            $this->queueExpenseForLogoExport($expense);

            return $expense->fresh(['posSession.cashbox', 'createdBy']);
        });
    }

    /**
     * @param  array<string, mixed>  $payload
     */
    private function createSalespersonExpense(User $user, array $payload): PosExpense
    {
        $definition = $this->resolveExpenseDefinition($payload);

        $mappedExpenseAccount = $this->mappedSalespersonExpenseAccount($user, $definition->name, $definition->code);
        $expenseAccountCode = $mappedExpenseAccount['code'] ?? ($definition->logo_code ?: $user->logo_expense_account_code);
        $expenseAccountName = $mappedExpenseAccount['name'] ?? ($definition->logo_name ?: $user->logo_expense_account_name);
        $logoCashbox = $this->resolveLogoCashboxForUser($user);

        if (! filled($expenseAccountCode)) {
            throw ValidationException::withMessages([
                'expense_account' => ['Bu gider kategorisi için Logo gider hesabı tanımlı değil.'],
            ]);
        }

        if (! filled($logoCashbox['code'] ?? null)) {
            throw ValidationException::withMessages([
                'cashbox' => ['Bu plasiyer için Logo kasa kodu tanımlı değil.'],
            ]);
        }

        $expense = PosExpense::query()->create([
            'pos_session_id' => null,
            'dealer_id' => (int) $user->dealer_id,
            'expense_date' => $payload['expense_date'] ?? now()->toDateString(),
            'category' => $definition->name,
            'amount' => number_format((float) $payload['amount'], 2, '.', ''),
            'currency' => self::POINT_CURRENCY,
            'note' => trim(implode(' ', array_filter([
                $user->name,
                $definition->name,
                filled($payload['note'] ?? null) ? trim((string) $payload['note']) : null,
            ]))),
            'created_by_user_id' => $user->id,
            'meta' => array_merge(is_array($payload['meta'] ?? null) ? $payload['meta'] : [], [
                'scope' => 'salesperson',
                'finance_definition_id' => $definition->id,
                'expense_category_code' => $definition->code,
                'logo_expense_account_code' => $expenseAccountCode,
                'logo_expense_account_name' => $expenseAccountName,
                'logo_category_code' => $definition->logo_code,
                'cashbox_code' => $logoCashbox['code'],
                'cashbox_name' => $logoCashbox['name'],
            ]),
        ]);

        $this->queueExpenseForLogoExport($expense);

        return $expense->fresh(['createdBy']);
    }

    /**
     * @param  array<string, mixed>  $payload
     */
    private function resolveExpenseDefinition(array $payload): FinanceDefinition
    {
        $category = trim((string) ($payload['category'] ?? ''));
        $categoryCode = $this->normalizeLegacyPointExpenseCategory($category);

        $definition = FinanceDefinition::query()
            ->where('type', 'expense_category')
            ->where('is_active', true)
            ->where(function (Builder $query) use ($payload, $category, $categoryCode): void {
                if (! empty($payload['finance_definition_id'])) {
                    $query->whereKey((int) $payload['finance_definition_id']);

                    return;
                }

                $query
                    ->where('code', $categoryCode)
                    ->orWhere('name', $category);
            })
            ->first();

        if (! $definition instanceof FinanceDefinition) {
            $logoExpenseAccountCode = $this->nullableExpenseString($payload['logo_expense_account_code'] ?? null);
            $logoExpenseAccountName = $this->nullableExpenseString($payload['logo_expense_account_name'] ?? null) ?? $category;

            if ($logoExpenseAccountCode === null) {
                throw ValidationException::withMessages(['category' => ['Aktif gider kategorisi bulunamadı.']]);
            }

            $definition = FinanceDefinition::query()->updateOrCreate(
                [
                    'type' => 'expense_category',
                    'code' => $this->expenseDefinitionCodeFromLogo($logoExpenseAccountCode),
                ],
                [
                    'name' => $logoExpenseAccountName,
                    'logo_code' => $logoExpenseAccountCode,
                    'logo_name' => $logoExpenseAccountName,
                    'is_active' => true,
                    'sort_order' => 900,
                    'meta' => [
                        'scope' => 'batum',
                        'source' => 'b2b_batum_expense_fallback',
                    ],
                ]
            );
        }

        return $definition;
    }

    private function nullableExpenseString(mixed $value): ?string
    {
        $value = trim((string) $value);

        return $value === '' ? null : $value;
    }

    private function expenseDefinitionCodeFromLogo(string $logoCode): string
    {
        $normalized = mb_strtolower(trim($logoCode), 'UTF-8');
        $normalized = preg_replace('/[^a-z0-9]+/i', '_', $normalized) ?? $normalized;
        $normalized = trim($normalized, '_');

        return 'batum_'.$normalized;
    }

    private function normalizeLegacyPointExpenseCategory(string $category): string
    {
        $normalized = mb_strtoupper(trim($category), 'UTF-8');

        return $normalized === 'MASRAF' ? 'marketing' : $category;
    }

    /**
     * @return array{code:string,name:string}|null
     */
    private function mappedSalespersonExpenseAccount(User $user, string $categoryName, ?string $categoryCode): ?array
    {
        $salespersonKeys = $this->normalizedUserSignals($user);
        $categoryKey = $this->salespersonExpenseCategoryKey($categoryName, $categoryCode);

        if ($salespersonKeys === [] || $categoryKey === null) {
            return null;
        }

        $canonicalName = $this->canonicalSalespersonName($salespersonKeys);

        if ($canonicalName !== null) {
            return self::SALESPERSON_EXPENSE_ACCOUNT_CODES[$canonicalName][$categoryKey] ?? null;
        }

        foreach (self::SALESPERSON_EXPENSE_ACCOUNT_CODES as $name => $accounts) {
            if ($this->normalizedSignalsMatch($salespersonKeys, $name)) {
                return $accounts[$categoryKey] ?? null;
            }
        }

        return null;
    }

    /**
     * @return array{code:string,name:string}|null
     */
    private function mappedBatumExpenseAccount(User $user, string $categoryName, ?string $categoryCode, ?string $logoCode): ?array
    {
        if (! $this->isBatumUser($user)) {
            return null;
        }

        $haystack = $this->normalizeSalespersonExpenseText(implode(' ', array_filter([
            $categoryName,
            $categoryCode,
            $logoCode,
        ])));

        foreach (self::BATUM_EXPENSE_ACCOUNT_NAMES as $code => $name) {
            $normalizedCode = $this->normalizeSalespersonExpenseText($code);
            $normalizedName = $this->normalizeSalespersonExpenseText($name);

            if (
                $haystack === $normalizedCode
                || $haystack === $normalizedName
                || str_contains($haystack, $normalizedCode)
                || str_contains($haystack, $normalizedName)
                || str_contains($normalizedName, $haystack)
            ) {
                return ['code' => $code, 'name' => $name];
            }
        }

        return null;
    }

    /**
     * @return array{code:?string,name:?string}
     */
    private function resolveLogoCashboxForUser(User $user, ?PosSession $session = null): array
    {
        $configuredCode = $this->nullableExpenseString($user->logo_cashbox_code);
        $configuredName = $this->nullableExpenseString($user->logo_cashbox_name);

        if ($this->isBatumUser($user)) {
            $normalizedConfiguredName = $this->normalizeSalespersonExpenseText($configuredName);
            $configuredLooksLikeBatum = $normalizedConfiguredName !== ''
                && str_contains($normalizedConfiguredName, 'BATUM');

            if ($configuredCode === null
                || str_starts_with($configuredCode, 'POINT-')
                || $configuredCode === '100.01.002'
                || ! $configuredLooksLikeBatum
            ) {
                return self::USER_CASHBOX_CODES['BATUM'];
            }
        }

        if ($configuredCode !== null) {
            return [
                'code' => $configuredCode,
                'name' => $configuredName,
            ];
        }

        $signals = $this->normalizedUserSignals($user);

        $canonicalName = $this->canonicalSalespersonName($signals);

        if ($canonicalName !== null && isset(self::USER_CASHBOX_CODES[$canonicalName])) {
            return self::USER_CASHBOX_CODES[$canonicalName];
        }

        foreach (self::USER_CASHBOX_CODES as $name => $cashbox) {
            if ($name === 'BATUM') {
                continue;
            }

            if ($this->normalizedSignalsMatch($signals, $name)) {
                return $cashbox;
            }
        }

        $sessionCode = $this->nullableExpenseString($session?->cashbox?->code);
        $sessionName = $this->nullableExpenseString($session?->cashbox?->name);

        return [
            'code' => $sessionCode,
            'name' => $sessionName,
        ];
    }

    private function isBatumUser(User $user): bool
    {
        $signals = [
            $user->branch_code,
            $user->region_code,
            $user->username,
            $user->name,
            $user->email,
        ];

        foreach ($signals as $signal) {
            if (str_contains($this->normalizeSalespersonExpenseText($signal), 'BATUM')) {
                return true;
            }
        }

        return false;
    }

    /**
     * @param  list<string>  $signals
     */
    private function canonicalSalespersonName(array $signals): ?string
    {
        foreach ($signals as $signal) {
            $compactSignal = str_replace(' ', '', $this->normalizeSalespersonExpenseText($signal));

            foreach (self::SALESPERSON_NAME_ALIASES as $alias => $canonicalName) {
                if ($compactSignal === $alias || str_contains($compactSignal, $alias) || str_contains($alias, $compactSignal)) {
                    return $canonicalName;
                }
            }
        }

        return null;
    }

    private function salespersonExpenseCategoryKey(string $categoryName, ?string $categoryCode): ?string
    {
        $value = $this->normalizeSalespersonExpenseText(trim($categoryName.' '.(string) $categoryCode));

        return match (true) {
            str_contains($value, 'YAKIT'), str_contains($value, 'FUEL') => 'fuel',
            str_contains($value, 'BAKIM'), str_contains($value, 'YIKAMA'), str_contains($value, 'SERVIS'), str_contains($value, 'SERVISI'), str_contains($value, 'MAINTENANCE'), str_contains($value, 'VEHICLE MAINTENANCE') => 'maintenance',
            str_contains($value, 'YOL'), str_contains($value, 'PAZARLAMA'), str_contains($value, 'SEYAHAT'), str_contains($value, 'TRAVEL') => 'travel',
            default => null,
        };
    }

    /**
     * @return list<string>
     */
    private function normalizedUserSignals(User $user): array
    {
        $rawSignals = [
            $user->name,
            $user->username,
            $user->email,
            trim(implode(' ', array_filter([
                $user->name,
                $user->username,
                $user->email,
            ]))),
        ];

        $signals = [];

        foreach ($rawSignals as $signal) {
            $normalized = $this->normalizeSalespersonExpenseText($signal);

            if ($normalized !== '') {
                $signals[] = $normalized;
                $signals[] = str_replace(' ', '', $normalized);
                $signals[] = str_replace('  ', ' ', $normalized);
            }
        }

        return array_values(array_unique(array_filter($signals)));
    }

    /**
     * @param  list<string>  $signals
     */
    private function normalizedSignalsMatch(array $signals, string $target): bool
    {
        $normalizedTarget = $this->normalizeSalespersonExpenseText($target);
        $compactTarget = str_replace(' ', '', $normalizedTarget);

        foreach ($signals as $signal) {
            $compactSignal = str_replace(' ', '', $signal);

            if (
                $signal === $normalizedTarget
                || $compactSignal === $compactTarget
                || str_contains($signal, $normalizedTarget)
                || str_contains($compactSignal, $compactTarget)
            ) {
                return true;
            }
        }

        return false;
    }

    private function normalizeSalespersonExpenseText(?string $value): string
    {
        $normalized = mb_strtoupper(trim((string) $value), 'UTF-8');
        $map = [
            'Ç' => 'C',
            'Ğ' => 'G',
            'İ' => 'I',
            'İ' => 'I',
            'Ö' => 'O',
            'Ş' => 'S',
            'Ü' => 'U',
            'ç' => 'C',
            'ğ' => 'G',
            'ı' => 'I',
            'i' => 'I',
            'ö' => 'O',
            'ş' => 'S',
            'ü' => 'U',
        ];
        $normalized = strtr($normalized, $map);
        $normalized = preg_replace('/[^A-Z0-9]+/', ' ', $normalized) ?? $normalized;

        return trim(preg_replace('/\s+/', ' ', $normalized) ?? $normalized);
    }

    /**
     * @param  Builder<PosExpense>  $query
     * @param  array<string, mixed>  $filters
     * @return Builder<PosExpense>
     */
    public function applyFilters(Builder $query, User $user, array $filters): Builder
    {
        if (! $user->hasRole('admin')) {
            $query
                ->where('dealer_id', $user->dealer_id)
                ->where('created_by_user_id', $user->id);
        }

        if (! empty($filters['pos_session_id'])) {
            $query->where('pos_session_id', (int) $filters['pos_session_id']);
        }

        if (! empty($filters['cashbox_id'])) {
            $query->whereHas('posSession', fn (Builder $q) => $q->where('cashbox_id', (int) $filters['cashbox_id']));
        }

        if (! empty($filters['date'])) {
            $query->whereDate('expense_date', (string) $filters['date']);
        } else {
            if (! empty($filters['date_from'])) {
                $query->whereDate('expense_date', '>=', (string) $filters['date_from']);
            }

            if (! empty($filters['date_to'])) {
                $query->whereDate('expense_date', '<=', (string) $filters['date_to']);
            }
        }

        return $query;
    }

    private function assertCanOperateSession(User $user, PosSession $session): void
    {
        if ($user->hasRole('admin')) {
            return;
        }

        $sessionDealerId = $session->openedBy?->dealer_id;
        if ($sessionDealerId === null || (int) $sessionDealerId !== (int) $user->dealer_id) {
            throw ValidationException::withMessages([
                'pos_session_id' => ['Session is not accessible in your dealer scope.'],
            ]);
        }

        if ($this->usesUserScopedCashbox($user) && (int) $session->opened_by !== (int) $user->id) {
            throw ValidationException::withMessages([
                'pos_session_id' => ['Cashier can only operate own session.'],
            ]);
        }
    }

    private function usesUserScopedCashbox(User $user): bool
    {
        if ($user->hasRole('dealer_admin') || $user->hasRole('admin')) {
            return false;
        }

        return $user->hasAnyRole(['cashier', 'point'])
            || in_array('pos', MenuPermissions::forUser($user), true);
    }

    private function pointCurrency(PosSession $session, User $user): string
    {
        $session->loadMissing('cashbox', 'openedBy');

        $batumSignals = [
            $user->branch_code,
            $user->region_code,
            $session->openedBy?->branch_code,
            $session->openedBy?->region_code,
            $session->cashbox?->code,
            $session->cashbox?->name,
        ];

        foreach ($batumSignals as $value) {
            if ($this->isBatumPointSignal($value)) {
                return self::BATUM_POINT_CURRENCY;
            }
        }

        return self::POINT_CURRENCY;
    }

    private function isBatumPointSignal(mixed $value): bool
    {
        $normalized = $this->normalizePointCurrencySignal($value);
        $batumCashboxCode = $this->normalizePointCurrencySignal(config('integrations.pos.batum_point_cashbox_code'));

        return str_contains($normalized, 'BATUM')
            || ($batumCashboxCode !== '' && $normalized === $batumCashboxCode);
    }

    private function normalizePointCurrencySignal(mixed $value): string
    {
        return mb_strtoupper(trim((string) $value), 'UTF-8');
    }

    private function queueExpenseForLogoExport(PosExpense $expense): void
    {
        $this->syncState->record(
            system: 'logo',
            domain: 'pos-expenses',
            direction: 'outbound',
            entity: $expense,
            externalRef: null,
            status: 'queued',
            error: null,
            meta: [
                'export_key' => 'B2B-POSEXP-'.$expense->id,
                'category' => $expense->category,
                'pos_session_id' => $expense->pos_session_id,
            ],
            payload: [
                'pos_expense_id' => $expense->id,
                'category' => $expense->category,
                'amount' => number_format((float) $expense->amount, 2, '.', ''),
                'currency' => $expense->currency,
            ],
        );
    }
}
