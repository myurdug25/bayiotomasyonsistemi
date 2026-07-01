<?php

namespace App\Services\Integrations\Logo;

use App\Models\Dealer;
use App\Models\IntegrationSyncState;
use App\Models\Order;
use App\Models\OrderItem;
use App\Services\Integrations\IntegrationSyncStateService;
use Illuminate\Support\Collection;
use Illuminate\Validation\ValidationException;

class LogoOrderExportService
{
    public function __construct(
        private readonly IntegrationSyncStateService $syncState
    ) {}

    /**
     * @param  array<string, mixed>  $filters
     * @return array<string, mixed>
     */
    public function pending(array $filters): array
    {
        $dealer = $this->resolveDealer(
            $filters['dealer_id'] ?? null,
            $filters['dealer_code'] ?? null,
        );

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
            ->where('domain', 'orders')
            ->where('direction', 'outbound')
            ->where('entity_type', Order::class)
            ->whereIn('status', $statuses)
            ->orderBy('id')
            ->limit($limit)
            ->get();

        $orders = Order::query()
            ->with([
                'dealer:id,code,name',
                'customer:id,dealer_id,source_system,source_reference,code,name,city,district,phone,tax_office,tax_number,meta',
                'cart:id,shipping_method,note,order_note',
                'user:id,name',
                'items.product:id,sku,oem_code,name,unit,vat_rate,meta',
            ])
            ->whereIn('id', $states->pluck('entity_id')->map(fn ($id) => (int) $id)->all())
            ->get()
            ->keyBy('id');

        $records = $states
            ->map(function (IntegrationSyncState $state) use ($orders, $dealer): ?array {
                $order = $orders->get((int) $state->entity_id);

                if (! $order instanceof Order) {
                    return null;
                }

                if ($dealer instanceof Dealer && (int) $order->dealer_id !== (int) $dealer->id) {
                    return null;
                }

                return $this->transformOrder($order, $state);
            })
            ->filter()
            ->values();

        return [
            'received' => $records->count(),
            'filters' => [
                'dealer_id' => $dealer?->id,
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
            $order = Order::query()->find((int) $record['order_id']);

            if (! $order instanceof Order) {
                throw ValidationException::withMessages([
                    "records.$index.order_id" => ['Gonderilen siparis kaydi bulunamadi.'],
                ]);
            }

            $status = (string) $record['status'];
            $externalReference = $this->nullableString($record['external_ref'] ?? null);
            $error = $this->nullableString($record['error'] ?? null);

            $this->syncState->record(
                system: 'logo',
                domain: 'orders',
                direction: 'outbound',
                entity: $order,
                externalRef: $externalReference,
                status: $status,
                error: $status === 'failed' ? $error : null,
                meta: [
                    'acknowledged' => true,
                    'export_key' => $order->logoExportKey(),
                    'payload' => is_array($record['meta'] ?? null) ? $record['meta'] : [],
                ],
                payload: $record,
                syncedAt: now(),
            );

            $summary[$status]++;
        }

        return $summary;
    }

    /**
     * @return array<string, mixed>
     */
    private function transformOrder(Order $order, IntegrationSyncState $state): array
    {
        $customer = $order->customer;
        $customerMeta = is_array($customer?->meta) ? $customer->meta : [];

        return [
            'order_id' => $order->id,
            'export_key' => $order->logoExportKey(),
            'dealer_id' => $order->dealer_id,
            'dealer_code' => $order->dealer?->code,
            'customer_id' => $order->customer_id,
            'customer_code' => $customer?->code,
            'customer_external_ref' => $customer?->source_reference,
            'customer_title' => $customer?->name,
            'order_no' => $order->order_no,
            'order_date' => optional($order->ordered_at ?? $order->created_at)?->toDateString(),
            'status' => $order->status,
            'currency' => strtoupper((string) $order->currency),
            'subtotal' => $this->money($order->subtotal),
            'discount_total' => $this->money($order->discount_total),
            'vat_total' => $this->money($order->tax_total),
            'grand_total' => $this->money($order->grand_total),
            'note' => $order->note,
            'shipping_method' => $order->cart?->shipping_method,
            'created_by_user_id' => $order->user_id,
            'created_by_name' => $order->user?->name,
            'sync_status' => $state->status,
            'sync_error' => $state->last_error,
            'items' => $this->transformOrderItems($order->items),
            'customer' => [
                'city' => $customer?->city,
                'district' => $customer?->district,
                'phone' => $customer?->phone,
                'tax_office' => $customer?->tax_office,
                'tax_number' => $customer?->tax_number,
                'address' => data_get($customerMeta, 'address') ?? data_get($customerMeta, 'full_address'),
                'logo' => data_get($customerMeta, 'integrations.logo.payload'),
            ],
            'meta' => [
                'created_at' => optional($order->created_at)?->toIso8601String(),
                'updated_at' => optional($order->updated_at)?->toIso8601String(),
                'logo_external_ref' => $state->external_ref,
                'cart' => [
                    'id' => $order->cart_id,
                    'shipping_method' => $order->cart?->shipping_method,
                    'note' => $order->cart?->note,
                    'order_note' => $order->cart?->order_note,
                ],
                'logo' => [
                    'document_type' => 'order',
                    'target_tables' => ['ORFICHE', 'ORFLINE'],
                ],
            ],
        ];
    }

    /**
     * @param  Collection<int, OrderItem>  $items
     * @return list<array<string, mixed>>
     */
    private function transformOrderItems(Collection $items): array
    {
        return $items
            ->map(function ($item): array {
                $product = $item->product;
                $productMeta = is_array($product?->meta) ? $product->meta : [];
                $logoPayload = data_get($productMeta, 'integrations.logo.payload');

                return [
                    'order_item_id' => $item->id,
                    'product_id' => $item->product_id,
                    'product_code' => $product?->sku,
                    'product_oem_code' => $product?->oem_code,
                    'product_external_ref' => data_get($productMeta, 'integrations.logo.external_ref'),
                    'product_name' => $product?->name,
                    'unit' => $product?->unit,
                    'quantity' => (int) $item->quantity,
                    'shipped_qty' => (int) $item->shipped_qty,
                    'unit_net_price' => $this->money($item->unit_net_price),
                    'discount_rate' => $this->money($item->discount_rate),
                    'vat_rate' => $this->money($item->tax_rate),
                    'line_total' => $this->money($item->line_total),
                    'currency' => strtoupper((string) $item->currency),
                    'campaign_key' => $item->campaign_key,
                    'logo' => [
                        'stock_ref' => data_get($productMeta, 'integrations.logo.external_ref'),
                        'unitset_ref' => data_get($logoPayload, 'unitset_ref') ?? data_get($logoPayload, 'raw.UNITSETREF'),
                        'uom_ref' => data_get($logoPayload, 'logo_price.uomref') ?? data_get($logoPayload, 'raw.UOMREF'),
                        'vat_included' => data_get($logoPayload, 'logo_price.incvat'),
                        'raw' => data_get($logoPayload, 'raw'),
                    ],
                ];
            })
            ->values()
            ->all();
    }

    private function resolveDealer(mixed $dealerId, mixed $dealerCode): ?Dealer
    {
        if ($dealerId !== null && $dealerId !== '') {
            return Dealer::query()->find((int) $dealerId);
        }

        $normalizedDealerCode = $this->nullableString($dealerCode);
        if ($normalizedDealerCode !== null) {
            return Dealer::query()
                ->where('code', $normalizedDealerCode)
                ->first();
        }

        return null;
    }

    private function money(mixed $value): string
    {
        return number_format((float) $value, 2, '.', '');
    }

    private function nullableString(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $value = trim((string) $value);

        return $value === '' ? null : $value;
    }
}
