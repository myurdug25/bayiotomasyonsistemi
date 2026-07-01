<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

class FixFactoryNames extends Command
{
    protected $signature = 'fix:factory-names';
    protected $description = 'Fix factory POS names by linking them to customer names';

    public function handle()
    {
        $factories = DB::table('finance_definitions')->where('type', 'factory')->get();
        foreach ($factories as $factory) {
            $customer = DB::table('customers')->where('code', $factory->code)->first();
            if ($customer) {
                DB::table('finance_definitions')
                    ->where('id', $factory->id)
                    ->update(['name' => $customer->name, 'logo_name' => $customer->name]);
                $this->info("Updated {$factory->code} to {$customer->name}");
            } else {
                $this->warn("Customer not found for code {$factory->code}");
            }
        }
    }
}
