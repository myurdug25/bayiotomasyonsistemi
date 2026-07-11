<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Integrations\Logo\LogoProductShelfExportService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

class LogoProductShelfExportController extends Controller
{
    public function index(Request $request, LogoProductShelfExportService $service): JsonResponse
    {
        $validated = $request->validate([
            'limit' => ['nullable', 'integer', 'min:1', 'max:500'],
            'statuses' => ['nullable', 'array'],
            'statuses.*' => ['string', Rule::in(['queued', 'failed'])],
        ]);

        return response()->json($service->pending($validated));
    }

    public function acknowledge(Request $request, LogoProductShelfExportService $service): JsonResponse
    {
        $validated = $request->validate([
            'records' => ['required', 'array'],
            'records.*.product_id' => ['required', 'integer'],
            'records.*.status' => ['required', 'string', Rule::in(['synced', 'failed', 'skipped'])],
            'records.*.external_ref' => ['nullable', 'string', 'max:128'],
            'records.*.error' => ['nullable', 'string', 'max:1000'],
            'records.*.warehouse_code' => ['nullable', 'string', 'max:16'],
            'records.*.shelf_address' => ['nullable', 'string', 'max:80'],
        ]);

        return response()->json([
            'message' => 'Logo product shelf acknowledgements processed.',
            'summary' => $service->acknowledge($validated),
        ]);
    }
}
