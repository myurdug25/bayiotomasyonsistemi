<?php

namespace Tests\Unit;

use App\Services\Campaign\CampaignWindowSelector;
use Carbon\CarbonImmutable;
use PHPUnit\Framework\TestCase;

class CampaignWindowSelectorTest extends TestCase
{
    public function test_current_campaigns_replace_expired_campaigns_for_effective_pricing(): void
    {
        $selector = new CampaignWindowSelector;
        $at = CarbonImmutable::parse('2026-08-08');

        $selected = $selector->select(collect([
            $this->campaign('OLD', '2026-07-01', '2026-07-31'),
            $this->campaign('NEW', '2026-08-01', '2026-08-31'),
        ]), $at);

        $this->assertSame(['NEW'], $selected->pluck('code')->all());
    }

    public function test_expired_and_future_campaigns_are_not_applied_when_no_current_campaign_exists(): void
    {
        $selector = new CampaignWindowSelector;
        $at = CarbonImmutable::parse('2026-08-08');

        $selected = $selector->select(collect([
            $this->campaign('OLD', '2026-07-01', '2026-07-31'),
            $this->campaign('FUTURE', '2026-09-01', '2026-09-30'),
        ]), $at);

        $this->assertSame([], $selected->pluck('code')->all());
    }

    private function campaign(string $code, string $startsAt, string $endsAt): object
    {
        return (object) [
            'code' => $code,
            'starts_at' => CarbonImmutable::parse($startsAt),
            'ends_at' => CarbonImmutable::parse($endsAt),
        ];
    }
}
