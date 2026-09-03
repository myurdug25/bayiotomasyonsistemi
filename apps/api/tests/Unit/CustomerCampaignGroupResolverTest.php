<?php

namespace Tests\Unit;

use App\Models\Customer;
use App\Services\Campaign\CustomerCampaignGroupResolver;
use PHPUnit\Framework\TestCase;

class CustomerCampaignGroupResolverTest extends TestCase
{
    public function test_batum_customer_code_adds_batum_campaign_group(): void
    {
        $customer = new Customer([
            'code' => '120-00-007',
            'name' => 'LTD 111',
            'meta' => ['price_group' => 'F2'],
        ]);

        $groups = (new CustomerCampaignGroupResolver)->resolveAll($customer);

        $this->assertContains('F2', $groups);
        $this->assertContains('BATUM', $groups);
    }
}
