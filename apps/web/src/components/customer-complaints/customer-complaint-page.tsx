"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { FileUp, MessageSquareText, Send, UserRound } from "lucide-react";
import { toast } from "sonner";

import { useSession } from "@/components/auth/session-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createCustomerComplaint } from "@/lib/api";

export function CustomerComplaintPage() {
  const { selectedCustomer } = useSession();
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);

  const salespersonName = selectedCustomer?.salesperson?.name ?? "Tanımlı plasiyer bulunamadı";
  const salespersonPhone = selectedCustomer?.salesperson?.phone ?? "Telefon yok";

  const mutation = useMutation({
    mutationFn: createCustomerComplaint,
    onSuccess: (response) => {
      toast.success(response.message ?? "Dilek / şikayet kaydınız alındı.");
      setSubject("");
      setMessage("");
      setAttachment(null);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Dilek / şikayet gönderilemedi.");
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    mutation.mutate({
      subject: subject.trim(),
      message: message.trim(),
      attachment,
    });
  };

  return (
    <div className="customer-complaint-page mx-auto flex w-full max-w-6xl flex-col gap-5 px-3 py-4 lg:px-5">
      <section className="overflow-hidden rounded-[30px] border border-[#ffff00]/45 bg-[radial-gradient(circle_at_10%_10%,rgba(255,255,0,0.26)_0%,transparent_30%),linear-gradient(135deg,rgba(8,31,23,0.98)_0%,rgba(4,18,14,0.98)_100%)] p-5 shadow-[0_30px_80px_-48px_rgba(255,255,0,0.75)]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <span className="flex h-16 w-16 items-center justify-center rounded-[22px] border border-[#ffff00]/55 bg-[#ffff00] text-slate-950 shadow-[0_18px_34px_-20px_rgba(255,255,0,0.9)]">
              <MessageSquareText className="h-8 w-8" />
            </span>
            <div>
              <p className="text-xs font-black uppercase tracking-[0.34em] text-[#ffff00]">Müşteri İletişimi</p>
              <h1 className="mt-1 text-3xl font-black text-white lg:text-4xl">Dilek / Şikayet</h1>
              <p className="mt-1 max-w-2xl text-sm font-semibold text-emerald-50/70">
                Talebiniz bağlı plasiyer ve merkez ekibe iletilir; şirket bilgileri kayda otomatik eklenir.
              </p>
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-2 lg:items-end">
            <div className="max-w-full rounded-[22px] border border-emerald-300/20 bg-black/20 px-4 py-3 text-sm font-black text-emerald-50">
              {selectedCustomer ? `${selectedCustomer.code} · ${selectedCustomer.title}` : "Cari bilgisi yükleniyor"}
            </div>
            <div className="flex max-w-full items-center gap-2 rounded-[18px] border border-[#ffff00]/24 bg-[#ffff00]/10 px-3 py-2 text-xs font-black text-emerald-50">
              <UserRound className="h-4 w-4 shrink-0 text-[#ffff00]" />
              <span className="shrink-0 uppercase tracking-[0.14em] text-[#ffff00]">Bağlı Plasiyer</span>
              <span className="min-w-0 truncate">{salespersonName}</span>
              <span className="hidden text-emerald-100/45 sm:inline">•</span>
              <span className="hidden shrink-0 text-emerald-100/70 sm:inline">{salespersonPhone}</span>
            </div>
          </div>
        </div>
      </section>

      <form onSubmit={submit} className="rounded-[30px] border border-emerald-300/18 bg-[linear-gradient(145deg,rgba(9,30,23,0.98)_0%,rgba(4,18,14,0.98)_100%)] p-5 shadow-[0_28px_70px_-50px_rgba(0,0,0,0.9)]">
        <div className="grid gap-4">
          <label className="grid gap-2">
            <span className="text-xs font-black uppercase tracking-[0.22em] text-emerald-100/60">Konu</span>
            <Input
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="Konu yazın"
              className="min-h-14 rounded-[18px] border-emerald-300/20 bg-black/20 text-base font-bold text-white placeholder:text-emerald-100/38"
              maxLength={180}
              required
            />
          </label>
          <label className="grid gap-2">
            <span className="text-xs font-black uppercase tracking-[0.22em] text-emerald-100/60">Mesaj</span>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Talebinizi detaylı yazın"
              className="min-h-[180px] rounded-[22px] border border-emerald-300/20 bg-black/20 px-4 py-4 text-base font-semibold leading-relaxed text-white outline-none placeholder:text-emerald-100/38 focus:border-[#ffff00]/70"
              maxLength={5000}
              required
            />
          </label>
          <label className="flex cursor-pointer flex-col gap-2 rounded-[22px] border border-dashed border-[#ffff00]/45 bg-[#ffff00]/8 px-4 py-4 text-sm font-black text-emerald-50 transition hover:bg-[#ffff00]/14 sm:flex-row sm:items-center sm:justify-between">
            <span className="inline-flex items-center gap-2">
              <FileUp className="h-5 w-5 text-[#ffff00]" />
              {attachment ? attachment.name : "Dosya ekle"}
            </span>
            <span className="text-xs font-bold text-emerald-100/55">Maks. 8 MB</span>
            <input
              type="file"
              className="hidden"
              onChange={(event) => setAttachment(event.target.files?.[0] ?? null)}
            />
          </label>
        </div>

        <div className="mt-5 flex justify-end">
          <Button
            type="submit"
            disabled={mutation.isPending}
            className="min-h-14 rounded-[18px] border border-red-300/45 !bg-[linear-gradient(135deg,#ff4b4b_0%,#c51616_100%)] px-7 text-base font-black text-white shadow-[0_22px_38px_-24px_rgba(239,68,68,0.95)]"
          >
            <Send className="h-5 w-5" />
            {mutation.isPending ? "Gönderiliyor..." : "Gönder"}
          </Button>
        </div>
      </form>
    </div>
  );
}
