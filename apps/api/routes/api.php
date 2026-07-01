<?php

use App\Http\Controllers\Api\AdminDashboardOverviewController;
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\CartController;
use App\Http\Controllers\Api\CartItemController;
use App\Http\Controllers\Api\CatalogController;
use App\Http\Controllers\Api\CollectionReportController;
use App\Http\Controllers\Api\CustomerBalanceReportController;
use App\Http\Controllers\Api\CustomerCardRequestController;
use App\Http\Controllers\Api\CustomerCollectionController;
use App\Http\Controllers\Api\CustomerController;
use App\Http\Controllers\Api\CustomerLedgerController;
use App\Http\Controllers\Api\FinanceDefinitionController;
use App\Http\Controllers\Api\CustomerUserController;
use App\Http\Controllers\Api\DealerController;
use App\Http\Controllers\Api\LogoCollectionExportController;
use App\Http\Controllers\Api\LogoCustomerExportController;
use App\Http\Controllers\Api\LogoCustomerSyncController;
use App\Http\Controllers\Api\LogoDashboardReportController;
use App\Http\Controllers\Api\LogoLedgerSyncController;
use App\Http\Controllers\Api\LogoOrderExportController;
use App\Http\Controllers\Api\LogoPosExpenseExportController;
use App\Http\Controllers\Api\LogoPosSaleExportController;
use App\Http\Controllers\Api\LogoProductSyncController;
use App\Http\Controllers\Api\LogoPurchaseReceiptExportController;
use App\Http\Controllers\Api\LogoReturnExportController;
use App\Http\Controllers\Api\LogoReturnScrapExportController;
use App\Http\Controllers\Api\LogoShipmentExportController;
use App\Http\Controllers\Api\MarketRateController;
use App\Http\Controllers\Api\ModeratorManagementController;
use App\Http\Controllers\Api\OrderBalanceReportController;
use App\Http\Controllers\Api\OrderController;
use App\Http\Controllers\Api\PosExpenseController;
use App\Http\Controllers\Api\PosQuickProductSearchController;
use App\Http\Controllers\Api\PosReportController;
use App\Http\Controllers\Api\PosSaleController;
use App\Http\Controllers\Api\PosSessionController;
use App\Http\Controllers\Api\ProductFilterOptionsController;
use App\Http\Controllers\Api\ProductImageController;
use App\Http\Controllers\Api\ProductSearchController;
use App\Http\Controllers\Api\ProfileController;
use App\Http\Controllers\Api\PurchaseReceiptController;
use App\Http\Controllers\Api\ReportRunController;
use App\Http\Controllers\Api\ReturnRequestController;
use App\Http\Controllers\Api\SalesReportController;
use App\Http\Controllers\Api\UserContextController;
use App\Http\Controllers\Api\UserNoteController;
use App\Http\Controllers\Api\WarehouseOrderController;
use App\Http\Controllers\Api\WarehouseShipmentController;
use App\Http\Controllers\Api\WarehouseShipmentPrintController;
use App\Http\Controllers\Api\CampaignController;
use Illuminate\Support\Facades\Route;

Route::middleware('throttle:logo-integration')->group(function (): void {
    Route::post('/integrations/logo/customers/sync', [LogoCustomerSyncController::class, 'store']);
    Route::get('/integrations/logo/customers/pending', [LogoCustomerExportController::class, 'index']);
    Route::post('/integrations/logo/customers/ack', [LogoCustomerExportController::class, 'acknowledge']);
    Route::get('/integrations/logo/collections/pending', [LogoCollectionExportController::class, 'index']);
    Route::post('/integrations/logo/collections/ack', [LogoCollectionExportController::class, 'acknowledge']);
    Route::get('/integrations/logo/pos-sales/pending', [LogoPosSaleExportController::class, 'index']);
    Route::post('/integrations/logo/pos-sales/ack', [LogoPosSaleExportController::class, 'acknowledge']);
    Route::get('/integrations/logo/pos-expenses/pending', [LogoPosExpenseExportController::class, 'index']);
    Route::post('/integrations/logo/pos-expenses/sync', [LogoPosExpenseExportController::class, 'sync']);
    Route::post('/integrations/logo/pos-expenses/ack', [LogoPosExpenseExportController::class, 'acknowledge']);
    Route::get('/integrations/logo/orders/pending', [LogoOrderExportController::class, 'index']);
    Route::post('/integrations/logo/orders/ack', [LogoOrderExportController::class, 'acknowledge']);
    Route::get('/integrations/logo/shipments/pending', [LogoShipmentExportController::class, 'index']);
    Route::post('/integrations/logo/shipments/ack', [LogoShipmentExportController::class, 'acknowledge']);
    Route::get('/integrations/logo/purchase-receipts/pending', [LogoPurchaseReceiptExportController::class, 'index']);
    Route::post('/integrations/logo/purchase-receipts/ack', [LogoPurchaseReceiptExportController::class, 'acknowledge']);
    Route::get('/integrations/logo/returns/pending', [LogoReturnExportController::class, 'index']);
    Route::post('/integrations/logo/returns/ack', [LogoReturnExportController::class, 'acknowledge']);
    Route::get('/integrations/logo/return-scraps/pending', [LogoReturnScrapExportController::class, 'index']);
    Route::post('/integrations/logo/return-scraps/ack', [LogoReturnScrapExportController::class, 'acknowledge']);
    Route::post('/integrations/logo/ledger/sync', [LogoLedgerSyncController::class, 'store']);
    Route::post('/integrations/logo/products/sync', [LogoProductSyncController::class, 'store']);
    Route::post('/integrations/logo/campaigns/sync', [CampaignController::class, 'sync']);
});

