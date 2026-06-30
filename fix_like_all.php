<?php

$dir = 'c:/Users/MURAT/Desktop/NFSSOFT/powersa/apps/api/app/Http/Controllers/Api';

$files = [
    'CustomerCardRequestController.php',
    'CustomerUserController.php',
    'ModeratorManagementController.php',
    'OrderController.php',
    'PosQuickProductSearchController.php',
    'ProductSearchController.php',
    'ReturnRequestController.php',
    'WarehouseOrderController.php',
    'CustomerController.php'
];

foreach ($files as $file) {
    $path = $dir . '/' . $file;
    if (file_exists($path)) {
        $content = file_get_contents($path);
        $content = str_replace(["'like',", "\"like\",", "'like' ,", "\"like\" ,"], ["'ilike',", "\"ilike\",", "'ilike' ,", "\"ilike\" ,"], $content);
        file_put_contents($path, $content);
        echo "Replaced in $file\n";
    }
}
