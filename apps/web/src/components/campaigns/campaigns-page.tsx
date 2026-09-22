"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Loader2, PackageSearch, Percent, Tags } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { fetchCampaigns } from "@/lib/api";

function formatDate(value?: string | null) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

export function CampaignsPage() {
  const { selectedCustomer } = useAuth();
  const campaignsQuery = useQuery({
    queryKey: ["campaigns-page", selectedCustomer?.id ?? null],
    queryFn: () => fetchCampaigns(selectedCustomer?.id),
    staleTime: 60_000,
  });
  const campaigns = useMemo(() => campaignsQuery.data?.data ?? [], [campaignsQuery.data?.data]);

  return (
    <div className="campaigns-page mx-auto flex w-full max-w-[1480px] flex-col gap-4 text-[var(--foreground)]">
      <section className="dashboard-panel-card overflow-hidden rounded-[24px] border-emerald-300/20 p-0">
        <div className="flex flex-col gap-4 border-b border-emerald-300/15 bg-[radial-gradient(circle_at_12%_8%,rgba(52,211,153,0.22),transparent_35%),linear-gradient(135deg,rgba(5,36,28,0.96),rgba(8,18,22,0.98))] p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <span className="grid h-14 w-14 place-items-center rounded-2xl border border-emerald-200/35 bg-emerald-300/12 text-emerald-100">
              <Percent className="h-7 w-7" />
            </span>
            <div>
              <p className="text-xs font-black uppercase tracking-[0.22em] text-emerald-100/70">Logo Kampanya</p>
              <h1 className="mt-1 text-3xl font-black tracking-tight text-white">Kampanyalar</h1>
              <p className="mt-1 text-sm font-semibold text-emerald-100/70">Cari ve ürün kapsamına göre aktif Logo kampanyalarını görüntüleyin.</p>
            </div>
          </div>
          <Badge className="rounded-full border-emerald-200/35 bg-emerald-300/12 px-4 py-2 text-sm font-black text-emerald-100">
            {campaigns.length} kampanya
          </Badge>
        </div>
      </section>

      {campaignsQuery.isLoading ? (
        <Card className="dashboard-panel-card">
          <CardContent className="flex h-56 items-center justify-center gap-2 text-sm font-black text-[var(--muted-foreground)]">
            <Loader2 className="h-5 w-5 animate-spin" />
            Kampanyalar yükleniyor...
          </CardContent>
        </Card>
      ) : campaigns.length === 0 ? (
        <Card className="dashboard-panel-card">
          <CardContent className="flex h-56 flex-col items-center justify-center text-center text-sm font-black text-[var(--muted-foreground)]">
            <PackageSearch className="mb-3 h-8 w-8 text-[var(--brand-primary)]" />
            Aktif kampanya bulunamadı.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {campaigns.map((campaign) => (
            <Card key={campaign.id} className="dashboard-panel-card overflow-hidden">
              <CardContent className="flex h-full flex-col gap-4 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-black uppercase tracking-[0.14em] text-emerald-300">{campaign.code}</p>
                    <h2 className="mt-1 line-clamp-2 text-lg font-black leading-6 text-[var(--foreground)]">{campaign.name}</h2>
                  </div>
                  <Badge className="shrink-0 rounded-full border-emerald-200/30 bg-emerald-300/12 text-emerald-100">
                    {campaign.is_active ? "Aktif" : "Pasif"}
                  </Badge>
                </div>

                {campaign.description ? (
                  <p className="line-clamp-3 text-sm font-semibold leading-6 text-[var(--muted-foreground)]">{campaign.description}</p>
                ) : null}

                <div className="mt-auto grid gap-2 text-sm font-bold">
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--brand-border)] bg-[var(--surface-soft)] px-3 py-2">
                    <span className="inline-flex items-center gap-2 text-[var(--muted-foreground)]"><Tags className="h-4 w-4" /> Hedef</span>
                    <strong>{campaign.target_quantity.toLocaleString("tr-TR")} adet</strong>
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--brand-border)] bg-[var(--surface-soft)] px-3 py-2">
                    <span className="inline-flex items-center gap-2 text-[var(--muted-foreground)]"><CalendarDays className="h-4 w-4" /> Tarih</span>
                    <strong className="text-right">{formatDate(campaign.starts_at)} - {formatDate(campaign.ends_at)}</strong>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
