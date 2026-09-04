<?php

return [
    'logo' => [
        'customer_sync_key' => env('LOGO_CUSTOMER_SYNC_KEY', ''),
        'product_sync_key' => env('LOGO_PRODUCT_SYNC_KEY', env('LOGO_CUSTOMER_SYNC_KEY', '')),
        'campaign_sync_enabled' => env('LOGO_CAMPAIGN_SYNC_ENABLED', false),
        'ledger_sync_key' => env('LOGO_LEDGER_SYNC_KEY', env('LOGO_CUSTOMER_SYNC_KEY', '')),
        'collection_sync_key' => env('LOGO_COLLECTION_SYNC_KEY', env('LOGO_CUSTOMER_SYNC_KEY', '')),
        'pos_sale_sync_key' => env('LOGO_POS_SALE_SYNC_KEY', env('LOGO_COLLECTION_SYNC_KEY', env('LOGO_CUSTOMER_SYNC_KEY', ''))),
        'pos_expense_sync_key' => env('LOGO_POS_EXPENSE_SYNC_KEY', env('LOGO_COLLECTION_SYNC_KEY', env('LOGO_CUSTOMER_SYNC_KEY', ''))),
        'pos_day_end_sync_key' => env('LOGO_POS_DAY_END_SYNC_KEY', env('LOGO_POS_EXPENSE_SYNC_KEY', env('LOGO_COLLECTION_SYNC_KEY', env('LOGO_CUSTOMER_SYNC_KEY', '')))),
        'previous_purchase_sync_key' => env('LOGO_PREVIOUS_PURCHASE_SYNC_KEY', env('LOGO_PRODUCT_SYNC_KEY', env('LOGO_CUSTOMER_SYNC_KEY', ''))),
        'order_sync_key' => env('LOGO_ORDER_SYNC_KEY', env('LOGO_COLLECTION_SYNC_KEY', env('LOGO_CUSTOMER_SYNC_KEY', ''))),
        'shipment_sync_key' => env('LOGO_SHIPMENT_SYNC_KEY', env('LOGO_ORDER_SYNC_KEY', env('LOGO_COLLECTION_SYNC_KEY', env('LOGO_CUSTOMER_SYNC_KEY', '')))),
        'retry' => [
            'max_attempts' => (int) env('LOGO_EXPORT_RETRY_MAX_ATTEMPTS', 8),
            'base_delay_seconds' => (int) env('LOGO_EXPORT_RETRY_BASE_DELAY_SECONDS', 30),
            'max_delay_seconds' => (int) env('LOGO_EXPORT_RETRY_MAX_DELAY_SECONDS', 3600),
        ],
        'shipments' => [
            'immediate_export' => [
                'enabled' => env('LOGO_SHIPMENT_IMMEDIATE_EXPORT_ENABLED', false),
                'url' => env('LOGO_SHIPMENT_IMMEDIATE_EXPORT_URL', ''),
                'token' => env('LOGO_SHIPMENT_IMMEDIATE_EXPORT_TOKEN', ''),
                'timeout' => (float) env('LOGO_SHIPMENT_IMMEDIATE_EXPORT_TIMEOUT', 10.0),
            ],
            'queued_export_wait_seconds' => (float) env('LOGO_SHIPMENT_QUEUED_EXPORT_WAIT_SECONDS', 0),
        ],
        'purchase_receipt_sync_key' => env('LOGO_PURCHASE_RECEIPT_SYNC_KEY', env('LOGO_SHIPMENT_SYNC_KEY', env('LOGO_ORDER_SYNC_KEY', env('LOGO_COLLECTION_SYNC_KEY', env('LOGO_CUSTOMER_SYNC_KEY', ''))))),
        'return_sync_key' => env('LOGO_RETURN_SYNC_KEY', env('LOGO_ORDER_SYNC_KEY', env('LOGO_COLLECTION_SYNC_KEY', env('LOGO_CUSTOMER_SYNC_KEY', '')))),
        'write' => [
            'enabled' => env('LOGO_WRITE_ENABLED', false),
            'transport' => env('LOGO_WRITE_TRANSPORT', 'bridge'),
            'exchange' => env('LOGO_WRITE_EXCHANGE', 'powersa.logo'),
            'rabbitmq' => [
                'host' => env('LOGO_WRITE_RABBITMQ_HOST', '127.0.0.1'),
                'port' => (int) env('LOGO_WRITE_RABBITMQ_PORT', 5672),
                'user' => env('LOGO_WRITE_RABBITMQ_USER', 'guest'),
                'password' => env('LOGO_WRITE_RABBITMQ_PASSWORD', 'guest'),
                'vhost' => env('LOGO_WRITE_RABBITMQ_VHOST', '/'),
                'heartbeat' => (int) env('LOGO_WRITE_RABBITMQ_HEARTBEAT', 30),
                'connection_timeout' => (float) env('LOGO_WRITE_RABBITMQ_CONNECTION_TIMEOUT', 3.0),
                'read_write_timeout' => (float) env('LOGO_WRITE_RABBITMQ_READ_WRITE_TIMEOUT', 3.0),
            ],
        ],
    ],
    'pos' => [
        'point_cashbox_code' => env('POS_POINT_CASHBOX_CODE', '100.01.007'),
        'point_cashbox_name' => env('POS_POINT_CASHBOX_NAME', 'ERZURUM POINT KASASI'),
        'erzurum_point_cashbox_code' => env('POS_ERZURUM_POINT_CASHBOX_CODE', env('POS_POINT_CASHBOX_CODE', '100.01.007')),
        'erzurum_point_cashbox_name' => env('POS_ERZURUM_POINT_CASHBOX_NAME', env('POS_POINT_CASHBOX_NAME', 'ERZURUM POINT KASASI')),
        'batum_point_cashbox_code' => env('POS_BATUM_POINT_CASHBOX_CODE', '100.04.001'),
        'batum_point_cashbox_name' => env('POS_BATUM_POINT_CASHBOX_NAME', 'BATUM MERKEZ KASASI'),
        'point_warehouse_no' => (int) env('POS_POINT_WAREHOUSE_NO', 0),
        'erzurum_point_warehouse_no' => (int) env('POS_ERZURUM_POINT_WAREHOUSE_NO', env('POS_POINT_WAREHOUSE_NO', 0)),
        'trabzon_point_warehouse_no' => (int) env('POS_TRABZON_POINT_WAREHOUSE_NO', 2),
        'samsun_point_warehouse_no' => (int) env('POS_SAMSUN_POINT_WAREHOUSE_NO', 3),
        'batum_point_warehouse_no' => (int) env('POS_BATUM_POINT_WAREHOUSE_NO', 4),
    ],
    'customer_complaints' => [
        'mail_to' => env('POWERSA_COMPLAINT_MAIL_TO', 'farukcelik@gucsa.com.tr'),
        'company_info' => env('POWERSA_COMPANY_INFO', ''),
        'iban_info' => env('POWERSA_IBAN_INFO', ''),
    ],
    'pricing' => [
        'batum_try_per_lari' => (float) env('BATUM_TRY_PER_LARI', 17.0),
        'batum_try_to_lari_multiplier' => (float) env('BATUM_TRY_TO_LARI_MULTIPLIER', 0.056),
    ],
    'eryaz' => [
        'previous_purchases_cache_seconds' => (int) env('ERYAZ_PREVIOUS_PURCHASES_CACHE_SECONDS', 300),
    ],
    'ownership' => [
        'customers' => [
            'master' => 'hybrid',
            'logo_to_b2b' => true,
            'b2b_to_logo' => true,
        ],
        'products' => [
            'master' => 'logo',
            'logo_to_b2b' => true,
            'b2b_to_logo' => false,
        ],
        'prices' => [
            'master' => 'logo',
            'logo_to_b2b' => true,
            'b2b_to_logo' => false,
        ],
        'stock' => [
            'master' => 'logo',
            'logo_to_b2b' => true,
            'b2b_to_logo' => false,
        ],
        'ledger' => [
            'master' => 'logo',
            'logo_to_b2b' => true,
            'b2b_to_logo' => false,
        ],
        'collections' => [
            'master' => 'hybrid',
            'logo_to_b2b' => true,
            'b2b_to_logo' => true,
        ],
        'orders' => [
            'master' => 'b2b',
            'logo_to_b2b' => false,
            'b2b_to_logo' => true,
        ],
        'purchase_receipts' => [
            'master' => 'b2b',
            'logo_to_b2b' => false,
            'b2b_to_logo' => true,
        ],
    ],
];
