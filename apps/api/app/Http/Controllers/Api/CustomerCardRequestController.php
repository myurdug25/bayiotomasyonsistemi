<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\CustomerCardRequest\ListCustomerCardRequestsRequest;
use App\Http\Requests\CustomerCardRequest\StoreCustomerCardRequest;
use App\Http\Requests\CustomerCardRequest\StoreCustomerCardRequestAttachmentRequest;
use App\Http\Requests\CustomerCardRequest\UpdateCustomerCardRequestStatusRequest;
use App\Models\Customer;
use App\Models\CustomerCardRequest;
use App\Models\CustomerCardRequestAttachment;
use App\Models\Dealer;
use App\Models\IntegrationSyncEvent;
use App\Models\User;
use App\Services\Integrations\Logo\LogoWritePublisher;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\StreamedResponse;

class CustomerCardRequestController extends Controller
{
    /**
     * @var array<string, string>
     */
    private const CUSTOMER_CODE_CITY_CODES = [
        'ADANA' => '01',
        'ADIYAMAN' => '02',
        'AFYON' => '03',
        'AFYONKARAHISAR' => '03',
        'AGRI' => '04',
        'AMASYA' => '05',
        'ANKARA' => '06',
        'ANTALYA' => '07',
        'ARTVIN' => '08',
        'AYDIN' => '09',
        'BALIKESIR' => '10',
        'BILECIK' => '11',
        'BINGOL' => '12',
        'BITLIS' => '13',
        'BOLU' => '14',
        'BURDUR' => '15',
        'BURSA' => '16',
        'CANAKKALE' => '17',
        'CANKIRI' => '18',
        'CORUM' => '19',
        'DENIZLI' => '20',
        'DIYARBAKIR' => '21',
        'EDIRNE' => '22',
        'ELAZIG' => '23',
        'ERZINCAN' => '24',
        'ERZURUM' => '25',
        'ESKISEHIR' => '26',
        'GAZIANTEP' => '27',
        'GIRESUN' => '28',
        'GUMUSHANE' => '29',
        'HAKKARI' => '30',
        'HATAY' => '31',
        'ISPARTA' => '32',
        'MERSIN' => '33',
        'ICEL' => '33',
        'ISTANBUL' => '34',
        'IZMIR' => '35',
        'KARS' => '36',
        'KASTAMONU' => '37',
        'KAYSERI' => '38',
        'KIRKLARELI' => '39',
        'KIRSEHIR' => '40',
        'KOCAELI' => '41',
        'IZMIT' => '41',
        'KONYA' => '42',
        'KUTAHYA' => '43',
        'MALATYA' => '44',
        'MANISA' => '45',
        'KAHRAMANMARAS' => '46',
        'MARAS' => '46',
        'MARDIN' => '47',
        'MUGLA' => '48',
        'MUS' => '49',
        'NEVSEHIR' => '50',
        'NIGDE' => '51',
        'ORDU' => '52',
        'RIZE' => '53',
        'SAKARYA' => '54',
        'ADAPAZARI' => '54',
        'SAMSUN' => '55',
        'SIIRT' => '56',
        'SINOP' => '57',
        'SIVAS' => '58',
        'TEKIRDAG' => '59',
        'TOKAT' => '60',
        'TRABZON' => '61',
        'TUNCELI' => '62',
        'SANLIURFA' => '63',
        'URFA' => '63',
        'USAK' => '64',
        'VAN' => '65',
        'YOZGAT' => '66',
        'ZONGULDAK' => '67',
        'AKSARAY' => '68',
        'BAYBURT' => '69',
        'KARAMAN' => '70',
        'KIRIKKALE' => '71',
        'BATMAN' => '72',
        'SIRNAK' => '73',
        'BARTIN' => '74',
        'ARDAHAN' => '75',
        'IGDIR' => '76',
        'YALOVA' => '77',
        'KARABUK' => '78',
        'KILIS' => '79',
        'OSMANIYE' => '80',
        'DUZCE' => '81',
        'BATUM' => '00',
        'BATUMI' => '00',
        'GURCISTAN' => '00',
        'GEORGIA' => '00',
        'ACARA' => '00',
    ];

