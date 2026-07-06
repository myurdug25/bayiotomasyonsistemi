<?php

namespace Tests\Feature;

use App\Models\Dealer;
use App\Models\StockSummary;
use App\Models\User;
use App\Observers\RealtimeDomainObserver;
use App\Services\Realtime\RealtimeDomainEventPublisher;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Redis;
use Mockery;
use Tests\TestCase;

class RealtimeEventApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_realtime_events_are_returned_as_json_and_scoped_to_the_users_dealer(): void
    {
        $dealer = Dealer::query()->create([
            'code' => 'REALTIME-001',
            'name' => 'Realtime Dealer',
        ]);
        $otherDealer = Dealer::query()->create([
            'code' => 'REALTIME-002',
            'name' => 'Other Realtime Dealer',
        ]);
        $user = User::factory()->create(['dealer_id' => $dealer->id]);
        $redis = Mockery::mock();

        Redis::shouldReceive('connection')->once()->andReturn($redis);
        $redis->shouldReceive('lrange')->once()->with(
            config('realtime.event_list'),
            0,
            99
        )->andReturn([
            json_encode([
                'id' => 'own-event',
                'event' => 'collection_added',
                'dealer_id' => $dealer->id,
                'occurred_at' => now()->toIso8601String(),
            ]),
            json_encode([
                'id' => 'global-event',
                'event' => 'stock_updated',
                'dealer_id' => null,
                'occurred_at' => now()->toIso8601String(),
            ]),
            json_encode([
                'id' => 'other-event',
                'event' => 'collection_added',
                'dealer_id' => $otherDealer->id,
                'occurred_at' => now()->toIso8601String(),
            ]),
        ]);

        $this->actingAs($user)
            ->getJson('/api/realtime/events?limit=100')
            ->assertOk()
            ->assertHeader('Content-Type', 'application/json')
            ->assertJsonCount(2, 'data')
            ->assertJsonPath('data.0.id', 'own-event')
            ->assertJsonPath('data.1.id', 'global-event')
            ->assertJsonMissing(['id' => 'other-event']);
    }

    public function test_realtime_events_require_authentication(): void
    {
        $this->getJson('/api/realtime/events')->assertUnauthorized();
    }

    public function test_stock_timestamp_only_updates_do_not_publish_realtime_events(): void
    {
        $publisher = Mockery::mock(RealtimeDomainEventPublisher::class);
        $publisher->shouldReceive('publish')->never();
        $observer = new RealtimeDomainObserver($publisher);
        $stock = new StockSummary;
        $stock->setRawAttributes([
            'product_id' => 77,
            'available_total' => 12,
            'reserved_total' => 0,
            'updated_at' => now()->subMinute(),
        ], true);
        $stock->updated_at = now();
        $stock->syncChanges();

        $observer->updated($stock);
    }

    public function test_stock_quantity_updates_publish_one_realtime_event(): void
    {
        $publisher = Mockery::mock(RealtimeDomainEventPublisher::class);
        $publisher->shouldReceive('publish')
            ->once()
            ->with('stock_updated', [
                'product_id' => 77,
                'available_total' => 13,
                'reserved_total' => 0,
            ]);
        $observer = new RealtimeDomainObserver($publisher);
        $stock = new StockSummary;
        $stock->setRawAttributes([
            'product_id' => 77,
            'available_total' => 12,
            'reserved_total' => 0,
            'updated_at' => now()->subMinute(),
        ], true);
        $stock->available_total = 13;
        $stock->updated_at = now();
        $stock->syncChanges();

        $observer->updated($stock);
    }
}
