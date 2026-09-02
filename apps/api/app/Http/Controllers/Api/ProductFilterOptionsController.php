<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Brand;
use App\Models\Category;
use App\Models\Product;
use App\Models\Vehicle;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Cache;

class ProductFilterOptionsController extends Controller
{
    public function __invoke(Request $request): JsonResponse
    {
        $scope = in_array($request->query('scope'), ['search', 'brands'], true)
            ? (string) $request->query('scope')
            : 'full';

        $allowedBrandIds = $this->allowedBrandIds($request);
        $brandFingerprint = $allowedBrandIds === null ? 'all' : md5(json_encode($allowedBrandIds) ?: 'none');

        return response()->json(Cache::remember(
            "products:filter-options:v9:{$scope}:{$brandFingerprint}",
            now()->addHours(2),
            fn (): array => $this->buildFilterOptions($scope, $allowedBrandIds)
        ));
    }

    /**
     * @return array<string, mixed>
     */
    private function buildFilterOptions(string $scope, ?array $allowedBrandIds): array
    {
        $brands = $this->buildBrandOptions($allowedBrandIds);

        if ($scope === 'brands') {
            return [
                'brands' => $brands,
                'categories' => [],
                'vehicles' => [],
                'meta' => $this->emptyMetaOptions(),
            ];
        }

        if ($scope === 'search') {
            return [
                'brands' => $brands,
                'categories' => [],
                'vehicles' => [],
                'meta' => $this->buildMetaOptions(['kod2', 'kod3']),
            ];
        }

        $categories = Category::query()
            ->select(['id', 'name', 'parent_id'])
            ->where('is_active', true)
            ->whereHas('products', function (Builder $query): void {
                $query->where('is_active', true)
                    ->where(function (Builder $builder): void {
                        $this->applyLogoProductFilter($builder);
                    });
            })
            ->orderBy('name')
            ->get()
            ->map(fn (Category $category) => [
                'id' => (int) $category->id,
                'name' => $category->name,
                'parent_id' => $category->parent_id !== null ? (int) $category->parent_id : null,
            ])
            ->values();

        $vehicles = Vehicle::query()
            ->select(['id', 'make', 'model', 'trim', 'year_from', 'year_to'])
            ->whereHas('fitments')
            ->orderBy('make')
            ->orderBy('model')
            ->orderBy('trim')
            ->orderByDesc('year_from')
            ->get();

        return [
            'brands' => $brands,
            'categories' => $categories,
            'vehicles' => $this->buildVehicleTree($vehicles),
            'meta' => $this->buildMetaOptions(),
        ];
    }

    private function buildBrandOptions(?array $allowedBrandIds): Collection
    {
        return Brand::query()
            ->select(['id', 'name'])
            ->where('is_active', true)
            ->when($allowedBrandIds !== null, function (Builder $query) use ($allowedBrandIds): void {
                $allowedBrandIds === []
                    ? $query->whereRaw('1 = 0')
                    : $query->whereIn('brands.id', $allowedBrandIds);
            })
            ->whereHas('products', function (Builder $query): void {
                $query->where('is_active', true)
                    ->where(function (Builder $builder): void {
                        $this->applyLogoProductFilter($builder);
                    });
            })
            ->orderBy('name')
            ->get()
            ->map(fn (Brand $brand) => [
                'id' => (int) $brand->id,
                'name' => $brand->name,
            ])
            ->values();
    }

    private function allowedBrandIds(Request $request): ?array
    {
        $user = $request->user();
        if ($user === null || ! $user->hasRole('customer') || $user->selected_customer_id === null) {
            return null;
        }

        $allowed = data_get($user->selectedCustomer?->meta, 'customer_user.allowed_brand_ids');

        return is_array($allowed)
            ? array_values(array_unique(array_map('intval', $allowed)))
            : null;
    }

    /**
     * @param  Collection<int, Vehicle>  $vehicles
     * @return array<int, array<string, mixed>>
     */
    private function buildVehicleTree(Collection $vehicles): array
    {
        return $vehicles
            ->groupBy(fn (Vehicle $vehicle) => $vehicle->make)
            ->map(function (Collection $makeVehicles, string $make) {
                return [
                    'make' => $make,
                    'models' => $makeVehicles
                        ->groupBy(fn (Vehicle $vehicle) => $vehicle->model)
                        ->map(function (Collection $modelVehicles, string $model) {
                            return [
                                'model' => $model,
                                'types' => $modelVehicles
                                    ->groupBy(fn (Vehicle $vehicle) => $vehicle->trim ?: 'Standard')
                                    ->map(function (Collection $typeVehicles, string $type) {
                                        return [
                                            'type' => $type,
                                            'years' => $typeVehicles
                                                ->map(function (Vehicle $vehicle) {
                                                    return [
                                                        'vehicle_id' => (int) $vehicle->id,
                                                        'label' => $this->formatYearLabel($vehicle),
                                                    ];
                                                })
                                                ->values()
                                                ->all(),
                                        ];
                                    })
                                    ->values()
                                    ->all(),
                            ];
                        })
                        ->values()
                        ->all(),
                ];
            })
            ->values()
            ->all();
    }

