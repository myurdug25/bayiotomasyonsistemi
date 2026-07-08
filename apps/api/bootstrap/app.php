<?php

use App\Console\Commands\Logo\BackfillLogoCollectionsCommand;
use App\Console\Commands\Logo\ReplayLogoWriteEventsCommand;
use App\Console\Commands\Products\ReindexProductsSearchCommand;
use App\Console\Commands\Users\SyncOperationalUsersCommand;
use App\Http\Middleware\ApiPerformanceLogger;
use App\Http\Middleware\EnsureUserHasMenuPermission;
use App\Http\Middleware\EnsureUserHasRole;
use App\Http\Middleware\SanitizeInputStrings;
use App\Http\Middleware\SecurityHeaders;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;
use Illuminate\Session\TokenMismatchException;
use Symfony\Component\HttpFoundation\Response;

return Application::configure(basePath: dirname(__DIR__))
    ->withCommands([
        BackfillLogoCollectionsCommand::class,
        ReplayLogoWriteEventsCommand::class,
        ReindexProductsSearchCommand::class,
        SyncOperationalUsersCommand::class,
    ])
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->append(SecurityHeaders::class);
        $middleware->statefulApi();
        $middleware->validateCsrfTokens(except: [
            'api/login',
            'api/auth/login',
            'api/logout',
            'api/auth/logout',
            'backend/api/login',
            'backend/api/auth/login',
            'backend/api/logout',
            'backend/api/auth/logout',
        ]);
        $middleware->redirectGuestsTo(function (Request $request): ?string {
            if ($request->is('api/*') || $request->is('backend/api/*') || $request->expectsJson()) {
                return null;
            }

            return '/login';
        });
        $middleware->appendToGroup('api', [
            SanitizeInputStrings::class,
            ApiPerformanceLogger::class,
        ]);
        $middleware->alias([
            'menu' => EnsureUserHasMenuPermission::class,
            'role' => EnsureUserHasRole::class,
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->render(function (AuthenticationException $exception, Request $request) {
            if (! $request->is('api/*') && ! $request->is('backend/api/*') && ! $request->expectsJson()) {
                return null;
            }

            return response()->json([
                'message' => $exception->getMessage(),
            ], Response::HTTP_UNAUTHORIZED);
        });

        $exceptions->render(function (TokenMismatchException $exception, Request $request) {
            if (! $request->is('api/*') && ! $request->is('backend/api/*') && ! $request->expectsJson()) {
                return null;
            }

            return response()->json([
                'message' => 'Oturum doğrulaması yenilenmeli. Lütfen tekrar deneyin.',
            ], Response::HTTP_PAGE_EXPIRED);
        });
    })->create();
