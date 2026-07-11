<?php

namespace App\Services\Warehouse;

use App\Models\IntegrationSyncState;
use App\Models\Order;
use App\Models\OrderItem;
use App\Models\OrderStatusHistory;
use App\Models\Product;
use App\Models\Shipment;
use App\Models\ShipmentItem;
use App\Models\ShipmentScan;
use App\Models\StockMovement;
use App\Models\StockSummary;
use App\Models\User;
use App\Models\Warehouse;
use App\Services\Integrations\IntegrationSyncStateService;
use App\Services\Integrations\Logo\LogoShipmentImmediateExportService;
use App\Support\Warehouse\WarehouseBranchResolver;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\Response;

class WarehouseShipmentService
{
    public function __construct(
        private readonly IntegrationSyncStateService $syncState,
        private readonly LogoShipmentImmediateExportService $logoShipmentImmediateExport,
    ) {}

    public function createShipment(
        User $user,
        int $orderId,
        ?int $warehouseId = null,
        ?string $warehouseCode = null,
        ?string $warehouseName = null,
        ?int $assignedUserId = null
    ): Shipment {
        return DB::transaction(function () use ($user, $orderId, $warehouseId, $warehouseCode, $warehouseName, $assignedUserId): Shipment {
            $order = Order::query()
                ->with(['items'])
                ->lockForUpdate()
                ->find($orderId);

            if (! $order instanceof Order) {
                throw ValidationException::withMessages([
                    'order_id' => ['Siparis bulunamadi.'],
                ]);
            }

            $this->ensureOrderScope($user, $order);

            if ($order->status !== 'approved') {
                throw ValidationException::withMessages([
                    'order_id' => ['Sadece approved durumundaki siparisler sevkiyata hazirdir.'],
                ]);
            }

            if ($order->items->isEmpty()) {
                throw ValidationException::withMessages([
                    'order_id' => ['Sipariste kalem bulunmuyor.'],
                ]);
            }

            $assignedUser = $this->resolveAssignedWarehouseUser($assignedUserId, $user);
            $assignedWarehouse = $this->preferredWarehouseForAssignedUser($assignedUser);
            $preferredWarehouse = $this->preferredWarehouseForOrder($order);
            $this->ensureAssignedWarehouseMatchesOrderTarget($preferredWarehouse, $assignedWarehouse);

            if ($preferredWarehouse !== null) {
                $warehouseId = null;
                $warehouseCode = $preferredWarehouse['code'];
                $warehouseName = $preferredWarehouse['name'];
            } elseif ($assignedWarehouse !== null) {
                $warehouseId = null;
                $warehouseCode = $assignedWarehouse['code'];
                $warehouseName = $assignedWarehouse['name'];
            }

            $warehouse = $this->resolveWarehouse($warehouseId, $warehouseCode, $warehouseName);

            $activeShipment = Shipment::query()
                ->where('order_id', $order->id)
                ->whereNotIn('status', ['cancelled'])
                ->latest('id')
                ->first();

            if ($activeShipment instanceof Shipment) {
                $hasShippedItems = ShipmentItem::query()
                    ->where('shipment_id', $activeShipment->id)
                    ->where('shipped_qty', '>', 0)
                    ->exists();

                if (! $hasShippedItems && (int) $activeShipment->warehouse_id !== (int) $warehouse->id) {
                    $activeShipment->forceFill([
                        'warehouse_id' => $warehouse->id,
                    ])->save();
                }

                if (! $hasShippedItems && (int) $activeShipment->warehouse_id === (int) $warehouse->id) {
                    $this->syncWarehouseSelection($warehouse, $warehouseCode, $warehouseName);
                }

                $this->syncOpenShipmentItemsFromOrder($activeShipment, $order);

                return $activeShipment->fresh([
                    'order.customer',
                    'warehouse',
                    'items.product',
                    'scans.scannedBy',
                ]);
            }

            $shipment = Shipment::create([
                'order_id' => $order->id,
                'warehouse_id' => $warehouse->id,
                'shipment_no' => $this->generateShipmentNo(),
                'status' => 'draft',
                'created_by' => $assignedUser->id,
            ]);

            foreach ($order->items as $item) {
                $unitPrice = $this->netUnitPriceForOrderItem($item);
                ShipmentItem::create([
                    'shipment_id' => $shipment->id,
                    'order_item_id' => $item->id,
                    'product_id' => $item->product_id,
                    'ordered_qty' => (int) $item->quantity,
                    'shipped_qty' => 0,
                    'unit_price' => number_format($unitPrice, 2, '.', ''),
                    'vat_rate' => number_format((float) $item->tax_rate, 2, '.', ''),
                    'line_total_shipped' => 0,
                ]);
            }

            return $shipment->fresh([
                'order.customer',
                'warehouse',
                'items.product',
                'scans.scannedBy',
            ]);
        });
    }

    private function syncOpenShipmentItemsFromOrder(Shipment $shipment, Order $order): void
    {
        if (! in_array($shipment->status, ['draft', 'picking', 'packed'], true)) {
            return;
        }

        $order->loadMissing('items');

        $shipmentItems = ShipmentItem::query()
            ->where('shipment_id', $shipment->id)
            ->lockForUpdate()
            ->get()
            ->keyBy('order_item_id');

        $orderItemIds = [];

        foreach ($order->items as $orderItem) {
            $orderItemIds[] = (int) $orderItem->id;
            $shipmentItem = $shipmentItems->get($orderItem->id);
            $unitPrice = $this->netUnitPriceForOrderItem($orderItem);

            if (! $shipmentItem instanceof ShipmentItem) {
                ShipmentItem::create([
                    'shipment_id' => $shipment->id,
                    'order_item_id' => $orderItem->id,
                    'product_id' => $orderItem->product_id,
                    'ordered_qty' => (int) $orderItem->quantity,
                    'shipped_qty' => 0,
                    'unit_price' => number_format($unitPrice, 2, '.', ''),
                    'vat_rate' => number_format((float) $orderItem->tax_rate, 2, '.', ''),
                    'line_total_shipped' => 0,
                ]);

                continue;
            }

            if ((int) $shipmentItem->shipped_qty > 0) {
                continue;
            }

            $shipmentItem->forceFill([
                'product_id' => $orderItem->product_id,
                'ordered_qty' => (int) $orderItem->quantity,
                'unit_price' => number_format($unitPrice, 2, '.', ''),
                'vat_rate' => number_format((float) $orderItem->tax_rate, 2, '.', ''),
                'line_total_shipped' => 0,
            ])->save();
        }

        foreach ($shipmentItems as $shipmentItem) {
            if (in_array((int) $shipmentItem->order_item_id, $orderItemIds, true)) {
                continue;
            }

            if ((int) $shipmentItem->shipped_qty > 0) {
                continue;
            }

            $shipmentItem->delete();
        }

        $hasShipped = ShipmentItem::query()
            ->where('shipment_id', $shipment->id)
            ->where('shipped_qty', '>', 0)
            ->exists();
        $hasRemaining = ShipmentItem::query()
            ->where('shipment_id', $shipment->id)
            ->whereColumn('shipped_qty', '<', 'ordered_qty')
            ->exists();

        $nextStatus = ! $hasShipped ? 'draft' : ($hasRemaining ? 'picking' : 'packed');
        if ($shipment->status !== $nextStatus) {
            $shipment->forceFill(['status' => $nextStatus])->save();
        }
    }

    private function resolveWarehouse(?int $warehouseId, ?string $warehouseCode, ?string $warehouseName): Warehouse
    {
        $warehouse = null;

        $code = trim((string) $warehouseCode);
        if ($code !== '') {
            $warehouse = Warehouse::query()->where('code', $code)->first();
        }

        if (! $warehouse instanceof Warehouse && $warehouseId !== null && $warehouseId > 0) {
            $warehouse = Warehouse::query()->find($warehouseId);
        }

        if (! $warehouse instanceof Warehouse && $code !== '') {
            $warehouse = Warehouse::query()->firstOrCreate(
                ['code' => $code],
                [
                    'name' => trim((string) $warehouseName) !== '' ? trim((string) $warehouseName) : "Logo Ambar {$code}",
                    'is_active' => true,
                ]
            );
        }

        if (! $warehouse instanceof Warehouse || ! $warehouse->is_active) {
            throw ValidationException::withMessages([
                'warehouse_id' => ['Depo bulunamadi veya aktif degil.'],
            ]);
        }

        $this->syncWarehouseSelection($warehouse, $warehouseCode, $warehouseName);

        return $warehouse;
    }