    public function index(ListCustomerCardRequestsRequest $request): JsonResponse
    {
        $user = $request->user();
        $this->ensureCustomerCardAccessRole($user);

        $validated = $request->validated();
        $limit = min((int) ($validated['limit'] ?? 20), 50);
        $q = trim((string) ($validated['q'] ?? ''));
        $statuses = is_array($validated['statuses'] ?? null) ? $validated['statuses'] : [];

        $query = CustomerCardRequest::query()
            ->select([
                'id',
                'dealer_id',
                'customer_id',
                'salesperson_user_id',
                'requested_by_user_id',
                'reviewed_by_user_id',
                'converted_by_user_id',
                'request_no',
                'company_name',
                'contact_name',
                'phone',
                'email',
                'customer_kind',
                'logo_special_code',
                'logo_authorization_code',
                'logo_e_collection_note',
                'city',
                'district',
                'tax_office',
                'tax_number',
                'address',
                'note',
                'status',
                'review_note',
                'reviewed_at',
                'converted_at',
                'created_at',
            ])
            ->with([
                'dealer:id,code,name',
                'customer:id,code,name,city,district,phone',
                'salesperson:id,dealer_id,name,email,phone',
                'requestedBy:id,name',
                'reviewedBy:id,name',
                'convertedBy:id,name',
                'attachments:id,customer_card_request_id,uploaded_by_user_id,attachment_type,disk,path,original_name,mime_type,size_bytes,note,created_at',
                'attachments.uploadedBy:id,name',
            ]);

        if (! $user->hasRole('admin')) {
            if ($user->dealer_id === null) {
                abort(Response::HTTP_FORBIDDEN, 'User has no dealer scope.');
            }

            $query->where('dealer_id', (int) $user->dealer_id);
        } elseif (! empty($validated['dealer_id'])) {
            $query->where('dealer_id', (int) $validated['dealer_id']);
        }

        if ($statuses !== []) {
            $query->whereIn('status', $statuses);
        }

        if ($q !== '') {
            $query->where(function (Builder $builder) use ($q): void {
                $builder->whereLike('request_no', "%{$q}%", caseSensitive: false)
                    ->orWhereLike('company_name', "%{$q}%", caseSensitive: false)
                    ->orWhereLike('contact_name', "%{$q}%", caseSensitive: false)
                    ->orWhereLike('phone', "%{$q}%", caseSensitive: false)
                    ->orWhereLike('tax_number', "%{$q}%", caseSensitive: false);
            });
        }

        $requests = $query
            ->orderByDesc('created_at')
            ->orderByDesc('id')
            ->cursorPaginate(
                perPage: $limit,
                columns: ['*'],
                cursorName: 'cursor',
                cursor: $validated['cursor'] ?? null
            );

        $rows = collect($requests->items())
            ->map(fn (CustomerCardRequest $customerCardRequest) => $this->serializeCustomerCardRequest($customerCardRequest))
            ->values();

        return response()->json([
            'data' => $rows,
            'next_cursor' => $requests->nextCursor()?->encode(),
            'prev_cursor' => $requests->previousCursor()?->encode(),
            'limit' => $limit,
            'summary' => $this->buildSummary($rows),
        ]);
    }

    public function salespeople(Request $request): JsonResponse
    {
        $user = $request->user();
        $this->ensureCustomerCardAccessRole($user);

        $query = User::query()
            ->select(['id', 'dealer_id', 'name', 'email', 'phone', 'is_active'])
            ->where('is_active', true)
            ->whereHas('roles', fn (Builder $builder) => $builder->where('slug', 'salesperson'))
            ->with('dealer:id,code,name')
            ->orderBy('name');

        if ($user->hasRole('salesperson')) {
            $query->whereKey((int) $user->id);
        } elseif ($user->hasRole('point')) {
            // Point users create cards on behalf of the selected salesperson.
        } elseif (! $user->hasRole('admin')) {
            if ($user->dealer_id === null) {
                abort(Response::HTTP_FORBIDDEN, 'User has no dealer scope.');
            }

            $query->where('dealer_id', (int) $user->dealer_id);
        } elseif ($request->filled('dealer_id')) {
            $query->where('dealer_id', (int) $request->input('dealer_id'));
        }

        return response()->json([
            'data' => $query->get()
                ->map(fn (User $salesperson) => [
                    'id' => (int) $salesperson->id,
                    'dealer_id' => $salesperson->dealer_id,
                    'name' => $salesperson->name,
                    'email' => $salesperson->email,
                    'phone' => $salesperson->phone,
                    'dealer' => [
                        'id' => $salesperson->dealer?->id,
                        'code' => $salesperson->dealer?->code,
                        'name' => $salesperson->dealer?->name,
                    ],
                ])
                ->values(),
        ]);
    }

