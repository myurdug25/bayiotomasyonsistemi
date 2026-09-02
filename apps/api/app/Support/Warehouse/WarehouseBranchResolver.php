<?php

namespace App\Support\Warehouse;

use App\Models\Customer;
use App\Models\User;
use Illuminate\Support\Str;

class WarehouseBranchResolver
{
    /**
     * Kullanıcı bölge kuralı tek kaynak:
     * - Siparişi oluşturan/bağlı plasiyerin gerçek şubesi önce gelir.
     * - Kullanıcı kimliği yoksa carinin açık şube alanları fallback olur.
     * - Cari kodu yalnızca son çaredir; 120-00-* tek başına Batum kanıtı değildir.
     * Böylece eski/yanlış cari şube verisi Erzurum plasiyerinin siparişini Batum'a göndermez.
     */
    public function resolveBranchCode(?User $user, ?Customer $customer = null): ?string
    {
        $salesperson = $this->resolveSalesperson($user, $customer);

        return $this->branchCodeFromUserIdentity($salesperson)
            ?? $this->normalizeBranchCode($salesperson?->branch_code)
            ?? $this->normalizeBranchCode($salesperson?->branch_name)
            ?? $this->branchCodeFromUserIdentity($user)
            ?? $this->normalizeBranchCode($user?->branch_code)
            ?? $this->normalizeBranchCode($user?->branch_name)
            ?? $this->normalizeBranchCode($customer?->branch_code)
            ?? $this->normalizeBranchCode($customer?->branch_name)
            // Eski carilerde şube alanları boş olabilir. Cari kodunun orta
            // segmenti yalnızca son çaredir; 120-00-* Batum varsayımı gerçek
            // bağlı plasiyer/oturum şubesini asla ezmemelidir.
            ?? $this->branchCodeFromCustomerCode($customer?->code);
    }

    private function branchCodeFromCustomerCode(mixed $value): ?string
    {
        $code = trim((string) $value);
        if ($code === '') {
            return null;
        }

        $segments = preg_split('/[^0-9]+/', $code) ?: [];
        $branchSegment = $segments[1] ?? null;

        return match ($branchSegment) {
            '00' => 'BATUM',
            '55' => 'SAMSUN',
            '61' => 'TRABZON',
            default => null,
        };
    }

    /**
     * @return array{code:string,name:string,reason:string}|null
     */
    public function targetWarehouse(?User $user, ?Customer $customer = null, ?string $shippingMethod = null): ?array
    {
        $branchCode = $this->resolveBranchCode($user, $customer);
        $method = mb_strtolower(trim((string) $shippingMethod), 'UTF-8');

        if ($method === 'kargo' && in_array($branchCode, ['TRABZON', 'SAMSUN'], true)) {
            return ['code' => '1', 'name' => 'ERZURUM DEPO', 'reason' => "{$branchCode}_KARGO_TO_ERZURUM"];
        }

        if ($this->isErzurumPointUser($user)) {
            return ['code' => '0', 'name' => 'ERZURUM POINT', 'reason' => 'USER_ERZURUM_POINT'];
        }

        return match ($branchCode) {
            'TRABZON' => ['code' => '2', 'name' => 'TRABZON DEPO', 'reason' => 'BRANCH_TRABZON'],
            'SAMSUN' => ['code' => '3', 'name' => 'SAMSUN DEPO', 'reason' => 'BRANCH_SAMSUN'],
            'BATUM' => ['code' => '4', 'name' => 'BATUM DEPO', 'reason' => 'BRANCH_BATUM'],
            'ERZURUM' => ['code' => '1', 'name' => 'ERZURUM DEPO', 'reason' => 'BRANCH_ERZURUM'],
            default => null,
        };
    }