    private function netUnitPriceForOrderItem(OrderItem $item): float
    {
        $quantity = max(1, (int) $item->quantity);
        $lineTotal = (float) $item->line_total;

        if ($lineTotal > 0) {
            return round($lineTotal / $quantity, 2);
        }

        return round((float) $item->unit_net_price, 2);
    }

    /**
     * @return array{code:string,name:string}|null
     */
    private function preferredWarehouseForOrder(Order $order): ?array
    {
        $order->loadMissing([
            'cart:id,shipping_method',
            'customer:id,salesperson_user_id,branch_code,branch_name',
            'customer.salesperson:id,name,username,email,branch_code,branch_name',
            'user:id,name,username,email,branch_code,branch_name',
        ]);

        $identityWarehouse = $this->targetWarehouseForOrderContext($order);

        if ($identityWarehouse !== null) {
            return $identityWarehouse;
        }

        $state = $this->logoSyncState('orders', Order::class, (int) $order->id);
        $meta = is_array($state?->meta) ? $state->meta : [];
        $code = trim((string) data_get($meta, 'target_warehouse_code'));
        $name = trim((string) data_get($meta, 'target_warehouse_name'));

        if ($code !== '') {
            return [
                'code' => $code,
                'name' => $name !== '' ? $name : "Logo Ambar {$code}",
            ];
        }

        return null;
    }

    private function syncWarehouseSelection(Warehouse $warehouse, ?string $warehouseCode, ?string $warehouseName): void
    {
        $code = trim((string) $warehouseCode);
        $name = trim((string) $warehouseName);
        $changes = [];

        if ($name !== '' && trim((string) $warehouse->name) !== $name) {
            $changes['name'] = $name;
        }

        if ($changes !== []) {
            $warehouse->forceFill($changes)->save();
        }
    }

    private function resolveAssignedWarehouseUser(?int $assignedUserId, User $fallbackUser): User
    {
        if ($assignedUserId === null || $assignedUserId <= 0) {
            return $fallbackUser;
        }

        $assignedUser = User::query()
            ->where('is_active', true)
            ->whereHas('roles', fn ($roleQuery) => $roleQuery->where('slug', 'warehouse'))
            ->find($assignedUserId);

        if (! $assignedUser instanceof User) {
            throw ValidationException::withMessages([
                'assigned_user_id' => ['Aktif depocu bulunamadi.'],
            ]);
        }

        if (! $fallbackUser->hasRole('admin') && $fallbackUser->dealer_id !== null) {
            $assignedDealerId = $assignedUser->dealer_id;
            if ($assignedDealerId !== null && (int) $assignedDealerId !== (int) $fallbackUser->dealer_id) {
                throw ValidationException::withMessages([
                    'assigned_user_id' => ['Bu depocu icin yetkiniz yok.'],
                ]);
            }
        }

        return $assignedUser;
    }

    /**
     * @return array{code:string,name:string}|null
     */
    private function preferredWarehouseForAssignedUser(User $assignedUser): ?array
    {
        $identity = $this->normalizeWarehouseIdentity(implode(' ', [
            (string) $assignedUser->name,
            (string) $assignedUser->username,
            (string) $assignedUser->email,
        ]));

        if ($identity === '') {
            return null;
        }

        $choices = [
            ['code' => '0', 'name' => 'ERZURUM POINT', 'needles' => ['ERZURUMPOINT', 'ERZPOINT']],
            ['code' => '1', 'name' => 'ERZURUM DEPO', 'needles' => ['ERZURUMDEPO', 'ERZDEPO', 'ERZURUMMERKEZ']],
            ['code' => '2', 'name' => 'TRABZON DEPO', 'needles' => ['TRABZONDEPO', 'TRABZONMERKEZ', 'TRABZON']],
            ['code' => '3', 'name' => 'SAMSUN DEPO', 'needles' => ['SAMSUNDEPO', 'SAMSUNMERKEZ', 'SAMSUN']],
            ['code' => '4', 'name' => 'BATUM DEPO', 'needles' => ['BATUMDEPO', 'BATUMMERKEZ', 'BATUM']],
        ];

        foreach ($choices as $choice) {
            foreach ($choice['needles'] as $needle) {
                if (str_contains($identity, $needle)) {
                    return [
                        'code' => $choice['code'],
                        'name' => $choice['name'],
                    ];
                }
            }
        }

        return null;
    }

    /**
     * @param  array{code:string,name:string}|null  $preferredWarehouse
     * @param  array{code:string,name:string}|null  $assignedWarehouse
     */
    private function ensureAssignedWarehouseMatchesOrderTarget(?array $preferredWarehouse, ?array $assignedWarehouse): void
    {
        if ($preferredWarehouse === null || $assignedWarehouse === null) {
            return;
        }

        $preferredCode = trim((string) ($preferredWarehouse['code'] ?? ''));
        $assignedCode = trim((string) ($assignedWarehouse['code'] ?? ''));

        if ($preferredCode === '' || $assignedCode === '' || $preferredCode === $assignedCode) {
            return;
        }

        $preferredName = trim((string) ($preferredWarehouse['name'] ?? ''));

        throw ValidationException::withMessages([
            'assigned_user_id' => [
                sprintf(
                    'Bu siparis %s deposuna ait. Farkli depo depocusu secilemez.',
                    $preferredName !== '' ? $preferredName : "Logo Ambar {$preferredCode}",
                ),
            ],
        ]);
    }

    /**
     * @return array{code:string,name:string}|null
     */
    private function targetWarehouseForOrderContext(Order $order): ?array
    {
        $targetWarehouse = app(WarehouseBranchResolver::class)
            ->targetWarehouse($order->user, $order->customer, $order->cart?->shipping_method);

        if ($targetWarehouse === null) {
            return null;
        }

        return [
            'code' => $targetWarehouse['code'],
            'name' => $targetWarehouse['name'],
        ];
    }

    private function normalizeBranchCode(mixed $value): ?string
    {
        $normalized = preg_replace('/[^A-Z0-9]+/', '', Str::upper(Str::ascii(trim((string) $value)))) ?? '';

        if ($normalized === '') {
            return null;
        }

        if (str_contains($normalized, 'TRABZON')) {
            return 'TRABZON';
        }

        if (str_contains($normalized, 'SAMSUN')) {
            return 'SAMSUN';
        }

        if (str_contains($normalized, 'ERZURUM') || str_starts_with($normalized, 'ERZ')) {
            return 'ERZURUM';
        }

        if (str_contains($normalized, 'BATUM')) {
            return 'BATUM';
        }

        return $normalized;
    }

    private function branchCodeFromUserIdentity(?User $user): ?string
    {
        if (! $user instanceof User) {
            return null;
        }

        $identity = preg_replace('/[^A-Z0-9]+/', '', Str::upper(Str::ascii(implode(' ', array_filter([
            $user->username,
            $user->email,
            $user->name,
        ]))))) ?? '';

        if ($identity === '') {
            return null;
        }

        $explicit = [
            'TRABZONPOINT' => 'TRABZON',
            'TRABZONDEPO' => 'TRABZON',
            'SAMSUNPOINT' => 'SAMSUN',
            'SAMSUNDEPO' => 'SAMSUN',
            'ERZURUMMERKEZ' => 'ERZURUM',
            'MUDURERZURUM' => 'ERZURUM',
            'AHMETARAC' => 'ERZURUM',
            'ERZDEPO' => 'ERZURUM',
            'BATUM' => 'BATUM',
        ];

        foreach ($explicit as $needle => $branch) {
            if (str_contains($identity, $needle)) {
                return $branch;
            }
        }

        return $this->normalizeBranchCode($identity);
    }

