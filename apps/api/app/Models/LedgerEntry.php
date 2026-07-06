<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class LedgerEntry extends Model
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
        'last_synced_at',
        'order_id',
        'collection_id',
        'date',
        'type',
        'debit',
        'credit',
        'balance_after',
        'entry_date',
        'entry_type',
        'amount',
        'currency',
        'reference_no',
        'description',
        'created_by_user_id',
        'meta',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'date' => 'date',
            'entry_date' => 'date',
            'debit' => 'decimal:2',
            'credit' => 'decimal:2',
            'balance_after' => 'decimal:2',
            'amount' => 'decimal:2',
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

    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class);
    }

    public function collection(): BelongsTo
    {
        return $this->belongsTo(Collection::class);
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by_user_id');
    }

    /**
     * Keep Logo echo rows for B2B-originated collections out of customer-facing balances.
     *
     * Logo sends back the collection as a ledger line after B2B exports it. When the original
     * B2B ledger line is still present for the same collection, that Logo line is only a sync
     * confirmation and must not be counted as a second financial movement.
     *
     * @param  Builder<LedgerEntry>  $query
     * @return Builder<LedgerEntry>
     */
    public function scopeEffectiveForCustomerBalance(Builder $query): Builder
    {
        $sourceSystem = $query->qualifyColumn('source_system');
        $collectionId = $query->qualifyColumn('collection_id');
        $customerId = $query->qualifyColumn('customer_id');
        $id = $query->qualifyColumn('id');

        return $query
            ->where(function (Builder $query): void {
                $query
                    ->whereNull('meta->source')
                    ->orWhere('meta->source', '!=', 'order_checkout');
            })
            ->where(function (Builder $query) use ($sourceSystem, $collectionId, $customerId, $id): void {
                $query
                    ->whereNull($sourceSystem)
                    ->orWhere($sourceSystem, '!=', 'logo')
                    ->orWhereNull($collectionId)
                    ->orWhereNotExists(function ($subquery) use ($collectionId, $customerId, $id): void {
                        $subquery
                            ->selectRaw('1')
                            ->from('ledger_entries as linked_b2b_ledger_entries')
                            ->join(
                                'collections as linked_b2b_collections',
                                'linked_b2b_collections.id',
                                '=',
                                'linked_b2b_ledger_entries.collection_id'
                            )
                            ->whereColumn('linked_b2b_ledger_entries.collection_id', $collectionId)
                            ->whereColumn('linked_b2b_ledger_entries.customer_id', $customerId)
                            ->whereColumn('linked_b2b_ledger_entries.id', '!=', $id)
                            ->where('linked_b2b_ledger_entries.source_system', 'b2b')
                            ->where('linked_b2b_collections.source_system', 'b2b');
                    });
            });
    }
}
