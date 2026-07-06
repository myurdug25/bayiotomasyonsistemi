<?php

namespace App\Observers;

use App\Models\Collection;
use App\Models\Customer;
use App\Models\LedgerEntry;
use App\Models\Order;
use App\Models\ReturnRequest;
use App\Models\Shipment;
use App\Models\StockSummary;
use App\Services\Realtime\RealtimeDomainEventPublisher;
use Illuminate\Contracts\Events\ShouldHandleEventsAfterCommit;
use Illuminate\Database\Eloquent\Model;

class RealtimeDomainObserver implements ShouldHandleEventsAfterCommit
{
    public function __construct(private readonly RealtimeDomainEventPublisher $events) {}

    public function created(Model $model): void
    {
        $this->publish($model, true);
    }

    public function updated(Model $model): void
    {
        $this->publish($model, false);
    }

    public function deleted(Model $model): void
    {
        $this->publish($model, false, true);
    }

    private function publish(Model $model, bool $created, bool $deleted = false): void
    {
        if ($model instanceof StockSummary) {
            if (! $created && ! $deleted && ! $model->wasChanged([
                'available_total',
                'reserved_total',
            ])) {
                return;
            }

            $this->events->publish('stock_updated', [
                'product_id' => (int) $model->product_id,
                'available_total' => (int) $model->available_total,
                'reserved_total' => (int) $model->reserved_total,
            ]);

            return;
        }

        if ($model instanceof Shipment) {
            $event = $created
                ? 'stock_transfer_created'
                : (in_array($model->status, ['shipped', 'partially_shipped'], true)
                    ? 'stock_transfer_received'
                    : 'stock_transfer_updated');
            $this->events->publish($event, [
                'shipment_id' => (int) $model->id,
                'order_id' => (int) $model->order_id,
                'status' => $model->status,
            ], $this->shipmentDealerId($model));

            return;
        }

        if ($model instanceof Order) {
            $this->events->publish($created ? 'stock_transfer_created' : 'stock_transfer_updated', [
                'order_id' => (int) $model->id,
                'status' => $model->status,
            ], $model->dealer_id !== null ? (int) $model->dealer_id : null);

            return;
        }

        if ($model instanceof Collection) {
            $this->events->publish(
                $created ? 'collection_added' : 'collection_updated',
                [
                    'collection_id' => (int) $model->id,
                    'customer_id' => (int) $model->customer_id,
                    'deleted' => $deleted,
                ],
                $model->dealer_id !== null ? (int) $model->dealer_id : null
            );

            return;
        }

        if ($model instanceof LedgerEntry) {
            $this->events->publish('customer_balance_changed', [
                'customer_id' => (int) $model->customer_id,
                'ledger_entry_id' => (int) $model->id,
                'deleted' => $deleted,
            ], $model->dealer_id !== null ? (int) $model->dealer_id : null);

            return;
        }

        if ($model instanceof Customer) {
            if (! $created && ! $deleted && ! $model->wasChanged([
                'code',
                'name',
                'city',
                'district',
                'phone',
                'salesperson_user_id',
                'region_code',
                'region_name',
                'branch_code',
                'branch_name',
                'is_active',
                'sync_status',
                'source_reference',
            ])) {
                return;
            }

            $this->events->publish($created ? 'customer_created' : 'customer_updated', [
                'customer_id' => (int) $model->id,
                'sync_status' => $model->sync_status,
                'deleted' => $deleted,
            ], $model->dealer_id !== null ? (int) $model->dealer_id : null);

            return;
        }

        if ($model instanceof ReturnRequest) {
            $this->events->publish($created ? 'return_created' : 'return_updated', [
                'return_request_id' => (int) $model->id,
                'status' => $model->status,
                'deleted' => $deleted,
            ], $model->dealer_id !== null ? (int) $model->dealer_id : null);
        }
    }

    private function shipmentDealerId(Shipment $shipment): ?int
    {
        $dealerId = $shipment->order()->value('dealer_id');

        return $dealerId !== null ? (int) $dealerId : null;
    }
}
