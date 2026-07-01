<?php

use Illuminate\Support\Facades\DB;

require __DIR__.'/vendor/autoload.php';
$app = require_once __DIR__.'/bootstrap/app.php';
$app->make('Illuminate\Contracts\Console\Kernel')->bootstrap();

try {
    $indexesKslines = DB::connection('logo')->select("
        SELECT i.name AS IndexName, c.name AS ColumnName 
        FROM sys.indexes i 
        INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id 
        INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id 
        WHERE i.object_id = OBJECT_ID('dbo.LG_003_01_KSLINES') AND i.is_unique = 1;
    ");
    echo "KSLINES Indexes:\n";
    print_r($indexesKslines);

    $indexesClfline = DB::connection('logo')->select("
        SELECT i.name AS IndexName, c.name AS ColumnName 
        FROM sys.indexes i 
        INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id 
        INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id 
        WHERE i.object_id = OBJECT_ID('dbo.LG_003_01_CLFLINE') AND i.is_unique = 1;
    ");
    echo "\nCLFLINE Indexes:\n";
    print_r($indexesClfline);

} catch (Exception $e) {
    echo 'Error: '.$e->getMessage()."\n";
}
