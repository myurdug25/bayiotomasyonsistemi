<?php

namespace App\Policies;

use App\Models\Customer;
use App\Models\User;
use App\Services\Customers\CustomerAccessScopeService;
use App\Support\MenuPermissions;

class CustomerPolicy
{
    public function before(User $user, string $ability): ?bool
    {
        if (app(CustomerAccessScopeService::class)->hasUnrestrictedCustomerAccess($user)) {
            return true;
        }

        return null;
    }

    public function viewAny(User $user): bool
    {
        return $user->hasAnyRole(['dealer_admin', 'salesperson', 'cashier', 'point', 'customer', 'warehouse'])
            || in_array('pos', MenuPermissions::forUser($user), true)
            || in_array('customers', MenuPermissions::forUser($user), true);
    }

    public function view(User $user, Customer $customer): bool
    {
        return $user->canAccessCustomer($customer);
    }

    public function selectContext(User $user, Customer $customer): bool
    {
        if ($user->hasRole('salesperson')) {
            return app(CustomerAccessScopeService::class)->canSelectCustomer($user, $customer);
        }

        return $this->view($user, $customer);
    }

    public function create(User $user): bool
    {
        return $user->hasRole('dealer_admin');
    }

    public function update(User $user, Customer $customer): bool
    {
        return $user->hasRole('dealer_admin') && $user->dealer_id === $customer->dealer_id;
    }

    public function delete(User $user, Customer $customer): bool
    {
        return $user->hasRole('dealer_admin') && $user->dealer_id === $customer->dealer_id;
    }

    public function collect(User $user, Customer $customer): bool
    {
        if ($user->hasAnyRole(['admin', 'global', 'global_user'])) {
            return true;
        }

        if ($user->hasAnyRole(['moderator', 'accounting', 'muhasebe'])) {
            return $user->canAccessCustomer($customer)
                || app(CustomerAccessScopeService::class)->hasUnrestrictedCustomerAccess($user);
        }

        $hasCollectionAccess = $user->hasAnyRole(['dealer_admin', 'salesperson', 'cashier', 'point'])
            || count(array_intersect(MenuPermissions::forUser($user), ['collections', 'pos'])) > 0;

        return $hasCollectionAccess && $user->canAccessCustomer($customer);
    }

    public function viewLedger(User $user, Customer $customer): bool
    {
        return $this->view($user, $customer);
    }

    public function createCollection(User $user, Customer $customer): bool
    {
        return $this->collect($user, $customer);
    }

    public function viewCollections(User $user, Customer $customer): bool
    {
        return $this->collect($user, $customer);
    }
}
