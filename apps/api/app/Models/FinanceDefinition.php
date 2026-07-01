<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class FinanceDefinition extends Model
{
    use HasFactory;

    public const TYPES = ['bank', 'factory', 'expense_category'];

    protected $fillable = [
        'type',
        'code',
        'name',
        'logo_code',
        'logo_name',
        'meta',
        'sort_order',
        'is_active',
    ];

    protected function casts(): array
    {
        return [
            'meta' => 'array',
            'sort_order' => 'integer',
            'is_active' => 'boolean',
        ];
    }
}
