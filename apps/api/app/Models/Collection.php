<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Collection extends Model
{
    use HasFactory;

    /**
     * @var list<string>
     */
    protected $fillable = [
        'dealer_id',
        'customer_id',
        'source_system',
        'source_reference',
        'sync_status',
        'sync_error',
        'last_synced_at',
        'date',
        'collected_by_user_id',
        'created_by_user_id',
        'collection_date',
        'method',
        'amount',
        'currency',
        'reference_no',
        'reference_fields',
        'note',
        'meta',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'date' => 'date',
            'collection_date' => 'date',
            'amount' => 'decimal:2',
            'reference_fields' => 'array',
            'meta' => 'array',
            'last_synced_at' => 'datetime',
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

    public function collectedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'collected_by_user_id');
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by_user_id');
    }

    public function ledgerEntries(): HasMany
    {
        return $this->hasMany(LedgerEntry::class);
    }

    public function logoExportKey(): string
    {
        $createdAt = $this->created_at?->format('YmdHisv') ?? 'unknown';

        return "B2B-COL-{$this->id}-{$createdAt}";
    }
}
