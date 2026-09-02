<?php

namespace App\Services\Users;

use App\Models\User;
use App\Support\CustomerFeaturePermissions;
use App\Support\MenuPermissions;
use Illuminate\Support\Facades\Cache;

class UserPermissionService
{
    /**
     * @return list<string>
     */
    public function menuPermissions(User $user): array
    {
        return MenuPermissions::forUser($user);
    }

    /**
     * @return list<string>
     */
    public function featurePermissions(User $user): array
    {
        return CustomerFeaturePermissions::forUser($user);
    }

    /**
     * @return list<string>
     */
    public function checkoutSummaryModes(User $user): array
    {
        return CustomerFeaturePermissions::checkoutSummaryModesForUser($user);
    }

    public function markChanged(User $user): void
    {
        $user->forceFill([
            'permissions_updated_at' => now(),
        ])->save();

        $this->clearUserCaches($user);
    }

    public function clearUserCaches(User $user): void
    {
        foreach ($this->userCacheKeys($user) as $key) {
            Cache::forget($key);
        }
    }

    /**
     * @return list<string>
     */
    private function userCacheKeys(User $user): array
    {
        return [
            "permissions:{$user->id}",
            "sale-types:{$user->id}",
            "sidebar-menu:{$user->id}",
            "page-access:{$user->id}",
            "customer-settings:{$user->id}",
        ];
    }
}
