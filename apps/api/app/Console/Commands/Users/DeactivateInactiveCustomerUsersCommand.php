<?php

namespace App\Console\Commands\Users;

use App\Models\User;
use Illuminate\Console\Command;

class DeactivateInactiveCustomerUsersCommand extends Command
{
    protected $signature = 'users:deactivate-inactive-customers {--days=30}';

    protected $description = 'Belirlenen süre boyunca hareket etmeyen müşteri kullanıcılarını pasife alır';

    public function handle(): int
    {
        $days = max(1, (int) $this->option('days'));
        $cutoff = now()->subDays($days);

        $count = User::query()
            ->where('is_active', true)
            ->whereHas('roles', fn ($query) => $query->where('slug', 'customer'))
            ->where(function ($query) use ($cutoff): void {
                $query
                    ->where('last_activity_at', '<', $cutoff)
                    ->orWhere(function ($nested) use ($cutoff): void {
                        $nested->whereNull('last_activity_at')->where('updated_at', '<', $cutoff);
                    });
            })
            ->update(['is_active' => false]);

        $this->info("{$count} müşteri kullanıcısı pasife alındı.");

        return self::SUCCESS;
    }
}
