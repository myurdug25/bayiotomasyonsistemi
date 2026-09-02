<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Auth\LoginRequest;
use App\Models\Customer;
use App\Models\User;
use App\Services\Users\UserPermissionService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;
use Symfony\Component\HttpFoundation\Response as HttpStatus;

class AuthController extends Controller
{
    public function login(LoginRequest $request): JsonResponse
    {
        $username = $this->normalizeLoginIdentifier((string) $request->input('username'));
        $password = (string) $request->input('password');
        $normalizedPassword = $this->trimCredentialEdges($password);
        $user = User::query()
            ->where(function ($query) use ($username): void {
                $query
                    ->whereRaw('LOWER(username) = ?', [$username])
                    ->orWhereRaw('LOWER(email) = ?', [$username]);
            })
            ->first();

        $passwordMatches = $user instanceof User && (
            Hash::check($password, $user->password)
            || ($normalizedPassword !== $password && Hash::check($normalizedPassword, $user->password))
        );

        if (! $passwordMatches) {
            Log::warning('Login failed', [
                'username' => $username,
                'user_found' => $user instanceof User,
                'user_active' => $user instanceof User ? (bool) $user->is_active : null,
                'ip' => $request->ip(),
                'user_agent' => mb_substr((string) $request->userAgent(), 0, 180),
            ]);

            return response()->json([
                'message' => 'Kullanıcı adı veya şifre hatalı.',
            ], HttpStatus::HTTP_UNPROCESSABLE_ENTITY);
        }

        $isCustomerUser = $user->hasRole('customer');
        $lastActivity = $user->last_activity_at ?? $user->updated_at ?? $user->created_at;
        if ($isCustomerUser && $user->is_active && $lastActivity?->lt(now()->subDays(30))) {
            $user->forceFill(['is_active' => false])->saveQuietly();

            return response()->json([
                'message' => 'Hesabınız pasif duruma alınmıştır. Lütfen mağaza ile iletişime geçiniz.',
            ], HttpStatus::HTTP_FORBIDDEN);
        }

        Auth::login($user, false);

        if (! $user->is_active) {
            Auth::guard('web')->logout();

            return response()->json([
                'message' => $isCustomerUser
                    ? 'Hesabınız pasif duruma alınmıştır. Lütfen mağaza ile iletişime geçiniz.'
                    : 'Kullanıcı hesabı pasif.',
            ], HttpStatus::HTTP_FORBIDDEN);
        }

        if ($isCustomerUser) {
            $user->forceFill(['last_activity_at' => now()])->saveQuietly();
        }

        $user = $this->clearSelectedCustomer($user);

        $request->session()->regenerate();

        return response()->json([
            'user' => $this->serializeAuthenticatedUser($user),
        ]);
    }

    private function normalizeLoginIdentifier(string $value): string
    {
        $value = $this->trimCredentialEdges($value);
        $value = preg_replace('/[\p{C}]+/u', '', $value) ?? $value;

        return mb_strtolower($value, 'UTF-8');
    }

    private function trimCredentialEdges(string $value): string
    {
        return preg_replace('/^[\p{Z}\p{C}\s]+|[\p{Z}\p{C}\s]+$/u', '', $value) ?? trim($value);
    }

    public function logout(Request $request): Response
    {
        $this->clearSelectedCustomer($request->user());

        Auth::guard('web')->logout();

        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return response()->noContent();
    }

    public function me(Request $request): JsonResponse
    {
        return response()->json([
            'user' => $this->serializeAuthenticatedUser($request->user()),
        ]);
    }

    private function serializeAuthenticatedUser(?User $user): ?User
    {
        if (! $user instanceof User) {
            return null;
        }

        $user->load([
            'roles',
            'dealer',
            'selectedCustomer:id,dealer_id,salesperson_user_id,region_code,region_name,branch_code,branch_name,source_system,source_reference,code,name,contact_name,email,city,district,phone,tax_office,tax_number,credit_limit,is_active,meta,last_synced_at',
            'selectedCustomer.salesperson:id,name,email,phone,avatar_url',
        ]);

        $this->ensureCustomerUserContext($user);
        $user->load([
            'selectedCustomer:id,dealer_id,salesperson_user_id,region_code,region_name,branch_code,branch_name,source_system,source_reference,code,name,contact_name,email,city,district,phone,tax_office,tax_number,credit_limit,is_active,meta,last_synced_at',
            'selectedCustomer.salesperson:id,name,email,phone,avatar_url',
        ]);

        $permissions = app(UserPermissionService::class);
        $user->setAttribute('menu_permissions', $permissions->menuPermissions($user));
        $user->setAttribute('feature_permissions', $permissions->featurePermissions($user));

        return $user;
    }

    private function clearSelectedCustomer(?User $user): ?User
    {
        if (! $user instanceof User || $user->selected_customer_id === null) {
            return $user;
        }

        if ($user->hasRole('customer')) {
            return $user;
        }

        $user->forceFill([
            'selected_customer_id' => null,
        ])->save();

        return $user->fresh() ?? $user;
    }

    private function ensureCustomerUserContext(User $user): void
    {
        if (! $user->hasRole('customer')) {
            return;
        }

        if ($user->selectedCustomer instanceof Customer && $user->selectedCustomer->is_active) {
            return;
        }

        $username = mb_strtolower(trim((string) $user->username));
        $customer = Customer::query()
            ->where('is_active', true)
            ->whereRaw('LOWER(code) = ?', [$username])
            ->first(['id']);

        if ($customer instanceof Customer) {
            $user->forceFill(['selected_customer_id' => $customer->id])->save();
        }
    }
}