    /**
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     */
    public function scanShipment(User $user, Shipment $shipment, array $payload): array
    {
        return DB::transaction(function () use ($user, $shipment, $payload): array {
            $model = Shipment::query()
                ->with([
                    'order.items',
                    'items.orderItem',
                    'items.product.stockSummary',
                    'warehouse',
                ])
                ->lockForUpdate()
                ->find($shipment->id);

            if (! $model instanceof Shipment) {
                throw ValidationException::withMessages([
                    'shipment' => ['Sevkiyat bulunamadi.'],
                ]);
            }

            $this->ensureShipmentScope($user, $model);

            if (in_array($model->status, ['cancelled', 'shipped', 'partially_shipped'], true)) {
                throw ValidationException::withMessages([
                    'shipment' => ['Bu sevkiyat barkod okutmaya kapali.'],
                ]);
            }

            $barcode = trim((string) $payload['barcode']);
            $qty = max(1, (int) ($payload['qty'] ?? 1));

            $product = $this->findProductByBarcode($barcode);
            if (! $product instanceof Product) {
                throw ValidationException::withMessages([
                    'barcode' => ['Barkod ile eslesen urun bulunamadi.'],
                ]);
            }

            $shipmentItem = ShipmentItem::query()
                ->where('shipment_id', $model->id)
                ->where('product_id', $product->id)
                ->lockForUpdate()
                ->first();

            if (! $shipmentItem instanceof ShipmentItem) {
                throw ValidationException::withMessages([
                    'barcode' => ['Okutulan urun sipariste bulunmuyor.'],
                ]);
            }

            $currentShippedQty = (int) $shipmentItem->shipped_qty;
            $nextShippedQty = $currentShippedQty + $qty;
            if ($nextShippedQty > (int) $shipmentItem->ordered_qty) {
                throw ValidationException::withMessages([
                    'qty' => ['Fazla okutma yapilamaz. Siparis miktari asildi.'],
                ]);
            }

            $availableTotal = $this->resolveProductWarehouseAvailableTotal(
                $product,
                $model->warehouse?->code,
                $model->warehouse?->name
            );
            $availableForShipment = max(0, $availableTotal - $currentShippedQty);
            $effectiveQty = min($qty, $availableForShipment);

            if ($effectiveQty <= 0) {
                throw ValidationException::withMessages([
                    'qty' => ['Bu urun icin sevk edilebilir mevcut stok yok.'],
                ]);
            }

            $nextShippedQty = $currentShippedQty + $effectiveQty;

            $shipmentItem->shipped_qty = $nextShippedQty;
            $shipmentItem->line_total_shipped = number_format(
                ((float) $shipmentItem->unit_price) * $nextShippedQty,
                2,
                '.',
                ''
            );
            $shipmentItem->save();

            ShipmentScan::create([
                'shipment_id' => $model->id,
                'product_id' => $product->id,
                'barcode' => $barcode,
                'qty' => $effectiveQty,
                'scanned_by' => $user->id,
                'scanned_at' => now(),
            ]);

            $hasRemaining = ShipmentItem::query()
                ->where('shipment_id', $model->id)
                ->whereColumn('shipped_qty', '<', 'ordered_qty')
                ->exists();

            $newShipmentStatus = $hasRemaining ? 'picking' : 'packed';
            if ($model->status !== $newShipmentStatus) {
                $model->status = $newShipmentStatus;
                $model->save();
            }

            if ($newShipmentStatus === 'picking' && $model->order->status === 'approved') {
                $this->updateOrderStatus($model->order, 'picking', $user, 'Depo barkod okutma basladi.');
            }

            if ($newShipmentStatus === 'packed' && $model->order->status !== 'packed') {
                $this->updateOrderStatus($model->order, 'packed', $user, 'Tum kalemler okutuldu ve paketlendi.');
            }

            $state = $this->shipmentState($user, $model->fresh([
                'order.customer',
                'warehouse',
                'items.product',
                'scans.scannedBy',
            ]));

            return [
                ...$state,
                'message' => 'Barkod okutuldu.',
                'gonderilen_tutar' => $state['totals']['gonderilen_tutar'],
            ];
        });
    }

    /**
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     */
    public function returnShipmentItem(User $user, Shipment $shipment, array $payload): array
    {
        return DB::transaction(function () use ($user, $shipment, $payload): array {
            $model = Shipment::query()
                ->with([
                    'order.items',
                    'items.orderItem',
                    'items.product',
                    'warehouse',
                ])
                ->lockForUpdate()
                ->find($shipment->id);

            if (! $model instanceof Shipment) {
                throw ValidationException::withMessages([
                    'shipment' => ['Sevkiyat bulunamadi.'],
                ]);
            }

            $this->ensureShipmentScope($user, $model);

            if (in_array($model->status, ['cancelled', 'shipped', 'partially_shipped'], true)) {
                throw ValidationException::withMessages([
                    'shipment' => ['Bu sevkiyat geri almaya kapali.'],
                ]);
            }

            $shipmentItem = ShipmentItem::query()
                ->where('shipment_id', $model->id)
                ->where('id', (int) $payload['item_id'])
                ->lockForUpdate()
                ->first();

            if (! $shipmentItem instanceof ShipmentItem) {
                throw ValidationException::withMessages([
                    'item_id' => ['Sevk satiri bulunamadi.'],
                ]);
            }

            $shippedQty = (int) $shipmentItem->shipped_qty;
            if ($shippedQty <= 0) {
                throw ValidationException::withMessages([
                    'qty' => ['Bu satirda geri alinacak sevk adedi yok.'],
                ]);
            }

            $qty = $payload['qty'] === null ? $shippedQty : max(1, (int) $payload['qty']);
            $returnQty = min($qty, $shippedQty);
            $nextShippedQty = max(0, $shippedQty - $returnQty);

            $shipmentItem->shipped_qty = $nextShippedQty;
            $shipmentItem->line_total_shipped = number_format(
                ((float) $shipmentItem->unit_price) * $nextShippedQty,
                2,
                '.',
                ''
            );
            $shipmentItem->save();

            $hasShipped = ShipmentItem::query()
                ->where('shipment_id', $model->id)
                ->where('shipped_qty', '>', 0)
                ->exists();
            $hasRemaining = ShipmentItem::query()
                ->where('shipment_id', $model->id)
                ->whereColumn('shipped_qty', '<', 'ordered_qty')
                ->exists();

            $newShipmentStatus = ! $hasShipped ? 'draft' : ($hasRemaining ? 'picking' : 'packed');
            if ($model->status !== $newShipmentStatus) {
                $model->status = $newShipmentStatus;
                $model->save();
            }

            if (! $hasShipped && $model->order->status !== 'approved') {
                $this->updateOrderStatus($model->order, 'approved', $user, 'Sevk edilen urunler geri alindi.');
            } elseif ($hasShipped && $hasRemaining && $model->order->status !== 'picking') {
                $this->updateOrderStatus($model->order, 'picking', $user, 'Sevk satiri geri alindi.');
            } elseif ($hasShipped && ! $hasRemaining && $model->order->status !== 'packed') {
                $this->updateOrderStatus($model->order, 'packed', $user, 'Tum kalemler okutuldu ve paketlendi.');
            }

            $state = $this->shipmentState($user, $model->fresh([
                'order.customer',
                'warehouse',
                'items.product',
                'scans.scannedBy',
            ]));

            return [
                ...$state,
                'message' => 'Sevk satiri geri alindi.',
                'gonderilen_tutar' => $state['totals']['gonderilen_tutar'],
            ];
        });
    }

    /**
     * @return array<string, mixed>
     */
    public function returnAllShipmentItems(User $user, Shipment $shipment): array
    {
        return DB::transaction(function () use ($user, $shipment): array {
            $model = Shipment::query()
                ->with([
                    'order.items',
                    'items.orderItem',
                    'items.product',
                    'warehouse',
                ])
                ->lockForUpdate()
                ->find($shipment->id);

            if (! $model instanceof Shipment) {
                throw ValidationException::withMessages([
                    'shipment' => ['Sevkiyat bulunamadi.'],
                ]);
            }

            $this->ensureShipmentScope($user, $model);

            if (in_array($model->status, ['cancelled', 'shipped', 'partially_shipped'], true)) {
                throw ValidationException::withMessages([
                    'shipment' => ['Bu sevkiyat geri almaya kapali.'],
                ]);
            }

            $returnableItems = ShipmentItem::query()
                ->where('shipment_id', $model->id)
                ->where('shipped_qty', '>', 0)
                ->lockForUpdate()
                ->get();

            if ($returnableItems->isEmpty()) {
                throw ValidationException::withMessages([
                    'shipment' => ['Geri alinacak sevk satiri bulunamadi.'],
                ]);
            }

            foreach ($returnableItems as $shipmentItem) {
                $qty = (int) $shipmentItem->shipped_qty;
                if ($qty <= 0) {
                    continue;
                }

                $shipmentItem->shipped_qty = 0;
                $shipmentItem->line_total_shipped = number_format(0, 2, '.', '');
                $shipmentItem->save();

                $orderItem = OrderItem::query()
                    ->lockForUpdate()
                    ->find((int) $shipmentItem->order_item_id);

                if ($orderItem instanceof OrderItem) {
                    $orderItem->shipped_qty = max(0, (int) $orderItem->shipped_qty - $qty);
                    $orderItem->save();
                }
            }

            $hasShipped = ShipmentItem::query()
                ->where('shipment_id', $model->id)
                ->where('shipped_qty', '>', 0)
                ->exists();
            $hasRemaining = ShipmentItem::query()
                ->where('shipment_id', $model->id)
                ->whereColumn('shipped_qty', '<', 'ordered_qty')
                ->exists();

            $newShipmentStatus = ! $hasShipped ? 'draft' : ($hasRemaining ? 'picking' : 'packed');
            if ($model->status !== $newShipmentStatus) {
                $model->status = $newShipmentStatus;
                $model->save();
            }

            if (! $hasShipped && $model->order->status !== 'approved') {
                $this->updateOrderStatus($model->order, 'approved', $user, 'Tüm sevk satırları siparişe geri alındı.');
            } elseif ($hasShipped && $hasRemaining && $model->order->status !== 'picking') {
                $this->updateOrderStatus($model->order, 'picking', $user, 'Sevk edilen satırlar geri alındı.');
            } elseif ($hasShipped && ! $hasRemaining && $model->order->status !== 'packed') {
                $this->updateOrderStatus($model->order, 'packed', $user, 'Tüm kalemler okundu ve paketlendi.');
            }

            $state = $this->shipmentState($user, $model->fresh([
                'order.customer',
                'warehouse',
                'items.product',
                'scans.scannedBy',
            ]));

            return [
                ...$state,
                'message' => 'Tüm sevk satırları sipariş listesine geri alındı.',
                'gonderilen_tutar' => $state['totals']['gonderilen_tutar'],
            ];
        });
    }