    private function normalizeBranchCode(mixed $value): ?string
    {
        $normalized = preg_replace('/[^A-Z0-9]+/', '', Str::upper(Str::ascii(trim((string) $value)))) ?? '';

        if ($normalized === '') {
            return null;
        }

        if (in_array($normalized, ['0', '250', 'RAF250', 'ERZURUMPOINT', 'ERZPOINT', 'POINT'], true)) {
            return 'ERZURUM';
        }

        if (in_array($normalized, ['1', '25', 'RAF25'], true)) {
            return 'ERZURUM';
        }

        if (in_array($normalized, ['2', '61', 'RAF61'], true)) {
            return 'TRABZON';
        }

        if (in_array($normalized, ['3', '55', 'RAF55'], true)) {
            return 'SAMSUN';
        }

        if (in_array($normalized, ['4', '995', 'RAF995'], true)) {
            return 'BATUM';
        }

        if (str_contains($normalized, 'TRABZON')) {
            return 'TRABZON';
        }

        if (str_contains($normalized, 'SAMSUN')) {
            return 'SAMSUN';
        }

        if (str_contains($normalized, 'ERZURUM') || str_starts_with($normalized, 'ERZ')) {
            return 'ERZURUM';
        }

        if (str_contains($normalized, 'BATUM')) {
            return 'BATUM';
        }

        return $normalized;
    }

    private function branchCodeFromUserIdentity(?User $user): ?string
    {
        if (! $user instanceof User) {
            return null;
        }

        $identity = preg_replace('/[^A-Z0-9]+/', '', Str::upper(Str::ascii(implode(' ', array_filter([
            $user->username,
            $user->email,
            $user->name,
        ]))))) ?? '';

        if ($identity === '') {
            return null;
        }

        foreach ($this->forcedUserBranchMap() as $needle => $branch) {
            if (str_contains($identity, $needle)) {
                return $branch;
            }
        }

        $identityBranch = $this->normalizeBranchCode($identity);

        return in_array($identityBranch, ['ERZURUM', 'TRABZON', 'SAMSUN', 'BATUM'], true)
            ? $identityBranch
            : null;
    }

    private function isErzurumPointUser(?User $user): bool
    {
        if (! $user instanceof User) {
            return false;
        }

        $identity = preg_replace('/[^A-Z0-9]+/', '', Str::upper(Str::ascii(implode(' ', array_filter([
            $user->username,
            $user->email,
            $user->name,
            $user->branch_code,
            $user->branch_name,
            $user->region_code,
            $user->region_name,
        ]))))) ?? '';

        if ($identity === '') {
            return false;
        }

        if (str_contains($identity, 'TRABZON') || str_contains($identity, 'SAMSUN') || str_contains($identity, 'BATUM')) {
            return false;
        }

        return str_contains($identity, 'ERZURUMPOINT')
            || str_contains($identity, 'ERZURUMHIZLISATIS')
            || str_contains($identity, 'ERZHIZLISATIS');
    }

    private function resolveSalesperson(?User $user, ?Customer $customer): ?User
    {
        if ($user instanceof User && $user->hasRole('salesperson')) {
            return $user;
        }

        $salesperson = $customer?->salesperson;

        return $salesperson instanceof User ? $salesperson : null;
    }

    /**
     * @return array<string, string>
     */
    private function forcedUserBranchMap(): array
    {
        return [
            'ERZURUMDEPO' => 'ERZURUM',
            'ERZURUMPOINT' => 'ERZURUM',
            'ERZHIZLISATIS' => 'ERZURUM',
            'ERZURUMHIZLISATIS' => 'ERZURUM',
            'TRABZONPOINT' => 'TRABZON',
            'TRABZONDEPO' => 'TRABZON',
            'TRABZONHIZLISATIS' => 'TRABZON',
            'SAMSUNPOINT' => 'SAMSUN',
            'SAMSUNDEPO' => 'SAMSUN',
            'SAMSUNHIZLISATIS' => 'SAMSUN',
            'ERZURUMMERKEZ' => 'ERZURUM',
            'MUDURERZURUM' => 'ERZURUM',
            'AHMETARAC' => 'ERZURUM',
            'ERZDEPO' => 'ERZURUM',
            'BATUMDEPO' => 'BATUM',
            'BATUMPOINT' => 'BATUM',
            'BATUM' => 'BATUM',
        ];
    }
}
