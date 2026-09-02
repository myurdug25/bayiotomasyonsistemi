<?php

namespace Tests\Unit;

use App\Models\IntegrationSyncState;
use App\Models\Product;
use App\Models\ShipmentItem;
use App\Services\Integrations\Logo\LogoWarehouseTransferExportService;
use Illuminate\Support\Collection;
use PHPUnit\Framework\Attributes\DataProvider;
use ReflectionClass;
use Tests\TestCase;

class LogoWarehouseTransferStockStageTest extends TestCase
{
    public function test_transfer_metadata_source_depot_wins_over_shipment_transit_warehouse(): void
    {
        $service = (new ReflectionClass(LogoWarehouseTransferExportService::class))
            ->newInstanceWithoutConstructor();
        $method = new \ReflectionMethod(
            LogoWarehouseTransferExportService::class,
            'resolveTransferSourceDepot',
        );

        $actual = $method->invoke(
            $service,
            '5',
            'ERZURUM SEVKIYAT',
            [
                'transfer_source_warehouse_code' => '1',
                'transfer_source_warehouse_name' => 'ERZURUM DEPO',
            ],
        );

        $this->assertSame(['1', 'ERZURUM DEPO'], $actual);
    }

    public function test_shipment_warehouse_is_used_when_transfer_source_metadata_is_missing(): void
    {
        $service = (new ReflectionClass(LogoWarehouseTransferExportService::class))
            ->newInstanceWithoutConstructor();
        $method = new \ReflectionMethod(
            LogoWarehouseTransferExportService::class,
            'resolveTransferSourceDepot',
        );

        $actual = $method->invoke(
            $service,
            '2',
            'TRABZON DEPO',
            [],
        );

        $this->assertSame(['2', 'TRABZON DEPO'], $actual);
    }

    /**
     * @return array<string, array{bool, array{0: ?string, 1: ?string, 2: ?string, 3: ?string}}>
     */
    public static function stockStageProvider(): array
    {
        return [
            'shipment moves stock from source depot into its transit warehouse' => [
                false,
                ['1', 'ERZURUM DEPO', '5', 'ERZURUM SEVKIYAT'],
            ],
            'acceptance moves stock from transit warehouse into final target depot' => [
                true,
                ['5', 'ERZURUM SEVKIYAT', '3', 'SAMSUN DEPO'],
            ],
        ];
    }

    /**
     * @param  array{0: ?string, 1: ?string, 2: ?string, 3: ?string}  $expected
     */
    #[DataProvider('stockStageProvider')]
    public function test_stock_movement_is_split_between_shipment_and_acceptance(
        bool $isAcceptanceStage,
        array $expected,
    ): void {
        $service = (new ReflectionClass(LogoWarehouseTransferExportService::class))
            ->newInstanceWithoutConstructor();
        $method = new \ReflectionMethod(
            LogoWarehouseTransferExportService::class,
            'stockMovementWarehousesForStage',
        );

        $actual = $method->invoke(
            $service,
            $isAcceptanceStage,
            '1',
            'ERZURUM DEPO',
            '5',
            'ERZURUM SEVKIYAT',
            '3',
            'SAMSUN DEPO',
        );

        $this->assertSame($expected, $actual);
    }

    /**
     * @return array<string, array{?string, ?string, bool}>
     */
    public static function acceptanceQueueProvider(): array
    {
        return [
            'queued shipment must finish first' => ['shipment', 'queued', true],
            'failed shipment must retry first' => ['shipment', 'failed', true],
            'synced shipment can promote acceptance' => ['shipment', 'synced', false],
            'queued partial acceptance must finish before the next remainder acceptance' => ['acceptance', 'queued', true],
            'synced partial acceptance can promote the next remainder acceptance' => ['acceptance', 'synced', false],
        ];
    }

    #[DataProvider('acceptanceQueueProvider')]
    public function test_acceptance_does_not_overwrite_an_unsynced_shipment_stage(
        ?string $stage,
        ?string $status,
        bool $expected,
    ): void {
        $service = (new ReflectionClass(LogoWarehouseTransferExportService::class))
            ->newInstanceWithoutConstructor();
        $method = new \ReflectionMethod(
            LogoWarehouseTransferExportService::class,
            'shouldDeferAcceptance',
        );
        $state = new IntegrationSyncState([
            'status' => $status,
            'meta' => ['transfer_stage' => $stage],
        ]);

        $this->assertSame($expected, $method->invoke($service, $state));
    }

    public function test_partial_acceptance_exports_only_the_accepted_quantity_and_value(): void
    {
        $service = (new ReflectionClass(LogoWarehouseTransferExportService::class))
            ->newInstanceWithoutConstructor();
        $method = new \ReflectionMethod(
            LogoWarehouseTransferExportService::class,
            'transformShipmentItems',
        );

        $product = new Product([
            'sku' => 'CS0040',
            'name' => 'Test urun',
            'unit' => 'ADET',
            'vat_rate' => 0,
        ]);
        $item = new ShipmentItem([
            'shipped_qty' => 10,
            'unit_price' => 100,
            'line_total_shipped' => 1000,
            'vat_rate' => 0,
        ]);
        $item->setRelation('product', $product);

        $records = $method->invoke(
            $service,
            new Collection([$item]),
            'excluded',
            ['CS0040' => 8],
        );

        $this->assertCount(1, $records);
        $this->assertSame(8, $records[0]['shipped_qty']);
        $this->assertSame('100.00', $records[0]['unit_price']);
        $this->assertSame('800.00', $records[0]['line_total']);
    }

    public function test_zero_accepted_quantity_is_not_exported(): void
    {
        $service = (new ReflectionClass(LogoWarehouseTransferExportService::class))
            ->newInstanceWithoutConstructor();
        $method = new \ReflectionMethod(
            LogoWarehouseTransferExportService::class,
            'transformShipmentItems',
        );

        $product = new Product(['sku' => 'CS0040', 'name' => 'Test urun']);
        $item = new ShipmentItem([
            'shipped_qty' => 10,
            'unit_price' => 100,
            'line_total_shipped' => 1000,
            'vat_rate' => 0,
        ]);
        $item->setRelation('product', $product);

        $records = $method->invoke(
            $service,
            new Collection([$item]),
            'excluded',
            ['CS0040' => 0],
        );

        $this->assertSame([], $records);
    }
}
