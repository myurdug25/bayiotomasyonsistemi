<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Warehouse\AddShipmentItemRequest;
use App\Http\Requests\Warehouse\CancelShipmentRequest;
use App\Http\Requests\Warehouse\CreateShipmentRequest;
use App\Http\Requests\Warehouse\FinalizeShipmentRequest;
use App\Http\Requests\Warehouse\ReturnShipmentItemRequest;
use App\Http\Requests\Warehouse\ScanShipmentRequest;
use App\Http\Requests\Warehouse\UpdateShipmentItemQuantityRequest;
use App\Http\Resources\Warehouse\ShipmentStateResource;
use App\Models\Shipment;
use App\Models\User;
use App\Services\Warehouse\WarehouseShipmentService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class WarehouseShipmentController extends Controller
{
    public function store(CreateShipmentRequest $request, WarehouseShipmentService $service): JsonResponse
    {
        $shipment = $service->createShipment(
            user: $request->user(),
            orderId: (int) $request->integer('order_id'),
            warehouseId: $request->filled('warehouse_id') ? (int) $request->integer('warehouse_id') : null,
            warehouseCode: $request->filled('warehouse_code') ? (string) $request->string('warehouse_code') : null,
            warehouseName: $request->filled('warehouse_name') ? (string) $request->string('warehouse_name') : null,
            assignedUserId: $request->filled('assigned_user_id') ? (int) $request->integer('assigned_user_id') : null
        );

        return response()->json(
            ['data' => new ShipmentStateResource($service->shipmentState($request->user(), $shipment))],
            Response::HTTP_CREATED
        );
    }

    public function staff(Request $request): JsonResponse
    {
        $user = $request->user();

        $staffQuery = User::query()
            ->select(['id', 'dealer_id', 'name', 'username', 'email', 'phone', 'branch_code', 'branch_name', 'is_active'])
            ->where('is_active', true)
            ->whereHas('roles', fn ($roleQuery) => $roleQuery->where('slug', 'warehouse'))
            ->with(['roles:id,name,slug'])
            ->orderBy('name');

        if (! $user->hasRole('admin') && $user->dealer_id !== null) {
            $staffQuery->where(function ($query) use ($user): void {
                $query
                    ->whereNull('dealer_id')
                    ->orWhere('dealer_id', $user->dealer_id);
            });
        }

        return response()->json([
            'data' => $staffQuery
                ->get()
                ->map(fn (User $staffUser): array => [
                    'id' => $staffUser->id,
                    'name' => $staffUser->name,
                    'username' => $staffUser->username,
                    'email' => $staffUser->email,
                    'phone' => $staffUser->phone,
                    'dealer_id' => $staffUser->dealer_id,
                    'branch_code' => $staffUser->branch_code,
                    'branch_name' => $staffUser->branch_name,
                    'roles' => $staffUser->roles
                        ->map(fn ($role): array => [
                            'id' => $role->id,
                            'name' => $role->name,
                            'slug' => $role->slug,
                        ])
                        ->values(),
                ])
                ->values(),
        ]);
    }

    public function show(Request $request, Shipment $shipment, WarehouseShipmentService $service): JsonResponse
    {
        return response()->json([
            'data' => new ShipmentStateResource($service->shipmentState($request->user(), $shipment)),
        ]);
    }

    public function scan(
        ScanShipmentRequest $request,
        Shipment $shipment,
        WarehouseShipmentService $service
    ): JsonResponse {
        $state = $service->scanShipment(
            user: $request->user(),
            shipment: $shipment,
            payload: [
                'barcode' => (string) $request->string('barcode'),
                'qty' => (int) ($request->integer('qty') ?: 1),
            ]
        );

        return response()->json(['data' => new ShipmentStateResource($state)]);
    }

    public function finalize(
        FinalizeShipmentRequest $request,
        Shipment $shipment,
        WarehouseShipmentService $service
    ): JsonResponse {
        $state = $service->finalizeShipment(
            user: $request->user(),
            shipment: $shipment,
            payload: $request->validated()
        );

        return response()->json(['data' => new ShipmentStateResource($state)]);
    }

    public function returnItem(
        ReturnShipmentItemRequest $request,
        Shipment $shipment,
        WarehouseShipmentService $service
    ): JsonResponse {
        $state = $service->returnShipmentItem(
            user: $request->user(),
            shipment: $shipment,
            payload: [
                'item_id' => (int) $request->integer('item_id'),
                'qty' => $request->filled('qty') ? (int) $request->integer('qty') : null,
            ]
        );

        return response()->json(['data' => new ShipmentStateResource($state)]);
    }

    public function returnAllItems(
        Request $request,
        Shipment $shipment,
        WarehouseShipmentService $service
    ): JsonResponse {
        $state = $service->returnAllShipmentItems(
            user: $request->user(),
            shipment: $shipment
        );

        return response()->json(['data' => new ShipmentStateResource($state)]);
    }

    public function addItem(
        AddShipmentItemRequest $request,
        Shipment $shipment,
        WarehouseShipmentService $service
    ): JsonResponse {
        $state = $service->addShipmentItem(
            user: $request->user(),
            shipment: $shipment,
            payload: $request->validated()
        );

        return response()->json(['data' => new ShipmentStateResource($state)]);
    }

    public function updateItemQuantity(
        UpdateShipmentItemQuantityRequest $request,
        Shipment $shipment,
        int $item,
        WarehouseShipmentService $service
    ): JsonResponse {
        $state = $service->updateShipmentItemQuantity(
            user: $request->user(),
            shipment: $shipment,
            itemId: $item,
            quantity: (int) $request->integer('quantity')
        );

        return response()->json(['data' => new ShipmentStateResource($state)]);
    }

    public function destroyItem(
        Request $request,
        Shipment $shipment,
        int $item,
        WarehouseShipmentService $service
    ): JsonResponse {
        $state = $service->deleteShipmentItem(
            user: $request->user(),
            shipment: $shipment,
            itemId: $item
        );

        return response()->json(['data' => new ShipmentStateResource($state)]);
    }

    public function cancel(
        CancelShipmentRequest $request,
        Shipment $shipment,
        WarehouseShipmentService $service
    ): JsonResponse {
        $state = $service->cancelShipment(
            user: $request->user(),
            shipment: $shipment,
            payload: $request->validated()
        );

        return response()->json(['data' => new ShipmentStateResource($state)]);
    }
}