    /**
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     */
    public function addShipmentItem(User $user, Shipment $shipment, array $payload): array
    {
        return DB::transaction(function () use ($user, $shipment, $payload): array {
            $model = Shipment::query()
                ->with([
                    'order.dealer',
                    'order.items',
                    'items.orderItem',
                    'items.product',
                    'warehouse',
                ])
                ->lockForUpdate()
                ->find($shipment->id);

            if (! $model instanceof Shipment) {
                throw ValidationException::withMessages([
                    'shipment' => ['Sevkiyat bulunamadi.'],
                ]);
            }

            $this->ensureEditableShipment($user, $model, 'Bu sevkiyat ürün eklemeye kapalı.');

            $product = Product::query()
                ->where('is_active', true)
                ->find((int) $payload['product_id']);

            if (! $product instanceof Product) {
                throw ValidationException::withMessages([
                    'product_id' => ['Aktif ürün bulunamadı.'],
                ]);
            }

            $quantity = max(1, (int) $payload['quantity']);
            $unitNetPrice = $this->resolveUnitNetPrice($model->order, $product, $payload['unit_net_price'] ?? null);
            $taxRate = $payload['tax_rate'] ?? null;
            $taxRate = $taxRate !== null ? (float) $taxRate : (float) $product->vat_rate;

            $orderItem = OrderItem::query()
                ->where('order_id', $model->order_id)
                ->where('product_id', $product->id)
                ->lockForUpdate()
                ->first();

            if ($orderItem instanceof OrderItem) {
                $orderItem->forceFill([
                    'quantity' => (int) $orderItem->quantity + $quantity,
                    'unit_net_price' => number_format($unitNetPrice, 2, '.', ''),
                    'tax_rate' => number_format($taxRate, 2, '.', ''),
                    'line_total' => number_format(((int) $orderItem->quantity + $quantity) * $unitNetPrice, 2, '.', ''),
                ])->save();
            } else {
                $orderItem = OrderItem::query()->create([
                    'order_id' => $model->order_id,
                    'product_id' => $product->id,
                    'quantity' => $quantity,
                    'shipped_qty' => 0,
                    'unit_net_price' => number_format($unitNetPrice, 2, '.', ''),
                    'discount_rate' => 0,
                    'tax_rate' => number_format($taxRate, 2, '.', ''),
                    'line_total' => number_format($quantity * $unitNetPrice, 2, '.', ''),
                    'currency' => $model->order?->currency ?: 'TRY',
                ]);
            }

            $shipmentItem = ShipmentItem::query()
                ->where('shipment_id', $model->id)
                ->where('order_item_id', $orderItem->id)
                ->lockForUpdate()
                ->first();

            if ($shipmentItem instanceof ShipmentItem) {
                $shipmentItem->forceFill([
                    'product_id' => $product->id,
                    'ordered_qty' => (int) $orderItem->quantity,
                    'unit_price' => number_format($unitNetPrice, 2, '.', ''),
                    'vat_rate' => number_format($taxRate, 2, '.', ''),
                    'line_total_shipped' => number_format(((float) $shipmentItem->shipped_qty) * $unitNetPrice, 2, '.', ''),
                ])->save();
            } else {
                ShipmentItem::query()->create([
                    'shipment_id' => $model->id,
                    'order_item_id' => $orderItem->id,
                    'product_id' => $product->id,
                    'ordered_qty' => (int) $orderItem->quantity,
                    'shipped_qty' => 0,
                    'unit_price' => number_format($unitNetPrice, 2, '.', ''),
                    'vat_rate' => number_format($taxRate, 2, '.', ''),
                    'line_total_shipped' => 0,
                ]);
            }

            $this->recalculateOrderTotals($model->order);
            $this->refreshOpenShipmentStatus($model);

            $state = $this->shipmentState($user, $model->fresh([
                'order.customer',
                'warehouse',
                'items.product',
                'scans.scannedBy',
            ]));

            return [
                ...$state,
                'message' => 'Ürün siparişe eklendi.',
                'gonderilen_tutar' => $state['totals']['gonderilen_tutar'],
            ];
        });
    }

    /**
     * @return array<string, mixed>
     */
    public function updateShipmentItemQuantity(User $user, Shipment $shipment, int $itemId, int $quantity): array
    {
        return DB::transaction(function () use ($user, $shipment, $itemId, $quantity): array {
            $model = Shipment::query()
                ->with([
                    'order.items',
                    'items.orderItem',
                    'items.product',
                    'warehouse',
                ])
                ->lockForUpdate()
                ->find($shipment->id);

            if (! $model instanceof Shipment) {
                throw ValidationException::withMessages([
                    'shipment' => ['Sevkiyat bulunamadi.'],
                ]);
            }

            $this->ensureEditableShipment($user, $model, 'Bu sevkiyat miktar düzenlemeye kapalı.');

            $shipmentItem = ShipmentItem::query()
                ->where('shipment_id', $model->id)
                ->where('id', $itemId)
                ->lockForUpdate()
                ->first();

            if (! $shipmentItem instanceof ShipmentItem) {
                throw ValidationException::withMessages([
                    'item_id' => ['Sevkiyat kalemi bulunamadi.'],
                ]);
            }

            $safeQuantity = max(1, $quantity);
            if ($safeQuantity < (int) $shipmentItem->shipped_qty) {
                throw ValidationException::withMessages([
                    'quantity' => ['Sipariş miktarı sevk edilen adedin altına indirilemez.'],
                ]);
            }

            $orderItem = OrderItem::query()
                ->where('order_id', $model->order_id)
                ->where('id', (int) $shipmentItem->order_item_id)
                ->lockForUpdate()
                ->first();

            if (! $orderItem instanceof OrderItem) {
                throw ValidationException::withMessages([
                    'order_item_id' => ['Sipariş kalemi bulunamadi.'],
                ]);
            }

            $unitPrice = (float) $shipmentItem->unit_price;
            $orderItem->forceFill([
                'quantity' => $safeQuantity,
                'line_total' => number_format($safeQuantity * $unitPrice, 2, '.', ''),
            ])->save();

            $shipmentItem->forceFill([
                'ordered_qty' => $safeQuantity,
                'line_total_shipped' => number_format(((int) $shipmentItem->shipped_qty) * $unitPrice, 2, '.', ''),
            ])->save();

            $this->recalculateOrderTotals($model->order);
            $this->refreshOpenShipmentStatus($model);

            $state = $this->shipmentState($user, $model->fresh([
                'order.customer',
                'warehouse',
                'items.product',
                'scans.scannedBy',
            ]));

            return [
                ...$state,
                'message' => 'Sipariş miktarı güncellendi.',
                'gonderilen_tutar' => $state['totals']['gonderilen_tutar'],
            ];
        });
    }

