<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\UserNotification;
use App\Services\Notifications\UserNotificationService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Schema;
use Symfony\Component\HttpFoundation\Response;

class UserNotificationController extends Controller
{
    public function __construct(private readonly UserNotificationService $notificationService) {}

    public function index(Request $request): JsonResponse
    {
        $user = $request->user();
        $status = trim((string) $request->query('status', 'active'));
        $limit = min(max((int) $request->integer('limit', 20), 1), 100);

        if (! Schema::hasTable('user_notifications')) {
            return response()->json([
                'data' => [],
                'unread_count' => 0,
            ]);
        }

        $query = UserNotification::query()
            ->where('user_id', (int) $user->id)
            ->orderByDesc('created_at')
            ->orderByDesc('id')
            ->limit(max($limit * 5, 100));

        if ($status === 'unread') {
            $query->where('status', 'unread');
        } elseif ($status === 'read') {
            $query->where('status', 'read');
        } elseif ($status !== 'all') {
            $query->where('status', '!=', 'archived');
        }

        $notifications = $query->get()
            ->filter(fn (UserNotification $notification): bool => $this->notificationService->canUserSeeNotification(
                $user,
                $notification->dealer_id !== null ? (int) $notification->dealer_id : null,
                is_array($notification->meta) ? $notification->meta : [],
            ))
            ->take($limit)
            ->values();

        $unreadCount = UserNotification::query()
            ->where('user_id', (int) $user->id)
            ->where('status', 'unread')
            ->get()
            ->filter(fn (UserNotification $notification): bool => $this->notificationService->canUserSeeNotification(
                $user,
                $notification->dealer_id !== null ? (int) $notification->dealer_id : null,
                is_array($notification->meta) ? $notification->meta : [],
            ))
            ->count();

        return response()->json([
            'data' => $notifications->map(fn (UserNotification $notification): array => $this->serialize($notification))->values(),
            'unread_count' => $unreadCount,
        ]);
    }

    public function read(Request $request, UserNotification $notification): JsonResponse
    {
        $this->ensureOwnNotification($request, $notification);

        if ($notification->status === 'unread') {
            $notification->forceFill([
                'status' => 'read',
                'read_at' => now(),
            ])->save();
        }

        return response()->json(['data' => $this->serialize($notification->fresh())]);
    }

    public function archive(Request $request, UserNotification $notification): JsonResponse
    {
        $this->ensureOwnNotification($request, $notification);

        $notification->forceFill([
            'status' => 'archived',
            'archived_at' => now(),
            'read_at' => $notification->read_at ?? now(),
        ])->save();

        return response()->json(['data' => $this->serialize($notification->fresh())]);
    }

    public function readAll(Request $request): JsonResponse
    {
        if (! Schema::hasTable('user_notifications')) {
            return response()->json([
                'updated_count' => 0,
                'unread_count' => 0,
            ]);
        }

        $now = now();
        $notifications = $this->visibleNotifications($request)
            ->filter(fn (UserNotification $notification): bool => $notification->status === 'unread')
            ->values();

        UserNotification::query()
            ->whereIn('id', $notifications->pluck('id')->all())
            ->update([
                'status' => 'read',
                'read_at' => $now,
                'updated_at' => $now,
            ]);

        return response()->json([
            'updated_count' => $notifications->count(),
            'unread_count' => $this->visibleUnreadCount($request),
        ]);
    }

    public function archiveAll(Request $request): JsonResponse
    {
        if (! Schema::hasTable('user_notifications')) {
            return response()->json([
                'archived_count' => 0,
                'unread_count' => 0,
            ]);
        }

        $now = now();
        $notifications = $this->visibleNotifications($request)
            ->filter(fn (UserNotification $notification): bool => $notification->status !== 'archived')
            ->values();

        UserNotification::query()
            ->whereIn('id', $notifications->pluck('id')->all())
            ->update([
                'status' => 'archived',
                'read_at' => $now,
                'archived_at' => $now,
                'updated_at' => $now,
            ]);

        return response()->json([
            'archived_count' => $notifications->count(),
            'unread_count' => $this->visibleUnreadCount($request),
        ]);
    }

    private function ensureOwnNotification(Request $request, UserNotification $notification): void
    {
        if ((int) $notification->user_id !== (int) $request->user()->id) {
            abort(Response::HTTP_FORBIDDEN, 'Notification belongs to another user.');
        }
    }

    private function visibleNotifications(Request $request)
    {
        $user = $request->user();

        return UserNotification::query()
            ->where('user_id', (int) $user->id)
            ->get()
            ->filter(fn (UserNotification $notification): bool => $this->notificationService->canUserSeeNotification(
                $user,
                $notification->dealer_id !== null ? (int) $notification->dealer_id : null,
                is_array($notification->meta) ? $notification->meta : [],
            ));
    }

    private function visibleUnreadCount(Request $request): int
    {
        return $this->visibleNotifications($request)
            ->filter(fn (UserNotification $notification): bool => $notification->status === 'unread')
            ->count();
    }

    private function serialize(UserNotification $notification): array
    {
        return [
            'id' => $notification->id,
            'type' => $notification->type,
            'title' => $notification->title,
            'body' => $notification->body,
            'url' => $notification->url,
            'status' => $notification->status,
            'meta' => $notification->meta,
            'created_at' => $notification->created_at?->toJSON(),
            'read_at' => $notification->read_at?->toJSON(),
            'archived_at' => $notification->archived_at?->toJSON(),
        ];
    }
}