    public function store(StoreCustomerCardRequest $request, LogoWritePublisher $logoWritePublisher): JsonResponse
    {
        $user = $request->user();
        $this->ensureCustomerCardAccessRole($user);

        $validated = $request->validated();
        $dealerId = $this->resolveDealerId($user, $validated);
        $salesperson = $this->resolveSalesperson($user, $dealerId, $validated);
        $autoConvert = (bool) ($validated['auto_convert'] ?? false);
        $createdCustomer = null;

        if ($dealerId === null) {
            return response()->json([
                'message' => 'dealer_id is required for users without an assigned dealer.',
            ], Response::HTTP_UNPROCESSABLE_ENTITY);
        }

        if ($autoConvert) {
            $this->ensureCustomerCardAutoConvertRole($user);

            if (! $salesperson instanceof User) {
                throw ValidationException::withMessages([
                    'salesperson_user_id' => ['Cari oluşturmak için plasiyer seçimi zorunludur.'],
                ]);
            }
        }

        $customerCardRequest = CustomerCardRequest::query()->create([
            'dealer_id' => $dealerId,
            'salesperson_user_id' => $salesperson?->id,
            'requested_by_user_id' => (int) $user->id,
            'reviewed_by_user_id' => $autoConvert ? (int) $user->id : null,
            'request_no' => $this->generateRequestNo(),
            'company_name' => (string) $validated['company_name'],
            'contact_name' => (string) $validated['contact_name'],
            'phone' => (string) $validated['phone'],
            'email' => $validated['email'] ?? null,
            'customer_kind' => (string) ($validated['customer_kind'] ?? 'company'),
            'logo_special_code' => 'F1',
            'logo_authorization_code' => $validated['logo_authorization_code'] ?? null,
            'logo_e_collection_note' => $this->generateLogoECollectionNote(),
            'city' => (string) $validated['city'],
            'district' => $validated['district'] ?? null,
            'tax_office' => $validated['tax_office'] ?? null,
            'tax_number' => $validated['tax_number'] ?? null,
            'address' => $validated['address'] ?? null,
            'note' => $validated['note'] ?? null,
            'status' => $autoConvert ? CustomerCardRequest::STATUS_APPROVED : CustomerCardRequest::STATUS_SUBMITTED,
            'review_note' => $autoConvert ? 'B2B yeni cari formundan otomatik oluşturuldu.' : null,
            'reviewed_at' => $autoConvert ? now() : null,
        ]);

        if ($autoConvert) {
            $createdCustomer = $this->createCustomerFromRequest($customerCardRequest, $user, $logoWritePublisher, false);
        }

        $customerCardRequest->loadMissing([
            'dealer:id,code,name',
            'customer:id,code,name,city,district,phone',
            'salesperson:id,dealer_id,name,email,phone',
            'requestedBy:id,name',
            'reviewedBy:id,name',
            'convertedBy:id,name',
            'attachments:id,customer_card_request_id,uploaded_by_user_id,attachment_type,disk,path,original_name,mime_type,size_bytes,note,created_at',
            'attachments.uploadedBy:id,name',
        ]);

        return response()->json([
            'data' => $this->serializeCustomerCardRequest($customerCardRequest),
            'customer' => $createdCustomer instanceof Customer
                ? $this->serializeCreatedCustomer($createdCustomer)
                : ($customerCardRequest->customer ? $this->serializeCreatedCustomer($customerCardRequest->customer) : null),
        ], Response::HTTP_CREATED);
    }

    public function updateStatus(UpdateCustomerCardRequestStatusRequest $request, CustomerCardRequest $customerCardRequest): JsonResponse
    {
        $user = $request->user();
        $this->ensureCustomerCardReviewRole($user);

        if (! $user->hasRole('admin') && $user->dealer_id !== (int) $customerCardRequest->dealer_id) {
            abort(Response::HTTP_FORBIDDEN);
        }

        $validated = $request->validated();
        $nextStatus = (string) $validated['status'];
        $this->ensureValidStatusTransition($customerCardRequest, $nextStatus);
        $this->ensureRequiredAttachmentsForApproval($customerCardRequest, $nextStatus);

        $customerCardRequest->forceFill([
            'status' => $nextStatus,
            'review_note' => $validated['review_note'] ?? $customerCardRequest->review_note,
            'reviewed_by_user_id' => $user->id,
            'reviewed_at' => now(),
        ])->save();

        $customerCardRequest->loadMissing([
            'dealer:id,code,name',
            'customer:id,code,name,city,district,phone',
            'salesperson:id,dealer_id,name,email,phone',
            'requestedBy:id,name',
            'reviewedBy:id,name',
            'convertedBy:id,name',
            'attachments:id,customer_card_request_id,uploaded_by_user_id,attachment_type,disk,path,original_name,mime_type,size_bytes,note,created_at',
            'attachments.uploadedBy:id,name',
        ]);

        return response()->json([
            'data' => $this->serializeCustomerCardRequest($customerCardRequest),
        ]);
    }

