"use client";

import { useEffect, useState } from "react";
import { Download, MonitorDown, X } from "lucide-react";
import { usePathname } from "next/navigation";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const WINDOWS_INSTALLER_FLAG_KEY = "powersa-b2b-windows-installer";

function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isWindowsInstallerShortcut(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const params = new URLSearchParams(window.location.search);
  const fromInstaller = params.get("desktop") === "1" || params.get("installer") === "1";

  if (fromInstaller) {
    window.localStorage.setItem(WINDOWS_INSTALLER_FLAG_KEY, "1");
    return true;
  }

  return window.localStorage.getItem(WINDOWS_INSTALLER_FLAG_KEY) === "1";
}

function shouldShowInstallPrompt(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const params = new URLSearchParams(window.location.search);
  return params.get("install") === "1";
}

export function PwaInstallPrompt() {
  const pathname = usePathname();
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(() => isStandaloneDisplay());
  const [isWindowsShortcut, setIsWindowsShortcut] = useState(() => isWindowsInstallerShortcut());
  const [installRequested, setInstallRequested] = useState(() => shouldShowInstallPrompt());
  const [isDismissed, setIsDismissed] = useState(false);
  const [showInstallHelp, setShowInstallHelp] = useState(false);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };

    const handleInstalled = () => {
      setInstallPrompt(null);
      setIsInstalled(true);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);
    setIsWindowsShortcut(isWindowsInstallerShortcut());
    setInstallRequested(shouldShowInstallPrompt());

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  if (pathname !== "/login" || !installRequested || isInstalled || isWindowsShortcut || isDismissed) {
    return null;
  }

  const install = async () => {
    const prompt = installPrompt;
    if (prompt === null) {
      setShowInstallHelp(true);
      return;
    }

    setShowInstallHelp(false);
    setInstallPrompt(null);
    await prompt.prompt();
    const choice = await prompt.userChoice;

    if (choice.outcome !== "accepted") {
      setInstallPrompt(prompt);
      setIsDismissed(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[160] flex items-center justify-center bg-[#020706]/72 px-4 py-6 backdrop-blur-xl">
      <div className="relative w-full max-w-[28rem] overflow-hidden rounded-[24px] border border-[#ffff00]/35 bg-[linear-gradient(145deg,rgba(11,24,18,0.96)_0%,rgba(5,12,10,0.98)_100%)] p-6 text-center text-[#eef5ec] shadow-[0_32px_90px_-42px_rgba(0,0,0,1),0_0_0_1px_rgba(255,255,255,0.06)]">
        <button
          type="button"
          onClick={() => setIsDismissed(true)}
          className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/6 text-[#b8c8b6] transition hover:bg-white/12 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ffff00]/60"
          aria-label="Kurulum penceresini kapat"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-[#ffff00]/40 bg-[linear-gradient(135deg,#fff35a_0%,#e4b51d_48%,#9b6b08_100%)] text-[#10210f] shadow-[0_22px_46px_-24px_rgba(255,230,0,1)]">
          <MonitorDown className="h-8 w-8" strokeWidth={2.8} />
        </div>

        <p className="mt-5 text-[0.72rem] font-black uppercase tracking-[0.22em] text-[#f3da47]">
          PowerSA B2B
        </p>
        <h2 className="mt-2 text-2xl font-black leading-tight text-white">
          PowerSA B2B uygulamasını yüklemek istiyor musunuz?
        </h2>
        <p className="mx-auto mt-3 max-w-[21rem] text-sm font-medium leading-6 text-[#b9c9b7]">
          Evet dediğinizde tarayıcınız hazırsa resmi kurulum onayı açılır. Hazır değilse Chrome/Edge
          adres çubuğundaki uygulama yükleme alanını kullanabilirsiniz.
        </p>
        {showInstallHelp ? (
          <div className="mt-4 rounded-2xl border border-[#ffff00]/25 bg-[#ffff00]/10 px-4 py-3 text-left text-sm font-bold leading-6 text-[#f7e77a]">
            Chrome/Edge kurulum onayı henüz gelmedi. Adres çubuğunun sağındaki uygulama yükle simgesine
            veya tarayıcı menüsündeki <strong>Uygulamayı yükle</strong> seçeneğine basın.
          </div>
        ) : null}

        <div className="mt-6 grid gap-3 sm:grid-cols-[1fr_auto]">
          <button
            type="button"
            onClick={install}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-[#ffff00]/40 bg-[linear-gradient(135deg,#fff35a_0%,#e4b51d_48%,#9b6b08_100%)] px-5 py-3 text-sm font-black uppercase tracking-[0.12em] text-[#10210f] shadow-[0_22px_46px_-24px_rgba(255,230,0,0.95),inset_0_1px_0_rgba(255,255,255,0.65)] transition hover:-translate-y-0.5 hover:shadow-[0_28px_54px_-24px_rgba(255,230,0,1),inset_0_1px_0_rgba(255,255,255,0.78)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ffff00]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#071312]"
          >
            {installPrompt === null ? "Nasıl yüklerim?" : "Evet, yükle"}
            <Download className="h-4 w-4" strokeWidth={3} />
          </button>
          <button
            type="button"
            onClick={() => setIsDismissed(true)}
            className="min-h-12 rounded-2xl border border-white/12 bg-white/7 px-5 py-3 text-sm font-bold text-[#dce7da] transition hover:bg-white/12 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ffff00]/50"
          >
            Sonra
          </button>
        </div>
      </div>
    </div>
  );
}
