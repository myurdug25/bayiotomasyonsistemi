<?php

namespace App\Providers;

use App\Models\Collection;
use App\Models\Customer;
use App\Models\Dealer;
use App\Models\LedgerEntry;
use App\Models\Order;
use App\Models\PosExpense;
use App\Models\PosSale;
use App\Models\PosSession;
use App\Models\Product;
use App\Models\ReturnRequest;
use App\Models\Shipment;
use App\Models\StockSummary;
use App\Observers\ProductObserver;
use App\Observers\RealtimeDomainObserver;
use App\Policies\CustomerPolicy;
use App\Policies\DealerPolicy;
use App\Policies\PosExpensePolicy;
use App\Policies\PosSalePolicy;
use App\Policies\PosSessionPolicy;
use App\Services\Integrations\Logo\Contracts\LogoWriteTransport;
use App\Services\Integrations\Logo\NullLogoWriteTransport;
use App\Services\Integrations\Logo\RabbitMqLogoWriteTransport;
use App\Support\QueryMetrics;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;
use Laravel\Telescope\TelescopeApplicationServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        $this->app->singleton(QueryMetrics::class, fn () => new QueryMetrics);
        $this->app->singleton(LogoWriteTransport::class, function () {
            $transport = (string) config('integrations.logo.write.transport', 'bridge');
            $enabled = (bool) config('integrations.logo.write.enabled', false);

            if ($enabled && $transport === 'rabbitmq') {
                return new RabbitMqLogoWriteTransport;
            }

            return new NullLogoWriteTransport;
        });

        if ($this->app->isLocal() && class_exists(TelescopeApplicationServiceProvider::class)) {
            $this->app->register(TelescopeServiceProvider::class);
        }
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        Gate::policy(Dealer::class, DealerPolicy::class);
        Gate::policy(Customer::class, CustomerPolicy::class);
        Gate::policy(PosSession::class, PosSessionPolicy::class);
        Gate::policy(PosSale::class, PosSalePolicy::class);
        Gate::policy(PosExpense::class, PosExpensePolicy::class);
        Product::observe(ProductObserver::class);
        Collection::observe(RealtimeDomainObserver::class);
        Customer::observe(RealtimeDomainObserver::class);
        LedgerEntry::observe(RealtimeDomainObserver::class);
        Order::observe(RealtimeDomainObserver::class);
        ReturnRequest::observe(RealtimeDomainObserver::class);
        Shipment::observe(RealtimeDomainObserver::class);
        StockSummary::observe(RealtimeDomainObserver::class);

        if ($this->app->isLocal()) {
            DB::listen(function (QueryExecuted $query): void {
                app(QueryMetrics::class)->add($query->time);
            });

            DB::whenQueryingForLongerThan(200, function ($connection, QueryExecuted $query): void {
                $requestPath = app()->bound('request') ? app('request')->path() : null;
                $requestMethod = app()->bound('request') ? app('request')->method() : null;

                Log::warning('Slow query detected (>200ms)', [
                    'connection' => $connection->getName(),
                    'time_ms' => round($query->time, 2),
                    'sql' => $query->sql,
                    'bindings' => $query->bindings,
                    'request_path' => $requestPath,
                    'request_method' => $requestMethod,
                ]);
            });
        }

        RateLimiter::for('api', function (Request $request) {
            $key = $request->user()?->id ?? $request->ip();

            return [
                Limit::perMinute(300)->by((string) $key),
            ];
        });

        RateLimiter::for('product-search', function (Request $request) {
            $key = $request->user()?->id ?? $request->ip();

            return [
                Limit::perMinute(120)->by((string) $key),
            ];
        });

        RateLimiter::for('login', function (Request $request) {
            $username = mb_strtolower(trim((string) $request->input('username', $request->input('email', ''))), 'UTF-8');
            $ip = (string) $request->ip();

            return [
                Limit::perMinute(5)->by($username !== '' ? $username.'|'.$ip : $ip),
                Limit::perMinute(30)->by($ip),
            ];
        });

        RateLimiter::for('logo-integration', function (Request $request) {
            $providedKey = trim((string) $request->header('X-Integration-Key', ''));
            $fingerprint = $providedKey !== ''
                ? hash('sha256', $providedKey)
                : (string) $request->ip();
            $routeScope = $request->route()?->getName()
                ?? $request->route()?->uri()
                ?? $request->path();

            return [
                // Bir entegrasyon akışındaki yoğun trafik (ör. POS kuyruğu), aynı
                // anahtarı kullanan kampanya/ürün senkronunu bloke etmemeli.
                Limit::perMinute(180)->by($fingerprint.'|'.$routeScope),
                Limit::perMinute(600)->by((string) $request->ip()),
            ];
        });

        RateLimiter::for('reports', function (Request $request) {
            $key = $request->user()?->id ?? $request->ip();

            return [
                Limit::perMinute(30)->by((string) $key),
            ];
        });

        RateLimiter::for('realtime-stream', function (Request $request) {
            $key = $request->user()?->id ?? $request->ip();

            return [
                Limit::perMinute(300)->by((string) $key),
            ];
        });

        RateLimiter::for('pos', function (Request $request) {
            $key = $request->user()?->id ?? $request->ip();

            return [
                Limit::perMinute(600)->by((string) $key),
            ];
        });

        RateLimiter::for('warehouse', function (Request $request) {
            $key = $request->user()?->id ?? $request->ip();

            return [
                Limit::perMinute(1800)->by((string) $key),
            ];
        });
    }
}
