<?php

use App\Models\Customer;
use App\Models\User;
use Illuminate\Support\Arr;

$users = User::query()
    ->where('is_active', true)
    ->whereNotNull('logo_customer_specode4')
    ->get(['id', 'logo_customer_specode4']);

$customers = Customer::all();
$updated = 0;

function normalizeCode(?string $code): ?string
{
    if ($code === null) return null;
    $trimmed = trim($code);
    return $trimmed === '' ? null : mb_strtoupper($trimmed);
}

function normalizeCodeList(?string $codes): array
{
    if ($codes === null) return [];
    return array_filter(
        array_map(
            fn (string $c) => normalizeCode($c),
            explode(',', $codes)
        )
    );
}

foreach ($customers as $customer) {
    $meta = $customer->meta ?? [];
    $customerSpecodes = array_filter([
        normalizeCode(Arr::get($meta, 'specode') ?? Arr::get($meta, 'raw.SPECODE')),
        normalizeCode(Arr::get($meta, 'specode2') ?? Arr::get($meta, 'raw.SPECODE2')),
        normalizeCode(Arr::get($meta, 'specode3') ?? Arr::get($meta, 'raw.SPECODE3')),
        normalizeCode(Arr::get($meta, 'specode4') ?? Arr::get($meta, 'raw.SPECODE4')),
        normalizeCode(Arr::get($meta, 'specode5') ?? Arr::get($meta, 'raw.SPECODE5')),
    ]);

    if (empty($customerSpecodes)) {
        continue;
    }

    $matches = $users->filter(function (User $user) use ($customerSpecodes) {
        $userSpecodes = normalizeCodeList($user->logo_customer_specode4);
        return count(array_intersect($customerSpecodes, $userSpecodes)) > 0;
    })->pluck('id')->values();

    if ($matches->count() === 1) {
        $newSalespersonId = (int) $matches->first();
        if ($customer->salesperson_user_id !== $newSalespersonId) {
            $customer->salesperson_user_id = $newSalespersonId;
            $customer->save();
            $updated++;
        }
    }
}

echo "Updated salesperson_user_id for {$updated} customers.\n";
