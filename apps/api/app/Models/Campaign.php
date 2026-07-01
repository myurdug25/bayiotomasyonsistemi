<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Campaign extends Model
{
    use HasFactory;

    protected $fillable = [
        'source_reference',
        'code',
        'name',
        'description',
        'customer_group',
        'target_quantity',
        'discount_percent',
        'group_field',
        'starts_at',
        'ends_at',
        'is_active',
        'meta',
        'last_synced_at',
    ];

    protected function casts(): array
    {
        return [
            'target_quantity' => 'integer',
            'discount_percent' => 'integer',
            'is_active'       => 'boolean',
            'starts_at'       => 'date',
            'ends_at'         => 'date',
            'meta'            => 'array',
            'last_synced_at'  => 'datetime',
        ];
    }

    public function campaignProducts(): HasMany
    {
        return $this->hasMany(CampaignProduct::class);
    }

    /**
     * Verilen cari grup kodunun bu kampanyaya uyup uymadığını kontrol eder.
     */
    public function matchesGroup(?string $customerGroup): bool
    {
        if ($this->customer_group === null || $this->customer_group === '') {
            return true; // Grup filtresi yoksa herkese açık
        }

        if ($customerGroup === null || $customerGroup === '') {
            return false;
        }

        $groups = array_map('trim', explode(',', $this->customer_group));

        return in_array(trim($customerGroup), $groups, true);
    }

    /**
     * Aktif ve tarihi geçmemiş kampanya sorgusu.
     */
    public function scopeActive($query)
    {
        return $query
            ->where('is_active', true)
            ->where(fn ($q) => $q->whereNull('starts_at')->orWhereDate('starts_at', '<=', today()))
            ->where(fn ($q) => $q->whereNull('ends_at')->orWhereDate('ends_at', '>=', today()));
    }
}
