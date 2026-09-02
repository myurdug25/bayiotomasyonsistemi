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
            'is_active' => 'boolean',
            'starts_at' => 'date',
            'ends_at' => 'date',
            'meta' => 'array',
            'last_synced_at' => 'datetime',
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
        return $this->matchesAnyGroup($customerGroup !== null ? [$customerGroup] : []);
    }

    /**
     * @param  iterable<string>  $customerGroups
     */
    public function matchesAnyGroup(iterable $customerGroups): bool
    {
        if ($this->customer_group === null || $this->customer_group === '') {
            return true; // Grup filtresi yoksa herkese açık
        }

        $normalizedCustomerGroups = collect($customerGroups)
            ->filter(fn (mixed $group): bool => is_string($group) && trim($group) !== '')
            ->map(fn (string $group): string => mb_strtoupper(trim($group), 'UTF-8'))
            ->all();

        if ($normalizedCustomerGroups === []) {
            return false;
        }

        $groups = array_map(
            static fn (string $group): string => mb_strtoupper(trim($group), 'UTF-8'),
            explode(',', $this->customer_group)
        );

        return array_intersect($groups, $normalizedCustomerGroups) !== [];
    }

    public function scopeActive($query)
    {
        $today = now()->toDateString();

        return $query
            ->where('is_active', true)
            ->where(function ($query) use ($today): void {
                $query->whereNull('starts_at')
                    ->orWhereDate('starts_at', '<=', $today);
            })
            ->where(function ($query) use ($today): void {
                $query->whereNull('ends_at')
                    ->orWhereDate('ends_at', '>=', $today);
            });
    }
}
