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

                $attributes = [
                    'name' => $record['name'],
                    'logo_code' => $record['logo_code'] ?? $record['code'],
                    'logo_name' => $record['name'],
                    'is_active' => (bool) ($record['is_active'] ?? true),
                    'meta' => $meta,
                ];
                if (in_array($record['type'], ['bank', 'pos_device', 'card_type'], true)) {
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
