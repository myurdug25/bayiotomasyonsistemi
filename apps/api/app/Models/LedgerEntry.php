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
     * Keep non-accounting/order-visibility rows and Logo echo rows out of customer balances.
     *
     * Open orders may be displayed on the customer ledger, but they are not accounting
     * movements until Logo creates an invoice. Logo also sends back the collection as a ledger
     * line after B2B exports it; when the original B2B ledger line is still present for the same
     * collection, that Logo line is only a sync confirmation and must not be counted twice.
     *
     * @param  Builder<LedgerEntry>  $query
     * @return Builder<LedgerEntry>
     */
    public function scopeEffectiveForCustomerBalance(Builder $query): Builder
    {
        $sourceSystem = $query->qualifyColumn('source_system');
        $sourceReference = $query->qualifyColumn('source_reference');
        $collectionId = $query->qualifyColumn('collection_id');
        $customerId = $query->qualifyColumn('customer_id');
        $id = $query->qualifyColumn('id');

        return $query
            ->where(function (Builder $query): void {
                $query
                    ->whereNull('meta->source')
                    ->orWhere(function (Builder $query): void {
                        $query
                            ->where('meta->source', '!=', 'order_checkout')
                            ->where('meta->source', '!=', 'order_visibility');
                    });
            })
            ->withoutDuplicatedLogoCollectionEcho($sourceSystem, $collectionId, $customerId, $id)
            ->withoutSyncedB2bCollectionProvisional($sourceSystem, $collectionId, $customerId, $id)
            ->withoutSyncedB2bLedgerProvisional($sourceSystem, $sourceReference, $customerId, $id);
    }

    /**
     * Keep customer ledger display clean while still allowing non-financial order rows to be shown.
     *
     * @param  Builder<LedgerEntry>  $query
     * @return Builder<LedgerEntry>
     */
    public function scopeVisibleForCustomerLedger(Builder $query): Builder
    {
        $sourceSystem = $query->qualifyColumn('source_system');
        $sourceReference = $query->qualifyColumn('source_reference');
        $collectionId = $query->qualifyColumn('collection_id');
        $customerId = $query->qualifyColumn('customer_id');
        $id = $query->qualifyColumn('id');

        return $query
            ->where(function (Builder $query): void {
                $query
                    ->whereNull('meta->source')
                    ->orWhere('meta->source', '!=', 'order_checkout');
            })
            ->withoutDuplicatedLogoCollectionEcho($sourceSystem, $collectionId, $customerId, $id)
            ->withoutSyncedB2bCollectionProvisional($sourceSystem, $collectionId, $customerId, $id)
            ->withoutSyncedB2bLedgerProvisional($sourceSystem, $sourceReference, $customerId, $id);
    }

    public function scopeWithoutDuplicatedLogoCollectionEcho(
        Builder $query,
        string $sourceSystem,
        string $collectionId,
        string $customerId,
        string $id
    ): Builder {
        return $query
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

    public function scopeWithoutSyncedB2bLedgerProvisional(
        Builder $query,
        string $sourceSystem,
        string $sourceReference,
        string $customerId,
        string $id
    ): Builder {
        return $query
            ->where(function (Builder $query) use ($sourceSystem, $sourceReference, $customerId, $id): void {
                $query
                    ->where($sourceSystem, '!=', 'b2b')
                    ->orWhereNull($sourceReference)
                    ->orWhereNotExists(function ($subquery) use ($sourceReference, $customerId, $id): void {
                        $subquery
                            ->selectRaw('1')
                            ->from('ledger_entries as authoritative_logo_entries')
                            ->whereColumn('authoritative_logo_entries.customer_id', $customerId)
                            ->whereColumn('authoritative_logo_entries.id', '!=', $id)
                            ->where('authoritative_logo_entries.source_system', 'logo')
                            ->whereNotNull('authoritative_logo_entries.source_reference')
                            ->where(function ($match) use ($sourceReference): void {
                                $match
                                    ->whereColumn('authoritative_logo_entries.source_reference', $sourceReference)
                                    ->orWhereRaw(
                                        $sourceReference." = ('CLFLINE-' || authoritative_logo_entries.source_reference)"
                                    )
                                    ->orWhereRaw(
                                        $sourceReference." LIKE ('%CLFLINE-' || authoritative_logo_entries.source_reference || '%')"
                                    );
                            });
                    });
            });
    }

    public function scopeWithoutSyncedB2bCollectionProvisional(
        Builder $query,
        string $sourceSystem,
        string $collectionId,
        string $customerId,
        string $id
    ): Builder {
        return $query
            ->where(function (Builder $query) use ($sourceSystem, $collectionId, $customerId, $id): void {
                $query
                    ->whereNull($collectionId)
                    ->orWhere($sourceSystem, '!=', 'b2b')
                    ->orWhereNotExists(function ($subquery) use ($collectionId, $customerId, $id): void {
                        $subquery
                            ->selectRaw('1')
                            ->from('collections as source_b2b_collections')
                            ->join('ledger_entries as authoritative_logo_entries', function ($join) use ($customerId, $id): void {
                                $join
                                    ->on('authoritative_logo_entries.customer_id', '=', $customerId)
                                    ->whereColumn('authoritative_logo_entries.id', '!=', $id)
                                    ->where('authoritative_logo_entries.source_system', 'logo')
                                    ->whereNull('authoritative_logo_entries.collection_id')
                                    ->whereNotNull('authoritative_logo_entries.source_reference');
                            })
                            ->whereColumn('source_b2b_collections.id', $collectionId)
                            ->where('source_b2b_collections.source_system', 'b2b')
                            ->whereNotNull('source_b2b_collections.source_reference')
                            ->where(function ($match): void {
                                $match
                                    ->whereColumn(
                                        'authoritative_logo_entries.source_reference',
                                        'source_b2b_collections.source_reference'
                                    )
                                    ->orWhereRaw(
                                        "source_b2b_collections.source_reference LIKE ('%CLFLINE-' || authoritative_logo_entries.source_reference || '%')"
                                    );
                            });
                    });
            });
    }
}
