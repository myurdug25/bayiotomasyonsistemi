<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;

class Product extends Model
{
    use HasFactory;

    /**
     * @var list<string>
     */
    protected $fillable = [
        'brand_id',
        'category_id',
        'sku',
        'oem_code',
        'name',
        'description',
        'unit',
        'vat_rate',
        'weight_kg',
        'is_active',
        'meta',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'vat_rate' => 'decimal:2',
            'weight_kg' => 'decimal:3',
            'is_active' => 'boolean',
            'meta' => 'array',
        ];
    }

    public function brand(): BelongsTo
    {
        return $this->belongsTo(Brand::class);
    }

    public function category(): BelongsTo
    {
        return $this->belongsTo(Category::class);
    }

    public function vehicles(): BelongsToMany
    {
        return $this->belongsToMany(Vehicle::class, 'vehicle_products')
            ->withPivot(['position', 'fitment_note'])
            ->withTimestamps();
    }

    public function fitments(): HasMany
    {
        return $this->hasMany(VehicleProduct::class);
    }

    public function stockSummary(): HasOne
    {
        return $this->hasOne(StockSummary::class);
    }

    public function basePrices(): HasMany
    {
        return $this->hasMany(BasePrice::class);
    }

    public function campaignPrices(): HasMany
    {
        return $this->hasMany(ProductCampaignPrice::class);
    }

    public function codeAliases(): HasMany
    {
        return $this->hasMany(ProductCodeAlias::class);
    }

    public function dealerPriceOverrides(): HasMany
    {
        return $this->hasMany(DealerPriceOverride::class);
    }

    public function cartItems(): HasMany
    {
        return $this->hasMany(CartItem::class);
    }

    public function orderItems(): HasMany
    {
        return $this->hasMany(OrderItem::class);
    }

    public function hotProduct(): HasOne
    {
        return $this->hasOne(HotProduct::class);
    }

    public function posSaleItems(): HasMany
    {
        return $this->hasMany(PosSaleItem::class);
    }

    public function stockMovements(): HasMany
    {
        return $this->hasMany(StockMovement::class);
    }

    public function shipmentItems(): HasMany
    {
        return $this->hasMany(ShipmentItem::class);
    }

    public function shipmentScans(): HasMany
    {
        return $this->hasMany(ShipmentScan::class);
    }
}
