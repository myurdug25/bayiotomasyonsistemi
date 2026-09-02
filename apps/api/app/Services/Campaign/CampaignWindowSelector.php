<?php

namespace App\Services\Campaign;

use Carbon\CarbonInterface;
use Illuminate\Support\Collection;

class CampaignWindowSelector
{
    /**
     * Logo'da aktif bırakılmış eski kampanyaları geçmiş görünümü için korur,
     * fakat bugün geçerli bir kampanya varsa fiyatlandırmada yalnızca güncel
     * kampanya dönemini kullanır. Gelecekte başlayacak kampanyalar erkenden
     * uygulanmaz.
     *
     * @template T of object
     *
     * @param  Collection<int, T>  $campaigns
     * @return Collection<int, T>
     */
    public function select(Collection $campaigns, ?CarbonInterface $at = null): Collection
    {
        $day = ($at ?? now())->copy()->startOfDay();

        $current = $campaigns->filter(function (object $campaign) use ($day): bool {
            $startsAt = $campaign->starts_at;
            $endsAt = $campaign->ends_at;

            return ($startsAt === null || $startsAt->copy()->startOfDay()->lte($day))
                && ($endsAt === null || $endsAt->copy()->endOfDay()->gte($day));
        })->values();

        if ($current->isNotEmpty()) {
            return $current;
        }

        return $campaigns->filter(function (object $campaign) use ($day): bool {
            $endsAt = $campaign->ends_at;

            return $endsAt !== null && $endsAt->copy()->endOfDay()->lt($day);
        })->values();
    }
}