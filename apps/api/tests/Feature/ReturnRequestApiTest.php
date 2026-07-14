<?php

namespace Tests\Feature;

use App\Models\Brand;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\Order;
use App\Models\OrderItem;
use App\Models\Product;
use App\Models\ReturnRequest;
use App\Models\Role;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

class ReturnRequestApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_salesperson_can_create_and_list_return_request(): void
    {
        [$user, $order, $orderItem, $customer] = $this->createOrderContext('salesperson');

        $this->actingAs($user);

        $createResponse = $this->postJson('/api/returns', [
            'order_id' => $order->id,
            'order_item_id' => $orderItem->id,
            'request_type' => 'faulty',
            'reason_code' => 'defective_on_arrival',
            'reason_note' => 'Filtre kutudan kırık çıktı.',
            'quantity' => 1,
        ]);

        $createResponse
            ->assertCreated()
            ->assertJsonPath('data.request_type', 'faulty')
            ->assertJsonPath('data.status', 'submitted')
            ->assertJsonPath('data.customer.id', $customer->id)
            ->assertJsonPath('data.order.id', $order->id)
            ->assertJsonPath('data.product.id', $orderItem->product_id)
            ->assertJsonPath('data.quantity', 1);

        $listResponse = $this->getJson('/api/returns?limit=10');

        $listResponse
            ->assertOk()
            ->assertJsonPath('summary.total_count', 1)
            ->assertJsonPath('summary.submitted_count', 1)
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.order.id', $order->id)
            ->assertJsonPath('data.0.customer.id', $customer->id);
    }

    public function test_point_user_with_returns_permission_can_create_and_list_return_request(): void
    {
        [$user, $order, $orderItem, $customer] = $this->createOrderContext('point', [
            'menu_permissions' => ['dashboard', 'orders', 'returns'],
        ]);

        $this->actingAs($user);

        $createResponse = $this->postJson('/api/returns', [
            'order_id' => $order->id,
            'order_item_id' => $orderItem->id,
            'request_type' => 'return',
            'reason_code' => 'wrong_product_sent',
            'reason_note' => 'Kasadan iade talebi girildi.',
            'quantity' => 1,
        ]);

        $createResponse
            ->assertCreated()
            ->assertJsonPath('data.request_type', 'return')
            ->assertJsonPath('data.status', 'submitted')
            ->assertJsonPath('data.customer.id', $customer->id);

        $this
            ->getJson('/api/returns?limit=10')
            ->assertOk()
            ->assertJsonPath('summary.total_count', 1)
            ->assertJsonPath('data.0.customer.id', $customer->id);
    }

    public function test_return_request_quantity_cannot_exceed_order_item_quantity(): void
    {
        [$user, $order, $orderItem] = $this->createOrderContext('salesperson');

        $this->actingAs($user);

        $response = $this->postJson('/api/returns', [
            'order_id' => $order->id,
            'order_item_id' => $orderItem->id,
            'request_type' => 'damaged',
            'reason_code' => 'damaged_in_transit',
            'quantity' => $orderItem->quantity + 1,
        ]);

        $response
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['quantity']);
    }

    public function test_return_request_quantity_cannot_exceed_remaining_returnable_quantity(): void
    {
        [$user, $order, $orderItem] = $this->createOrderContext('salesperson');

        $this->actingAs($user);

        $this
            ->postJson('/api/returns', [
                'order_id' => $order->id,
                'order_item_id' => $orderItem->id,
                'request_type' => 'return',
                'reason_code' => 'wrong_product_sent',
                'quantity' => 1,
            ])
            ->assertCreated();

        $this
            ->getJson("/api/orders/{$order->id}")
            ->assertOk()
            ->assertJsonPath('order.items.0.returned_quantity', 1)
            ->assertJsonPath('order.items.0.returnable_quantity', 1);

        $this
            ->postJson('/api/returns', [
                'order_id' => $order->id,
                'order_item_id' => $orderItem->id,
                'request_type' => 'faulty',
                'reason_code' => 'defective_on_arrival',
                'quantity' => 2,
            ])
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['quantity']);
    }

    public function test_rejected_return_request_does_not_reduce_returnable_quantity(): void
    {
        [$user, $order, $orderItem] = $this->createOrderContext('salesperson');

        $this->actingAs($user);

        $createResponse = $this
            ->postJson('/api/returns', [
                'order_id' => $order->id,
                'order_item_id' => $orderItem->id,
                'request_type' => 'return',
                'reason_code' => 'wrong_product_sent',
                'quantity' => 2,
            ])
            ->assertCreated();

        $requestId = (int) $createResponse->json('data.id');

        $this
            ->patchJson("/api/returns/{$requestId}/status", [
                'status' => 'rejected',
                'resolution_note' => 'Yanlış talep.',
            ])
            ->assertOk();

        $this
            ->postJson('/api/returns', [
                'order_id' => $order->id,
                'order_item_id' => $orderItem->id,
                'request_type' => 'faulty',
                'reason_code' => 'defective_on_arrival',
                'quantity' => 2,
            ])
            ->assertCreated();
    }

    public function test_salesperson_can_move_return_request_through_review_flow(): void
    {
        [$user, $order, $orderItem] = $this->createOrderContext('salesperson');

        $this->actingAs($user);

        $createResponse = $this->postJson('/api/returns', [
            'order_id' => $order->id,
            'order_item_id' => $orderItem->id,
            'request_type' => 'damaged',
            'reason_code' => 'damaged_in_transit',
            'quantity' => 1,
        ]);

        $requestId = (int) $createResponse->json('data.id');

        $reviewResponse = $this->patchJson("/api/returns/{$requestId}/status", [
            'status' => 'reviewing',
            'resolution_note' => 'Ürün fiziksel incelemeye alındı.',
        ]);

        $reviewResponse
            ->assertOk()
            ->assertJsonPath('data.status', 'reviewing')
            ->assertJsonPath('data.reviewed_by.id', $user->id)
            ->assertJsonPath('data.resolution_note', 'Ürün fiziksel incelemeye alındı.');

        $approveResponse = $this->patchJson("/api/returns/{$requestId}/status", [
            'status' => 'approved',
            'resolution_note' => 'İade onaylandı.',
        ]);

        $approveResponse
            ->assertOk()
            ->assertJsonPath('data.status', 'approved')
            ->assertJsonPath('data.logo_sync_status', null)
            ->assertJsonPath('data.scrap_logo_sync_status', 'queued')
            ->assertJsonPath('data.resolution_note', 'İade onaylandı.');

        $this->assertDatabaseMissing('integration_sync_states', [
            'system' => 'logo',
            'domain' => 'returns',
            'direction' => 'outbound',
            'entity_type' => ReturnRequest::class,
            'entity_id' => $requestId,
            'status' => 'queued',
        ]);

        $this->assertDatabaseHas('integration_sync_states', [
            'system' => 'logo',
            'domain' => 'return-scraps',
            'direction' => 'outbound',
            'entity_type' => ReturnRequest::class,
            'entity_id' => $requestId,
            'status' => 'queued',
        ]);

        $this->assertDatabaseHas('ledger_entries', [
            'source_system' => 'b2b',
            'source_reference' => ReturnRequest::query()->findOrFail($requestId)->request_no,
            'type' => 'credit',
            'customer_id' => $order->customer_id,
            'credit' => '50.00',
        ]);
    }

    public function test_faulty_return_approval_creates_only_scrap_fiche_queue(): void
    {
        [$user, $order, $orderItem] = $this->createOrderContext('salesperson');

        $this->actingAs($user);

        $createResponse = $this->postJson('/api/returns', [
            'order_id' => $order->id,
            'order_item_id' => $orderItem->id,
            'request_type' => 'faulty',
            'reason_code' => 'defective_on_arrival',
            'quantity' => 1,
        ]);

        $requestId = (int) $createResponse->json('data.id');

        $this
            ->patchJson("/api/returns/{$requestId}/status", [
                'status' => 'approved',
                'resolution_note' => 'Arızalı ürün iadesi onaylandı.',
            ])
            ->assertOk()
            ->assertJsonPath('data.status', 'approved')
            ->assertJsonPath('data.request_type', 'faulty')
            ->assertJsonPath('data.logo_sync_status', null)
            ->assertJsonPath('data.scrap_logo_sync_status', 'queued');

        $this->assertDatabaseMissing('integration_sync_states', [
            'system' => 'logo',
            'domain' => 'returns',
            'direction' => 'outbound',
            'entity_type' => ReturnRequest::class,
            'entity_id' => $requestId,
        ]);

        $this->assertDatabaseHas('integration_sync_states', [
            'system' => 'logo',
            'domain' => 'return-scraps',
            'direction' => 'outbound',
            'entity_type' => ReturnRequest::class,
            'entity_id' => $requestId,
            'status' => 'queued',
        ]);
    }

    public function test_plain_return_approval_does_not_create_scrap_fiche_queue(): void
    {
        [$user, $order, $orderItem] = $this->createOrderContext('salesperson');

        $this->actingAs($user);

        $createResponse = $this->postJson('/api/returns', [
            'order_id' => $order->id,
            'order_item_id' => $orderItem->id,
            'request_type' => 'return',
            'reason_code' => 'wrong_product_sent',
            'quantity' => 1,
        ]);

        $requestId = (int) $createResponse->json('data.id');

        $this
            ->patchJson("/api/returns/{$requestId}/status", [
                'status' => 'approved',
            ])
            ->assertOk()
            ->assertJsonPath('data.status', 'approved')
            ->assertJsonPath('data.scrap_logo_sync_status', null);

        $this->assertDatabaseHas('integration_sync_states', [
            'system' => 'logo',
            'domain' => 'returns',
            'direction' => 'outbound',
            'entity_type' => ReturnRequest::class,
            'entity_id' => $requestId,
            'status' => 'queued',
        ]);

        $this->assertDatabaseHas('ledger_entries', [
            'source_system' => 'b2b',
            'source_reference' => ReturnRequest::query()->findOrFail($requestId)->request_no,
            'type' => 'credit',
            'customer_id' => $order->customer_id,
            'credit' => '50.00',
        ]);

        $this->assertDatabaseMissing('integration_sync_states', [
            'system' => 'logo',
            'domain' => 'return-scraps',
            'direction' => 'outbound',
            'entity_type' => ReturnRequest::class,
            'entity_id' => $requestId,
        ]);
    }

    public function test_completed_return_does_not_requeue_synced_logo_exports(): void
    {
        config(['integrations.logo.return_sync_key' => 'return-sync-key']);

        [$user, $order, $orderItem] = $this->createOrderContext('salesperson');

        $this->actingAs($user);

        $createResponse = $this->postJson('/api/returns', [
            'order_id' => $order->id,
            'order_item_id' => $orderItem->id,
            'request_type' => 'faulty',
            'reason_code' => 'defective_on_arrival',
            'quantity' => 1,
        ]);

        $requestId = (int) $createResponse->json('data.id');

        $this
            ->patchJson("/api/returns/{$requestId}/status", [
                'status' => 'approved',
                'resolution_note' => 'Logo aktarımı için onaylandı.',
            ])
            ->assertOk()
            ->assertJsonPath('data.logo_sync_status', null)
            ->assertJsonPath('data.scrap_logo_sync_status', 'queued');

        $this
            ->withHeader('X-Integration-Key', 'return-sync-key')
            ->postJson('/api/integrations/logo/return-scraps/ack', [
                'records' => [
                    [
                        'return_request_id' => $requestId,
                        'status' => 'synced',
                        'external_ref' => 'SCRAP-LOGO-001',
                    ],
                ],
            ])
            ->assertOk()
            ->assertJsonPath('summary.synced', 1);

        $this
            ->patchJson("/api/returns/{$requestId}/status", [
                'status' => 'completed',
                'resolution_note' => 'Logo aktarımı tamamlandı.',
            ])
            ->assertOk()
            ->assertJsonPath('data.status', ReturnRequest::STATUS_COMPLETED)
            ->assertJsonPath('data.logo_sync_status', null)
            ->assertJsonPath('data.logo_external_ref', null)
            ->assertJsonPath('data.scrap_logo_sync_status', 'synced')
            ->assertJsonPath('data.scrap_logo_external_ref', 'SCRAP-LOGO-001');
    }

    public function test_completed_return_without_existing_logo_state_queues_exports(): void
    {
        [$user, $order, $orderItem] = $this->createOrderContext('salesperson');

        $this->actingAs($user);

        $createResponse = $this->postJson('/api/returns', [
            'order_id' => $order->id,
            'order_item_id' => $orderItem->id,
            'request_type' => 'faulty',
            'reason_code' => 'defective_on_arrival',
            'quantity' => 1,
        ]);

        $requestId = (int) $createResponse->json('data.id');

        $this
            ->patchJson("/api/returns/{$requestId}/status", [
                'status' => 'reviewing',
            ])
            ->assertOk()
            ->assertJsonPath('data.logo_sync_status', null)
            ->assertJsonPath('data.scrap_logo_sync_status', null);

        $this
            ->patchJson("/api/returns/{$requestId}/status", [
                'status' => 'completed',
                'resolution_note' => 'Doğrudan tamamlandı.',
            ])
            ->assertOk()
            ->assertJsonPath('data.status', ReturnRequest::STATUS_COMPLETED)
            ->assertJsonPath('data.logo_sync_status', null)
            ->assertJsonPath('data.scrap_logo_sync_status', 'queued');
    }

    public function test_dealer_admin_cannot_update_return_request_status(): void
    {
        [$user, $order, $orderItem] = $this->createOrderContext('dealer_admin');

        $this->actingAs($user);

        $createResponse = $this->postJson('/api/returns', [
            'order_id' => $order->id,
            'order_item_id' => $orderItem->id,
            'request_type' => 'faulty',
            'reason_code' => 'defective_on_arrival',
            'quantity' => 1,
        ]);

        $requestId = (int) $createResponse->json('data.id');

        $response = $this->patchJson("/api/returns/{$requestId}/status", [
            'status' => 'reviewing',
        ]);

        $response->assertForbidden();
    }

    /**
     * @return array{0: User, 1: Order, 2: OrderItem, 3: Customer}
     */
    private function createOrderContext(string $roleSlug, array $userOverrides = []): array
    {
        $dealer = $this->createDealer('DLR-RET-'.Str::upper(Str::random(4)));
        $user = $this->createUserWithRole($roleSlug, $dealer, $userOverrides);
        $customer = $this->createCustomer(
            $dealer,
            'RET-001',
            'İade Test Carisi',
            $roleSlug === 'salesperson' ? $user : null
        );
        $brand = Brand::query()->create([
            'name' => 'Return Brand',
            'slug' => 'return-brand-'.Str::lower(Str::random(4)),
            'is_active' => true,
        ]);

        $product = Product::withoutEvents(function () use ($brand): Product {
            return Product::query()->create([
                'sku' => 'RET-SKU-'.Str::upper(Str::random(4)),
                'oem_code' => 'RET-OEM-'.Str::upper(Str::random(4)),
                'name' => 'İade Test Ürünü',
                'brand_id' => $brand->id,
                'vat_rate' => 20,
                'is_active' => true,
            ]);
        });

        $order = Order::query()->create([
            'order_no' => 'ORD-RET-'.Str::upper(Str::random(6)),
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'user_id' => $user->id,
            'status' => 'completed',
            'currency' => 'TRY',
            'subtotal' => 100.00,
            'discount_total' => 0,
            'tax_total' => 20.00,
            'grand_total' => 120.00,
            'ordered_at' => now()->subDays(2),
            'approved_at' => now()->subDays(2),
            'note' => 'Return request test order',
        ]);

        $orderItem = OrderItem::query()->create([
            'order_id' => $order->id,
            'product_id' => $product->id,
            'quantity' => 2,
            'shipped_qty' => 2,
            'unit_net_price' => 50.00,
            'discount_rate' => 0,
            'tax_rate' => 20,
            'line_total' => 100.00,
            'currency' => 'TRY',
        ]);

        return [$user, $order, $orderItem, $customer];
    }

    private function createDealer(string $code): Dealer
    {
        return Dealer::query()->create([
            'code' => $code,
            'name' => 'Dealer '.$code,
            'is_active' => true,
        ]);
    }

    private function createCustomer(Dealer $dealer, string $code, string $name, ?User $salesperson = null): Customer
    {
        return Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $salesperson?->id,
            'code' => $code,
            'name' => $name,
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
            'is_active' => true,
        ], $overrides));

        $user->roles()->sync([$role->id]);

        return $user;
    }
}