    /**
     * @return array<string, mixed>
     */
    public function deleteShipmentItem(User $user, Shipment $shipment, int $itemId): array
    {
        return DB::transaction(function () use ($user, $shipment, $itemId): array {
            $model = Shipment::query()
                ->with([
                    'order.items',
                    'items.orderItem',
                    'items.product',
                    'warehouse',
                ])
                ->lockForUpdate()
                ->find($shipment->id);

            if (! $model instanceof Shipment) {
                throw ValidationException::withMessages([
                    'shipment' => ['Sevkiyat bulunamadi.'],
                ]);
            }

            $this->ensureShipmentScope($user, $model);

            if (in_array($model->status, ['cancelled', 'shipped', 'partially_shipped'], true)) {
                throw ValidationException::withMessages([
                    'shipment' => ['Bu sevkiyat kalem silmeye kapali.'],
                ]);
            }

            $shipmentItem = ShipmentItem::query()
                ->where('shipment_id', $model->id)
                ->where('id', $itemId)
                ->lockForUpdate()
                ->first();

            if (! $shipmentItem instanceof ShipmentItem) {
                throw ValidationException::withMessages([
                    'item_id' => ['Sevkiyat kalemi bulunamadi.'],
                ]);
            }

            $itemCount = ShipmentItem::query()
                ->where('shipment_id', $model->id)
                ->count();

            if ($itemCount <= 1) {
                return $this->cancelShipment($user, $model);
            }

            ShipmentScan::query()
                ->where('shipment_id', $model->id)
                ->where('product_id', $shipmentItem->product_id)
                ->delete();

            $shipmentItem->delete();

            $hasShipped = ShipmentItem::query()
                ->where('shipment_id', $model->id)
                ->where('shipped_qty', '>', 0)
                ->exists();
            $hasRemaining = ShipmentItem::query()
                ->where('shipment_id', $model->id)
                ->whereColumn('shipped_qty', '<', 'ordered_qty')
                ->exists();

            $newShipmentStatus = ! $hasShipped ? 'draft' : ($hasRemaining ? 'picking' : 'packed');
            if ($model->status !== $newShipmentStatus) {
                $model->status = $newShipmentStatus;
                $model->save();
            }

            if (! $hasShipped && $model->order->status !== 'approved') {
                $this->updateOrderStatus($model->order, 'approved', $user, 'Sevkiyat kalemi silindi.');
            } elseif ($hasShipped && $hasRemaining && $model->order->status !== 'picking') {
                $this->updateOrderStatus($model->order, 'picking', $user, 'Sevkiyat kalemi silindi.');
            } elseif ($hasShipped && ! $hasRemaining && $model->order->status !== 'packed') {
                $this->updateOrderStatus($model->order, 'packed', $user, 'Kalan sevkiyat kalemleri paketlendi.');
            }

            $state = $this->shipmentState($user, $model->fresh([
                'order.customer',
                'warehouse',
                'items.product',
                'scans.scannedBy',
            ]));

            return [
                ...$state,
                'message' => 'Sevkiyat kalemi silindi.',
                'gonderilen_tutar' => $state['totals']['gonderilen_tutar'],
            ];
        });
    }

    /**
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     */
    public function finalizeShipment(User $user, Shipment $shipment, array $payload): array
    {
        $state = DB::transaction(function () use ($user, $shipment, $payload): array {
            $model = Shipment::query()
                ->with([
                    'order.items',
                    'items.orderItem',
                    'items.product',
                    'warehouse',
                ])
                ->lockForUpdate()
                ->find($shipment->id);

            if (! $model instanceof Shipment) {
                throw ValidationException::withMessages([
                    'shipment' => ['Sevkiyat bulunamadi.'],
                ]);
            }

            $this->ensureShipmentScope($user, $model);

            if (in_array($model->status, ['cancelled', 'shipped', 'partially_shipped'], true)) {
                throw ValidationException::withMessages([
                    'shipment' => ['Bu sevkiyat finalize edilemez.'],
                ]);
            }

            $totalShippedInShipment = (int) $model->items->sum('shipped_qty');
            if ($totalShippedInShipment <= 0) {
                throw ValidationException::withMessages([
                    'shipment' => ['Finalize icin en az bir okutulmus urun olmalidir.'],
                ]);
            }

            $remainingWarehouseStockByProduct = [];
            $finalizedQtyTotal = 0;

            foreach ($model->items as $item) {
                $qty = (int) $item->shipped_qty;
                if ($qty <= 0) {
                    continue;
                }

                $product = Product::query()
                    ->lockForUpdate()
                    ->find($item->product_id);

                if (! $product instanceof Product) {
                    throw ValidationException::withMessages([
                        'stock' => ["Urun bulunamadi (product_id={$item->product_id})."],
                    ]);
                }

                $warehouseSnapshot = $this->resolveProductWarehouseStockSnapshot(
                    $product,
                    $model->warehouse?->code,
                    $model->warehouse?->name
                );
                $warehouseAvailable = $warehouseSnapshot
                    ?? max(0, (int) $product->stockSummary?->available_total);

                $stockKey = (string) $item->product_id;
                if (! array_key_exists($stockKey, $remainingWarehouseStockByProduct)) {
                    $remainingWarehouseStockByProduct[$stockKey] = $warehouseAvailable;
                }

                $finalQty = min($qty, max(0, (int) $remainingWarehouseStockByProduct[$stockKey]));
                $remainingWarehouseStockByProduct[$stockKey] = max(0, (int) $remainingWarehouseStockByProduct[$stockKey] - $finalQty);

                if ($finalQty !== $qty) {
                    $item->shipped_qty = $finalQty;
                    $item->line_total_shipped = number_format(
                        ((float) $item->unit_price) * $finalQty,
                        2,
                        '.',
                        ''
                    );
                    $item->save();

                    $qty = $finalQty;
                }

                if ($qty <= 0) {
                    continue;
                }

                $stock = StockSummary::query()
                    ->lockForUpdate()
                    ->find($item->product_id);

                if (! $stock instanceof StockSummary) {
                    throw ValidationException::withMessages([
                        'stock' => ["Stock summary bulunamadi (product_id={$item->product_id})."],
                    ]);
                }

                $availableTotal = max(0, (int) $stock->available_total);
                $reservedTotal = max(0, (int) $stock->reserved_total);
                if ($warehouseSnapshot === null && $availableTotal < $qty) {
                    throw ValidationException::withMessages([
                        'stock' => ["Yetersiz toplam stok (product_id={$item->product_id})."],
                    ]);
                }

                // Fiziksel stok Logo ambar toplamıdır; fatura Logo'da oluşmadan yerelde azaltılmaz.
                $reserveToConsume = min($reservedTotal, $qty);

                $stock->reserved_total = max(0, $reservedTotal - $reserveToConsume);
                $stock->updated_at = now();
                $stock->save();

                StockMovement::create([
                    'product_id' => $item->product_id,
                    'type' => 'out',
                    'source' => 'shipment',
                    'source_id' => $model->id,
                    'qty' => number_format((float) $qty, 3, '.', ''),
                    'created_at' => now(),
                ]);

                $orderItem = OrderItem::query()
                    ->lockForUpdate()
                    ->find($item->order_item_id);

                if (! $orderItem instanceof OrderItem) {
                    throw ValidationException::withMessages([
                        'order_item_id' => ["Order kalemi bulunamadi (id={$item->order_item_id})."],
                    ]);
                }

                $orderItem->shipped_qty = min(
                    (int) $orderItem->quantity,
                    (int) $orderItem->shipped_qty + $qty
                );
                $orderItem->save();
                $finalizedQtyTotal += $qty;
            }

            if ($finalizedQtyTotal <= 0) {
                throw ValidationException::withMessages([
                    'stock' => ['Fatura kesilemez. Secili depoda faturalanabilir canli stok bulunamadi.'],
                ]);
            }

            $hasRemainingInShipment = ShipmentItem::query()
                ->where('shipment_id', $model->id)
                ->whereColumn('shipped_qty', '<', 'ordered_qty')
                ->exists();

            $model->status = $hasRemainingInShipment ? 'partially_shipped' : 'shipped';
            $model->carrier_name = $payload['carrier_name'] ?? $model->carrier_name;
            $model->tracking_no = $payload['tracking_no'] ?? $model->tracking_no;
            $model->note = $payload['note'] ?? $model->note;
            $model->shipped_at = now();
            $model->save();

            $this->syncOrderShipmentStatus($model->order, $user, 'Sevkiyat finalize edildi.');

            $this->syncState->record(
                system: 'logo',
                domain: 'warehouse-shipments',
                direction: 'outbound',
                entity: $model,
                externalRef: null,
                status: 'queued',
                error: null,
                meta: [
                    'export_key' => $model->logoExportKey(),
                    'shipment_no' => $model->shipment_no,
                    'order_id' => $model->order_id,
                    'order_no' => $model->order?->order_no,
                    'warehouse_code' => $model->warehouse?->code,
                ],
                payload: [
                    'shipment_id' => $model->id,
                    'shipment_no' => $model->shipment_no,
                    'order_id' => $model->order_id,
                    'status' => $model->status,
                ],
            );

            $state = $this->shipmentState($user, $model->fresh([
                'order.customer',
                'warehouse',
                'items.product',
                'scans.scannedBy',
            ]));

            return [
                ...$state,
                'message' => 'Sevkiyat finalize edildi.',
                'gonderilen_tutar' => $state['totals']['gonderilen_tutar'],
            ];
        });

        $shipmentId = (int) data_get($state, 'shipment.id');
        if ($shipmentId <= 0) {
            return $state;
        }

        $freshShipment = Shipment::query()->find($shipmentId);
        if (! $freshShipment instanceof Shipment) {
            return $state;
        }

        if ($this->logoShipmentImmediateExport->export($freshShipment) instanceof IntegrationSyncState) {
            $freshState = $this->shipmentState($user, $freshShipment->fresh([
                'order.customer',
                'warehouse',
                'items.product',
                'scans.scannedBy',
            ]));

            return [
                ...$freshState,
                'message' => 'Sevkiyat finalize edildi ve Logo faturasi aktarildi.',
                'gonderilen_tutar' => $freshState['totals']['gonderilen_tutar'],
            ];
        }

        $queuedSyncState = $this->waitForQueuedLogoShipmentSync($freshShipment);
        if ($queuedSyncState instanceof IntegrationSyncState) {
            if ($queuedSyncState->status === 'failed') {
                throw ValidationException::withMessages([
                    'logo' => ['Logo fatura aktarimi basarisiz: '.($queuedSyncState->last_error ?: 'Bilinmeyen hata')],
                ]);
            }

            if ($queuedSyncState->status === 'synced') {
                $freshState = $this->shipmentState($user, $freshShipment->fresh([
                    'order.customer',
                    'warehouse',
                    'items.product',
                    'scans.scannedBy',
                ]));

                return [
                    ...$freshState,
                    'message' => 'Sevkiyat finalize edildi ve Logo faturasi aktarildi.',
                    'gonderilen_tutar' => $freshState['totals']['gonderilen_tutar'],
                ];
            }
        }

        return $state;
    }