    public function convertToCustomer(CustomerCardRequest $customerCardRequest, LogoWritePublisher $logoWritePublisher): JsonResponse
    {
        /** @var User $user */
        $user = request()->user();
        $this->ensureCustomerCardReviewRole($user);

        if (! $user->hasRole('admin') && $user->dealer_id !== (int) $customerCardRequest->dealer_id) {
            abort(Response::HTTP_FORBIDDEN);
        }

        if ($customerCardRequest->status !== CustomerCardRequest::STATUS_APPROVED) {
            throw ValidationException::withMessages([
                'status' => ['Cari açılışı için başvurunun onaylı olması gerekir.'],
            ]);
        }

        $this->ensureRequiredAttachmentsForApproval($customerCardRequest, CustomerCardRequest::STATUS_APPROVED);

        if ($customerCardRequest->customer_id !== null) {
            throw ValidationException::withMessages([
                'customer_id' => ['Bu başvurudan zaten bir cari oluşturuldu.'],
            ]);
        }

        $customer = $this->createCustomerFromRequest($customerCardRequest, $user, $logoWritePublisher);

        $customerCardRequest->loadMissing([
            'dealer:id,code,name',
            'customer:id,code,name,city,district,phone',
            'salesperson:id,dealer_id,name,email,phone',
            'requestedBy:id,name',
            'reviewedBy:id,name',
            'convertedBy:id,name',
            'attachments:id,customer_card_request_id,uploaded_by_user_id,attachment_type,disk,path,original_name,mime_type,size_bytes,note,created_at',
            'attachments.uploadedBy:id,name',
        ]);

        return response()->json([
            'data' => $this->serializeCustomerCardRequest($customerCardRequest->fresh([
                'dealer:id,code,name',
                'customer:id,code,name,city,district,phone',
                'salesperson:id,dealer_id,name,email,phone',
                'requestedBy:id,name',
                'reviewedBy:id,name',
                'convertedBy:id,name',
                'attachments:id,customer_card_request_id,uploaded_by_user_id,attachment_type,disk,path,original_name,mime_type,size_bytes,note,created_at',
                'attachments.uploadedBy:id,name',
            ])),
            'customer' => $this->serializeCreatedCustomer($customer),
        ]);
    }

    public function storeAttachment(
        StoreCustomerCardRequestAttachmentRequest $request,
        CustomerCardRequest $customerCardRequest
    ): JsonResponse {
        $user = $request->user();
        $this->ensureCanAccessCustomerCardRequest($user, $customerCardRequest);

        $validated = $request->validated();
        $uploadedFile = $request->file('file');
        if ($uploadedFile === null) {
            throw ValidationException::withMessages([
                'file' => ['Yüklenecek dosya bulunamadı.'],
            ]);
        }

        $disk = (string) config('filesystems.default', 'local');
        $path = $uploadedFile->store(
            sprintf('customer-card-requests/%d', $customerCardRequest->id),
            ['disk' => $disk]
        );

        $attachment = $customerCardRequest->attachments()->create([
            'uploaded_by_user_id' => (int) $user->id,
            'attachment_type' => (string) $validated['attachment_type'],
            'disk' => $disk,
            'path' => $path,
            'original_name' => (string) $uploadedFile->getClientOriginalName(),
            'mime_type' => $uploadedFile->getClientMimeType(),
            'size_bytes' => (int) $uploadedFile->getSize(),
            'note' => $validated['note'] ?? null,
        ]);

        $attachment->loadMissing('uploadedBy:id,name');

        $customerCardRequest->load([
            'dealer:id,code,name',
            'customer:id,code,name,city,district,phone',
            'salesperson:id,dealer_id,name,email,phone',
            'requestedBy:id,name',
            'reviewedBy:id,name',
            'convertedBy:id,name',
            'attachments:id,customer_card_request_id,uploaded_by_user_id,attachment_type,disk,path,original_name,mime_type,size_bytes,note,created_at',
            'attachments.uploadedBy:id,name',
        ]);

        return response()->json([
            'data' => $this->serializeCustomerCardRequest($customerCardRequest),
        ], Response::HTTP_CREATED);
    }

