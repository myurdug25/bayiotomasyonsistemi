<?php

return [
    'enabled' => (bool) env('REALTIME_ENABLED', env('APP_ENV') !== 'testing'),
    'redis_connection' => env('REALTIME_REDIS_CONNECTION', 'default'),
    'channel' => env('REALTIME_REDIS_CHANNEL', 'powersa.domain-events'),
    'event_list' => env('REALTIME_REDIS_EVENT_LIST', 'powersa.domain-events:recent'),
    'event_list_limit' => (int) env('REALTIME_EVENT_LIST_LIMIT', 250),
    'event_list_ttl' => (int) env('REALTIME_EVENT_LIST_TTL', 3600),
];
