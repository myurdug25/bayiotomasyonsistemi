<?php

namespace App\Policies;

use App\Models\PosExpense;
use App\Models\User;
use App\Support\MenuPermissions;

class PosExpensePolicy
{
    public function before(User $user, string $ability): ?bool
    {
        if ($user->hasRole('admin')) {
            return true;
        }

        return null;
    }

    public function viewAny(User $user): bool
    {
        return $this->canUsePos($user);
    }

    public function create(User $user): bool
    {
        return $this->canUsePos($user);
    }

    public function view(User $user, PosExpense $expense): bool
    {
        return $this->canAccessExpense($user, $expense);
    }

    private function canAccessExpense(User $user, PosExpense $expense): bool
    {
        if (! $this->canUsePos($user)) {
            return false;
        }

        if ((int) $expense->dealer_id !== (int) $user->dealer_id) {
            return false;
        }

        return (int) $expense->created_by_user_id === (int) $user->id;
    }

    private function canUsePos(User $user): bool
    {
        return $user->hasAnyRole(['dealer_admin', 'salesperson', 'cashier', 'point'])
            || in_array('pos-expenses', MenuPermissions::forUser($user), true);
    }
}