    public function showAttachment(
        CustomerCardRequest $customerCardRequest,
        CustomerCardRequestAttachment $attachment
    ): StreamedResponse {
        $user = request()->user();
        $this->ensureCanAccessCustomerCardRequest($user, $customerCardRequest);
        $this->ensureAttachmentBelongsToRequest($customerCardRequest, $attachment);

        return Storage::disk($attachment->disk)->response(
            $attachment->path,
            $attachment->original_name,
            [
                'Content-Type' => $attachment->mime_type ?: 'application/octet-stream',
            ]
        );
    }

    private function ensureCustomerCardAccessRole(User $user): void
    {
        if (! $user->hasAnyRole(['admin', 'dealer_admin', 'salesperson', 'point'])) {
            abort(Response::HTTP_FORBIDDEN);
        }
    }

    private function ensureCustomerCardReviewRole(User $user): void
    {
        if (! $user->hasAnyRole(['admin', 'salesperson'])) {
            abort(Response::HTTP_FORBIDDEN);
        }
    }

    private function ensureCustomerCardAutoConvertRole(User $user): void
    {
        if (! $user->hasAnyRole(['admin', 'dealer_admin', 'salesperson', 'point'])) {
            abort(Response::HTTP_FORBIDDEN);
        }
    }

    private function ensureCanAccessCustomerCardRequest(User $user, CustomerCardRequest $customerCardRequest): void
    {
        $this->ensureCustomerCardAccessRole($user);

        if (! $user->hasRole('admin') && $user->dealer_id !== (int) $customerCardRequest->dealer_id) {
            abort(Response::HTTP_FORBIDDEN);
        }
    }

    private function ensureAttachmentBelongsToRequest(
        CustomerCardRequest $customerCardRequest,
        CustomerCardRequestAttachment $attachment
    ): void {
        if ((int) $attachment->customer_card_request_id !== (int) $customerCardRequest->id) {
            abort(Response::HTTP_NOT_FOUND);
        }
    }

    /**
     * @param  array<string, mixed>  $validated
     */
    private function resolveDealerId(User $user, array $validated): ?int
    {
        if ($user->dealer_id !== null) {
            return (int) $user->dealer_id;
        }

        if ($user->hasRole('admin') && ! empty($validated['dealer_id'])) {
            return (int) $validated['dealer_id'];
        }

        if ($user->hasRole('admin') && $user->selected_customer_id !== null) {
            $dealerId = Customer::query()
                ->whereKey((int) $user->selected_customer_id)
                ->value('dealer_id');

            return $dealerId !== null ? (int) $dealerId : null;
        }

        if ($user->hasRole('admin')) {
            $dealerId = Dealer::query()
                ->where('is_active', true)
                ->orderBy('id')
                ->value('id');

            return $dealerId !== null ? (int) $dealerId : null;
        }

        return null;
    }

    /**
     * @param  array<string, mixed>  $validated
     */
    private function resolveSalesperson(User $user, ?int $dealerId, array $validated): ?User
    {
        if ($user->hasRole('salesperson')) {
            return $user;
        }

        if (empty($validated['salesperson_user_id'])) {
            return null;
        }

        if ($dealerId === null && ! $user->hasRole('point')) {
            throw ValidationException::withMessages([
                'salesperson_user_id' => ['Plasiyer seçmek için önce bayi kapsamı belirlenmelidir.'],
            ]);
        }

        $salespersonQuery = User::query()
            ->whereKey((int) $validated['salesperson_user_id'])
            ->where('is_active', true)
            ->whereHas('roles', fn (Builder $builder) => $builder->where('slug', 'salesperson'))
            ->when(
                $dealerId !== null && ! $user->hasRole('point'),
                fn (Builder $builder) => $builder->where('dealer_id', $dealerId)
            );

        $salesperson = $salespersonQuery->first();

        if (! $salesperson instanceof User) {
            throw ValidationException::withMessages([
                'salesperson_user_id' => ['Seçilen plasiyer bu bayi için geçerli değil.'],
            ]);
        }

        return $salesperson;
    }

    private function ensureValidStatusTransition(CustomerCardRequest $customerCardRequest, string $nextStatus): void
    {
        if ($customerCardRequest->status === $nextStatus) {
            return;
        }

        $allowedTransitions = match ($customerCardRequest->status) {
            CustomerCardRequest::STATUS_SUBMITTED => [
                CustomerCardRequest::STATUS_REVIEWING,
                CustomerCardRequest::STATUS_APPROVED,
                CustomerCardRequest::STATUS_REJECTED,
            ],
            CustomerCardRequest::STATUS_REVIEWING => [
                CustomerCardRequest::STATUS_APPROVED,
                CustomerCardRequest::STATUS_REJECTED,
            ],
            default => [],
        };

        if (! in_array($nextStatus, $allowedTransitions, true)) {
            throw ValidationException::withMessages([
                'status' => ['Geçersiz durum geçişi.'],
            ]);
        }
    }

