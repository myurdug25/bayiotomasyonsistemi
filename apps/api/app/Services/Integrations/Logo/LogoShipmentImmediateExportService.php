<?php

namespace App\Services\Integrations\Logo;

use App\Models\IntegrationSyncState;
use App\Models\Shipment;
use Illuminate\Support\Facades\Http;
use Illuminate\Validation\ValidationException;
use Throwable;

class LogoShipmentImmediateExportService
{
    public function __construct(
        private readonly LogoShipmentExportService $shipments
    ) {}

    public function export(Shipment $shipment): ?IntegrationSyncState
    {
        if (! $this->enabled()) {
            return null;
        }

        $url = trim((string) config('integrations.logo.shipments.immediate_export.url', ''));
        if ($url === '') {
            return $this->fail($shipment, 'LOGO_SHIPMENT_IMMEDIATE_EXPORT_URL tanimli degil.');
        }

        $record = $this->shipments->recordForShipment($shipment);
        if (! is_array($record)) {
            return $this->fail($shipment, 'Sevkiyat Logo aktarim payloadi hazirlanamadi.');
        }

        $headers = ['Accept' => 'application/json'];
        $token = trim((string) config('integrations.logo.shipments.immediate_export.token', ''));
        if ($token !== '') {
            $headers['Authorization'] = 'Bearer '.$token;
        }

        try {
            $response = Http::timeout($this->timeout())
                ->withHeaders($headers)
                ->post($url, ['record' => $record]);
        } catch (Throwable $exception) {
            return $this->fail($shipment, $exception->getMessage(), $record);
        }

        if (! $response->successful()) {
            return $this->fail(
                $shipment,
                'Logo bridge HTTP '.$response->status().': '.$this->responseMessage($response->json(), $response->body()),
                $record
            );
        }

        $body = $response->json();
        $externalRef = $this->nullableString(data_get($body, 'external_ref'));
        $status = $this->normalizeStatus(data_get($body, 'status'), $externalRef);
        $error = $this->nullableString(data_get($body, 'error'));

        $this->shipments->acknowledge([
            'records' => [[
                'shipment_id' => (int) $shipment->getKey(),
                'status' => $status,
                'external_ref' => $externalRef,
                'error' => $error,
                'meta' => [
                    'export_key' => $record['export_key'] ?? $shipment->logoExportKey(),
                    'immediate_export' => true,
                    'bridge' => is_array(data_get($body, 'meta')) ? data_get($body, 'meta') : [],
                ],
            ]],
        ]);

        if ($status !== 'synced') {
            return $this->throwFailure($error ?: 'Logo bridge synced disinda sonuc dondurdu.');
        }

        return $this->state($shipment);
    }

    private function enabled(): bool
    {
        return (bool) config('integrations.logo.shipments.immediate_export.enabled', false);
    }

    private function timeout(): float
    {
        $timeout = (float) config('integrations.logo.shipments.immediate_export.timeout', 10.0);

        return $timeout > 0 ? $timeout : 10.0;
    }

    /**
     * @param  array<string, mixed>|null  $record
     */
    private function fail(Shipment $shipment, string $message, ?array $record = null): never
    {
        $this->shipments->acknowledge([
            'records' => [[
                'shipment_id' => (int) $shipment->getKey(),
                'status' => 'failed',
                'external_ref' => null,
                'error' => $message,
                'meta' => [
                    'export_key' => $record['export_key'] ?? $shipment->logoExportKey(),
                    'immediate_export' => true,
                ],
            ]],
        ]);

        $this->throwFailure($message);
    }

    private function throwFailure(string $message): never
    {
        throw ValidationException::withMessages([
            'logo' => ['Logo fatura aktarimi basarisiz: '.$message],
        ]);
    }

    private function state(Shipment $shipment): ?IntegrationSyncState
    {
        return IntegrationSyncState::query()
            ->where('system', 'logo')
            ->where('domain', 'warehouse-shipments')
            ->where('direction', 'outbound')
            ->where('entity_type', Shipment::class)
            ->where('entity_id', (int) $shipment->getKey())
            ->first();
    }

    private function normalizeStatus(mixed $status, ?string $externalRef): string
    {
        $normalized = strtolower(trim((string) $status));

        if (in_array($normalized, ['synced', 'failed', 'skipped'], true)) {
            return $normalized;
        }

        return $externalRef ? 'synced' : 'failed';
    }

    private function nullableString(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $normalized = trim((string) $value);

        return $normalized === '' ? null : $normalized;
    }

    private function responseMessage(mixed $json, string $body): string
    {
        if (is_array($json)) {
            return $this->nullableString(data_get($json, 'message'))
                ?? $this->nullableString(data_get($json, 'error'))
                ?? 'bos hata mesaji';
        }

        return $this->nullableString($body) ?? 'bos hata mesaji';
    }
}
