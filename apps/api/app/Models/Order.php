<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;

class Order extends Model
{
    use HasFactory;

    /**
     * @var list<string>
     */
    protected $fillable = [
        'order_no',
        'dealer_id',
        'customer_id',
        'user_id',
        'cart_id',
        'status',
        'currency',
        'subtotal',
        'discount_total',
        'tax_total',
        'grand_total',
        'ordered_at',
        'approved_at',
        'note',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'subtotal' => 'decimal:2',
            'discount_total' => 'decimal:2',
            'tax_total' => 'decimal:2',
            'grand_total' => 'decimal:2',
            'ordered_at' => 'datetime',
            'approved_at' => 'datetime',
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

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function cart(): BelongsTo
    {
        return $this->belongsTo(Cart::class);
    }

    public function items(): HasMany
    {
        return $this->hasMany(OrderItem::class);
    }

    public function statusHistory(): HasMany
    {
        return $this->hasMany(OrderStatusHistory::class);
    }

    public function latestStatusHistory(): HasOne
    {
        return $this->hasOne(OrderStatusHistory::class)->latestOfMany('created_at');
    }

    public function ledgerEntries(): HasMany
    {
        return $this->hasMany(LedgerEntry::class);
    }

    public function shipments(): HasMany
    {
        return $this->hasMany(Shipment::class);
    }

    public function latestActiveShipment(): HasOne
    {
        return $this->hasOne(Shipment::class)
            ->ofMany(
                ['id' => 'max'],
                fn ($query) => $query->where('status', '!=', 'cancelled')
            );
    }

    public function logoExportKey(): string
    {
        return 'B2B-ORDER-'.$this->order_no;
    }
}
