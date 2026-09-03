<?php

namespace App\Http\Resources;

use App\Models\Customer;
use App\Models\User;
use App\Support\Pricing\DisplayCurrency;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class CollectionResource extends JsonResource
{
    /**
     * Transform the resource into an array.
     *
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        $date = $this->date ?? $this->collection_date;
        $user = $request->user();
        $displayUser = $user instanceof User ? $user : null;
        $displayCustomer = $this->relationLoaded('customer') && $this->customer instanceof Customer
            ? $this->customer
            : null;
        $sourceCurrency = (string) ($this->currency ?: 'TRY');

        return [
            'id' => $this->id,
            'dealer_id' => $this->dealer_id,
            'customer_id' => $this->customer_id,
            'source_system' => $this->source_system,
            'source_reference' => $this->source_reference,
            'sync_status' => $this->sync_status,
            'sync_error' => $this->sync_error,
            'last_synced_at' => $this->last_synced_at,
            'date' => $date,
            'created_by' => $this->created_by_user_id ?? $this->collected_by_user_id,
            'collected_by_user_id' => $this->collected_by_user_id,
            'created_by_user_id' => $this->created_by_user_id,
            'collection_date' => $this->collection_date,
            'method' => $this->method,
            'amount' => DisplayCurrency::formatPrice($this->amount, $sourceCurrency, $displayUser, $displayCustomer) ?? (string) $this->amount,
            'currency' => DisplayCurrency::normalize($sourceCurrency, $displayUser, $displayCustomer),
            'reference_no' => $this->reference_no,
            'reference_fields' => $this->reference_fields ?? $this->meta,
            'note' => $this->note,
            'meta' => $this->meta,
            'created_at' => $this->created_at,
            'updated_at' => $this->updated_at,
        ];
    }
}