    private function formatYearLabel(Vehicle $vehicle): string
    {
        $from = $vehicle->year_from;
        $to = $vehicle->year_to;

        if ($from !== null && $to !== null) {
            return $from === $to ? (string) $from : sprintf('%d-%d', $from, $to);
        }

        if ($from !== null) {
            return sprintf('%d+', $from);
        }

        if ($to !== null) {
            return sprintf('<= %d', $to);
        }

        return 'Unknown';
    }

    /**
     * @return array<string, list<string>>
     */
    private function buildMetaOptions(?array $onlyKeys = null): array
    {
        $metaOptions = $this->emptyMetaOptions();
        $targetKeys = $onlyKeys ?? array_keys($metaOptions);

        $needsBrandFallback = $onlyKeys === null || in_array('specode5', $targetKeys, true);
        $query = Product::query()
            ->select(['products.id', 'products.meta'])
            ->where('products.is_active', true)
            ->whereNotNull('meta')
            ->where(function (Builder $query): void {
                $this->applyLogoProductFilter($query);
            });

        if ($needsBrandFallback) {
            $query
                ->addSelect('brands.name as option_brand_name')
                ->leftJoin('brands', 'brands.id', '=', 'products.brand_id');
        }

        foreach ($query->lazyById(500, 'products.id', 'id') as $product) {
            if (! is_array($product->meta)) {
                continue;
            }

            foreach ($targetKeys as $key) {
                $this->pushMetaOption($metaOptions, $key, $this->firstMetaValue($product->meta, $this->metaValuePaths($key)));
            }

            if ($needsBrandFallback) {
                $this->pushMetaOption($metaOptions, 'specode5', $product->option_brand_name ?? null);
            }
        }

        foreach ($metaOptions as $key => $values) {
            $unique = array_values(array_unique($values));
            usort($unique, fn (string $a, string $b) => strnatcasecmp($a, $b));
            $metaOptions[$key] = $unique;
        }

        return $metaOptions;
    }

    /**
     * @return array<string, list<string>>
     */
    private function emptyMetaOptions(): array
    {
        return [
            'kod1' => [],
            'kod2' => [],
            'kod3' => [],
            'specode4' => [],
            'specode5' => [],
            'stok_turu' => [],
        ];
    }

    /**
     * @param  array<string, list<string>>  $metaOptions
     */
    private function pushMetaOption(array &$metaOptions, string $key, mixed $value): void
    {
        if (! array_key_exists($key, $metaOptions)) {
            return;
        }

        if (! is_scalar($value)) {
            return;
        }

        $normalized = trim((string) $value);
        if ($normalized === '') {
            return;
        }

        $metaOptions[$key][] = $normalized;
    }

    /**
     * @param  array<string, mixed>  $meta
     * @param  list<string>  $paths
     */
    private function firstMetaValue(array $meta, array $paths): ?string
    {
        foreach ($paths as $path) {
            $value = data_get($meta, $path);
            if (! is_scalar($value)) {
                continue;
            }

            $normalized = trim((string) $value);
            if ($normalized !== '') {
                return $normalized;
            }
        }

        return null;
    }

    /**
     * @return list<string>
     */
    private function metaValuePaths(string $key): array
    {
        return match ($key) {
            'kod1' => [
                'kod1',
                'specode',
                'integrations.logo.payload.kod1',
                'integrations.logo.payload.specode',
                'integrations.logo.payload.raw.KOD1',
                'integrations.logo.payload.raw.SPECODE',
            ],
            'kod2' => [
                'kod2',
                'specode2',
                'integrations.logo.payload.kod2',
                'integrations.logo.payload.specode2',
                'integrations.logo.payload.raw.KOD2',
                'integrations.logo.payload.raw.SPECODE2',
            ],
            'kod3' => [
                'kod3',
                'specode3',
                'integrations.logo.payload.kod3',
                'integrations.logo.payload.specode3',
                'integrations.logo.payload.raw.KOD3',
                'integrations.logo.payload.raw.SPECODE3',
            ],
            'specode4' => [
                'specode4',
                'integrations.logo.payload.specode4',
                'integrations.logo.payload.raw.SPECODE4',
            ],
            'specode5' => [
                'specode5',
                'brand_name',
                'brand_code',
                'integrations.logo.payload.specode5',
                'integrations.logo.payload.brand_name',
                'integrations.logo.payload.brand_code',
                'integrations.logo.payload.raw.SPECODE5',
                'integrations.logo.payload.raw.BRANDNAME',
                'integrations.logo.payload.raw.MARKNAME',
                'integrations.logo.payload.raw.MARKA',
                'integrations.logo.payload.raw.MARK',
                'integrations.logo.payload.raw.MARKCODE',
            ],
            'stok_turu' => [
                'stok_turu',
                'integrations.logo.payload.stok_turu',
                'integrations.logo.payload.raw.STOK_TURU',
                'integrations.logo.payload.raw.STOKTURU',
                'integrations.logo.payload.raw.CARDTYPE',
            ],
            default => [],
        };
    }

    private function applyLogoProductFilter(Builder $query): void
    {
        $query
            ->whereNotNull('products.meta->integrations->logo->synced_at')
            ->orWhereNotNull('products.meta->integrations->logo->external_ref')
            ->orWhereNotNull('products.meta->integrations->logo->logical_ref');
    }
}
