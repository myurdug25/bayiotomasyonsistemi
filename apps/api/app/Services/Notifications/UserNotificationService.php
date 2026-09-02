<?php

namespace App\Services\Notifications;

use App\Models\User;
use App\Models\UserNotification;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;

class UserNotificationService
{
    /**
     * @param  iterable<User>  $users
     * @param  array<string, mixed>  $meta
     */
    public function notifyUsers(
        iterable $users,
        string $type,
        string $title,
        ?string $body,
        ?string $url,
        array $meta = []
    ): int {
        if (! Schema::hasTable('user_notifications')) {
            return 0;
        }

        $count = 0;
        $seen = [];

        foreach ($users as $user) {
            if (! $user instanceof User || ! $user->is_active) {
                continue;
            }

            $userId = (int) $user->id;
            if (isset($seen[$userId])) {
                continue;
            }
            $seen[$userId] = true;

            UserNotification::query()->create([
                'user_id' => $userId,
                'dealer_id' => $user->dealer_id,
                'type' => $type,
                'title' => $title,
                'body' => $body,
                'url' => $url,
                'status' => 'unread',
                'meta' => $meta,
            ]);

            $count++;
        }

        return $count;
    }

    /**
     * @param  array<string, mixed>  $meta
     * @param  list<string>  $permissionKeys
     */
    public function notifyBranch(
        ?int $dealerId,
        mixed $warehouseCode,
        mixed $warehouseName,
        string $type,
        string $title,
        ?string $body,
        ?string $url,
        array $meta = [],
        array $permissionKeys = ['warehouse']
    ): int {
        $users = $this->targetUsers($dealerId, $warehouseCode, $warehouseName, $permissionKeys);

        return $this->notifyUsers($users, $type, $title, $body, $url, [
            ...$meta,
            'warehouse_code' => $this->nullableString($warehouseCode),
            'warehouse_name' => $this->nullableString($warehouseName),
        ]);
    }

    /**
     * @param  list<string>  $permissionKeys
     * @return Collection<int, User>
     */
    public function targetUsers(?int $dealerId, mixed $warehouseCode, mixed $warehouseName, array $permissionKeys = ['warehouse']): Collection
    {
        $query = User::query()->with('roles')->where('is_active', true);

        $branchCandidates = $this->branchCandidates($warehouseCode, $warehouseName);

        return $query->get()
            ->filter(function (User $user) use ($dealerId, $branchCandidates, $permissionKeys): bool {
                if (! $this->hasNotificationPermission($user, $permissionKeys)) {
                    return false;
                }

                if ($this->userHasAnyRole($user, ['admin'])) {
                    return true;
                }

                if ($dealerId !== null && (int) $user->dealer_id !== $dealerId) {
                    return false;
                }

                if ($branchCandidates === []) {
                    return true;
                }

                return $this->userMatchesBranches($user, $branchCandidates);
            })
            ->values();
    }

    /**
     * Existing notifications are filtered as well, so notifications created
     * before the branch-scope fix cannot leak into another branch's panel.
     *
     * @param  array<string, mixed>  $meta
     */
    public function canUserSeeNotification(User $user, ?int $dealerId, array $meta): bool
    {
        $user->loadMissing('roles');

        if ($this->userHasAnyRole($user, ['admin'])) {
            return true;
        }

        if ($dealerId !== null && (int) $user->dealer_id !== $dealerId) {
            return false;
        }

        $branchCandidates = $this->branchCandidates(
            $meta['warehouse_code'] ?? $meta['target_warehouse_code'] ?? $meta['branch_code'] ?? null,
            $meta['warehouse_name'] ?? $meta['target_warehouse_name'] ?? $meta['branch_name'] ?? null,
        );

        if ($branchCandidates === []) {
            return true;
        }

        return $this->userMatchesBranches($user, $branchCandidates);
    }

    /**
     * @param  list<string>  $branchCandidates
     */
    private function userMatchesBranches(User $user, array $branchCandidates): bool
    {
        $username = $this->normalizeSignal($user->username);

        if ($username === 'TURGAY.BUYUKKAL') {
            return collect($branchCandidates)->intersect(['TRABZON', 'SAMSUN'])->isNotEmpty();
        }

        if ($username === 'MUDUR.ERZURUM') {
            return in_array('ERZURUM', $branchCandidates, true);
        }

        $userSignals = collect([
            $user->branch_code,
            $user->branch_name,
            $user->region_code,
            $user->region_name,
            $user->logo_cashbox_name,
        ])
            ->map(fn (mixed $value): ?string => $this->normalizeSignal($value))
            ->filter()
            ->values();

        return $userSignals->contains(function (string $signal) use ($branchCandidates): bool {
            foreach ($branchCandidates as $candidate) {
                if ($signal === $candidate || str_contains($signal, $candidate) || str_contains($candidate, $signal)) {
                    return true;
                }
            }

            return false;
        });
    }

    /**
     * @param  list<string>  $permissionKeys
     */
    private function hasNotificationPermission(User $user, array $permissionKeys): bool
    {
        if ($this->userHasAnyRole($user, ['admin', 'dealer_admin', 'warehouse', 'cashier', 'point'])) {
            return true;
        }

        $permissions = is_array($user->menu_permissions) ? $user->menu_permissions : [];

        foreach ($permissionKeys as $permission) {
            if (in_array($permission, $permissions, true)) {
                return true;
            }
        }

        return false;
    }

    /**
     * @param  list<string>  $roles
     */
    private function userHasAnyRole(User $user, array $roles): bool
    {
        if ($user->relationLoaded('roles')) {
            return $user->roles
                ->pluck('slug')
                ->intersect($roles)
                ->isNotEmpty();
        }

        return $user->hasAnyRole($roles);
    }

    /**
     * @return list<string>
     */
    private function branchCandidates(mixed $warehouseCode, mixed $warehouseName): array
    {
        $code = $this->nullableString($warehouseCode);
        $name = $this->normalizeSignal($warehouseName);
        $candidates = [];

        foreach ([$code, $name] as $signal) {
            $normalized = $this->normalizeSignal($signal);
            if ($normalized !== null) {
                $candidates[] = $normalized;
            }
        }

        $mapped = match ($code) {
            '0', '1', '5' => 'ERZURUM',
            '2', '6' => 'TRABZON',
            '3', '7' => 'SAMSUN',
            '4', '8' => 'BATUM',
            default => null,
        };

        if ($mapped !== null) {
            $candidates[] = $mapped;
        }

        foreach (['ERZURUM', 'TRABZON', 'SAMSUN', 'BATUM'] as $branch) {
            if ($name !== null && str_contains($name, $branch)) {
                $candidates[] = $branch;
            }
        }

        return collect($candidates)->filter()->unique()->values()->all();
    }

    private function normalizeSignal(mixed $value): ?string
    {
        $value = Str::of((string) $value)
            ->upper()
            ->replace(['İ', 'İ'], 'I')
            ->replace(['Ş', 'Ğ', 'Ü', 'Ö', 'Ç'], ['S', 'G', 'U', 'O', 'C'])
            ->replaceMatches('/\s+/', ' ')
            ->trim()
            ->toString();

        return $value === '' ? null : $value;
    }

    private function nullableString(mixed $value): ?string
    {
        $value = trim((string) $value);

        return $value === '' ? null : $value;
    }
}
