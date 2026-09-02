<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Integration\ListLogoFinanceDefinitionsRequest;
use App\Http\Requests\Integration\SyncLogoFinanceDefinitionsRequest;
use App\Models\FinanceDefinition;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;

class LogoFinanceDefinitionSyncController extends Controller
{
    /**
     * @var array<string, string>
     */
    private array $approvedFactoryNames = [
        '120-61-006' => 'SIRAÇ MADENİ YAĞLAR PAZ. TİC. LTD. ŞTİ.',
        '320-54-002' => 'DİNAMİK OTOMOTİV GID.TEKS.İTH.İHR.SANAYİ VE TİC.LTD.ŞTİ',
        '320-34-006' => 'DELTA OTO AKSAMI SAN.TİC.A.Ş',
        '320-34-008' => 'ŞAMPİYON FİLTRE PAZ.TİC.VE SAN.A.Ş.',
        '320-34-010' => 'ŞAMPİYON FİLTRE PROTESTO HESABI',
        '320-34-026' => 'ATILGAN OTOMOTİV SANAYİ SERVİS HİZ.İÇ VE DIŞ TİC.A.Ş',
        '320-34-020' => 'ÖZAŞ OTOMOTİV SAN. VE TİC. LTD. ŞTİ.',
        '320-34-001' => 'WUNDER FİLTRE ANONİM ŞİRKETİ',
        '320-25-005' => 'YAĞSAN İNŞAAT MAĞDENİ YAĞLAR A.Ş.',
        '320-35-004' => 'GARANTİ FİLTRE SANAYİ VE TİCARET ANONİM ŞİRKETİ(FİLTRECİM)',
        '320-34-014' => 'BAYER OTOMOTİV SANAYİ VE TİCARET A.Ş',
    ];

    public function pending(ListLogoFinanceDefinitionsRequest $request): JsonResponse
    {
        $records = FinanceDefinition::query()
            ->where('type', 'factory')
            ->where('is_active', true)
            ->orderBy('sort_order')
            ->orderBy('id')
            ->get(['type', 'code', 'logo_code'])
            ->map(fn (FinanceDefinition $definition): array => [
                'type' => $definition->type,
                'code' => $definition->code,
                'logo_code' => $definition->logo_code ?: $definition->code,
            ])
            ->values();

        return response()->json([
            'received' => $records->count(),
            'records' => $records,
        ]);
    }

    public function sync(SyncLogoFinanceDefinitionsRequest $request): JsonResponse
    {
        $validated = $request->validated();
        $records = $validated['records'] ?? [];
        $summary = [
            'received' => count($records),
            'created' => 0,
            'updated' => 0,
            'skipped' => 0,
            'deactivated' => 0,
        ];

        DB::transaction(function () use ($records, $validated, &$summary): void {
            foreach ($records as $record) {
                $definition = FinanceDefinition::query()
                    ->where('type', $record['type'])
                    ->where(function ($query) use ($record): void {
                        $query
                            ->where('code', $record['code'])
                            ->orWhere('logo_code', $record['logo_code'] ?? $record['code']);
                    })
                    ->lockForUpdate()
                    ->first();

                if (! $definition instanceof FinanceDefinition) {
                    if ($record['type'] === 'factory') {
                        $summary['skipped']++;

                        continue;
                    }

                    $definition = new FinanceDefinition([
                        'type' => $record['type'],
                        'code' => $record['code'],
                        'sort_order' => 0,
                    ]);
                    $summary['created']++;
                }

                $meta = is_array($definition->meta) ? $definition->meta : [];
                data_set($meta, 'integrations.logo.source_table', $record['source_table'] ?? null);
                data_set($meta, 'integrations.logo.synced_at', now()->toIso8601String());
                data_set($meta, 'integrations.logo.payload', $record['meta'] ?? []);

                $financials = [];
                foreach ([
                    'balance' => 'balance',
                    'balance_debit' => 'debit',
                    'balance_credit' => 'credit',
                ] as $recordKey => $metaKey) {
                    if (array_key_exists($recordKey, $record) && is_numeric($record[$recordKey])) {
                        $financials[$metaKey] = number_format((float) $record[$recordKey], 2, '.', '');
                    }
                }

                if (! empty($record['balance_direction'])) {
                    $financials['direction'] = mb_strtolower(trim((string) $record['balance_direction']), 'UTF-8');
                } elseif (isset($financials['balance'])) {
                    $balance = (float) $financials['balance'];
                    $financials['direction'] = $balance > 0 ? 'debit' : ($balance < 0 ? 'credit' : 'zero');
                }

                if (! empty($record['currency'])) {
                    $financials['currency'] = mb_strtoupper(trim((string) $record['currency']), 'UTF-8');
                }

                if ($financials !== []) {
                    $financials['synced_at'] = now()->toIso8601String();
                    data_set($meta, 'integrations.logo.financials', $financials);
                }

                $name = $record['name'];
                if ($record['type'] === 'factory') {
                    $name = $this->approvedFactoryNames[$record['code']]
                        ?? $this->approvedFactoryNames[$record['logo_code'] ?? '']
                        ?? $name;
                }

                $attributes = [
                    'name' => $name,
                    'logo_code' => $record['logo_code'] ?? $record['code'],
                    'logo_name' => $name,
                    'is_active' => (bool) ($record['is_active'] ?? true),
                    'meta' => $meta,
                ];
                if (in_array($record['type'], ['bank', 'cashbox', 'pos_device', 'card_type'], true)) {
                    $attributes['code'] = $record['code'];
                }

                $definition->forceFill($attributes)->save();
                $summary['updated']++;
            }

            foreach (array_unique($validated['full_snapshot_types'] ?? []) as $type) {
                $activeCodes = collect($records)
                    ->where('type', $type)
                    ->flatMap(fn (array $record): array => [
                        $record['code'],
                        $record['logo_code'] ?? null,
                    ])
                    ->filter()
                    ->unique()
                    ->values()
                    ->all();

                $query = FinanceDefinition::query()
                    ->where('type', $type)
                    ->where('is_active', true);

                if ($activeCodes !== []) {
                    $query
                        ->whereNotIn('code', $activeCodes)
                        ->where(function ($definitionQuery) use ($activeCodes): void {
                            $definitionQuery
                                ->whereNull('logo_code')
                                ->orWhereNotIn('logo_code', $activeCodes);
                        });
                }

                $summary['deactivated'] += $query->update(['is_active' => false]);
            }
        });

        return response()->json($summary);
    }
}
