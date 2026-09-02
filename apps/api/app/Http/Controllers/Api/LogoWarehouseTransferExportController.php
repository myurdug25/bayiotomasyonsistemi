<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Integration\AcknowledgeLogoShipmentsRequest;
use App\Http\Requests\Integration\ListPendingLogoShipmentsRequest;
use App\Services\Integrations\Logo\LogoWarehouseTransferExportService;
use Illuminate\Http\JsonResponse;

class LogoWarehouseTransferExportController extends Controller
{
    public function index(
        ListPendingLogoShipmentsRequest $request,
        LogoWarehouseTransferExportService $service
    ): JsonResponse {
        return response()->json($service->pending($request->validated()));
    }

    public function acknowledge(
        AcknowledgeLogoShipmentsRequest $request,
        LogoWarehouseTransferExportService $service
    ): JsonResponse {
        $summary = $service->acknowledge($request->validated());

        return response()->json([
            'message' => 'Logo warehouse transfer acknowledgements processed.',
            'summary' => $summary,
        ]);
    }
}
