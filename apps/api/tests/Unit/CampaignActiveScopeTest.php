<?php

namespace Tests\Unit;

use App\Models\Campaign;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class CampaignActiveScopeTest extends TestCase
{
    use RefreshDatabase;

    public function test_active_scope_only_includes_current_logo_active_campaigns(): void
    {
        $expired = Campaign::query()->create([
            'source_reference' => 'LOGO-ACTIVE-EXPIRED-DATE',
            'code' => 'F1-ACTIVE',
            'name' => 'Logo Active Campaign',
            'customer_group' => 'F1',
            'starts_at' => today()->subMonth(),
            'ends_at' => today()->subDay(),
            'is_active' => true,
        ]);
        $future = Campaign::query()->create([
            'source_reference' => 'LOGO-ACTIVE-FUTURE-DATE',
            'code' => 'F1-FUTURE',
            'name' => 'Logo Future Campaign',
            'customer_group' => 'F1',
            'starts_at' => today()->addDay(),
            'ends_at' => today()->addMonth(),
            'is_active' => true,
        ]);
        $current = Campaign::query()->create([
            'source_reference' => 'LOGO-ACTIVE-CURRENT-DATE',
            'code' => 'F1-CURRENT',
            'name' => 'Logo Current Campaign',
            'customer_group' => 'F1',
            'starts_at' => today()->subDay(),
            'ends_at' => today()->addDay(),
            'is_active' => true,
        ]);

        $activeIds = Campaign::query()->active()->pluck('id')->all();

        $this->assertNotContains($expired->id, $activeIds);
        $this->assertNotContains($future->id, $activeIds);
        $this->assertContains($current->id, $activeIds);
    }
}
