<?php

namespace App\Http\Controllers\Api;

use App\Models\Campaign;
use App\Models\CampaignProduct;
use App\Models\Customer;
use App\Models\Product;
use App\Services\Campaign\CampaignProgressService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Routing\Controller;
use Illuminate\Support\Facades\DB;

class CampaignController extends Controller
{
    public function __construct(
        private readonly CampaignProgressService $progressService
    ) {}

    /**
     * GET /api/campaigns?customer_id=X
     * Müşterinin grubuna ait aktif kampanyaları ve ürün listesini döner.
     */
    public function index(Request $request): JsonResponse
    {
        $customerId = $request->query('customer_id');

        if ($customerId !== null) {
            /** @var Customer|null $customer */
            $customer = Customer::find((int) $customerId);

            if ($customer === null) {
                return response()->json(['data' => []]);
            }

            $campaigns = $this->progressService->campaignsForCustomer($customer);
        } else {
            $campaigns = Campaign::with('campaignProducts')->active()->get();
        }

        return response()->json([
            'data' => $campaigns->map(fn (Campaign $c) => $this->campaignPayload($c))->values(),
        ]);
    }

    /**
     * GET /api/customers/{customer}/campaign-progress
     * Sepetteki ürünlere bakarak o müşterinin kampanya ilerlemesini döner.
     */
    public function progress(Request $request, Customer $customer): JsonResponse
    {
        $this->authorize('view', $customer);

        $campaigns = $this->progressService->campaignsForCustomer($customer);

        if ($campaigns->isEmpty()) {
            return response()->json(['data' => []]);
        }

        // Aktif sepetteki ürünleri al
        $cartItems = DB::table('cart_items')
            ->join('carts', 'carts.id', '=', 'cart_items.cart_id')
            ->join('products', 'products.id', '=', 'cart_items.product_id')
            ->where('carts.customer_id', $customer->id)
            ->where('carts.is_active', true)
            ->select([
                'cart_items.product_id',
                'products.sku',
                'cart_items.quantity',
            ])
            ->get()
            ->map(fn ($row): array => [
                'product_id' => (int) $row->product_id,
                'sku'        => (string) $row->sku,
                'quantity'   => (int) $row->quantity,
            ])
            ->all();

        $progress = $this->progressService->calculate($campaigns, $cartItems);

        return response()->json(['data' => $progress]);
    }

    /**
     * POST /integrations/logo/campaigns/sync
     * Logo sync script tarafından çağrılır — kampanyaları günceller.
     */
    public function sync(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'campaigns'                    => ['required', 'array'],
            'campaigns.*.source_reference' => ['required', 'string', 'max:128'],
            'campaigns.*.code'             => ['required', 'string', 'max:64'],
            'campaigns.*.name'             => ['required', 'string', 'max:255'],
            'campaigns.*.description'      => ['nullable', 'string', 'max:500'],
            'campaigns.*.customer_group'   => ['nullable', 'string', 'max:128'],
            'campaigns.*.target_quantity'  => ['required', 'integer', 'min:1'],
            'campaigns.*.group_field'      => ['nullable', 'string', 'max:32'],
            'campaigns.*.starts_at'        => ['nullable', 'date'],
            'campaigns.*.ends_at'          => ['nullable', 'date'],
            'campaigns.*.is_active'        => ['boolean'],
            'campaigns.*.meta'             => ['nullable', 'array'],
            'campaigns.*.discount_percent' => ['nullable', 'integer', 'min:0', 'max:100'],
            'campaigns.*.products'         => ['nullable', 'array'],
            'campaigns.*.products.*'       => ['string', 'max:191'],
        ]);

        $synced  = 0;
        $skipped = 0;

        DB::transaction(function () use ($validated, &$synced, &$skipped): void {
            $incomingRefs = collect($validated['campaigns'])
                ->pluck('source_reference')
                ->all();

            // Artık gönderilmeyen kampanyaları pasif yap
            Campaign::whereNotIn('source_reference', $incomingRefs)
                ->where('is_active', true)
                ->update(['is_active' => false]);

            foreach ($validated['campaigns'] as $row) {
                $campaign = Campaign::updateOrCreate(
                    ['source_reference' => $row['source_reference']],
                    [
                        'code'             => $row['code'],
                        'name'             => $row['name'],
                        'description'      => $row['description'] ?? null,
                        'customer_group'   => $row['customer_group'] ?? null,
                        'target_quantity'  => (int) $row['target_quantity'],
                        'discount_percent' => isset($row['discount_percent']) ? (int) $row['discount_percent'] : null,
                        'group_field'      => $row['group_field'] ?? 'specode',
                        'starts_at'        => $row['starts_at'] ?? null,
                        'ends_at'          => $row['ends_at'] ?? null,
                        'is_active'        => (bool) ($row['is_active'] ?? true),
                        'meta'             => $row['meta'] ?? null,
                        'last_synced_at'   => now(),
                    ]
                );

                // Kampanya ürünlerini güncelle
                if (isset($row['products']) && is_array($row['products'])) {
                    $this->syncCampaignProducts($campaign, $row['products']);
                }

                $synced++;
            }
        });

        return response()->json([
            'synced'  => $synced,
            'skipped' => $skipped,
            'message' => "Kampanya sync tamamlandı: {$synced} kampanya güncellendi.",
        ]);
    }

    private function syncCampaignProducts(Campaign $campaign, array $skus): void
    {
        if ($skus === []) {
            $campaign->campaignProducts()->delete();
            return;
        }

        // Mevcut product_sku'ları al
        $existingSkus = $campaign->campaignProducts()->pluck('product_sku')->all();
        $incomingSkus = array_unique(array_map('trim', $skus));
        $incomingSkus = array_filter($incomingSkus, fn (string $s): bool => $s !== '');

        // Kaldırılanları sil
        $toDelete = array_diff($existingSkus, $incomingSkus);
        if ($toDelete !== []) {
            $campaign->campaignProducts()->whereIn('product_sku', $toDelete)->delete();
        }

        // Yenileri ekle
        $toInsert = array_diff($incomingSkus, $existingSkus);

        foreach ($toInsert as $sku) {
            // SKU üzerinden ürünü bul
            $product = Product::where('sku', $sku)->first();

            CampaignProduct::create([
                'campaign_id' => $campaign->id,
                'product_id'  => $product?->id,
                'product_sku' => $sku,
            ]);
        }
    }

    private function campaignPayload(Campaign $campaign): array
    {
        return [
            'id'              => $campaign->id,
            'code'            => $campaign->code,
            'name'            => $campaign->name,
            'description'     => $campaign->description,
            'customer_group'  => $campaign->customer_group,
            'target_quantity' => $campaign->target_quantity,
            'discount_percent'=> $campaign->discount_percent,
            'starts_at'       => $campaign->starts_at?->toDateString(),
            'ends_at'         => $campaign->ends_at?->toDateString(),
            'is_active'       => $campaign->is_active,
            'product_skus'    => $campaign->campaignProducts->pluck('product_sku')->values()->all(),
        ];
    }
}
