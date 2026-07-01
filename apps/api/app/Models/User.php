<?php

namespace App\Models;

// use Illuminate\Contracts\Auth\MustVerifyEmail;
use App\Services\Customers\CustomerAccessScopeService;
use Database\Factories\UserFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;

class User extends Authenticatable
{
    /** @use HasFactory<UserFactory> */
    use HasFactory, Notifiable;

    /**
     * The attributes that are mass assignable.
     *
     * @var list<string>
     */
    protected $fillable = [
        'dealer_id',
        'customer_scope',
        'region_code',
        'region_name',
        'branch_code',
        'branch_name',
        'logo_customer_specode4',
        'logo_cashbox_code',
        'logo_cashbox_name',
        'logo_expense_account_code',
        'logo_expense_account_name',
        'selected_customer_id',
        'name',
        'username',
        'email',
        'phone',
        'avatar_url',
        'password',
        'is_active',
        'menu_permissions',
        'feature_permissions',
    ];

    /**
     * The attributes that should be hidden for serialization.
     *
     * @var list<string>
     */
    protected $hidden = [
        'password',
        'remember_token',
    ];

    /**
     * Get the attributes that should be cast.
     *
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
            'is_active' => 'boolean',
            'menu_permissions' => 'array',
            'feature_permissions' => 'array',
        ];
    }

    public function dealer(): BelongsTo
    {
        return $this->belongsTo(Dealer::class);
    }

    public function selectedCustomer(): BelongsTo
    {
        return $this->belongsTo(Customer::class, 'selected_customer_id');
    }

    public function assignedCustomers(): HasMany
    {
        return $this->hasMany(Customer::class, 'salesperson_user_id');
    }

    public function roles(): BelongsToMany
    {
        return $this->belongsToMany(Role::class);
    }

    public function hasRole(string $role): bool
    {
        return $this->roles()->where('slug', $role)->exists();
    }

    /**
     * @param  list<string>  $roles
     */
    public function hasAnyRole(array $roles): bool
    {
        return $this->roles()->whereIn('slug', $roles)->exists();
    }

    public function canAccessCustomer(Customer $customer): bool
    {
        return app(CustomerAccessScopeService::class)->canAccessCustomer($this, $customer);
    }

    public function effectiveCustomerScope(): string
    {
        if ($this->hasRole('salesperson')) {
            return 'assigned';
        }

        $scope = strtolower(trim((string) ($this->customer_scope ?? 'dealer')));

        if (! in_array($scope, ['dealer', 'region', 'branch', 'assigned'], true)) {
            return 'dealer';
        }

        if ($scope === 'region' && trim((string) $this->region_code) === '') {
            return 'dealer';
        }

        if ($scope === 'branch' && trim((string) $this->branch_code) === '') {
            return 'dealer';
        }

        return $scope;
    }

    public function carts(): HasMany
    {
        return $this->hasMany(Cart::class);
    }

    public function orders(): HasMany
    {
        return $this->hasMany(Order::class);
    }

    public function orderStatusChanges(): HasMany
    {
        return $this->hasMany(OrderStatusHistory::class, 'changed_by_user_id');
    }

    public function collections(): HasMany
    {
        return $this->hasMany(Collection::class, 'collected_by_user_id');
    }

    public function ledgerEntries(): HasMany
    {
        return $this->hasMany(LedgerEntry::class, 'created_by_user_id');
    }

    public function reportRuns(): HasMany
    {
        return $this->hasMany(ReportRun::class);
    }

    public function openedPosSessions(): HasMany
    {
        return $this->hasMany(PosSession::class, 'opened_by');
    }

    public function createdPosSales(): HasMany
    {
        return $this->hasMany(PosSale::class, 'created_by');
    }

    public function createdShipments(): HasMany
    {
        return $this->hasMany(Shipment::class, 'created_by');
    }

    public function shipmentScans(): HasMany
    {
        return $this->hasMany(ShipmentScan::class, 'scanned_by');
    }
}
