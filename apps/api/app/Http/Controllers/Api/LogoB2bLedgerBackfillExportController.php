<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Integration\AcknowledgeLogoB2bLedgerBackfillRequest;
use App\Http\Requests\Integration\ListPendingLogoB2bLedgerBackfillRequest;
use App\Services\Integrations\Logo\LogoB2bLedgerBackfillExportService;
use Illuminate\Http\JsonResponse;

class LogoB2bLedgerBackfillExportController extends Controller
{
    public function index(
        ListPendingLogoB2bLedgerBackfillRequest $request,
        LogoB2bLedgerBackfillExportService $service
    ): JsonResponse {
        return response()->json($service->pending($request->validated()));
    }

    public function acknowledge(
        AcknowledgeLogoB2bLedgerBackfillRequest $request,
        LogoB2bLedgerBackfillExportService $service
    ): JsonResponse {
        return response()->json([
            'message' => 'Logo B2B ledger backfill acknowledgements processed.',
            'summary' => $service->acknowledge($request->validated()),
        ]);
    }
}
