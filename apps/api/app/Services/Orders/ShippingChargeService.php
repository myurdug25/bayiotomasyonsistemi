<?php

namespace App\Services\Orders;

use App\Models\FinanceDefinition;

class ShippingChargeService
{
    public const DEFAULT_CARGO_LIMIT = 5000.0;

    public const DEFAULT_CARGO_FEE = 500.0;

    public const DEFAULT_BUS_FEE = 500.0;

    /**
     * @return array{cargo_limit: float, cargo_fee: float, bus_fee: float}
     */
    public function rules(): array
    {
        $values = FinanceDefinition::query()
            ->where('type', 'shipping_rule')
            ->where('is_active', true)
            ->whereIn('code', ['cargo_limit', 'cargo_fee', 'bus_fee'])
            ->get(['code', 'logo_code', 'logo_name', 'name', 'meta'])
            ->mapWithKeys(function (FinanceDefinition $definition): array {
                $amount = $this->definitionAmount($definition);

                return $amount === null ? [] : [mb_strtolower(trim($definition->code), 'UTF-8') => $amount];
            });

        return [
            'cargo_limit' => (float) $values->get('cargo_limit', self::DEFAULT_CARGO_LIMIT),
            'cargo_fee' => (float) $values->get('cargo_fee', self::DEFAULT_CARGO_FEE),
            'bus_fee' => (float) $values->get('bus_fee', self::DEFAULT_BUS_FEE),
        ];
    }

    /**
     * @return array{
     *     method: string|null,
     *     amount: float,
     *     applied: bool,
     *     cargo_limit: float,
     *     cargo_fee: float,
     *     bus_fee: float
     * }
     */
    public function resolve(?string $shippingMethod, float $orderTotal, bool $isWarehouseTransfer = false): array
    {
        $rules = $this->rules();
        $method = mb_strtolower(trim((string) $shippingMethod), 'UTF-8');
        $amount = 0.0;

        if (! $isWarehouseTransfer) {
            if ($method === 'otobus') {
                // Otobüs ücretinde limit yoktur; tanımlı ücret her siparişe eklenir.
                $amount = $rules['bus_fee'];
            } elseif ($method === 'kargo' && $orderTotal < $rules['cargo_limit']) {
                // Kargo ücreti yalnızca sipariş toplamı tanımlı limitin altındaysa eklenir.
                $amount = $rules['cargo_fee'];
            }
        }

        $amount = round(max(0, $amount), 2);

        return [
            'method' => $method !== '' ? $method : null,
            'amount' => $amount,
            'applied' => $amount > 0,
            ...$rules,
        ];
    }

    private function definitionAmount(FinanceDefinition $definition): ?float
    {
        $candidates = [
            $definition->logo_code,
            data_get($definition->meta, 'amount'),
            data_get($definition->meta, 'value'),
            $definition->logo_name,
            $definition->name,
        ];

        foreach ($candidates as $candidate) {
            if (is_int($candidate) || is_float($candidate)) {
                return max(0, (float) $candidate);
            }

            if (! is_string($candidate)) {
                continue;
            }

            $normalized = str_replace(['₺', 'TL', 'GEL', ' '], '', trim($candidate));
            if (preg_match('/^-?\d+(?:[.,]\d+)?$/', $normalized) !== 1) {
                continue;
            }

            return max(0, (float) str_replace(',', '.', $normalized));
        }

        return null;
    }
}
