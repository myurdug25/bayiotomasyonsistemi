<?php
$p='c:/Users/MURAT/Desktop/NFSSOFT/powersa/apps/api/app/Http/Controllers/Api/WarehouseOrderController.php';
file_put_contents($p, str_replace(["'like',", "\"like\","], ["'ilike',", "\"ilike\","], file_get_contents($p)));
echo "Done";
