<?php

namespace Tests\Feature;

use App\Models\Brand;
use App\Models\Category;
use App\Models\Product;
use App\Models\StockSummary;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

class LogoProductSyncApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        config([
            'integrations.logo.product_sync_key' => 'test-sync-key',
            'meilisearch.enabled' => false,
        ]);
    }

    public function test_logo_product_sync_requires_valid_integration_key(): void
    {
        $response = $this->postJson('/api/integrations/logo/products/sync', [
            'records' => [
                [
                    'external_ref' => '2001',
                    'sku' => 'LOGO-SKU-2001',
                    'name' => 'Test Urun',
                ],
            ],
        ]);

        $response
            ->assertUnauthorized()
            ->assertJsonPath('message', 'Unauthorized integration request.');
    }

    public function test_logo_product_sync_upserts_catalog_stock_and_base_prices(): void
    {
        $priceListId = (int) DB::table('price_lists')->where('code', 'A')->value('id');

        $brand = Brand::query()->create([
            'name' => 'Fleet Guard Old',
            'slug' => 'logo-brand-fg',
            'is_active' => true,
        ]);

        $category = Category::query()->create([
            'name' => 'Old Yag',
            'slug' => 'logo-category-yag',
            'is_active' => true,
        ]);

        $existingProduct = Product::query()->create([
            'brand_id' => $brand->id,
            'category_id' => $category->id,
            'sku' => 'SKU-1001',
            'oem_code' => 'OEM-OLD',
            'name' => 'Eski Urun',
            'unit' => 'adet',
            'vat_rate' => 18,
            'is_active' => true,
            'meta' => [
                'legacy' => 'keep',
                'integrations' => [
                    'logo' => [
                        'external_ref' => '2001',
                    ],
                ],
            ],
        ]);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/products/sync', [
                'price_list_code' => 'A',
                'records' => [
                    [
                        'external_ref' => '2001',
                        'sku' => 'SKU-1001',
                        'oem_code' => 'OEM-NEW',
                        'name' => 'Logo Yag Filtresi',
                        'description' => 'Guncel urun aciklamasi',
                        'unit' => 'adet',
                        'vat_rate' => 20,
                        'weight_kg' => 1.25,
                        'is_active' => false,
                        'brand_code' => 'FG',
                        'brand_name' => 'Fleetguard',
                        'category_code' => 'YAG',
                        'category_name' => 'Yag Filtresi',
                        'available_total' => 15,
                        'reserved_total' => 2,
                        'list_price' => 450.50,
                        'currency' => 'try',
                        'code_aliases' => [
                            [
                                'code' => '3A760',
                                'type' => 'oem',
                                'brand_name' => 'POWERSA',
                            ],
                            [
                                'code' => 'WH760',
                                'type' => 'competitor',
                                'brand_name' => 'WUNDER',
                            ],
                        ],
                        'meta' => [
                            'logo_name2' => 'Aciklama 2 Yag Filtresi',
                            'specode' => 'FILTRE',
                            'logo_units' => [
                                'units' => [
                                    [
                                        'code' => 'ADET',
                                        'name' => 'Adet',
                                        'barcode' => '8690000001001',
                                    ],
                                ],
                            ],
                            'raw' => [
                                'LOGICALREF' => 2001,
                                'CODE' => 'SKU-1001',
                                'NAME4' => 'PWS-3A760',
                                'IMAGE' => 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=',
                            ],
                        ],
                    ],
                    [
                        'external_ref' => '2002',
                        'sku' => 'SKU-1002',
                        'oem_code' => 'OEM-1002',
                        'name' => 'Logo Hava Filtresi',
                        'brand_code' => 'BOSCH',
                        'brand_name' => 'Bosch',
                        'category_code' => 'HAVA',
                        'category_name' => 'Hava Filtresi',
                        'available_total' => 9,
                        'reserved_total' => 1,
                        'list_price' => 275.75,
                        'currency' => 'TRY',
                        'code_aliases' => [
                            [
                                'code' => 'OEM-1002-A',
                                'type' => 'oem',
                            ],
                        ],
                        'meta' => [
                            'kod1' => 'FILTRE',
                            'kod2' => 'HAVA',
                            'kod3' => 'ELEMENT',
                            'stok_turu' => 'T',
                            'raw' => [
                                'LOGICALREF' => 2002,
                                'CODE' => 'SKU-1002',
                                'NAME3' => 'Aciklama 2 Hava Filtresi',
                            ],
                        ],
                    ],
                ],
            ]);

        $response
            ->assertOk()
            ->assertJsonPath('summary.received', 2)
            ->assertJsonPath('summary.created', 1)
            ->assertJsonPath('summary.updated', 1)
            ->assertJsonPath('summary.brands_created', 1)
            ->assertJsonPath('summary.brands_updated', 1)
            ->assertJsonPath('summary.categories_created', 1)
            ->assertJsonPath('summary.categories_updated', 1)
            ->assertJsonPath('summary.stock_synced', 2)
            ->assertJsonPath('summary.prices_synced', 2);

        $existingProduct->refresh();
        $brand->refresh();
        $category->refresh();

        $this->assertSame('Fleetguard', $brand->name);
        $this->assertSame('Yag Filtresi', $category->name);
        $this->assertSame('Aciklama 2 Yag Filtresi', $existingProduct->name);
        $this->assertSame('OEM-NEW', $existingProduct->oem_code);
        $this->assertSame('keep', $existingProduct->meta['legacy']);
        $this->assertSame('2001', $existingProduct->meta['integrations']['logo']['external_ref']);
        $this->assertSame('FILTRE', $existingProduct->meta['integrations']['logo']['payload']['specode']);
        $this->assertSame('FILTRE', $existingProduct->meta['specode']);
        $this->assertSame('SKU-1001', $existingProduct->meta['integrations']['logo']['payload']['raw']['CODE']);
        $this->assertSame(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=',
            $existingProduct->meta['integrations']['logo']['payload']['raw']['IMAGE']
        );
        $this->assertFalse($existingProduct->is_active);

        $this->assertDatabaseHas('stock_summary', [
            'product_id' => $existingProduct->id,
            'available_total' => 15,
            'reserved_total' => 2,
        ]);

        $this->assertDatabaseHas('base_prices', [
            'price_list_id' => $priceListId,
            'product_id' => $existingProduct->id,
            'list_price' => 450.50,
            'currency' => 'TRY',
        ]);

        $this->assertDatabaseHas('product_code_aliases', [
            'product_id' => $existingProduct->id,
            'code' => 'WH760',
            'normalized_code' => 'WH760',
            'code_type' => 'competitor',
            'brand_name' => 'WUNDER',
            'source' => 'logo',
        ]);

        $this->assertDatabaseHas('product_code_aliases', [
            'product_id' => $existingProduct->id,
            'code' => '8690000001001',
            'normalized_code' => '8690000001001',
            'code_type' => 'other',
            'source' => 'logo',
        ]);

        $this->assertDatabaseHas('product_code_aliases', [
            'product_id' => $existingProduct->id,
            'code' => 'PWS-3A760',
            'normalized_code' => 'PWS3A760',
            'code_type' => 'other',
            'source' => 'logo',
        ]);

        $newProduct = Product::query()->where('sku', 'SKU-1002')->firstOrFail();

        $this->assertSame('Aciklama 2 Hava Filtresi', $newProduct->name);
        $this->assertSame('2002', $newProduct->meta['integrations']['logo']['external_ref']);
        $this->assertSame('HAVA', $newProduct->meta['integrations']['logo']['payload']['kod2']);

        $this->assertDatabaseHas('stock_summary', [
            'product_id' => $newProduct->id,
            'available_total' => 9,
            'reserved_total' => 1,
        ]);

        $this->assertDatabaseHas('base_prices', [
            'price_list_id' => $priceListId,
            'product_id' => $newProduct->id,
            'list_price' => 275.75,
            'currency' => 'TRY',
        ]);

        $this->assertDatabaseHas('product_code_aliases', [
            'product_id' => $newProduct->id,
            'code' => 'OEM-1002-A',
            'normalized_code' => 'OEM1002A',
            'code_type' => 'oem',
            'source' => 'logo',
        ]);

        $this->assertDatabaseHas('integration_sync_states', [
            'system' => 'logo',
            'domain' => 'products',
            'direction' => 'inbound',
            'entity_type' => Product::class,
            'entity_id' => $existingProduct->id,
            'external_ref' => '2001',
            'status' => 'synced',
        ]);

        $this->assertDatabaseHas('integration_sync_events', [
            'system' => 'logo',
            'domain' => 'products',
            'direction' => 'inbound',
            'entity_type' => Product::class,
            'entity_id' => $newProduct->id,
            'external_ref' => '2002',
            'status' => 'synced',
        ]);
    }

    public function test_logo_product_sync_uses_specode5_as_brand_even_when_marka_kodu_is_different(): void
    {
        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/products/sync', [
                'price_list_code' => 'A',
                'records' => [
                    [
                        'external_ref' => '450907006',
                        'sku' => '0450907006',
                        'name' => 'Yakit Filtresi',
                        'brand_code' => 'CITROEN',
                        'brand_name' => 'CITROEN',
                        'meta' => [
                            'kod2' => 'YAKIT',
                            'kod3' => 'SPINON',
                            'specode4' => 'E',
                            'specode5' => 'BOSCH',
                            'raw' => [
                                'CODE' => '0450907006',
                                'SPECODE5' => 'BOSCH',
                                'MARKCODE' => 'CITROEN',
                            ],
                        ],
                    ],
                ],
            ]);

        $response
            ->assertOk()
            ->assertJsonPath('summary.received', 1)
            ->assertJsonPath('summary.brands_created', 1);

        $product = Product::query()->where('sku', '0450907006')->firstOrFail();

        $this->assertSame('BOSCH', $product->brand?->name);
        $this->assertSame('BOSCH', $product->meta['specode5']);
        $this->assertSame('BOSCH', $product->meta['integrations']['logo']['payload']['specode5']);
        $this->assertDatabaseMissing('brands', [
            'name' => 'CITROEN',
        ]);
    }

    public function test_logo_product_sync_resolves_existing_product_from_integration_state_external_ref(): void
    {
        $product = Product::query()->create([
            'sku' => 'OLD-CS0040',
            'name' => 'Eski Logo Urunu',
            'unit' => 'adet',
            'vat_rate' => 20,
            'is_active' => true,
            'meta' => [],
        ]);

        DB::table('integration_sync_states')->insert([
            'system' => 'logo',
            'domain' => 'products',
            'direction' => 'inbound',
            'entity_type' => Product::class,
            'entity_id' => $product->id,
            'external_ref' => 'CS0040-REF',
            'status' => 'synced',
            'last_synced_at' => now(),
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/products/sync', [
                'records' => [
                    [
                        'external_ref' => 'CS0040-REF',
                        'sku' => 'NEW-CS0040',
                        'name' => 'Guncel Logo Urunu',
                    ],
                ],
            ]);

        $response
            ->assertOk()
            ->assertJsonPath('summary.created', 0)
            ->assertJsonPath('summary.updated', 1);

        $product->refresh();

        $this->assertSame('NEW-CS0040', $product->sku);
        $this->assertSame('Guncel Logo Urunu', $product->name);
        $this->assertSame(1, Product::query()->count());
    }

    public function test_logo_product_sync_clamps_negative_real_stock_to_zero(): void
    {
        Product::query()->create([
            'sku' => 'PWS-3A760',
            'name' => 'HAVA FILTRESI',
            'unit' => 'adet',
            'vat_rate' => 20,
            'is_active' => true,
            'meta' => [],
        ]);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/products/sync', [
                'records' => [
                    [
                        'external_ref' => '5',
                        'sku' => 'PWS-3A760',
                        'name' => 'HAVA FILTRESI',
                        'available_total' => -229,
                        'reserved_total' => 0,
                    ],
                ],
            ]);

        $response
            ->assertOk()
            ->assertJsonPath('summary.stock_synced', 1);

        $product = Product::query()->where('sku', 'PWS-3A760')->firstOrFail();

        $this->assertDatabaseHas('stock_summary', [
            'product_id' => $product->id,
            'available_total' => 0,
            'reserved_total' => 0,
        ]);
    }

    public function test_logo_product_sync_does_not_zero_stock_when_logo_snapshot_is_empty(): void
    {
        $product = Product::query()->create([
            'sku' => 'CS 0040',
            'name' => 'YAG FILTRESI',
            'unit' => 'adet',
            'vat_rate' => 20,
            'is_active' => true,
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'external_ref' => '3',
                    ],
                ],
            ],
        ]);

        StockSummary::query()->create([
            'product_id' => $product->id,
            'available_total' => 12,
            'reserved_total' => 2,
        ]);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/products/sync', [
                'records' => [
                    [
                        'external_ref' => '3',
                        'sku' => 'CS 0040',
                        'name' => 'YAG FILTRESI',
                        'available_total' => 0,
                        'reserved_total' => 0,
                        'meta' => [
                            'logo_stock' => [
                                'available_total' => 0,
                                'reserved_total' => 0,
                                'warehouses' => [],
                            ],
                        ],
                    ],
                ],
            ]);

        $response
            ->assertOk()
            ->assertJsonPath('summary.stock_synced', 0);

        $this->assertDatabaseHas('stock_summary', [
            'product_id' => $product->id,
            'available_total' => 12,
            'reserved_total' => 2,
        ]);
    }

    public function test_logo_product_sync_uses_warehouse_totals_when_logo_header_stock_is_zero(): void
    {
        $product = Product::query()->create([
            'sku' => '0451103336',
            'name' => 'CLIO 1.4',
            'unit' => 'adet',
            'vat_rate' => 20,
            'is_active' => true,
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'external_ref' => '4',
                    ],
                ],
            ],
        ]);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/products/sync', [
                'records' => [
                    [
                        'external_ref' => '4',
                        'sku' => '0451103336',
                        'name' => 'CLIO 1.4',
                        'available_total' => 0,
                        'reserved_total' => 0,
                        'meta' => [
                            'logo_stock' => [
                                'available_total' => 0,
                                'reserved_total' => 0,
                                'warehouses' => [
                                    [
                                        'warehouse_code' => '1',
                                        'onhand_total' => 7,
                                        'reserved_total' => 1,
                                    ],
                                    [
                                        'warehouse_code' => '2',
                                        'available_total' => 3,
                                        'reserved_total' => 2,
                                    ],
                                ],
                            ],
                        ],
                    ],
                ],
            ]);

        $response
            ->assertOk()
            ->assertJsonPath('summary.stock_synced', 1);

        $this->assertDatabaseHas('stock_summary', [
            'product_id' => $product->id,
            'available_total' => 10,
            'reserved_total' => 3,
        ]);
    }

    public function test_logo_product_sync_stock_only_updates_only_stock_payload(): void
    {
        $product = Product::query()->create([
            'sku' => 'WY 996',
            'name' => 'PICK-UP D22 2.5DI 2002>',
            'unit' => 'adet',
            'vat_rate' => 20,
            'is_active' => true,
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'external_ref' => '9864B2023',
                        'payload' => [
                            'logo_name2' => 'PICK-UP D22 2.5DI 2002>',
                            'specode5' => 'WUNDER',
                            'logo_stock' => [
                                'warehouses' => [
                                    [
                                        'invenno' => 0,
                                        'warehouse_code' => '0',
                                        'available_total' => 6,
                                        'shelf_key' => '25',
                                        'shelf_address' => 'RAF-25-A1',
                                    ],
                                    [
                                        'invenno' => 1,
                                        'warehouse_code' => '1',
                                        'available_total' => 61,
                                        'shelf_key' => '61',
                                        'shelf_address' => 'RAF-61-B4',
                                    ],
                                ],
                            ],
                        ],
                    ],
                ],
            ],
        ]);

        StockSummary::query()->create([
            'product_id' => $product->id,
            'available_total' => 67,
            'reserved_total' => 0,
        ]);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/products/sync', [
                'mode' => 'stock_only',
                'records' => [
                    [
                        'external_ref' => '9864B2023',
                        'sku' => 'WY 996',
                        'name' => 'BU ALAN YAZILMAMALI',
                        'brand_name' => 'BU DA YAZILMAMALI',
                        'available_total' => 58,
                        'reserved_total' => 1,
                        'meta' => [
                            'logo_stock' => [
                                'available_total' => 58,
                                'reserved_total' => 1,
                                'warehouses' => [
                                    [
                                        'invenno' => 0,
                                        'warehouse_code' => '0',
                                        'warehouse_name' => 'ERZURUM POI',
                                        'available_total' => 5,
                                    ],
                                    [
                                        'invenno' => 1,
                                        'warehouse_code' => '1',
                                        'warehouse_name' => 'ERZURUM DEP',
                                        'available_total' => 42,
                                        'shelf_address' => null,
                                    ],
                                ],
                            ],
                        ],
                    ],
                ],
            ]);

        $response
            ->assertOk()
            ->assertJsonPath('summary.received', 1)
            ->assertJsonPath('summary.updated', 1)
            ->assertJsonPath('summary.created', 0)
            ->assertJsonPath('summary.stock_synced', 1)
            ->assertJsonPath('summary.prices_synced', 0)
            ->assertJsonPath('summary.code_aliases_synced', 0);

        $product->refresh();

        $this->assertSame('PICK-UP D22 2.5DI 2002>', $product->name);
        $this->assertSame('WUNDER', $product->meta['integrations']['logo']['payload']['specode5']);
        $this->assertSame(
            42,
            $product->meta['integrations']['logo']['payload']['logo_stock']['warehouses'][1]['available_total']
        );
        $this->assertSame(
            'RAF-25-A1',
            $product->meta['integrations']['logo']['payload']['logo_stock']['warehouses'][0]['shelf_address']
        );
        $this->assertSame(
            '25',
            $product->meta['integrations']['logo']['payload']['logo_stock']['warehouses'][0]['shelf_key']
        );
        $this->assertSame(
            'RAF-61-B4',
            $product->meta['integrations']['logo']['payload']['logo_stock']['warehouses'][1]['shelf_address']
        );
        $this->assertSame(
            '61',
            $product->meta['integrations']['logo']['payload']['logo_stock']['warehouses'][1]['shelf_key']
        );

        $this->assertDatabaseHas('stock_summary', [
            'product_id' => $product->id,
            'available_total' => 58,
            'reserved_total' => 1,
        ]);
    }

    public function test_logo_product_sync_stock_only_preserves_existing_warehouse_payload_when_incoming_has_no_breakdown(): void
    {
        $product = Product::query()->create([
            'sku' => 'CS 0040',
            'name' => 'CLIO 1.4 - 1.5DCI - 1.6 1998>',
            'unit' => 'adet',
            'vat_rate' => 20,
            'is_active' => true,
            'meta' => [
                'integrations' => [
                    'logo' => [
                        'external_ref' => '1609',
                        'payload' => [
                            'logo_stock' => [
                                'warehouses' => [
                                    [
                                        'invenno' => 0,
                                        'warehouse_code' => '0',
                                        'warehouse_name' => 'ERZURUM POINT',
                                        'available_total' => 4,
                                        'shelf_key' => '25',
                                        'shelf_address' => 'RAF-25-A1',
                                    ],
                                    [
                                        'invenno' => 1,
                                        'warehouse_code' => '1',
                                        'warehouse_name' => 'ERZURUM DEPO',
                                        'available_total' => 12,
                                        'shelf_key' => '61',
                                        'shelf_address' => 'RAF-61-B4',
                                    ],
                                ],
                            ],
                        ],
                    ],
                ],
            ],
        ]);

        $response = $this
            ->withHeader('X-Integration-Key', 'test-sync-key')
            ->postJson('/api/integrations/logo/products/sync', [
                'mode' => 'stock_only',
                'records' => [
                    [
                        'external_ref' => '1609',
                        'sku' => 'CS 0040',
                        'available_total' => 58,
                        'reserved_total' => 1,
                        'meta' => [
                            'logo_stock' => [
                                'available_total' => 58,
                                'reserved_total' => 1,
                                'warehouses' => [],
                            ],
                        ],
                    ],
                ],
            ]);

        $response
            ->assertOk()
            ->assertJsonPath('summary.updated', 1)
            ->assertJsonPath('summary.stock_synced', 1);

        $product->refresh();

        $logoStock = $product->meta['integrations']['logo']['payload']['logo_stock'];

        $this->assertSame(58, $logoStock['available_total']);
        $this->assertSame(1, $logoStock['reserved_total']);
        $this->assertCount(2, $logoStock['warehouses']);
        $this->assertSame('RAF-25-A1', $logoStock['warehouses'][0]['shelf_address']);
        $this->assertSame('RAF-61-B4', $logoStock['warehouses'][1]['shelf_address']);
    }
}
