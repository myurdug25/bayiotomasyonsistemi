<?php

namespace App\Http\Middleware;

use App\Support\MenuPermissions;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class EnsureUserHasRole
{
    public function handle(Request $request, Closure $next, string ...$roles): Response
    {
        $user = $request->user();

        if (! $user) {
            abort(Response::HTTP_UNAUTHORIZED, 'Unauthenticated.');
        }

        if (empty($roles)) {
            abort(Response::HTTP_FORBIDDEN, 'This action is unauthorized for your role.');
        }

        if ($user->hasAnyRole($roles)) {
            return $next($request);
        }

        $routeMenuPermissions = $this->routeMenuPermissions($request);
        if (
            $routeMenuPermissions !== []
            && array_intersect(MenuPermissions::forUser($user), $routeMenuPermissions) !== []
        ) {
            return $next($request);
        }

        abort(Response::HTTP_FORBIDDEN, 'This action is unauthorized for your role.');
    }

    /**
     * A moderator-assigned menu permission may satisfy a role gate only when
     * the same route is also protected by that explicit menu permission.
     * Role-only admin routes therefore remain role-only.
     *
     * @return list<string>
     */
    private function routeMenuPermissions(Request $request): array
    {
        $middleware = $request->route()?->gatherMiddleware() ?? [];
        $permissions = [];

        foreach ($middleware as $entry) {
            if (! is_string($entry) || ! str_starts_with($entry, 'menu:')) {
                continue;
            }

            $permissions = array_merge(
                $permissions,
                explode(',', substr($entry, strlen('menu:')))
            );
        }

        return array_values(array_diff(
            MenuPermissions::normalize($permissions),
            ['moderator', 'customer-users']
        ));
    }
}
