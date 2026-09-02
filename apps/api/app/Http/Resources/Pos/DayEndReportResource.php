<?php

namespace App\Http\Resources\Pos;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class DayEndReportResource extends JsonResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        return [
            'filters' => $this['filters'] ?? [],
            'session' => $this['session'] ?? null,
            'summary' => $this['summary'] ?? [],
            'totals_by_method' => $this['totals_by_method'] ?? [],
            'expenses' => $this['expenses'] ?? [],
            'report_tables' => $this['report_tables'] ?? [],
            'cancelled' => $this['cancelled'] ?? [],
            'logo_sync' => $this['logo_sync'] ?? [],
            'day_end_export' => $this['day_end_export'] ?? null,
            'generated_at' => $this['generated_at'] ?? null,
        ];
    }
}