Route::middleware('web')->group(function (): void {
    Route::prefix('auth')->group(function (): void {
        Route::post('/login', [AuthController::class, 'login'])->middleware(['guest', 'throttle:login']);

        Route::middleware('auth:sanctum')->group(function (): void {
            Route::post('/logout', [AuthController::class, 'logout']);
            Route::get('/me', [AuthController::class, 'me']);
        });
    });

    // Legacy aliases kept for backward compatibility with existing clients.
    Route::post('/login', [AuthController::class, 'login'])->middleware(['guest', 'throttle:login']);
    Route::middleware('auth:sanctum')->group(function (): void {
        Route::post('/logout', [AuthController::class, 'logout']);
        Route::get('/me', [AuthController::class, 'me']);
    });
});

Route::middleware('auth:sanctum')->group(function () {
    Route::patch('/profile', [ProfileController::class, 'update']);
    Route::get('/market-rates/tcmb', MarketRateController::class);
    Route::middleware('menu:notes')->group(function (): void {
        Route::get('/notes', [UserNoteController::class, 'index']);
        Route::post('/notes', [UserNoteController::class, 'store']);
        Route::patch('/notes/{note}', [UserNoteController::class, 'update']);
        Route::delete('/notes/{note}', [UserNoteController::class, 'destroy']);
    });

    Route::middleware(['role:admin,dealer_admin,salesperson,cashier,point,warehouse,customer', 'menu:orders,warehouse'])->group(function (): void {
        Route::get('/orders/{order}', [OrderController::class, 'show']);
    });

    Route::middleware(['role:admin,dealer_admin,salesperson,point', 'menu:new-customer-card'])->group(function (): void {
        Route::get('/customer-card-salespeople', [CustomerCardRequestController::class, 'salespeople']);
        Route::get('/customer-card-requests', [CustomerCardRequestController::class, 'index']);
        Route::post('/customer-card-requests', [CustomerCardRequestController::class, 'store']);
        Route::post('/customer-card-requests/{customerCardRequest}/attachments', [CustomerCardRequestController::class, 'storeAttachment']);
        Route::get('/customer-card-requests/{customerCardRequest}/attachments/{attachment}', [CustomerCardRequestController::class, 'showAttachment']);
    });

    Route::middleware(['role:admin,salesperson', 'menu:new-customer-card'])->group(function (): void {
        Route::patch('/customer-card-requests/{customerCardRequest}/status', [CustomerCardRequestController::class, 'updateStatus']);
        Route::post('/customer-card-requests/{customerCardRequest}/convert', [CustomerCardRequestController::class, 'convertToCustomer']);
    });

    Route::middleware('role:admin')->group(function (): void {
        Route::get('/admin/dashboard/overview', AdminDashboardOverviewController::class);
        Route::post('/admin/finance-definitions', [FinanceDefinitionController::class, 'store']);
        Route::patch('/admin/finance-definitions/{financeDefinition}', [FinanceDefinitionController::class, 'update']);
    });

    Route::middleware(['role:admin,moderator', 'menu:moderator'])->group(function (): void {
        Route::get('/moderator/overview', [ModeratorManagementController::class, 'overview']);
        Route::post('/moderator/users', [ModeratorManagementController::class, 'storeUser']);
        Route::patch('/moderator/users/{user}', [ModeratorManagementController::class, 'updateUser']);
        Route::post('/moderator/users/{user}/reset-password', [ModeratorManagementController::class, 'resetUserPassword']);
        Route::delete('/moderator/users/{user}', [ModeratorManagementController::class, 'destroyUser']);
        Route::post('/moderator/customers', [ModeratorManagementController::class, 'storeCustomer']);
        Route::patch('/moderator/customers/{customer}', [ModeratorManagementController::class, 'updateCustomer']);
    });

    Route::middleware(['role:admin,moderator', 'menu:moderator,customer-users'])->group(function (): void {
        Route::get('/customer-users', [CustomerUserController::class, 'index']);
        Route::post('/customer-users/{customer}', [CustomerUserController::class, 'store']);
    });

    Route::middleware('role:admin,dealer_admin,salesperson,cashier,point,customer,warehouse')->group(function () {
        Route::get('/products/search', ProductSearchController::class)
            ->middleware(['menu:search', 'throttle:product-search']);
        Route::get('/products/{product}/image', ProductImageController::class)
            ->middleware('menu:search');
        Route::get('/products/filter-options', ProductFilterOptionsController::class)
            ->middleware('menu:search');
        Route::get('/catalog/new-products', [CatalogController::class, 'newProducts'])
            ->middleware('menu:catalogs,dashboard');
        Route::get('/catalog/hot-products', [CatalogController::class, 'hotProducts'])
            ->middleware('menu:catalogs,dashboard');
        Route::get('/cart', [CartController::class, 'show'])->middleware('menu:cart');
        Route::post('/cart/items', [CartItemController::class, 'store'])->middleware('menu:cart');
        Route::delete('/cart/items/{id}', [CartItemController::class, 'destroy'])->middleware('menu:cart');
        Route::get('/orders', [OrderController::class, 'index'])->middleware('menu:orders,dashboard');
        Route::post('/orders', [OrderController::class, 'store'])->middleware('menu:orders,cart');
        Route::get('/returns', [ReturnRequestController::class, 'index'])->middleware('menu:returns');
        Route::post('/returns', [ReturnRequestController::class, 'store'])->middleware('menu:returns');
        Route::patch('/returns/{returnRequest}/status', [ReturnRequestController::class, 'updateStatus'])->middleware('menu:returns');
        Route::get('/reports/customer-balances', CustomerBalanceReportController::class)
            ->middleware(['throttle:reports', 'menu:reports,dashboard']);
        Route::get('/reports/order-balances', OrderBalanceReportController::class)
            ->middleware(['throttle:reports', 'menu:reports,dashboard,orders']);
        Route::get('/reports/collections', CollectionReportController::class)
            ->middleware(['throttle:reports', 'menu:reports,collections,dashboard']);
        Route::get('/reports/sales', SalesReportController::class)
            ->middleware(['throttle:reports', 'menu:reports,dashboard']);
        Route::get('/reports/logo-dashboard', LogoDashboardReportController::class)
            ->middleware(['throttle:reports', 'menu:dashboard,reports']);
        Route::get('/reports/runs/{reportRun}', [ReportRunController::class, 'show'])
            ->middleware(['throttle:reports', 'menu:reports,dashboard']);
        Route::get('/context', [UserContextController::class, 'show'])->middleware('menu:customers,cart,orders,ledger,collections,reports,dashboard');
        Route::post('/context/customer', [UserContextController::class, 'setCustomer'])->middleware('menu:customers,cart,orders,ledger,collections,reports,dashboard');
        Route::delete('/context/customer', [UserContextController::class, 'clearCustomer'])->middleware('menu:customers,cart,orders,ledger,collections,reports,dashboard');
        Route::get('/customers/{customer}/ledger', [CustomerLedgerController::class, 'index'])->middleware('menu:ledger');
        Route::apiResource('dealers', DealerController::class)->only(['index', 'show', 'update'])->middleware('menu:customers,search,cart,orders,reports,ledger,collections,dashboard,extra');
        Route::apiResource('customers', CustomerController::class)->middleware('menu:customers,cart,orders,ledger,collections,reports,dashboard,new-customer-card');
        Route::get('/campaigns', [CampaignController::class, 'index']);
        Route::get('/customers/{customer}/campaign-progress', [CampaignController::class, 'progress']);
    });

    Route::middleware(['role:admin,dealer_admin,salesperson,cashier,point', 'menu:collections,pos'])->group(function (): void {
        Route::get('/finance-definitions', [FinanceDefinitionController::class, 'index']);
        Route::get('/collections/next-sequence', [CustomerCollectionController::class, 'nextSequence']);
        Route::get('/customers/{customer}/collections', [CustomerCollectionController::class, 'index']);
        Route::post('/customers/{customer}/collections', [CustomerCollectionController::class, 'store']);
        Route::patch('/customers/{customer}/collections/{collection}', [CustomerCollectionController::class, 'update']);
        Route::delete('/customers/{customer}/collections/{collection}', [CustomerCollectionController::class, 'destroy']);
        Route::post('/customers/{customer}/collections/send', [CustomerCollectionController::class, 'sendMany']);
        Route::post('/customers/{customer}/collections/{collection}/send', [CustomerCollectionController::class, 'send']);
    });

    Route::prefix('pos')
        ->middleware(['role:admin,dealer_admin,salesperson,cashier,point,warehouse', 'throttle:pos'])
        ->group(function () {
            Route::middleware('menu:pos,pos-expenses,pos-day-end')->group(function (): void {
                Route::get('/customers', [CustomerController::class, 'index']);
                Route::post('/sessions/open', [PosSessionController::class, 'open']);
                Route::post('/sessions/close', [PosSessionController::class, 'close']);
                Route::get('/sessions/current', [PosSessionController::class, 'current']);
            });

            Route::middleware('menu:pos')->group(function (): void {
                Route::get('/products/quick-search', PosQuickProductSearchController::class);
                Route::post('/sales', [PosSaleController::class, 'store']);
                Route::post('/sales/{posSale}/cancel', [PosSaleController::class, 'cancel']);
                Route::get('/sales/{posSale}/print', [PosSaleController::class, 'print']);
                Route::get('/sales/{posSale}/print/receipt', [PosSaleController::class, 'printReceipt']);
            });

            Route::middleware('menu:pos-expenses,collections')->group(function (): void {
                Route::get('/expenses', [PosExpenseController::class, 'index']);
                Route::post('/expenses', [PosExpenseController::class, 'store']);
            });

            Route::middleware('menu:pos-day-end')->group(function (): void {
                Route::get('/reports/day-end', [PosReportController::class, 'dayEnd']);
                Route::get('/reports/day-end/print', [PosReportController::class, 'dayEndPrint']);
            });

            Route::middleware('menu:pos,delivery-notes')->group(function (): void {
                Route::get('/sales', [PosSaleController::class, 'index']);
                Route::get('/sales/{posSale}', [PosSaleController::class, 'show']);
                Route::put('/sales/{posSale}', [PosSaleController::class, 'update']);
                Route::delete('/sales/{posSale}', [PosSaleController::class, 'destroy']);
            });
        });

    Route::prefix('warehouse')
        ->middleware(['role:warehouse,admin,dealer_admin', 'menu:warehouse', 'throttle:pos'])
        ->group(function () {
            Route::get('/orders/ready', [WarehouseOrderController::class, 'ready']);
            Route::patch('/orders/{order}/items/{item}', [OrderController::class, 'updateWarehouseItem']);
            Route::get('/staff', [WarehouseShipmentController::class, 'staff']);
            Route::post('/shipments', [WarehouseShipmentController::class, 'store']);
            Route::get('/shipments/{shipment}', [WarehouseShipmentController::class, 'show']);
            Route::get('/shipments/{shipment}/print/packing-slip', [WarehouseShipmentPrintController::class, 'packingSlip']);
            Route::get('/shipments/{shipment}/print/label', [WarehouseShipmentPrintController::class, 'label']);
            Route::post('/shipments/{shipment}/scan', [WarehouseShipmentController::class, 'scan']);
            Route::post('/shipments/{shipment}/return-item', [WarehouseShipmentController::class, 'returnItem']);
            Route::post('/shipments/{shipment}/return-all', [WarehouseShipmentController::class, 'returnAllItems']);
            Route::post('/shipments/{shipment}/add-item', [WarehouseShipmentController::class, 'addItem']);
            Route::patch('/shipments/{shipment}/items/{item}/quantity', [WarehouseShipmentController::class, 'updateItemQuantity']);
            Route::delete('/shipments/{shipment}/items/{item}', [WarehouseShipmentController::class, 'destroyItem']);
            Route::post('/shipments/{shipment}/finalize', [WarehouseShipmentController::class, 'finalize']);
            Route::post('/shipments/{shipment}/cancel', [WarehouseShipmentController::class, 'cancel']);
        });

    Route::prefix('purchase-receipts')
        ->middleware(['role:admin,dealer_admin,warehouse', 'menu:extra', 'throttle:pos'])
        ->group(function (): void {
            Route::post('/', [PurchaseReceiptController::class, 'store']);
        });
});
