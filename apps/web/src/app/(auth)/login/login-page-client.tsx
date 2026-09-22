"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  AlertCircle,
  Database,
  Eye,
  EyeOff,
  Headphones,
  Loader2,
  LogIn,
  Lock,
  ShieldCheck,
  UserRound,
} from "lucide-react";

import { GuestOnly } from "@/components/auth/guest-only";
import { NfsSoftCredit } from "@/components/layout/nfssoft-credit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { clearUserContextStorage, resolvePostLoginRoute } from "@/lib/post-login-route";

const loginSchema = z.object({
  username: z.string().trim().min(1, "Kullanıcı adı gerekli"),
  password: z.string().min(1, "Şifre gerekli"),
  remember: z.boolean().default(true),
});

type LoginFormValues = z.input<typeof loginSchema>;

export default function LoginPageClient() {
  const router = useRouter();
  const { login } = useAuth();

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      username: "",
      password: "",
      remember: true,
    },
    mode: "onSubmit",
    reValidateMode: "onChange",
  });

  const submitWithTarget = async (values: LoginFormValues, nextOverride?: string | null) => {
    setSubmitError(null);

    try {
      clearUserContextStorage();
      const user = await login(values);
      const target = nextOverride ?? resolvePostLoginRoute(user);

      router.replace(target);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Giriş başarısız");
    }
  };

  const onSubmit = form.handleSubmit(async (values) => {
    await submitWithTarget(values);
  });

  return (
    <GuestOnly>
      <main
        className="relative flex min-h-[100dvh] flex-col overflow-hidden bg-[#02070a] px-4 py-5 text-[#eef5ec] sm:px-6 lg:px-8"
      >
        <Image
          src="/login/powersa-login-background-dark-1920x1080.webp"
          alt=""
          fill
          sizes="100vw"
          className="object-cover"
          priority
        />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_48%,rgba(6,15,18,0.08)_0%,rgba(2,7,10,0.38)_62%,rgba(0,0,0,0.58)_100%)]" />
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.18)_0%,rgba(0,0,0,0.04)_42%,rgba(0,0,0,0.32)_100%)]" />

        <div className="relative z-10 mx-auto grid min-h-[calc(100dvh-5rem)] w-full max-w-[70rem] items-center gap-6 lg:grid-cols-[1.04fr_0.96fr]">
          <section className="relative flex min-h-[34rem] overflow-hidden rounded-[22px] border border-white/20 bg-[linear-gradient(145deg,rgba(12,21,28,0.72)_0%,rgba(7,13,18,0.78)_100%)] p-5 shadow-[0_38px_95px_-54px_rgba(0,0,0,0.95)] backdrop-blur-md sm:p-7">
            <div className="pointer-events-none absolute inset-0 rounded-[22px] bg-[linear-gradient(120deg,rgba(255,255,255,0.1)_0%,rgba(255,255,255,0.02)_38%,rgba(255,255,255,0)_100%)]" />
            <div className="pointer-events-none absolute inset-x-8 bottom-[8.6rem] h-px bg-white/10" />

            <div className="relative flex w-full flex-col">
              <div className="flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-[10px] border border-[#8fb765]/40 bg-[#13251b]/80 text-[#a8d47c]">
                  <ShieldCheck className="h-4 w-4" />
                </span>
                <p className="text-[0.78rem] font-black uppercase tracking-[0.28em] text-[#f2f6ee]">
                  Powersa B2B Giriş
                </p>
              </div>

              <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
                <div className="w-full max-w-[23rem]">
                  <Image
                    src="/brand/logotransparan-clean.png"
                    alt="Güçsa Powersa Filter Logo"
                    width={910}
                    height={883}
                    sizes="304px"
                    className="mx-auto h-auto w-full max-w-[19rem] object-contain [filter:drop-shadow(0_24px_22px_rgba(0,0,0,0.42))]"
                    priority
                  />
                </div>
                <p className="mt-3 text-[1rem] font-semibold text-[#b9d39f]">Güçlü altyapı. Güvenilir çözümler.</p>
              </div>

              <div className="grid gap-4 border-t border-[#304236] pt-5 text-left sm:grid-cols-3">
                <div className="flex min-w-0 items-center gap-3">
                  <ShieldCheck className="h-5 w-5 shrink-0 text-[#a8d47c]" />
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-[#edf4eb]">Kurumsal güvenlik</p>
                    <p className="truncate text-xs text-[#8fa18f]">256-bit SSL şifreleme</p>
                  </div>
                </div>
                <div className="flex min-w-0 items-center gap-3">
                  <Database className="h-5 w-5 shrink-0 text-[#a8d47c]" />
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-[#edf4eb]">Yüksek performans</p>
                    <p className="truncate text-xs text-[#8fa18f]">Kesintisiz veri erişimi</p>
                  </div>
                </div>
                <div className="flex min-w-0 items-center gap-3">
                  <Headphones className="h-5 w-5 shrink-0 text-[#a8d47c]" />
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-[#edf4eb]">7/24 destek</p>
                    <p className="truncate text-xs text-[#8fa18f]">Profesyonel destek ekibi</p>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-[22px] border border-white/20 bg-[linear-gradient(145deg,rgba(12,21,28,0.72)_0%,rgba(7,13,18,0.8)_100%)] p-5 shadow-[0_38px_95px_-54px_rgba(0,0,0,0.95)] backdrop-blur-md sm:p-7">
            <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
              <div className="px-1 pt-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="flex items-center gap-2 text-[0.72rem] font-black uppercase tracking-[0.28em] text-[#a8d47c]">
                      <UserRound className="h-4 w-4" />
                      Giriş bilgileri
                    </p>
                    <h1 className="mt-5 text-[1.35rem] font-black leading-tight text-[#f3f7f2]">
                      Kullanıcı bilgilerinizle devam edin.
                    </h1>
                  </div>
                </div>
              </div>

              <div className="border-b border-white/10 px-1 pb-6">
                <div className="space-y-5">
                  <div className="space-y-2.5">
                    <label className="block text-[0.72rem] font-black uppercase tracking-[0.24em] text-[#a7cf79]">
                      Kullanıcı adı
                    </label>
                    <div className="relative">
                      <UserRound className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#8ea08e]" />
                      <Input
                        type="text"
                        placeholder="Kullanıcı adınız"
                        autoComplete="username"
                        disabled={form.formState.isSubmitting}
                        className="h-14 rounded-[10px] border border-white/12 bg-[#060b10]/78 pl-12 text-[0.98rem] font-semibold text-[#eff5f0] placeholder:text-[#7f8f82] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] focus-visible:border-[#89b766] focus-visible:ring-[#6f9446]/25"
                        {...form.register("username")}
                      />
                    </div>
                    {form.formState.errors.username ? (
                      <p className="text-sm font-medium text-[#db7c7c]">{form.formState.errors.username.message}</p>
                    ) : null}
                  </div>

                  <div className="space-y-2.5">
                    <label className="block text-[0.72rem] font-black uppercase tracking-[0.24em] text-[#a7cf79]">
                      Şifre
                    </label>
                    <div className="relative">
                      <Lock className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#8ea08e]" />
                      <Input
                        type={showPassword ? "text" : "password"}
                        placeholder="Şifreniz"
                        autoComplete="current-password"
                        disabled={form.formState.isSubmitting}
                        className="h-14 rounded-[10px] border border-white/12 bg-[#060b10]/78 pl-12 pr-[3.25rem] text-[0.98rem] font-semibold text-[#eff5f0] placeholder:text-[#7f8f82] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] focus-visible:border-[#89b766] focus-visible:ring-[#6f9446]/25"
                        {...form.register("password")}
                      />
                      <button
                        type="button"
                        aria-label={showPassword ? "Şifreyi gizle" : "Şifreyi göster"}
                        onClick={() => setShowPassword((previous) => !previous)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-[10px] p-2 text-[#b9ccc6] transition-colors hover:bg-[#1a2c22]"
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                    {form.formState.errors.password ? (
                      <p className="text-sm font-medium text-[#db7c7c]">{form.formState.errors.password.message}</p>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <label className="flex items-center gap-3 text-sm font-semibold text-[#d8e5dd]">
                      <input
                        type="checkbox"
                        disabled={form.formState.isSubmitting}
                        className="h-[1.125rem] w-[1.125rem] rounded border-[#c5d4c2] accent-[#5f8f3f]"
                        {...form.register("remember")}
                      />
                      Beni hatırla
                    </label>
                    <span className="text-sm font-semibold text-[#aebdaf]">Şifremi unuttum?</span>
                  </div>

                  {submitError ? (
                    <div className="flex items-start gap-3 rounded-[12px] bg-[#35191b] px-4 py-3.5 text-sm font-medium text-[#f0c2c2]">
                      <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
                      <p>{submitError}</p>
                    </div>
                  ) : null}

                  <Button
                    type="submit"
                    className="h-14 w-full rounded-[10px] border border-[#a8d47c]/60 bg-[linear-gradient(135deg,rgba(35,88,34,0.92)_0%,rgba(54,116,38,0.96)_54%,rgba(111,169,64,0.94)_100%)] text-[0.96rem] font-black uppercase tracking-[0.16em] text-white shadow-[0_0_0_1px_rgba(189,244,124,0.12),0_26px_38px_-22px_rgba(88,185,72,0.86)] hover:from-[#1b6332] hover:via-[#21763a] hover:to-[#75ad45]"
                    disabled={form.formState.isSubmitting}
                  >
                    {form.formState.isSubmitting ? (
                      <>
                        <Loader2 className="h-5 w-5 animate-spin" /> Giriş yapılıyor...
                      </>
                    ) : (
                      <>
                        <LogIn className="h-5 w-5" /> Panele giriş yap
                      </>
                    )}
                  </Button>
                </div>
              </div>

              <div className="flex items-center justify-center gap-4 text-center text-xs font-medium text-[#8fa18f]">
                <ShieldCheck className="h-4 w-4 text-[#9ac673]" />
                <span>Güvenli oturum</span>
                <span className="h-4 w-px bg-[#304236]" />
                <span>Verileriniz 256-bit SSL ile korunmaktadır.</span>
              </div>
            </form>
          </section>
        </div>
        <NfsSoftCredit
          dark
          className="relative z-10 mx-auto mt-3 max-w-[70rem] tracking-[0.14em] text-[#8fa18f]/85"
        />
      </main>
    </GuestOnly>
  );
}
