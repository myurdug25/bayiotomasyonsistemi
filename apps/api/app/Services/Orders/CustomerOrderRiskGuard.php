<?php

namespace App\Services\Orders;

use App\Models\Customer;
use App\Models\LedgerEntry;
use Carbon\CarbonInterface;
use Illuminate\Validation\ValidationException;

class CustomerOrderRiskGuard
{
    public function assertCanPlaceOrder(Customer $customer, float|int|string $orderTotal, ?CarbonInterface $now = null): void
    {
        $limit = $this->resolveOpenAccountLimit($customer);
        $termDays = $this->resolvePaymentTermDays($customer);
        $orderAmount = max(0.0, $this->decimal($orderTotal));

        if ($limit <= 0 || $orderAmount <= 0) {
            return;
        }

        $snapshot = $this->openAccountSnapshot($customer, $termDays, $now ?? now());
        $projectedOpenAmount = $snapshot['open_amount'] + $orderAmount;
        $projectedOverdueAmount = $snapshot['overdue_amount'] + ($termDays === 0 ? $orderAmount : 0.0);

        if ($projectedOverdueAmount <= 0 || $projectedOpenAmount <= $limit) {
            return;
        }

        throw ValidationException::withMessages([
            'customer_id' => [
                sprintf(
                    'Müşterinin vadesi geçmiş açık hesabı var ve sipariş açık hesap risk limitini aşıyor. Limit: %s TL, açık bakiye: %s TL, vadesi geçmiş: %s TL.',
                    $this->formatMoney($limit),
                    $this->formatMoney($snapshot['open_amount']),
                    $this->formatMoney($projectedOverdueAmount)
                ),
            ],
        ]);
    }

    private function resolveOpenAccountLimit(Customer $customer): float
    {
        $creditLimit = $this->decimal($customer->credit_limit);
        if ($creditLimit > 0) {
            return $creditLimit;
        }

        foreach ([
            'open_account_risk_limit',
            'risk.open_account_limit',
            'integrations.logo.payload.open_account_risk_limit',
            'integrations.logo.payload.risk.open_account_limit',
            'integrations.logo.payload.raw.OPEN_ACCOUNT_RISK_LIMIT',
            'integrations.logo.payload.raw.OPENACCOUNTRISKLIMIT',
            'integrations.logo.payload.raw.RISKLIMIT',
            'integrations.logo.payload.raw.RISKLIMIT1',
            'integrations.logo.payload.raw.RISK_LIMIT',
            'integrations.logo.payload.raw.RISK_LIMIT1',
            'integrations.logo.payload.raw.DBSLIMIT1',
            'integrations.logo.payload.raw.ACCRISKLIMIT',
            'integrations.logo.payload.raw.OPENACCRISKLIMIT',
        ] as $path) {
            $value = $this->decimal(data_get($customer->meta, $path));
            if ($value > 0) {
                return $value;
            }
        }

        return 0.0;
    }

    private function resolvePaymentTermDays(Customer $customer): int
    {
        foreach ([
            'payment_term_days',
            'payment_terms_days',
            'payment_plan_days',
            'integrations.logo.payload.payment_term_days',
            'integrations.logo.payload.payment_terms_days',
            'integrations.logo.payload.payment_plan_days',
            'integrations.logo.payload.raw.PAYMENT_CODE',
            'integrations.logo.payload.raw.PAYMENTPLAN_CODE',
            'integrations.logo.payload.raw.PAYPLAN_CODE',
            'integrations.logo.payload.raw.PAYMENT_PLAN_CODE',
            'integrations.logo.payload.raw.PAYMENTPLAN',
        ] as $path) {
            $value = data_get($customer->meta, $path);
            if ($value === null || $value === '') {
                continue;
            }

            $days = $this->integer($value);
            if ($days >= 0) {
                return $days;
            }
        }

        return 0;
    }

    /**
     * @return array{open_amount: float, overdue_amount: float}
     */
    private function openAccountSnapshot(Customer $customer, int $termDays, CarbonInterface $now): array
    {
        $query = LedgerEntry::query()
            ->effectiveForCustomerBalance()
            ->where('customer_id', $customer->id);

        if ($customer->dealer_id !== null) {
            $query->where('dealer_id', $customer->dealer_id);
        }

        $entries = $query
            ->orderBy('date')
            ->orderBy('id')
            ->get(['id', 'date', 'debit', 'credit']);

        $openDebits = [];

        foreach ($entries as $entry) {
            $debit = max(0.0, $this->decimal($entry->debit));
            $credit = max(0.0, $this->decimal($entry->credit));

            if ($debit > 0) {
                $openDebits[] = [
                    'date' => $entry->date,
                    'amount' => $debit,
                ];
            }

            while ($credit > 0 && $openDebits !== []) {
                $remaining = $openDebits[0]['amount'];
                $applied = min($remaining, $credit);
                $remaining -= $applied;
                $credit -= $applied;

                if ($remaining <= 0.00001) {
                    array_shift($openDebits);
                    continue;
                }

                $openDebits[0]['amount'] = $remaining;
                break;
            }
        }

        $cutoff = $now->copy()->subDays($termDays)->startOfDay();
        $openAmount = 0.0;
        $overdueAmount = 0.0;

        foreach ($openDebits as $openDebit) {
            $amount = (float) $openDebit['amount'];
            $openAmount += $amount;

            if ($openDebit['date'] !== null && $openDebit['date']->lessThanOrEqualTo($cutoff)) {
                $overdueAmount += $amount;
            }
        }

        return [
            'open_amount' => $openAmount,
            'overdue_amount' => $overdueAmount,
        ];
    }

    private function decimal(mixed $value): float
    {
        if ($value === null || $value === '') {
            return 0.0;
        }

        if (is_numeric($value)) {
            return (float) $value;
        }

        $normalized = trim((string) $value);
        $normalized = preg_replace('/[^\d,.\-]/', '', $normalized) ?? '';

        if (str_contains($normalized, ',') && str_contains($normalized, '.')) {
            $normalized = str_replace('.', '', $normalized);
            $normalized = str_replace(',', '.', $normalized);
        } elseif (str_contains($normalized, ',')) {
            $normalized = str_replace(',', '.', $normalized);
        }

        return is_numeric($normalized) ? (float) $normalized : 0.0;
    }

    private function integer(mixed $value): int
    {
        if ($value === null || $value === '') {
            return 0;
        }

        if (is_numeric($value)) {
            return max(0, (int) $value);
        }

        preg_match('/\d+/', (string) $value, $matches);

        return isset($matches[0]) ? max(0, (int) $matches[0]) : 0;
    }

    private function formatMoney(float $value): string
    {
        return number_format($value, 2, ',', '.');
    }
}