    private function ensureRequiredAttachmentsForApproval(
        CustomerCardRequest $customerCardRequest,
        string $nextStatus
    ): void {
        if ($nextStatus !== CustomerCardRequest::STATUS_APPROVED) {
            return;
        }

        $requirements = $this->buildAttachmentRequirements($customerCardRequest);
        if ($requirements['is_complete']) {
            return;
        }

        $missingLabels = collect($requirements['missing_types'])
            ->pluck('label')
            ->filter(fn ($label) => is_string($label) && $label !== '')
            ->implode(', ');

        throw ValidationException::withMessages([
            'status' => [
                sprintf(
                    'Onay için zorunlu evraklar eksik: %s.',
                    $missingLabels !== '' ? $missingLabels : 'zorunlu evrak listesi'
                ),
            ],
        ]);
    }

    private function generateRequestNo(): string
    {
        do {
            $candidate = sprintf('YCK-%s-%s', now()->format('YmdHis'), Str::upper(Str::random(4)));
            $exists = CustomerCardRequest::query()->where('request_no', $candidate)->exists();
        } while ($exists);

        return $candidate;
    }

    private function generateCustomerCode(string $city): string
    {
        $prefix = sprintf('120-%s', $this->resolveCustomerCodeCityCode($city));
        $nextCounter = $this->nextCustomerCodeCounter($prefix);

        for ($counter = $nextCounter; $counter <= 999; $counter++) {
            $candidate = sprintf('%s-%03d', $prefix, $counter);
            $exists = Customer::query()
                ->where('code', $candidate)
                ->exists();

            if (! $exists) {
                return $candidate;
            }
        }

        throw ValidationException::withMessages([
            'code' => ['Yeni cari kodu üretilemedi.'],
        ]);
    }

    private function nextCustomerCodeCounter(string $prefix): int
    {
        $highest = Customer::query()
            ->whereLike('code', $prefix.'-%', caseSensitive: false)
            ->pluck('code')
            ->map(function (string $code) use ($prefix): int {
                $suffix = Str::after($code, $prefix.'-');

                return preg_match('/^\d{3}$/', $suffix) === 1 ? (int) $suffix : 0;
            })
            ->max();

        return max(1, ((int) $highest) + 1);
    }

    private function resolveCustomerCodeCityCode(string $city): string
    {
        $normalized = $this->normalizeCustomerCodeCity($city);

        return self::CUSTOMER_CODE_CITY_CODES[$normalized] ?? '00';
    }

    private function normalizeCustomerCodeCity(string $city): string
    {
        $normalized = Str::ascii($city);
        $normalized = Str::upper($normalized);
        $normalized = preg_replace('/[^A-Z0-9]+/', ' ', $normalized) ?? '';

        return trim(preg_replace('/\s+/', ' ', $normalized) ?? '');
    }

    private function generateLogoECollectionNote(): string
    {
        return sprintf('e ( yeni cari - %s )', now()->format('d.m.Y'));
    }

