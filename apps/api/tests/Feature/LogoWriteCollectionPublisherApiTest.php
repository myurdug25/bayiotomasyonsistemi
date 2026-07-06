<?php

namespace Tests\Feature;

use App\Models\Cashbox;
use App\Models\Collection;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\IntegrationSyncEvent;
use App\Models\IntegrationSyncState;
use App\Models\LedgerEntry;
use App\Models\Role;
use App\Models\User;
use App\Services\Integrations\Logo\Contracts\LogoWriteTransport;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

class LogoWriteCollectionPublisherApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_collection_for_exportable_customer_queues_logo_event_after_send(): void
    {
        config()->set('integrations.logo.write.enabled', false);

        $dealer = Dealer::query()->create([
            'code' => 'DLR-COL-'.Str::upper(Str::random(4)),
            'name' => 'Collection Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);

        $cashbox = Cashbox::query()->create([
            'code' => '100.01.002',
            'name' => 'Ahmet Arac Kasasi',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'b2b',
            'source_reference' => '1001',
            'sync_status' => 'synced',
            'code' => 'CR-COL-001',
            'name' => 'Tahsilat Cari',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $this->postJson("/api/customers/{$customer->id}/collections", [
            'method' => 'cash',
            'amount' => 150,
            'note' => 'Cari odeme',
            'meta' => [
                'cashbox_id' => $cashbox->id,
            ],
        ])
            ->assertCreated()
            ->assertJsonPath('collection.meta.cashbox_id', $cashbox->id)
            ->assertJsonPath('collection.sync_status', 'draft');

        $collection = Collection::query()->latest('id')->firstOrFail();

        $this->assertFalse(
            LedgerEntry::query()->where('collection_id', $collection->id)->exists(),
            'Draft tahsilat gönderilmeden cari hesap hareketi yazılmamalı.'
        );

        $this->postJson("/api/customers/{$customer->id}/collections/{$collection->id}/send")
            ->assertOk()
            ->assertJsonPath('collection.sync_status', 'pending');

        $ledgerEntry = LedgerEntry::query()
            ->where('collection_id', $collection->id)
            ->firstOrFail();
        $this->assertSame('150.00', (string) $ledgerEntry->credit);
        $this->assertSame($cashbox->id, (int) data_get($ledgerEntry->meta, 'cashbox_id'));
        $this->assertSame($user->id, (int) $ledgerEntry->created_by_user_id);

        $state = IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', 'collections-write')
            ->where('direction', 'outbound')
            ->where('entity_type', Collection::class)
            ->where('entity_id', $collection->id)
            ->first();

        $this->assertNotNull($state);
        $this->assertSame('queued', $state->status);
        $this->assertSame('logo.collection.create', data_get($state->meta, 'event_type'));

        $event = IntegrationSyncEvent::query()
            ->where('integration_sync_state_id', $state->id)
            ->latest('id')
            ->first();

        $this->assertNotNull($event);
        $this->assertSame('queued', $event->status);
        $this->assertSame('logo.collection.create', data_get($event->meta, 'envelope.event_type'));
        $this->assertSame('CR-COL-001', data_get($event->meta, 'envelope.payload.customer_code'));
        $this->assertSame($cashbox->id, data_get($event->meta, 'envelope.payload.cashbox_id'));
        $this->assertSame('100.01.002', data_get($event->meta, 'envelope.payload.cashbox_code'));
        $this->assertSame('Ahmet Arac Kasasi', data_get($event->meta, 'envelope.payload.cashbox_name'));
        $this->assertSame('100.01.002', data_get($event->meta, 'envelope.payload.meta.cashbox.code'));
    }

    public function test_collection_event_is_marked_published_when_transport_succeeds(): void
    {
        config()->set('integrations.logo.write.enabled', true);
        config()->set('integrations.logo.write.transport', 'rabbitmq');

        $recorder = new class
        {
            /**
             * @var array<int, array<string, mixed>>
             */
            public array $items = [];
        };

        $this->app->instance(LogoWriteTransport::class, new class($recorder) implements LogoWriteTransport
        {
            public function __construct(private object $recorder) {}

            public function publish(array $envelope): void
            {
                $this->recorder->items[] = $envelope;
            }
        });

        $dealer = Dealer::query()->create([
            'code' => 'DLR-COL-PUB-'.Str::upper(Str::random(4)),
            'name' => 'Collection Published Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'b2b',
            'source_reference' => '1001',
            'sync_status' => 'synced',
            'code' => 'CR-COL-PUB',
            'name' => 'Tahsilat Publish Cari',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $this->postJson("/api/customers/{$customer->id}/collections", [
            'method' => 'cash',
            'amount' => 200,
            'note' => 'Cari odeme',
        ])
            ->assertCreated()
            ->assertJsonPath('collection.sync_status', 'draft');

        $collection = Collection::query()->latest('id')->firstOrFail();

        $this->postJson("/api/customers/{$customer->id}/collections/{$collection->id}/send")
            ->assertOk()
            ->assertJsonPath('collection.sync_status', 'pending');

        $state = IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', 'collections-write')
            ->where('entity_type', Collection::class)
            ->where('entity_id', $collection->id)
            ->first();

        $this->assertNotNull($state);
        $this->assertSame('published', $state->status);

        $event = IntegrationSyncEvent::query()
            ->where('integration_sync_state_id', $state->id)
            ->latest('id')
            ->first();

        $this->assertNotNull($event);
        $this->assertSame('published', $event->status);
        $this->assertCount(1, $recorder->items);
        $this->assertSame('logo.collection.create', $recorder->items[0]['event_type'] ?? null);
    }

    public function test_collections_can_be_queued_for_logo_with_bulk_send(): void
    {
        config()->set('integrations.logo.write.enabled', false);

        $dealer = Dealer::query()->create([
            'code' => 'DLR-COL-BULK-'.Str::upper(Str::random(4)),
            'name' => 'Collection Bulk Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'b2b',
            'source_reference' => '1001',
            'sync_status' => 'synced',
            'code' => 'CR-COL-BULK',
            'name' => 'Tahsilat Bulk Cari',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $firstId = (int) Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'source_reference' => null,
            'sync_status' => 'draft',
            'date' => '2026-05-01',
            'collection_date' => '2026-05-01',
            'method' => 'cash',
            'amount' => 150,
            'currency' => 'TRY',
            'note' => 'Cari odeme 1',
        ])->id;

        $secondId = (int) Collection::query()->create([
            'dealer_id' => $dealer->id,
            'customer_id' => $customer->id,
            'source_system' => 'b2b',
            'source_reference' => null,
            'sync_status' => 'draft',
            'date' => '2026-05-02',
            'collection_date' => '2026-05-02',
            'method' => 'transfer',
            'amount' => 250,
            'currency' => 'TRY',
            'note' => 'Havale aciklamasi',
        ])->id;

        $this->postJson("/api/customers/{$customer->id}/collections/send", [
            'collection_ids' => [$firstId, $secondId],
        ])
            ->assertOk()
            ->assertJsonPath('summary.received', 2)
            ->assertJsonPath('summary.queued', 2)
            ->assertJsonPath('summary.skipped', 0);

        $this->assertSame(2, Collection::query()->whereIn('id', [$firstId, $secondId])->where('sync_status', 'pending')->count());

        $this->assertSame(2, IntegrationSyncEvent::query()
            ->where('domain', 'collections-write')
            ->where('entity_type', Collection::class)
            ->whereIn('entity_id', [$firstId, $secondId])
            ->count());
    }

    public function test_factory_card_collection_is_marked_without_cashbox(): void
    {
        config()->set('integrations.logo.write.enabled', false);

        $dealer = Dealer::query()->create([
            'code' => 'DLR-COL-FAC-'.Str::upper(Str::random(4)),
            'name' => 'Collection Factory Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('salesperson', $dealer);
        $user->forceFill([
            'logo_cashbox_code' => '100.02.003',
            'logo_cashbox_name' => 'PLASIYER KASASI',
        ])->save();

        Cashbox::query()->create([
            'code' => '100.02.003',
            'name' => 'PLASIYER KASASI',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $user->id,
            'source_system' => 'b2b',
            'source_reference' => '1001',
            'sync_status' => 'synced',
            'code' => 'CR-COL-FAC',
            'name' => 'Fabrika Kart Cari',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $this->postJson("/api/customers/{$customer->id}/collections", [
            'method' => 'cc',
            'amount' => 3500,
            'note' => 'Fabrikaya gonderilen miktar',
            'reference_fields' => [
                'collection_channel' => 'factory',
                'factory_pos_account' => '120-61-031',
            ],
        ])
            ->assertCreated()
            ->assertJsonPath('collection.sync_status', 'draft')
            ->assertJsonPath('collection.meta.factory_collected', true)
            ->assertJsonPath('collection.reference_fields.collection_channel', 'factory')
            ->assertJsonPath('collection.reference_fields.factory_pos_account', '120-61-031')
            ->assertJsonPath('collection.reference_fields.factory_customer_code', '120-61-031')
            ->assertJsonPath('collection.reference_no', 'FBC0001')
            ->assertJsonPath('collection.note', 'FBC0001 Fabrika Kart Cari 120-61-031')
            ->assertJsonMissingPath('collection.meta.cashbox_id');
    }

    public function test_check_collection_over_standard_valor_goes_to_manager_review(): void
    {
        config()->set('integrations.logo.write.enabled', false);

        $dealer = Dealer::query()->create([
            'code' => 'DLR-COL-VAL-'.Str::upper(Str::random(4)),
            'name' => 'Collection Valor Dealer',
            'is_active' => true,
        ]);

        $user = $this->createUserWithRole('point', $dealer);

        $cashbox = Cashbox::query()->create([
            'code' => '100.03.004',
            'name' => 'Valor Kasasi',
            'is_active' => true,
        ]);

        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'b2b',
            'source_reference' => '1001',
            'sync_status' => 'synced',
            'code' => 'CR-COL-VAL',
            'name' => 'Valor Cari',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        $this->postJson("/api/customers/{$customer->id}/collections", [
            'method' => 'check',
            'amount' => 1500,
            'reference_fields' => [
                'bank_name' => 'Yapi Kredi',
                'check_no' => 'CHK-001',
                'due_date' => now()->addDays(75)->toDateString(),
                'valor_days' => 75,
            ],
            'meta' => [
                'cashbox_id' => $cashbox->id,
            ],
        ])
            ->assertCreated()
            ->assertJsonPath('collection.sync_status', 'reviewing')
            ->assertJsonPath('collection.reference_fields.requires_manager_approval', true)
            ->assertJsonPath('collection.reference_fields.manager_approval_reason', 'valor_limit_exceeded')
            ->assertJsonPath('collection.meta.manager_approval.status', 'reviewing')
            ->assertJsonPath('collection.meta.manager_approval.valor_days', 75)
            ->assertJsonPath('collection.meta.manager_approval.limit_days', 60);

        $collection = Collection::query()->latest('id')->firstOrFail();

        $this->postJson("/api/customers/{$customer->id}/collections/{$collection->id}/send")
            ->assertUnprocessable()
            ->assertJsonPath('errors.collection.0', 'Bu tahsilat müdür onayı bekliyor.');
    }

    public function test_physical_pos_uses_managed_bank_sequence_and_never_salesperson_cashbox(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-POS-FIN-'.Str::upper(Str::random(4)),
            'name' => 'Physical Pos Dealer',
            'is_active' => true,
        ]);
        $user = $this->createUserWithRole('salesperson', $dealer);
        $user->forceFill([
            'logo_cashbox_code' => '100.01.002',
            'logo_cashbox_name' => 'AHMET ARAÇ KASASI',
        ])->save();
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'salesperson_user_id' => $user->id,
            'source_system' => 'logo',
            'source_reference' => '1001',
            'sync_status' => 'synced',
            'code' => '120-25-999',
            'name' => 'ABC Ticaret',
            'is_active' => true,
        ]);

        $this->actingAs($user);

        foreach (['FP0001', 'FP0002'] as $expectedReference) {
            $this->postJson("/api/customers/{$customer->id}/collections", [
                'method' => 'cc',
                'amount' => 250,
                'note' => 'Kullanıcı bunu değiştirememeli',
                'reference_fields' => ['pos_bank' => 'yapi_kredi'],
            ])
                ->assertCreated()
                ->assertJsonPath('collection.reference_no', $expectedReference)
                ->assertJsonPath('collection.note', "{$expectedReference} ABC Ticaret YAPI KREDI")
                ->assertJsonPath('collection.reference_fields.collection_channel', 'physical_pos')
                ->assertJsonPath('collection.reference_fields.bank_logo_code', '02')
                ->assertJsonMissingPath('collection.meta.cashbox_id');
        }
    }

    public function test_transfer_uses_he_sequence_and_preview_does_not_consume_it(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'DLR-HE-'.Str::upper(Str::random(4)),
            'name' => 'Transfer Dealer',
            'is_active' => true,
        ]);
        $user = $this->createUserWithRole('point', $dealer);
        $customer = Customer::query()->create([
            'dealer_id' => $dealer->id,
            'source_system' => 'logo',
            'source_reference' => '2001',
            'sync_status' => 'synced',
            'code' => '120-25-998',
            'name' => 'Havale Cari',
            'is_active' => true,
        ]);

        $this->actingAs($user)
            ->getJson('/api/collections/next-sequence?type=transfer')
            ->assertOk()
            ->assertJsonPath('next_sequence', 'HE0001');

        $this->getJson('/api/collections/next-sequence?type=transfer')
            ->assertOk()
            ->assertJsonPath('next_sequence', 'HE0001');

        $this->postJson("/api/customers/{$customer->id}/collections", [
            'method' => 'transfer',
            'amount' => 500,
            'reference_fields' => ['bank_code' => 'ziraat_bankasi'],
        ])
            ->assertCreated()
            ->assertJsonPath('collection.reference_no', 'HE0001')
            ->assertJsonPath('collection.note', 'HE0001 Havale Cari ZIRAAT BANKASI')
            ->assertJsonMissingPath('collection.meta.cashbox_id');

        $this->getJson('/api/collections/next-sequence?type=transfer')
            ->assertOk()
            ->assertJsonPath('next_sequence', 'HE0002');
    }

    private function createUserWithRole(string $roleSlug, Dealer $dealer): User
    {
        $role = Role::query()->firstOrCreate(
            ['slug' => $roleSlug],
            ['name' => Str::headline(str_replace('_', ' ', $roleSlug))]
        );

        $user = User::factory()->create([
            'dealer_id' => $dealer->id,
            'is_active' => true,
        ]);

        $user->roles()->sync([$role->id]);

        return $user;
    }
}
