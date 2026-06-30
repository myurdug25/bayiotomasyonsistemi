<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;

class SanitizeInputStrings
{
    /**
     * Handle an incoming request.
     *
     * @return mixed
     */
    public function handle(Request $request, Closure $next)
    {
        if ($request->isJson() || $request->isMethod('POST') || $request->isMethod('PUT') || $request->isMethod('PATCH')) {
            $input = $request->all();

            array_walk_recursive($input, function (&$value) {
                if (is_string($value)) {
                    // Replace curly braces with normal parentheses to prevent C# String.Format exceptions
                    // in external integration tools (like Logo Sync)
                    $value = str_replace(['{', '}'], ['(', ')'], $value);
                }
            });

            $request->merge($input);
        }

        return $next($request);
    }
}