    private function createCustomerFromRequest(
        CustomerCardRequest $customerCardRequest,
        User $user,
        LogoWritePublisher $logoWritePublisher,
        bool $enforceAttachmentRequirements = true
    ): Customer {
        if ($enforceAttachmentRequirements) {
            $this->ensureRequiredAttachmentsForApproval($customerCardRequest, CustomerCardRequest::STATUS_APPROVED);
        }

        return DB::transaction(function () use ($customerCardRequest, $user, $logoWritePublisher): Customer {
            $customerCardRequest->refresh();

            if ($customerCardRequest->customer_id !== null) {
                throw ValidationException::withMessages([
                    'customer_id' => ['Bu başvurudan zaten bir cari oluşturuldu.'],
                ]);
            }

            $dealer = Dealer::query()
                ->select(['id', 'code'])
                ->findOrFail((int) $customerCardRequest->dealer_id);
            $salespersonId = $customerCardRequest->salesperson_user_id;

            if ($user->hasRole('salesperson')) {
                $salespersonId = (int) $user->id;
            }

            $salesperson = $salespersonId !== null
                ? User::query()
                    ->select(['id', 'logo_customer_specode4'])
                    ->find((int) $salespersonId)
                : null;

            $logoPayload = array_filter([
                'cardtype' => 3,
                'customer_kind' => $customerCardRequest->customer_kind ?: 'company',
                'specode' => $customerCardRequest->logo_special_code ?: 'F1',
                'specode4' => $this->firstLogoCustomerSpecode4($salesperson?->logo_customer_specode4),
                'cyphcode' => $customerCardRequest->logo_authorization_code,
                'e_collection_note' => $customerCardRequest->logo_e_collection_note ?: $this->generateLogoECollectionNote(),
            ], fn ($value) => $value !== null && $value !== '');

            $customer = Customer::query()->create([
                'dealer_id' => $dealer->id,
                'salesperson_user_id' => $salespersonId,
                'source_system' => 'b2b',
                'sync_status' => 'pending',
                'sync_error' => null,
                'code' => $this->generateCustomerCode($customerCardRequest->city),
                'name' => $customerCardRequest->company_name,
                'contact_name' => $customerCardRequest->contact_name,
                'email' => $customerCardRequest->email,
                'phone' => $customerCardRequest->phone,
                'city' => $customerCardRequest->city,
                'district' => $customerCardRequest->district,
                'tax_office' => $customerCardRequest->tax_office,
                'tax_number' => $customerCardRequest->tax_number,
                'credit_limit' => 0,
                'is_active' => true,
                'meta' => array_filter([
                    'address' => $customerCardRequest->address,
                    'customer_kind' => $customerCardRequest->customer_kind ?: 'company',
                    'customer_card_request' => [
                        'id' => $customerCardRequest->id,
                        'request_no' => $customerCardRequest->request_no,
                        'note' => $customerCardRequest->note,
                    ],
                    'integrations' => [
                        'logo' => [
                            'payload' => $logoPayload,
                        ],
                    ],
                ], fn ($value) => $value !== null && $value !== ''),
            ]);

            $customerCardRequest->forceFill([
                'customer_id' => $customer->id,
                'salesperson_user_id' => $salespersonId,
                'converted_by_user_id' => $user->id,
                'converted_at' => now(),
            ])->save();

            $logoWritePublisher->queueCustomerCreate($customer);

            return $customer;
        });
    }

    private function firstLogoCustomerSpecode4(?string $value): ?string
    {
        foreach (preg_split('/[,;|]+/', (string) $value) ?: [] as $entry) {
            $normalized = Str::upper(trim($entry));

            if ($normalized !== '') {
                return $normalized;
            }
        }

        return null;
    }

    /**
     * @return array<string, mixed>
     */
    private function serializeCreatedCustomer(Customer $customer): array
    {
        return [
            'id' => $customer->id,
            'code' => $customer->code,
            'name' => $customer->name,
            'sync_status' => $customer->sync_status,
            'logo_queue_status' => $this->latestLogoCustomerWriteStatus($customer),
        ];
    }

    private function latestLogoCustomerWriteStatus(Customer $customer): ?string
    {
        $status = IntegrationSyncEvent::query()
            ->where('system', 'logo')
            ->where('domain', 'customers-write')
            ->where('direction', 'outbound')
            ->where('entity_type', Customer::class)
            ->where('entity_id', (int) $customer->id)
            ->latest('id')
            ->value('status');

        return is_string($status) ? $status : null;
    }

