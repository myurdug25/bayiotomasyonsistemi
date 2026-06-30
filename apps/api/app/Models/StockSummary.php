<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class StockSummary extends Model
{
    use HasFactory;

    protected $table = 'stock_summary';

    protected $primaryKey = 'product_id';

    public $incrementing = false;

    public $timestamps = false;

    /**
     * @var string
     */
    protected $keyType = 'int';

    /**
     * @var list<string>
     */
    protected $fillable = [
        'product_id',
        'available_total',
        'reserved_total',
        'updated_at',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'available_total' => 'integer',
            'reserved_total' => 'integer',
            'updated_at' => 'datetime',
        ];
    }

    protected function availableTotal(): Attribute
    {
        return Attribute::make(
            get: fn (mixed $value): int => max(0, (int) $value),
            set: fn (mixed $value): int => max(0, (int) $value),
        );
    }

    protected function reservedTotal(): Attribute
    {
        return Attribute::make(
            get: fn (mixed $value): int => max(0, (int) $value),
            set: fn (mixed $value): int => max(0, (int) $value),
        );
    }

    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class);
    }
}
