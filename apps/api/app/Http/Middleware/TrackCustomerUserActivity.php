<?php

namespace App\Http\Middleware;

use App\Models\User;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Symfony\Component\HttpFoundation\Response;

class TrackCustomerUserActivity
{
    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();

        if (! $user instanceof User || ! $user->hasRole('customer')) {
            return $next($request);
        }

        $lastActivity = $user->last_activity_at ?? $user->updated_at ?? $user->created_at;
        if ($lastActivity?->lt(now()->subDays(30))) {
            $user->forceFill(['is_active' => false])->saveQuietly();
            Auth::guard('web')->logout();
            $request->session()->invalidate();
            $request->session()->regenerateToken();

            return response()->json([
                'message' => 'Hesabınız pasif duruma alınmıştır. Lütfen mağaza ile iletişime geçiniz.',
            ], Response::HTTP_FORBIDDEN);
        }

        if ($user->last_activity_at === null || $user->last_activity_at->lt(now()->subMinutes(5))) {
            $user->forceFill(['last_activity_at' => now()])->saveQuietly();
        }

        return $next($request);
    }
}