    /**
     * @return array<string, mixed>
     */
    private function serializeCustomerCardRequest(CustomerCardRequest $customerCardRequest): array
    {
        $attachmentRequirements = $this->buildAttachmentRequirements($customerCardRequest);

        return [
            'id' => (int) $customerCardRequest->id,
            'request_no' => $customerCardRequest->request_no,
            'company_name' => $customerCardRequest->company_name,
            'contact_name' => $customerCardRequest->contact_name,
            'phone' => $customerCardRequest->phone,
            'email' => $customerCardRequest->email,
            'customer_kind' => $customerCardRequest->customer_kind ?? 'company',
            'logo_special_code' => $customerCardRequest->logo_special_code ?? 'F1',
            'logo_authorization_code' => $customerCardRequest->logo_authorization_code,
            'logo_e_collection_note' => $customerCardRequest->logo_e_collection_note,
            'city' => $customerCardRequest->city,
            'district' => $customerCardRequest->district,
            'tax_office' => $customerCardRequest->tax_office,
            'tax_number' => $customerCardRequest->tax_number,
            'address' => $customerCardRequest->address,
            'note' => $customerCardRequest->note,
            'status' => $customerCardRequest->status,
            'review_note' => $customerCardRequest->review_note,
            'created_at' => $customerCardRequest->created_at?->toJSON(),
            'reviewed_at' => $customerCardRequest->reviewed_at?->toJSON(),
            'dealer' => [
                'id' => $customerCardRequest->dealer?->id,
                'code' => $customerCardRequest->dealer?->code,
                'name' => $customerCardRequest->dealer?->name,
            ],
            'salesperson' => [
                'id' => $customerCardRequest->salesperson?->id,
                'dealer_id' => $customerCardRequest->salesperson?->dealer_id,
                'name' => $customerCardRequest->salesperson?->name,
                'email' => $customerCardRequest->salesperson?->email,
                'phone' => $customerCardRequest->salesperson?->phone,
            ],
            'customer' => [
                'id' => $customerCardRequest->customer?->id,
                'code' => $customerCardRequest->customer?->code,
                'title' => $customerCardRequest->customer?->name,
                'city' => $customerCardRequest->customer?->city,
                'district' => $customerCardRequest->customer?->district,
                'phone' => $customerCardRequest->customer?->phone,
            ],
            'requested_by' => [
                'id' => $customerCardRequest->requestedBy?->id,
                'name' => $customerCardRequest->requestedBy?->name,
            ],
            'reviewed_by' => [
                'id' => $customerCardRequest->reviewedBy?->id,
                'name' => $customerCardRequest->reviewedBy?->name,
            ],
            'converted_by' => [
                'id' => $customerCardRequest->convertedBy?->id,
                'name' => $customerCardRequest->convertedBy?->name,
            ],
            'converted_at' => $customerCardRequest->converted_at?->toJSON(),
            'attachments' => $customerCardRequest->attachments
                ->map(fn (CustomerCardRequestAttachment $attachment) => [
                    'id' => $attachment->id,
                    'attachment_type' => $attachment->attachment_type,
                    'original_name' => $attachment->original_name,
                    'mime_type' => $attachment->mime_type,
                    'size_bytes' => $attachment->size_bytes,
                    'note' => $attachment->note,
                    'uploaded_at' => $attachment->created_at?->toJSON(),
                    'uploaded_by' => [
                        'id' => $attachment->uploadedBy?->id,
                        'name' => $attachment->uploadedBy?->name,
                    ],
                    'download_url' => sprintf(
                        '/api/customer-card-requests/%d/attachments/%d',
                        $customerCardRequest->id,
                        $attachment->id
                    ),
                ])
                ->values()
                ->all(),
            'attachment_requirements' => $attachmentRequirements,
        ];
    }

    /**
     * @return array{
     *   required_types: list<array{type: string, label: string}>,
     *   uploaded_types: list<string>,
     *   missing_types: list<array{type: string, label: string}>,
     *   is_complete: bool
     * }
     */
    private function buildAttachmentRequirements(CustomerCardRequest $customerCardRequest): array
    {
        $customerCardRequest->loadMissing('attachments');

        $uploadedTypes = $customerCardRequest->attachments
            ->pluck('attachment_type')
            ->filter(fn ($type) => is_string($type) && $type !== '')
            ->unique()
            ->values();

        $requiredTypes = collect(CustomerCardRequestAttachment::requiredTypesForApproval())
            ->map(fn (string $type) => [
                'type' => $type,
                'label' => CustomerCardRequestAttachment::labelFor($type),
            ])
            ->values();

        $missingTypes = $requiredTypes
            ->filter(fn (array $item) => ! $uploadedTypes->contains($item['type']))
            ->values();

        return [
            'required_types' => $requiredTypes->all(),
            'uploaded_types' => $uploadedTypes->all(),
            'missing_types' => $missingTypes->all(),
            'is_complete' => $missingTypes->isEmpty(),
        ];
    }

    /**
     * @param  Collection<int, array<string, mixed>>  $rows
     * @return array<string, mixed>
     */
    private function buildSummary(Collection $rows): array
    {
        $statusBreakdown = $rows
            ->groupBy(fn (array $row) => (string) ($row['status'] ?? 'unknown'))
            ->map(fn (Collection $group, string $status) => [
                'status' => $status,
                'count' => $group->count(),
            ])
            ->values()
            ->all();

        return [
            'total_count' => $rows->count(),
            'submitted_count' => $rows->where('status', CustomerCardRequest::STATUS_SUBMITTED)->count(),
            'reviewing_count' => $rows->where('status', CustomerCardRequest::STATUS_REVIEWING)->count(),
            'approved_count' => $rows->where('status', CustomerCardRequest::STATUS_APPROVED)->count(),
            'rejected_count' => $rows->where('status', CustomerCardRequest::STATUS_REJECTED)->count(),
            'converted_count' => $rows->filter(fn (array $row) => ! empty($row['customer']['id'] ?? null))->count(),
            'status_breakdown' => $statusBreakdown,
        ];
    }
}
