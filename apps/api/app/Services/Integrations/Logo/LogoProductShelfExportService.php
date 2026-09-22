<?php

namespace App\Services\Integrations\Logo;

use App\Models\IntegrationSyncState;
use App\Models\Product;
use App\Services\Integrations\IntegrationSyncStateService;
use Illuminate\Validation\ValidationException;

class LogoProductShelfExportService
{
    public function __construct(private readonly IntegrationSyncStateService $syncState) {}

    /**
     * @param  array<string, mixed>  $filters
     * @return array<string, mixed>
     */
    public function pending(array $filters): array
    {
        $statuses = collect((array) ($filters['statuses'] ?? ['queued', 'failed']))
            ->filter(fn ($status) => in_array($status, ['queued', 'failed'], true))
            ->values()
            ->all();

        if ($statuses === []) {
            $statuses = ['queued', 'failed'];
        }

        $limit = min((int) ($filters['limit'] ?? 100), 500);

        $states = IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', 'product-shelves')
            ->where('direction', 'outbound')
            ->where('entity_type', Product::class)
            ->whereIn('status', $statuses)
            ->orderBy('id')
            ->limit($limit)
            ->get();

        $products = Product::query()
            ->whereIn('id', $states->pluck('entity_id')->map(fn ($id) => (int) $id)->all())
            ->get()
            ->keyBy('id');

        $records = $states
            ->map(function (IntegrationSyncState $state) use ($products): ?array {
                $product = $products->get((int) $state->entity_id);

                if (! $product instanceof Product) {
                    return null;
                }

                $meta = is_array($state->meta) ? $state->meta : [];

                return [
                    'product_id' => (int) $product->id,
                    'export_key' => (string) ($meta['export_key'] ?? "B2B-PRODUCT-SHELF-{$product->id}"),
                    'product_code' => (string) ($meta['product_code'] ?? $product->sku),
                    'product_external_ref' => $meta['product_external_ref'] ?? null,
                    'warehouse_code' => (string) ($meta['warehouse_code'] ?? ''),
                    'warehouse_name' => $meta['warehouse_name'] ?? null,
                    'shelf_address' => $meta['shelf_address'] ?? null,
                    'oem_code' => $meta['oem_code'] ?? $product->oem_code,
                    'oem_codes' => array_values(array_filter((array) ($meta['oem_codes'] ?? []), fn ($code): bool => $this->nullableString($code) !== null)),
                    'competitor_codes' => array_values(array_filter((array) ($meta['competitor_codes'] ?? []), fn ($code): bool => $this->nullableString($code) !== null)),
                    'requested_at' => $meta['requested_at'] ?? $state->updated_at?->toIso8601String(),
                ];
            })
            ->filter()
            ->values();

        return [
            'received' => $records->count(),
            'filters' => [
                'statuses' => $statuses,
                'limit' => $limit,
            ],
            'records' => $records->all(),
        ];
    }

    /**
     * @param  array<string, mixed>  $payload
     * @return array<string, int>
     */
    public function acknowledge(array $payload): array
    {
        $summary = [
            'received' => count($payload['records'] ?? []),
            'synced' => 0,
            'failed' => 0,
            'skipped' => 0,
        ];

        foreach ((array) ($payload['records'] ?? []) as $index => $record) {
            $product = Product::query()->find((int) ($record['product_id'] ?? 0));

            if (! $product instanceof Product) {
                throw ValidationException::withMessages([
                    "records.$index.product_id" => ['Gonderilen urun kaydi bulunamadi.'],
                ]);
            }

            $status = (string) ($record['status'] ?? '');
            if (! in_array($status, ['synced', 'failed', 'skipped'], true)) {
                throw ValidationException::withMessages([
                    "records.$index.status" => ['Gecersiz senkron durumu.'],
                ]);
            }

            $this->syncState->record(
                system: 'logo',
                domain: 'product-shelves',
                direction: 'outbound',
                entity: $product,
                externalRef: $this->nullableString($record['external_ref'] ?? null),
                status: $status,
                error: $status === 'failed' ? $this->nullableString($record['error'] ?? null) : null,
                meta: [
                    'acknowledged_at' => now()->toIso8601String(),
                    'warehouse_code' => $record['warehouse_code'] ?? null,
                    'shelf_address' => $record['shelf_address'] ?? null,
                ],
                payload: $record,
                syncedAt: $status === 'synced' ? now() : null,
            );

            if (isset($summary[$status])) {
                $summary[$status]++;
            }
        }

        return $summary;
    }

    private function nullableString(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $string = trim((string) $value);

        return $string === '' ? null : $string;
    }
}
