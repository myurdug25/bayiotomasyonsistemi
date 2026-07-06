<?php

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Process;

class SyncShippedProductsStockJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public $tries = 3;

    public $timeout = 120;

    public function __construct(
        public array $productCodes
    ) {}

    public function handle(): void
    {
        if (empty($this->productCodes)) {
            return;
        }

        $codes = implode(',', array_unique(array_filter($this->productCodes)));

        if (empty($codes)) {
            return;
        }

        $scriptPath = base_path('../../tools/logo-sync/run-sync-products-targeted.cmd');

        if (! file_exists($scriptPath)) {
            Log::warning("Logo sync script not found at {$scriptPath}");

            return;
        }

        Log::info("Starting Logo targeted stock sync for products: {$codes}");

        $result = Process::env([
            'SYNC_PRODUCTS_TARGET_CODES' => $codes,
            'SYNC_PRODUCTS_STOCK_ONLY' => 'true',
        ])->timeout(120)->run($scriptPath);

        if ($result->failed()) {
            Log::error('Logo targeted stock sync failed: '.$result->errorOutput());
        } else {
            Log::info('Logo targeted stock sync completed.');
        }
    }
}
