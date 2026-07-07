<?php

namespace Tests\Feature;

use App\Models\Customer;
use App\Models\Dealer;
use App\Models\IntegrationSyncState;
use App\Models\Order;
use App\Models\OrderItem;
use App\Models\OrderStatusHistory;
use App\Models\Product;
use App\Models\Role;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;
use Tests\TestCase;

class OrderListApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_salesperson_lists_only_own_dealer_orders(): void
    {
        $dealerA = $this->createDealer('DLR-ORD-A');
        $dealerB = $this->createDealer('DLR-ORD-B');

        $salesA = $this->createUserWithRole('salesperson', $dealerA);
        $salesB = $this->createUserWithRole('salesperson', $dealerB);

        $this->createOrder($dealerA, $salesA, [
            'order_no' => 'ORD-LIST-001',
            'customer_name' => 'A Servis',
        ]);

        $this->createOrder($dealerB, $salesB, [
            'order_no' => 'ORD-LIST-002',
            'customer_name' => 'B Servis',
        ]);

        $this->actingAs($salesA);

        $response = $this->getJson('/api/orders?limit=50');

        $response
            ->assertOk()
            ->assertJsonPath('limit', 50)
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.order_no', 'ORD-LIST-001');
    }

    public function test_salesperson_lists_only_assigned_customer_orders_within_same_dealer(): void
    {
        $dealer = $this->createDealer('DLR-ORD-ASG');
        $salesA = $this->createUserWithRole('salesperson', $dealer);
        $salesB = $this->createUserWithRole('salesperson', $dealer);

        $this->createOrder($dealer, $salesA, [
            'order_no' => 'ORD-ASG-001',
            'customer_name' => 'Atanmis Cari',
        ]);

        $this->createOrder($dealer, $salesB, [
            'order_no' => 'ORD-ASG-002',
            'customer_name' => 'Diger Cari',
        ]);

        $this->actingAs($salesA);

        $this->getJson('/api/orders?limit=50')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.order_no', 'ORD-ASG-001');
    }

    public function test_orders_list_supports_status_and_query_filters(): void
    {
        $dealer = $this->createDealer('DLR-ORD-FLT');
        $sales = $this->createUserWithRole('salesperson', $dealer);

        $this->createOrder($dealer, $sales, [
            'order_no' => 'ORD-PEND-001',
            'status' => 'pending',
            'customer_name' => 'Alfa Otomotiv',
        ]);

        $this->createOrder($dealer, $sales, [
            'order_no' => 'ORD-SHIPPED-001',
            'status' => 'shipped',
            'customer_name' => 'Beta Lastik',
            'shipped_qty' => 3,
            'quantity' => 3,
        ]);

        $this->actingAs($sales);

        $response = $this->getJson('/api/orders?status=shipped&q=beta');

        $response
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.order_no', 'ORD-SHIPPED-001')
            ->assertJsonPath('data.0.status', 'shipped')
            ->assertJsonPath('data.0.customer.title', 'Beta Lastik');
    }

    public function test_legacy_partial_shipment_is_listed_as_balance(): void
    {
        $dealer = $this->createDealer('DLR-ORD-BAL');
        $sales = $this->createUserWithRole('salesperson', $dealer);

        $order = $this->createOrder($dealer, $sales, [
            'order_no' => 'ORD-BAL-001',
            'status' => 'partially_shipped',
            'quantity' => 3,
            'shipped_qty' => 2,
        ]);

        $this->actingAs($sales);

        $this->getJson('/api/orders?status=balance')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.order_no', 'ORD-BAL-001')
            ->assertJsonPath('data.0.status', 'balance')
            ->assertJsonPath('data.0.remaining_quantity', 1);

        $this->getJson('/api/orders/'.$order->id)
            ->assertOk()
            ->assertJsonPath('order.status', 'balance')
            ->assertJsonPath('order.items.0.shipped_qty', 2)
            ->assertJsonPath('order.items.0.remaining_quantity', 1);
    }

    public function test_orders_list_returns_totals_and_timeline_summary(): void
    {
        $dealer = $this->createDealer('DLR-ORD-SUM');
        $sales = $this->createUserWithRole('salesperson', $dealer);

        $targetOrder = $this->createOrder($dealer, $sales, [
            'order_no' => 'ORD-SUM-001',
            'status' => 'approved',
            'customer_name' => 'Gamma Servis',
        ]);

        IntegrationSyncState::query()->create([
            'system' => 'logo',
            'domain' => 'orders',
            'direction' => 'outbound',
            'entity_type' => Order::class,
            'entity_id' => $targetOrder->id,
            'dealer_id' => $dealer->id,
            'customer_id' => $targetOrder->customer_id,
            'status' => 'failed',
            'external_ref' => 'ORFICHE-TEST-001',
            'last_error' => 'Logo test hatasi',
        ]);

        $this->createOrder($dealer, $sales, [
            'order_no' => 'ORD-SUM-002',
            'status' => 'pending',
            'customer_name' => 'Delta Servis',
        ]);

        $this->appendStatusHistory($targetOrder, 'pending', $sales, 'Created');
        $this->appendStatusHistory($targetOrder, 'approved', $sales, 'Approved');

        $this->actingAs($sales);

        $response = $this->getJson('/api/orders?status=approved&limit=20');

        $response
            ->assertOk()
            ->assertJsonPath('summary.totals.order_count', 1)
            ->assertJsonPath('summary.status_timeline_summary.total_events', 2)
            ->assertJsonPath('data.0.order_no', 'ORD-SUM-001')
            ->assertJsonPath('data.0.logo_sync_status', 'failed')
            ->assertJsonPath('data.0.logo_sync_error', 'Logo test hatasi')
            ->assertJsonPath('data.0.logo_external_ref', 'ORFICHE-TEST-001')
            ->assertJsonPath('data.0.totals.item_count', 1)
            ->assertJsonPath('data.0.status_timeline_summary.total_events', 2)
            ->assertJsonPath('data.0.status_timeline_summary.last_event.status', 'approved');
    }

    public function test_warehouse_role_cannot_list_orders(): void
    {
        $dealer = $this->createDealer('DLR-ORD-WH');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer);

        $this->actingAs($warehouseUser);

        $this->getJson('/api/orders')
            ->assertForbidden();
    }

    public function test_warehouse_user_with_orders_menu_can_list_orders(): void
    {
        $dealer = $this->createDealer('DLR-ORD-WH-MENU');
        $warehouseUser = $this->createUserWithRole('warehouse', $dealer, [
            'menu_permissions' => ['warehouse', 'orders'],
        ]);

        $this->createOrder($dealer, $warehouseUser, [
            'order_no' => 'ORD-WH-MENU-001',
            'customer_name' => 'Depo Yetkili Cari',
        ]);

        $this->actingAs($warehouseUser);

        $this->getJson('/api/orders?limit=50')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.order_no', 'ORD-WH-MENU-001');
    }

    public function test_admin_can_filter_orders_by_dealer(): void
    {
        $dealerA = $this->createDealer('DLR-ORD-ADM-A');
        $dealerB = $this->createDealer('DLR-ORD-ADM-B');

        $admin = $this->createUserWithRole('admin');
        $salesA = $this->createUserWithRole('salesperson', $dealerA);
        $salesB = $this->createUserWithRole('salesperson', $dealerB);

        $this->createOrder($dealerA, $salesA, ['order_no' => 'ORD-ADM-001']);
        $this->createOrder($dealerB, $salesB, ['order_no' => 'ORD-ADM-002']);

        $this->actingAs($admin);

        $response = $this->getJson('/api/orders?dealer_id='.$dealerA->id);

        $response
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.order_no', 'ORD-ADM-001')
            ->assertJsonPath('data.0.dealer_id', $dealerA->id);
    }

    public function test_branch_scoped_user_lists_only_branch_orders(): void
    {
        $dealer = $this->createDealer('DLR-ORD-BRANCH');
        $branchUser = $this->createUserWithRole('dealer_admin', $dealer, [
            'customer_scope' => 'branch',
            'region_code' => 'KARADENIZ',
            'branch_code' => 'TRABZON',
        ]);
        $sales = $this->createUserWithRole('salesperson', $dealer);

        $this->createOrder($dealer, $sales, [
            'order_no' => 'ORD-BR-001',
            'customer_name' => 'Trabzon Cari',
            'customer_region_code' => 'KARADENIZ',
            'customer_branch_code' => 'TRABZON',
        ]);

        $this->createOrder($dealer, $sales, [
            'order_no' => 'ORD-BR-002',
            'customer_name' => 'Samsun Cari',
            'customer_region_code' => 'KARADENIZ',
            'customer_branch_code' => 'SAMSUN',
        ]);

        $this->actingAs($branchUser);

        $this->getJson('/api/orders?limit=50')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.order_no', 'ORD-BR-001');
    }

    public function test_salesperson_order_list_includes_selected_context_customer(): void
    {
        $dealer = $this->createDealer('DLR-ORD-CTX');
        $salesA = $this->createUserWithRole('salesperson', $dealer);
        $salesB = $this->createUserWithRole('salesperson', $dealer);

        $this->createOrder($dealer, $salesA, [
            'order_no' => 'ORD-CTX-001',
            'customer_name' => 'Assigned Cari',
        ]);

        $selectedOrder = $this->createOrder($dealer, $salesB, [
            'order_no' => 'ORD-CTX-002',
            'customer_name' => 'Selected Cari',
        ]);

        $salesA->forceFill([
            'selected_customer_id' => $selectedOrder->customer_id,
        ])->save();

        $this->actingAs($salesA);

        $this->getJson('/api/orders?limit=50')
            ->assertOk()
            ->assertJsonPath('summary.totals.order_count', 2)
            ->assertJsonCount(2, 'data')
            ->assertJsonFragment(['order_no' => 'ORD-CTX-001'])
            ->assertJsonFragment(['order_no' => 'ORD-CTX-002']);
    }

    public function test_salesperson_order_list_uses_logo_specode4_filter_over_assigned_scope(): void
    {
        $dealer = $this->createDealer('DLR-ORD-SP4');
        $sales = $this->createUserWithRole('salesperson', $dealer, [
            'logo_customer_specode4' => 'A',
        ]);
        $otherSales = $this->createUserWithRole('salesperson', $dealer);

        $this->createOrder($dealer, $otherSales, [
            'order_no' => 'ORD-SP4-001',
            'customer_name' => 'Specode A Cari',
            'customer_meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'specode4' => 'A',
                        ],
                    ],
                ],
            ],
        ]);

        $this->createOrder($dealer, $sales, [
            'order_no' => 'ORD-SP4-002',
            'customer_name' => 'Specode B Cari',
            'customer_meta' => [
                'integrations' => [
                    'logo' => [
                        'payload' => [
                            'specode4' => 'B',
                        ],
                    ],
                ],
            ],
        ]);

        $this->actingAs($sales);

        $this->getJson('/api/orders?limit=50')
            ->assertOk()
            ->assertJsonPath('summary.totals.order_count', 1)
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.order_no', 'ORD-SP4-001');
    }

    private function createDealer(string $code): Dealer
    {
        return Dealer::query()->create([
            'code' => $code,
            'name' => 'Dealer '.$code,
            'is_active' => true,
        ]);
    }

    private function createUserWithRole(string $roleSlug, ?Dealer $dealer = null, array $overrides = []): User
    {
        $role = Role::query()->firstOrCreate(
            ['slug' => $roleSlug],
            ['name' => Str::headline(str_replace('_', ' ', $roleSlug))]
        );

        $user = User::factory()->create(array_merge([
            'dealer_id' => $dealer?->id,
            'customer_scope' => $roleSlug === 'salesperson' ? 'assigned' : 'dealer',
            'region_code' => null,
            'branch_code' => null,
            'is_active' => true,
        ], $overrides));

        $user->roles()->sync([$role->id]);

        return $user;
    }

    /**
     * @param  array<string, mixed>  $overrides
     */
    private function createOrder(Dealer $dealer, User $user, array $overrides = []): Order
    {
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $user->hasRole('salesperson') ? $user->id : null,
            'region_code' => $overrides['customer_region_code'] ?? null,
            'branch_code' => $overrides['customer_branch_code'] ?? null,
            'code' => (string) ($overrides['customer_code'] ?? ('CR-'.Str::upper(Str::random(5)))),
            'name' => (string) ($overrides['customer_name'] ?? 'Order Test Customer'),
            'meta' => $overrides['customer_meta'] ?? null,
            'is_active' => true,
        ]);

        $product = Product::withoutEvents(function () use ($overrides): Product {
            return Product::query()->create([
                'sku' => (string) ($overrides['sku'] ?? ('SKU-'.Str::upper(Str::random(6)))),
                'oem_code' => (string) ($overrides['oem_code'] ?? ('OEM-'.Str::upper(Str::random(6)))),
                'name' => (string) ($overrides['product_name'] ?? 'Order Test Product'),
                'vat_rate' => 20,
                'is_active' => true,
            ]);
        });

        $quantity = (int) ($overrides['quantity'] ?? 4);
        $shippedQty = (int) ($overrides['shipped_qty'] ?? 1);
        $unitNetPrice = (float) ($overrides['unit_net_price'] ?? 100);
        $lineTotal = (float) ($quantity * $unitNetPrice);
        $taxTotal = (float) ($lineTotal * 0.20);

        $order = Order::query()->create([
            'order_no' => (string) ($overrides['order_no'] ?? ('ORD-'.Str::upper(Str::random(8)))),
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'user_id' => $user->id,
            'status' => (string) ($overrides['status'] ?? 'pending'),
            'currency' => 'TRY',
            'subtotal' => $lineTotal,
            'discount_total' => 0,
            'tax_total' => $taxTotal,
            'grand_total' => $lineTotal + $taxTotal,
            'ordered_at' => $overrides['ordered_at'] ?? Carbon::now()->subMinutes(random_int(1, 60)),
            'approved_at' => $overrides['approved_at'] ?? null,
        ]);

        OrderItem::query()->create([
            'order_id' => $order->id,
            'product_id' => $product->id,
            'quantity' => $quantity,
            'shipped_qty' => $shippedQty,
            'unit_net_price' => $unitNetPrice,
            'discount_rate' => 0,
            'tax_rate' => 20,
            'line_total' => $lineTotal,
            'currency' => 'TRY',
        ]);

        return $order;
    }

    private function appendStatusHistory(Order $order, string $status, User $changedBy, ?string $note = null): void
    {
        OrderStatusHistory::query()->create([
            'order_id' => $order->id,
            'status' => $status,
            'changed_by_user_id' => $changedBy->id,
            'note' => $note,
            'created_at' => Carbon::now(),
        ]);
    }
}
