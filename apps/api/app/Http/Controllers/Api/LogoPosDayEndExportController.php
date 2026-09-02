<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Integration\AcknowledgeLogoPosDayEndsRequest;
use App\Http\Requests\Integration\ListPendingLogoPosDayEndsRequest;
use App\Services\Integrations\Logo\LogoPosDayEndExportService;
use Illuminate\Http\JsonResponse;

class LogoPosDayEndExportController extends Controller
{
    public function index(
        ListPendingLogoPosDayEndsRequest $request,
        LogoPosDayEndExportService $service
    ): JsonResponse {
        return response()->json($service->pending($request->validated()));
    }

    public function acknowledge(
        AcknowledgeLogoPosDayEndsRequest $request,
        LogoPosDayEndExportService $service
    ): JsonResponse {
        $summary = $service->acknowledge($request->validated());

        return response()->json([
            'message' => 'Logo POS day-end acknowledgements processed.',
            'summary' => $summary,
        ]);
    }
}
