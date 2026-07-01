<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class ProductCampaignPrice extends Model
{
    use HasFactory;

    protected $fillable = [
        'product_id',
        'source_reference',
        'campaign_key',
        'name',
        'condition',
        'min_quantity',
        'unit_price',
        'currency',
        'priority',
        'branch',
        'starts_at',
        'ends_at',
        'is_active',
        'meta',
    ];

    protected function casts(): array
    {
        return [
            'min_quantity' => 'integer',
            'unit_price' => 'decimal:4',
            'priority' => 'integer',
            'branch' => 'integer',
            'starts_at' => 'date',
            'ends_at' => 'date',
            'is_active' => 'boolean',
            'meta' => 'array',
        ];
    }

    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class);
    }
}