    private function waitForQueuedLogoShipmentSync(Shipment $shipment): ?IntegrationSyncState
    {
        $waitSeconds = (float) config('integrations.logo.shipments.queued_export_wait_seconds', 0);
        if ($waitSeconds <= 0) {
            return null;
        }

        $deadline = microtime(true) + min($waitSeconds, 20.0);
        $sleepMicroseconds = 250_000;

        do {
            $state = IntegrationSyncState::query()
                ->where('system', 'logo')
                ->where('domain', 'warehouse-shipments')
                ->where('direction', 'outbound')
                ->where('entity_type', Shipment::class)
                ->where('entity_id', (int) $shipment->getKey())
                ->first();

            if ($state instanceof IntegrationSyncState && in_array($state->status, ['synced', 'failed'], true)) {
                return $state;
            }

            usleep($sleepMicroseconds);
        } while (microtime(true) < $deadline);

        return null;
    }

    /**
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     */
    public function cancelShipment(User $user, Shipment $shipment, array $payload = []): array
    {
        return DB::transaction(function () use ($user, $shipment, $payload): array {
            $model = Shipment::query()
                ->with([
                    'order.items',
                    'items.orderItem',
                    'items.product',
                    'warehouse',
                ])
                ->lockForUpdate()
                ->find($shipment->id);

            if (! $model instanceof Shipment) {
                throw ValidationException::withMessages([
                    'shipment' => ['Sevkiyat bulunamadi.'],
                ]);
            }

            $this->ensureShipmentScope($user, $model);

            if ($model->status === 'cancelled') {
                return $this->shipmentState($user, $model->fresh([
                    'order.customer',
                    'warehouse',
                    'items.product',
                    'scans.scannedBy',
                ]));
            }

            $wasFinalized = in_array($model->status, ['shipped', 'partially_shipped'], true);

            if ($wasFinalized) {
                foreach ($model->items as $item) {
                    $qty = (int) $item->shipped_qty;
                    if ($qty <= 0) {
                        continue;
                    }

                    $stock = StockSummary::query()
                        ->lockForUpdate()
                        ->find($item->product_id);

                    if (! $stock instanceof StockSummary) {
                        throw ValidationException::withMessages([
                            'stock' => ["Stock summary bulunamadi (product_id={$item->product_id})."],
                        ]);
                    }

                    $stock->reserved_total = (int) $stock->reserved_total + $qty;
                    $stock->updated_at = now();
                    $stock->save();

                    StockMovement::create([
                        'product_id' => $item->product_id,
                        'type' => 'in',
                        'source' => 'shipment',
                        'source_id' => $model->id,
                        'qty' => number_format((float) $qty, 3, '.', ''),
                        'created_at' => now(),
                    ]);

                    $orderItem = OrderItem::query()
                        ->lockForUpdate()
                        ->find($item->order_item_id);

                    if ($orderItem instanceof OrderItem) {
                        $orderItem->shipped_qty = max(0, (int) $orderItem->shipped_qty - $qty);
                        $orderItem->save();
                    }
                }
            }

            $model->status = 'cancelled';
            $model->note = isset($payload['note']) && is_string($payload['note'])
                ? trim((string) $payload['note'])
                : $model->note;
            $model->save();

            $this->syncOrderShipmentStatus($model->order, $user, 'Sevkiyat iptal edildi.');

            return [
                ...$this->shipmentState($user, $model->fresh([
                    'order.customer',
                    'warehouse',
                    'items.product',
                    'scans.scannedBy',
                ])),
                'message' => 'Sevkiyat iptal edildi.',
            ];
        });
    }

    private function ensureEditableShipment(User $user, Shipment $shipment, string $message): void
    {
        $this->ensureShipmentScope($user, $shipment);

        if (in_array($shipment->status, ['cancelled', 'shipped', 'partially_shipped'], true)) {
            throw ValidationException::withMessages([
                'shipment' => [$message],
            ]);
        }
    }

    private function resolveUnitNetPrice(Order $order, Product $product, mixed $payloadValue): float
    {
        $order->loadMissing('dealer');
        $priceListId = $order->dealer?->price_list_id;
        if ($priceListId !== null) {
            $basePrice = DB::table('base_prices')
                ->where('price_list_id', (int) $priceListId)
                ->where('product_id', $product->id)
                ->value('list_price');

            if ($basePrice !== null && is_numeric($basePrice)) {
                return max(0.0, round((float) $basePrice, 2));
            }
        }

        if ($payloadValue !== null && is_numeric($payloadValue)) {
            return max(0.0, round((float) $payloadValue, 2));
        }

        return 0.0;
    }

    private function recalculateOrderTotals(Order $order): void
    {
        $items = OrderItem::query()
            ->where('order_id', $order->id)
            ->lockForUpdate()
            ->get();

        $subtotal = 0.0;
        $taxTotal = 0.0;

        foreach ($items as $item) {
            $lineTotal = (float) $item->line_total;
            $subtotal += $lineTotal;
            $taxTotal += $lineTotal * ((float) $item->tax_rate / 100);
        }

        $order->forceFill([
            'subtotal' => number_format($subtotal, 2, '.', ''),
            'tax_total' => number_format($taxTotal, 2, '.', ''),
            'grand_total' => number_format($subtotal + $taxTotal, 2, '.', ''),
        ])->save();
    }

    private function refreshOpenShipmentStatus(Shipment $shipment): void
    {
        if (! in_array($shipment->status, ['draft', 'picking', 'packed'], true)) {
            return;
        }

        $hasShipped = ShipmentItem::query()
            ->where('shipment_id', $shipment->id)
            ->where('shipped_qty', '>', 0)
            ->exists();
        $hasRemaining = ShipmentItem::query()
            ->where('shipment_id', $shipment->id)
            ->whereColumn('shipped_qty', '<', 'ordered_qty')
            ->exists();

        $nextStatus = ! $hasShipped ? 'draft' : ($hasRemaining ? 'picking' : 'packed');
        if ($shipment->status !== $nextStatus) {
            $shipment->forceFill(['status' => $nextStatus])->save();
        }
    }

