<?php

return [
    'enabled' => (bool) env('MEILISEARCH_ENABLED', true),
    'host' => rtrim((string) env('MEILISEARCH_HOST', 'http://127.0.0.1:7700'), '/'),
    'key' => env('MEILISEARCH_KEY'),
    'products_index' => env('MEILISEARCH_PRODUCTS_INDEX', 'products'),
    'timeout' => (int) env('MEILISEARCH_TIMEOUT', 1),
    'queue' => env('MEILISEARCH_QUEUE', 'default'),
    'batch_size' => (int) env('MEILISEARCH_BATCH_SIZE', 500),
];
