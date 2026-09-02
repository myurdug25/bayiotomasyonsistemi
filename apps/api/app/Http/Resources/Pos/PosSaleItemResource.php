<?php

namespace App\Http\Resources\Pos;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class PosSaleItemResource extends JsonResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        $vatMultiplier = 1 + (((float) $this->vat_rate) / 100);

        return [
            'id' => $this->id,
            'product_id' => $this->product_id,
            'sku' => $this->product?->sku,
            'oem' => $this->product?->oem_code,
            'name' => $this->product?->name,
            'brand' => $this->product?->brand?->name,
            'qty' => number_format((float) $this->qty, 3, '.', ''),
            'unit_price' => number_format((float) $this->unit_price, 2, '.', ''),
            'vat_rate' => number_format((float) $this->vat_rate, 2, '.', ''),
            'line_total' => number_format((float) $this->line_total, 2, '.', ''),
            'unit_price_vat_included' => number_format((float) $this->unit_price * $vatMultiplier, 2, '.', ''),
            'line_total_vat_included' => number_format((float) $this->line_total * $vatMultiplier, 2, '.', ''),
        ];
    }
}