    /**
     * @return array<string, mixed>
     */
    public function shipmentState(User $user, Shipment $shipment): array
    {
        $shipment->loadMissing([
            'order.customer',
            'warehouse',
            'items.product.stockSummary',
            'scans.scannedBy',
        ]);

        $this->ensureShipmentScope($user, $shipment);
        $logoSyncState = $this->logoSyncState('warehouse-shipments', Shipment::class, (int) $shipment->id);
        $customer = $shipment->order?->customer;
        $customerMeta = is_array($customer?->meta) ? $customer->meta : [];

        $remainingItems = [];
        $shippedItems = [];

        $orderedQtyTotal = 0;
        $shippedQtyTotal = 0;
        $sentAmount = 0.0;

        foreach ($shipment->items as $item) {
            $orderedQty = (int) $item->ordered_qty;
            $shippedQty = (int) $item->shipped_qty;
            $remainingQty = max(0, $orderedQty - $shippedQty);
            $lineTotalShipped = (float) $item->line_total_shipped;
            $productMeta = is_array($item->product?->meta) ? $item->product->meta : [];
            $availableTotal = $this->resolveProductWarehouseAvailableTotal(
                $item->product,
                $shipment->warehouse?->code,
                $shipment->warehouse?->name
            );

            $orderedQtyTotal += $orderedQty;
            $shippedQtyTotal += $shippedQty;
            $sentAmount += $lineTotalShipped;

            $payload = [
                'id' => $item->id,
                'order_item_id' => $item->order_item_id,
                'product_id' => $item->product_id,
                'sku' => $item->product?->sku,
                'oem' => $item->product?->oem_code,
                'name' => $item->product?->name,
                'shelf_address' => $this->resolveShelfAddress($productMeta),
                'ordered_qty' => $orderedQty,
                'shipped_qty' => $shippedQty,
                'remaining_qty' => $remainingQty,
                'unit_price' => number_format((float) $item->unit_price, 2, '.', ''),
                'vat_rate' => number_format((float) $item->vat_rate, 2, '.', ''),
                'line_total_shipped' => number_format($lineTotalShipped, 2, '.', ''),
                'logo_stock' => [
                    'available_total' => $availableTotal,
                    'reserved_total' => (int) ($item->product?->stockSummary?->reserved_total ?? 0),
                    'updated_at' => $item->product?->stockSummary?->updated_at?->toIso8601String(),
                ],
            ];

            if ($remainingQty > 0) {
                $remainingItems[] = $payload;
            }

            if ($shippedQty > 0 && ! in_array($shipment->status, ['shipped', 'partially_shipped', 'cancelled'], true)) {
                $shippedItems[] = $payload;
            }
        }

        $remainingQtyTotal = max(0, $orderedQtyTotal - $shippedQtyTotal);

        return [
            'shipment' => [
                'id' => $shipment->id,
                'shipment_no' => $shipment->shipment_no,
                'status' => $shipment->status,
                'order_id' => $shipment->order_id,
                'warehouse_id' => $shipment->warehouse_id,
                'carrier_name' => $shipment->carrier_name,
                'tracking_no' => $shipment->tracking_no,
                'note' => $shipment->note,
                'shipped_at' => $shipment->shipped_at,
                'logo_sync_status' => $logoSyncState?->status,
                'logo_sync_error' => $logoSyncState?->last_error,
                'logo_external_ref' => $logoSyncState?->external_ref,
                'logo_last_synced_at' => $logoSyncState?->last_synced_at,
                'created_at' => $shipment->created_at,
                'updated_at' => $shipment->updated_at,
                'order' => [
                    'id' => $shipment->order?->id,
                    'order_no' => $shipment->order?->order_no,
                    'status' => $shipment->order?->status,
                    'currency' => $shipment->order?->currency,
                    'grand_total' => number_format((float) ($shipment->order?->grand_total ?? 0), 2, '.', ''),
                    'customer' => [
                        'id' => $customer?->id,
                        'code' => $customer?->code,
                        'title' => $customer?->name,
                        'city' => $this->resolveCustomerLocation($customer?->city, $customerMeta, 'city'),
                        'district' => $this->resolveCustomerLocation($customer?->district, $customerMeta, 'district'),
                        'address' => $this->resolveCustomerAddress($customerMeta),
                        'phone' => $this->resolveCustomerPhone($customer?->phone, $customerMeta),
                    ],
                ],
                'warehouse' => [
                    'id' => $shipment->warehouse?->id,
                    'code' => $shipment->warehouse?->code,
                    'name' => $shipment->warehouse?->name,
                ],
            ],
            'remaining_items' => array_values($remainingItems),
            'shipped_items' => array_values($shippedItems),
            'totals' => [
                'ordered_qty_total' => $orderedQtyTotal,
                'shipped_qty_total' => $shippedQtyTotal,
                'remaining_qty_total' => $remainingQtyTotal,
                'sent_amount' => number_format($sentAmount, 2, '.', ''),
                'gonderilen_tutar' => number_format($sentAmount, 2, '.', ''),
            ],
            'recent_scans' => $shipment->scans
                ->sortByDesc('scanned_at')
                ->take(50)
                ->values()
                ->map(fn (ShipmentScan $scan) => [
                    'id' => $scan->id,
                    'product_id' => $scan->product_id,
                    'barcode' => $scan->barcode,
                    'qty' => (int) $scan->qty,
                    'scanned_at' => $scan->scanned_at,
                    'scanned_by' => [
                        'id' => $scan->scannedBy?->id,
                        'name' => $scan->scannedBy?->name,
                    ],
                ])
                ->all(),
        ];
    }

    /**
     * @param  array<string, mixed>  $meta
     */
    private function resolveCustomerPhone(?string $phone, array $meta): ?string
    {
        $current = trim((string) $phone);
        if ($current !== '') {
            return $current;
        }

        foreach ([
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
        ] as $path) {
            $candidate = trim((string) data_get($meta, $path, ''));
            if ($candidate !== '') {
                return $candidate;
            }
        }

        return null;
    }

    /**
     * @param  array<string, mixed>  $meta
     */
    private function resolveCustomerLocation(?string $value, array $meta, string $field): ?string
    {
        $current = trim((string) $value);
        if ($current !== '') {
            return $current;
        }

        $paths = $field === 'city'
            ? [
                'integrations.logo.payload.raw.CITY',
                'integrations.logo.payload.raw.IL',
                'integrations.logo.payload.raw.PROVINCE',
                'integrations.logo.payload.city',
                'integrations.logo.payload.province',
            ]
            : [
                'integrations.logo.payload.raw.TOWN',
                'integrations.logo.payload.raw.DISTRICT',
                'integrations.logo.payload.raw.ILCE',
                'integrations.logo.payload.raw.İLÇE',
                'integrations.logo.payload.raw.COUNTY',
                'integrations.logo.payload.district',
                'integrations.logo.payload.town',
            ];

        foreach ($paths as $path) {
            $candidate = trim((string) data_get($meta, $path, ''));
            if ($candidate !== '') {
                return $candidate;
            }
        }

        return null;
    }

    /**
     * @param  array<string, mixed>  $meta
     */
    private function resolveCustomerAddress(array $meta): ?string
    {
        foreach ([
            'address',
            'full_address',
            'integrations.logo.payload.address',
            'integrations.logo.payload.full_address',
            'integrations.logo.payload.raw.ADDR1',
            'integrations.logo.payload.raw.ADDRESS',
            'integrations.logo.payload.raw.ADRES',
        ] as $path) {
            $candidate = trim((string) data_get($meta, $path, ''));
            if ($candidate !== '') {
                return $candidate;
            }
        }

        return null;
    }

    private function logoSyncState(string $domain, string $entityType, int $entityId): ?IntegrationSyncState
    {
        return IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', $domain)
            ->where('direction', 'outbound')
            ->where('entity_type', $entityType)
            ->where('entity_id', $entityId)
            ->latest('id')
            ->first();
    }

    private function ensureShipmentScope(User $user, Shipment $shipment): void
    {
        if ($user->hasRole('admin')) {
            return;
        }

        if (! $shipment->relationLoaded('order')) {
            $shipment->load('order');
        }

        if ($user->dealer_id === null || (int) $user->dealer_id !== (int) $shipment->order?->dealer_id) {
            abort(Response::HTTP_FORBIDDEN, 'Bu sevkiyata erisim yetkiniz yok.');
        }
    }

    private function ensureOrderScope(User $user, Order $order): void
    {
        if ($user->hasRole('admin')) {
            return;
        }

        if ($user->dealer_id === null || (int) $user->dealer_id !== (int) $order->dealer_id) {
            abort(Response::HTTP_FORBIDDEN, 'Bu siparis icin sevkiyat yetkiniz yok.');
        }
    }

