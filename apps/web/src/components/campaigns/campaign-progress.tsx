"use client";

import { Trophy, Target, ChevronRight, Sparkles } from "lucide-react";
import type { CampaignProgressDto } from "@/lib/api";
import { cn } from "@/lib/utils";

interface CampaignProgressBarProps {
  progress: CampaignProgressDto;
  compact?: boolean;
}

export function CampaignProgressBar({
  progress,
  compact = false,
}: CampaignProgressBarProps) {
  const {
    name,
    description,
    target_quantity,
    cart_quantity,
    progress_pct,
    is_completed,
    remaining,
  } = progress;

  return (
    <div
      className={cn(
        "rounded-2xl border transition-all duration-300",
        is_completed
          ? "border-emerald-400/40 bg-gradient-to-br from-emerald-950/60 to-emerald-900/40 shadow-lg shadow-emerald-900/20"
          : "border-white/10 bg-white/5 hover:bg-white/8"
      )}
    >
      <div className={cn("p-3", compact ? "p-2.5" : "p-4")}>
        {/* Başlık */}
        <div className="mb-2 flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {is_completed ? (
              <Trophy className="h-4 w-4 shrink-0 text-emerald-400" />
            ) : (
              <Target className="h-4 w-4 shrink-0 text-amber-400" />
            )}
            <span
              className={cn(
                "font-bold leading-tight truncate",
                compact ? "text-xs" : "text-sm",
                is_completed ? "text-emerald-300" : "text-white"
              )}
            >
              {name}
            </span>
          </div>

          {/* Adet göstergesi */}
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-xs font-black tabular-nums",
              is_completed
                ? "bg-emerald-500/30 text-emerald-300"
                : "bg-white/10 text-white/70"
            )}
          >
            {cart_quantity}/{target_quantity}
          </span>
        </div>

        {/* İlerleme çubuğu */}
        <div className="relative h-2 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500",
              is_completed
                ? "bg-gradient-to-r from-emerald-500 to-emerald-400"
                : progress_pct >= 60
                  ? "bg-gradient-to-r from-amber-600 to-amber-400"
                  : "bg-gradient-to-r from-blue-600 to-blue-400"
            )}
            style={{ width: `${progress_pct}%` }}
          />
        </div>

        {/* Durum mesajı */}
        {!compact && (
          <p
            className={cn(
              "mt-1.5 text-xs",
              is_completed ? "text-emerald-400" : "text-white/50"
            )}
          >
            {is_completed ? (
              <span className="flex items-center gap-1">
                <Sparkles className="h-3 w-3" />
                Kampanya tamamlandı!
              </span>
            ) : (
              `${remaining} ürün daha ekleyin`
            )}
          </p>
        )}
      </div>
    </div>
  );
}

interface CampaignPanelProps {
  campaigns: CampaignProgressDto[];
  className?: string;
}

/**
 * Birden fazla kampanya ilerlemesini listeleyen panel.
 */
export function CampaignPanel({ campaigns, className }: CampaignPanelProps) {
  if (campaigns.length === 0) return null;

  const completed = campaigns.filter((c) => c.is_completed).length;
  const total = campaigns.length;

  return (
    <div
      className={cn(
        "rounded-2xl border border-white/10 bg-gradient-to-br from-slate-900/80 to-slate-800/60 p-4 backdrop-blur-sm",
        className
      )}
    >
      {/* Panel başlığı */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-amber-500/20">
            <Trophy className="h-3.5 w-3.5 text-amber-400" />
          </div>
          <span className="text-sm font-bold text-white">Kampanyalar</span>
        </div>
        {completed > 0 && (
          <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-bold text-emerald-400">
            {completed}/{total} tamamlandı
          </span>
        )}
      </div>

      {/* Kampanya listesi */}
      <div className="flex flex-col gap-2">
        {campaigns.map((c) => (
          <CampaignProgressBar key={c.campaign_id} progress={c} />
        ))}
      </div>
    </div>
  );
}
