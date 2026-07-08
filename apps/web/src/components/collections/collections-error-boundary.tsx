"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCcw, UsersRound } from "lucide-react";

import { Button } from "@/components/ui/button";

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
};

export class CollectionsErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[collections] page render failed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="admin-collections-page">
        <div className="dashboard-panel-card mx-auto max-w-2xl rounded-[24px] border border-red-300/25 bg-red-950/20 p-6 text-center text-slate-100">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-red-200/40 bg-red-300/12 text-red-100">
            <AlertTriangle className="h-7 w-7" />
          </div>
          <h1 className="text-2xl font-black text-white">Tahsilat sayfası yenilenemedi</h1>
          <p className="mt-2 text-sm font-semibold text-slate-300">
            Bir kayıt beklenmeyen formatta geldi. Sayfayı komple düşürmeden tekrar yüklemeyi deneyebilirsin.
          </p>
          <p className="mt-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs font-semibold text-red-100">
            {this.state.error.message || "Beklenmeyen ekran hatası"}
          </p>
          <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row">
            <Button
              type="button"
              className="admin-danger-action rounded-xl px-5 font-black"
              onClick={() => this.setState({ error: null })}
            >
              <RefreshCcw className="h-4 w-4" />
              Tekrar Dene
            </Button>
            <Button asChild variant="outline" className="rounded-xl px-5 font-black">
              <Link href="/customers">
                <UsersRound className="h-4 w-4" />
                Cari Seç
              </Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