    private function syncOrderShipmentStatus(Order $order, User $user, string $note): void
    {
        $orderItems = OrderItem::query()
            ->where('order_id', $order->id)
            ->lockForUpdate()
            ->get();

        $orderedTotal = (int) $orderItems->sum('quantity');
        $shippedTotal = (int) $orderItems->sum('shipped_qty');

        $nextStatus = 'approved';

        if ($shippedTotal > 0 && $shippedTotal < $orderedTotal) {
            $nextStatus = 'balance';
        }

        if ($orderedTotal > 0 && $shippedTotal >= $orderedTotal) {
            $nextStatus = 'shipped';
        }

        $this->updateOrderStatus($order, $nextStatus, $user, $note);
    }

    private function updateOrderStatus(Order $order, string $status, User $user, string $note): void
    {
        if ($order->status === $status) {
            return;
        }

        $order->status = $status;
        $order->save();

        OrderStatusHistory::create([
            'order_id' => $order->id,
            'status' => $status,
            'changed_by_user_id' => $user->id,
            'note' => $note,
            'created_at' => now(),
        ]);
    }

    private function findProductByBarcode(string $barcode): ?Product
    {
        $barcode = trim($barcode);

        $direct = Product::query()
            ->where('sku', $barcode)
            ->orWhere('oem_code', $barcode)
            ->first();

        if ($direct instanceof Product) {
            return $direct;
        }

        try {
            return Product::query()
                ->where('meta->barcode', $barcode)
                ->orWhereJsonContains('meta->barcodes', $barcode)
                ->first();
        } catch (\Throwable) {
            return null;
        }
    }

    /**
     * @param  array<string, mixed>  $meta
     */
    private function resolveShelfAddress(array $meta): ?string
    {
        foreach ([
            'shelf_address',
            'raf_address',
            'raf_adresi',
            'raf_bilgisi',
            'raf_bilgileri',
            'shelf',
            'raf',
            'location',
            'location_code',
            'integrations.logo.payload.shelf_address',
            'integrations.logo.payload.shelfaddress',
            'integrations.logo.payload.shelf_addr',
            'integrations.logo.payload.raf_address',
            'integrations.logo.payload.raf_adresi',
            'integrations.logo.payload.rafadresi',
            'integrations.logo.payload.raf_bilgisi',
            'integrations.logo.payload.rafbilgisi',
            'integrations.logo.payload.raf_bilgileri',
            'integrations.logo.payload.rafbilgileri',
            'integrations.logo.payload.shelf',
            'integrations.logo.payload.raf',
            'integrations.logo.payload.location',
            'integrations.logo.payload.location_code',
            'integrations.logo.payload.raw.SHELF_ADDRESS',
            'integrations.logo.payload.raw.SHELFADDRESS',
            'integrations.logo.payload.raw.SHELF_ADDR',
            'integrations.logo.payload.raw.RAF_ADDRESS',
            'integrations.logo.payload.raw.RAF_ADRESI',
            'integrations.logo.payload.raw.RAFADRESI',
            'integrations.logo.payload.raw.RAF_BILGISI',
            'integrations.logo.payload.raw.RAFBILGISI',
            'integrations.logo.payload.raw.RAF_BILGILERI',
            'integrations.logo.payload.raw.RAFBILGILERI',
            'integrations.logo.payload.raw.SHELF',
            'integrations.logo.payload.raw.RAF',
            'integrations.logo.payload.raw.LOCATION',
            'integrations.logo.payload.raw.LOCATION_CODE',
            'integrations.logo.payload.raw.LOCATIONCODE',
        ] as $path) {
            $value = data_get($meta, $path);

            if (is_scalar($value)) {
                $normalized = trim((string) $value);
                if ($normalized !== '') {
                    return $normalized;
                }
            }
        }

        return null;
    }

    private function resolveProductWarehouseAvailableTotal(
        ?Product $product,
        ?string $warehouseCode,
        ?string $warehouseName = null
    ): int {
        $warehouseStock = $this->resolveProductWarehouseStockSnapshot($product, $warehouseCode, $warehouseName);
        if ($warehouseStock !== null) {
            return $warehouseStock;
        }

        return max(0, (int) ($product?->stockSummary?->available_total ?? 0));
    }

    private function resolveProductWarehouseStockSnapshot(
        ?Product $product,
        ?string $warehouseCode,
        ?string $warehouseName = null
    ): ?int {
        $meta = is_array($product?->meta) ? $product->meta : [];
        $warehouses = data_get($meta, 'integrations.logo.payload.logo_stock.warehouses');
        $normalizedWarehouseCode = trim((string) $warehouseCode);
        $normalizedWarehouseName = trim((string) $warehouseName);

        if (is_array($warehouses) && ($normalizedWarehouseCode !== '' || $normalizedWarehouseName !== '')) {
            foreach ($warehouses as $warehouse) {
                if (! is_array($warehouse)) {
                    continue;
                }

                $code = $this->firstArrayScalar($warehouse, [
                    'warehouse_code',
                    'branch_code',
                    'code',
                    'invenno',
                    'warehouse_no',
                ]);
                $name = $this->firstArrayScalar($warehouse, [
                    'warehouse_name',
                    'branch_name',
                    'name',
                    'depo_adi',
                    'ambar_adi',
                    'branch',
                ]);

                if (! $this->warehouseIdentityMatches($code, $name, $normalizedWarehouseCode, $normalizedWarehouseName)) {
                    continue;
                }

                return $this->firstIntegerValue($warehouse, [
                    'available_total',
                    'available',
                    'onhand_total',
                    'onhand',
                    'stock',
                    'quantity',
                ]);
            }

            return 0;
        }

        return null;
    }

    private function warehouseIdentityMatches(
        ?string $candidateCode,
        ?string $candidateName,
        string $warehouseCode,
        string $warehouseName
    ): bool {
        if ($warehouseCode !== '' && $candidateCode !== null && $this->normalizeWarehouseIdentity($candidateCode) === $this->normalizeWarehouseIdentity($warehouseCode)) {
            return true;
        }

        if ($warehouseName !== '' && $candidateName !== null && $this->normalizeWarehouseIdentity($candidateName) === $this->normalizeWarehouseIdentity($warehouseName)) {
            return true;
        }

        return false;
    }

    private function normalizeWarehouseIdentity(string $value): string
    {
        return preg_replace('/[^A-Z0-9]+/', '', str($value)->trim()->upper()->ascii()->toString()) ?? '';
    }

    private function adjustProductWarehouseAvailableTotal(
        Product $product,
        ?string $warehouseCode,
        int $delta
    ): void {
        $normalizedWarehouseCode = trim((string) $warehouseCode);
        if ($normalizedWarehouseCode === '' || $delta === 0) {
            return;
        }

        $meta = is_array($product->meta) ? $product->meta : [];
        $warehouses = data_get($meta, 'integrations.logo.payload.logo_stock.warehouses');
        if (! is_array($warehouses)) {
            return;
        }

        $changed = false;

        foreach ($warehouses as $index => $warehouse) {
            if (! is_array($warehouse)) {
                continue;
            }

            $code = $this->firstArrayScalar($warehouse, [
                'warehouse_code',
                'branch_code',
                'code',
                'invenno',
                'warehouse_no',
            ]);

            if ($code !== $normalizedWarehouseCode) {
                continue;
            }

            $current = $this->firstIntegerValue($warehouse, [
                'available_total',
                'available',
                'onhand_total',
                'onhand',
                'stock',
                'quantity',
            ]);
            $warehouses[$index]['available_total'] = max(0, $current + $delta);
            $changed = true;
            break;
        }

        if (! $changed) {
            return;
        }

        data_set($meta, 'integrations.logo.payload.logo_stock.warehouses', $warehouses);
        $product->forceFill(['meta' => $meta])->save();
    }

    /**
     * @param  array<string, mixed>  $payload
     * @param  list<string>  $keys
     */
    private function firstArrayScalar(array $payload, array $keys): ?string
    {
        foreach ($keys as $key) {
            $candidate = $payload[$key] ?? null;

            if (! is_scalar($candidate)) {
                continue;
            }

            $normalized = trim((string) $candidate);
            if ($normalized !== '') {
                return $normalized;
            }
        }

        return null;
    }

    /**
     * @param  array<string, mixed>  $payload
     * @param  list<string>  $keys
     */
    private function firstIntegerValue(array $payload, array $keys): int
    {
        foreach ($keys as $key) {
            $candidate = $payload[$key] ?? null;

            if (is_numeric($candidate)) {
                return max(0, (int) $candidate);
            }
        }

        return 0;
    }

    private function generateShipmentNo(): string
    {
        do {
            $candidate = 'SHP-'.now()->format('YmdHis').'-'.Str::upper(Str::random(4));
            $exists = Shipment::query()->where('shipment_no', $candidate)->exists();
        } while ($exists);

        return $candidate;
    }
}
