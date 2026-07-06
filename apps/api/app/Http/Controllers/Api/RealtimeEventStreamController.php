<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Redis;
use Throwable;

class RealtimeEventStreamController extends Controller
{
    public function __invoke(Request $request): JsonResponse
    {
        $user = $request->user();
        $isAdmin = $user->hasRole('admin');
        $dealerId = $user->dealer_id !== null ? (int) $user->dealer_id : null;
        $limit = min(100, max(1, (int) $request->integer('limit', 50)));

        try {
            $messages = Redis::connection((string) config('realtime.redis_connection', 'default'))
                ->lrange((string) config('realtime.event_list', 'powersa.domain-events:recent'), 0, $limit - 1);
        } catch (Throwable) {
            $messages = [];
        }

        $events = collect($messages)
            ->map(static fn (mixed $message): mixed => is_string($message) ? json_decode($message, true) : null)
            ->filter(static function (mixed $event) use ($isAdmin, $dealerId): bool {
                if (! is_array($event) || ! isset($event['id'], $event['event'])) {
                    return false;
                }

                $eventDealerId = isset($event['dealer_id']) ? (int) $event['dealer_id'] : null;

                return $isAdmin || $eventDealerId === null || $eventDealerId === $dealerId;
            })
            ->values()
            ->all();

        return response()->json([
            'data' => $events,
            'polled_at' => now()->toIso8601String(),
        ])->header('Cache-Control', 'no-store');
    }
}
