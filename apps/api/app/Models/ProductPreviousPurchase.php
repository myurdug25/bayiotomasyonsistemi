<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class ProductPreviousPurchase extends Model
{
    /**
     * @var list<string>
     */
    protected $fillable = [
        'dealer_id',
        'customer_id',
        'product_id',
        'customer_code',
        'product_code',
        'source_database',
        'external_ref',
        'purchase_date',
        'document_no',
        'description',
        'quantity',
        'unit',
        'unit_price',
        'net_price',
        'discounts',
        'gross_total',
        'net_total',
        'synced_at',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'purchase_date' => 'date',
            'quantity' => 'decimal:4',
            'unit_price' => 'decimal:4',
            'net_price' => 'decimal:4',
            'discounts' => 'array',
            'gross_total' => 'decimal:4',
            'net_total' => 'decimal:4',
            'synced_at' => 'datetime',
        ];
    }

    public function dealer(): BelongsTo
    {
        return $this->belongsTo(Dealer::class);
    }

    public function customer(): BelongsTo
    {
        return $this->belongsTo(Customer::class);
    }

    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class);
    }
}
