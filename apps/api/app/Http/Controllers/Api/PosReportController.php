<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Pos\DayEndReportRequest;
use App\Http\Resources\Pos\DayEndReportResource;
use App\Models\PosSale;
use App\Services\Pos\DayEndReportService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Response as LaravelResponse;
use Symfony\Component\HttpFoundation\Response as HttpStatus;

class PosReportController extends Controller
{
    public function dayEnd(DayEndReportRequest $request, DayEndReportService $dayEndReportService): JsonResponse
    {
        $this->authorize('viewAny', PosSale::class);

        $report = $dayEndReportService->build($request->user(), $request->validated());

        return response()->json([
            'data' => new DayEndReportResource($report),
        ]);
    }

    public function dayEndSave(DayEndReportRequest $request, DayEndReportService $dayEndReportService): JsonResponse
    {
        $this->authorize('viewAny', PosSale::class);

        $report = $dayEndReportService->save($request->user(), $request->validated());

        return response()->json([
            'data' => new DayEndReportResource($report),
        ]);
    }

    public function dayEndPrint(
        DayEndReportRequest $request,
        DayEndReportService $dayEndReportService
    ): LaravelResponse {
        $this->authorize('viewAny', PosSale::class);

        $report = $dayEndReportService->build($request->user(), $request->validated());

        return response()->view('pos.prints.day-end', [
            'report' => $report,
        ], HttpStatus::HTTP_OK, [
            'Content-Type' => 'text/html; charset=UTF-8',
        ]);
    }
}
