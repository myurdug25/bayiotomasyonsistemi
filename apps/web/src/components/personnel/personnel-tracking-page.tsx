"use client";

import { Activity, Clock3, MapPin, PhoneCall, ShieldCheck, UserRoundCog, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

const personnelRows = [
  { name: "Aktif Plasiyerler", value: "Anlık", detail: "Cari ziyaret, sepet ve sipariş hareketleri", icon: Users },
  { name: "Depo Ekibi", value: "Takip", detail: "Hazırlama, sevkiyat ve transfer adımları", icon: ShieldCheck },
  { name: "Hızlı Satış", value: "POS", detail: "Şube bazlı satış ve gün sonu durumu", icon: Activity },
];

const followUpRows = [
  { title: "Ziyaret / cari hareketleri", owner: "Plasiyer", status: "Hazır", tone: "emerald" },
  { title: "Depo hazırlama performansı", owner: "Depocu", status: "Hazır", tone: "sky" },
  { title: "POS gün sonu takipleri", owner: "Hızlı Satış", status: "Hazır", tone: "violet" },
  { title: "Tahsilat ve bakiye aksiyonları", owner: "Muhasebe", status: "Planlandı", tone: "amber" },
];

export function PersonnelTrackingPage() {
  return (
    <div className="personnel-tracking-page mx-auto flex w-full max-w-[1480px] flex-col gap-4 text-[var(--foreground)]">
      <section className="dashboard-panel-card overflow-hidden rounded-[24px] border-violet-300/20 p-0">
        <div className="flex flex-col gap-4 border-b border-violet-300/15 bg-[radial-gradient(circle_at_12%_8%,rgba(139,92,246,0.28),transparent_35%),linear-gradient(135deg,rgba(24,18,48,0.96),rgba(8,18,22,0.98))] p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <span className="grid h-14 w-14 place-items-center rounded-2xl border border-violet-200/35 bg-violet-300/12 text-violet-100">
              <UserRoundCog className="h-7 w-7" />
            </span>
            <div>
              <p className="text-xs font-black uppercase tracking-[0.22em] text-violet-100/70">Admin Operasyon</p>
              <h1 className="mt-1 text-3xl font-black tracking-tight text-white">Personel Takip</h1>
              <p className="mt-1 text-sm font-semibold text-violet-100/70">
                Personel hareketlerini, görev akışlarını ve operasyon durumlarını tek ekranda izleyin.
              </p>
            </div>
          </div>
          <Badge className="rounded-full border-violet-200/35 bg-violet-300/12 px-4 py-2 text-sm font-black text-violet-100">
            Admin
          </Badge>
        </div>
      </section>

      <div className="grid gap-3 lg:grid-cols-3">
        {personnelRows.map((row) => {
          const Icon = row.icon;

          return (
            <Card key={row.name} className="dashboard-panel-card overflow-hidden">
              <CardContent className="flex items-center gap-4 p-4">
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-violet-200/25 bg-violet-300/12 text-violet-100">
                  <Icon className="h-6 w-6" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-black text-[var(--foreground)]">{row.name}</p>
                  <p className="mt-1 text-2xl font-black text-violet-200">{row.value}</p>
                  <p className="mt-1 line-clamp-2 text-xs font-semibold leading-5 text-[var(--muted-foreground)]">{row.detail}</p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card className="dashboard-panel-card overflow-hidden">
        <CardContent className="p-4 2xl:p-5">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-black text-[var(--foreground)]">Takip Alanları</h2>
              <p className="mt-1 text-sm font-semibold text-[var(--muted-foreground)]">Bu ekran canlı personel metriklerine bağlanacak ana operasyon yüzeyidir.</p>
            </div>
            <Badge className="w-fit rounded-full border-emerald-200/35 bg-emerald-300/12 text-emerald-100">
              Hazır arayüz
            </Badge>
          </div>

          <div className="grid gap-2">
            {followUpRows.map((row) => (
              <div
                key={row.title}
                className="grid gap-3 rounded-2xl border border-[var(--brand-border)] bg-[var(--surface-soft)] p-3 sm:grid-cols-[minmax(0,1fr)_140px_110px] sm:items-center"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-black text-[var(--foreground)]">{row.title}</p>
                  <p className="mt-1 flex items-center gap-2 text-xs font-semibold text-[var(--muted-foreground)]">
                    <Clock3 className="h-3.5 w-3.5" />
                    Günlük operasyon takibi
                  </p>
                </div>
                <p className="inline-flex items-center gap-2 text-sm font-black text-[var(--foreground)]">
                  <MapPin className="h-4 w-4 text-violet-300" />
                  {row.owner}
                </p>
                <Badge className="justify-center rounded-full border-violet-200/30 bg-violet-300/12 text-violet-100">
                  {row.status}
                </Badge>
              </div>
            ))}
          </div>

          <div className="mt-4 rounded-2xl border border-emerald-300/20 bg-emerald-300/8 p-4 text-sm font-semibold leading-6 text-emerald-50/82">
            <p className="flex items-center gap-2 font-black text-emerald-100">
              <PhoneCall className="h-4 w-4" />
              Sonraki entegrasyon
            </p>
            <p className="mt-1">
              Kullanıcı hareketleri, sipariş sayıları, cari ziyaretleri ve depo işlem süreleri API tarafında hazırlandığında bu sayfa aynı menüden canlı metriklerle beslenecek.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
