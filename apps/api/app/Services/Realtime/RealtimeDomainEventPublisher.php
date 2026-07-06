<?php

namespace App\Services\Realtime;

use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Redis;
use Throwable;

class RealtimeDomainEventPublisher
{
    /**
     * @param  array<string, mixed>  $payload
     */
    public function publish(string $event, array $payload = [], ?int $dealerId = null): void
    {
        if (! config('realtime.enabled', true)) {
            return;
        }

        $eventData = [
            'id' => bin2hex(random_bytes(12)),
            'event' => $event,
            'dealer_id' => $dealerId,
            'occurred_at' => now()->toIso8601String(),
            'payload' => $payload,
        ];
        $message = json_encode($eventData, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        if (! is_string($message)) {
            return;
        }

        try {
            $redis = Redis::connection((string) config('realtime.redis_connection', 'default'));
            $eventList = (string) config('realtime.event_list', 'powersa.domain-events:recent');

            $redis->lpush($eventList, $message);
            $redis->ltrim($eventList, 0, max(1, (int) config('realtime.event_list_limit', 250)) - 1);
            $redis->expire($eventList, max(60, (int) config('realtime.event_list_ttl', 3600)));
            $redis->publish((string) config('realtime.channel', 'powersa.domain-events'), $message);
        } catch (Throwable $exception) {
            Log::warning('Realtime domain event could not be published.', [
                'event' => $event,
                'error' => $exception->getMessage(),
            ]);
        }
    }
}
