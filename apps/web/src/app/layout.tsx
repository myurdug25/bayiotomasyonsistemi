import type { Metadata, Viewport } from "next";
import { Inter, Public_Sans, Roboto_Condensed } from "next/font/google";

import { AppProvider } from "@/components/app/app-provider";
import { ReactQueryProvider } from "@/components/providers/react-query-provider";
import { Toaster } from "@/components/ui/sonner";

import "./globals.css";

const uiThemeScript = `
(() => {
  try {
    const themeStorageKey = "powersa-ui-theme";
    const accentStorageKey = "powersa-ui-accent";
    const legacyColorStorageKey = "powersa-ui-color";
    const storedAccent = window.localStorage.getItem(accentStorageKey);
    const storedLegacyColor = window.localStorage.getItem(legacyColorStorageKey);
    const legacyColorMap = {
      green: "#3f7b58",
      amber: "#000000",
      red: "#ad564f",
      blue: "#3a6f9f",
    };
    const deprecatedYellowAccent = "#b48722";
    const isHexColor = (value) => /^#[0-9a-fA-F]{6}$/.test(value ?? "");
    const normalizeAccent = (value) => {
      if (isHexColor(value)) {
        const normalized = value.toLowerCase();
        return normalized === deprecatedYellowAccent ? "#000000" : normalized;
      }

      if (value && legacyColorMap[value]) {
        return legacyColorMap[value];
      }

      return "#3f7b58";
    };
    const storedTheme = window.localStorage.getItem(themeStorageKey);
    const theme = storedTheme === "light" || storedTheme === "dark" ? storedTheme : "dark";
    const accent = normalizeAccent(storedAccent ?? storedLegacyColor);
    document.documentElement.dataset.uiTheme = theme;
    document.documentElement.dataset.uiColor = "custom";
    document.documentElement.style.setProperty("--ui-accent-base", accent);
    if (!storedTheme) {
      window.localStorage.setItem(themeStorageKey, theme);
    }
  } catch (error) {
    document.documentElement.dataset.uiTheme = "dark";
    document.documentElement.dataset.uiColor = "custom";
    document.documentElement.style.setProperty("--ui-accent-base", "#3f7b58");
  }
})();
`;

const publicSans = Public_Sans({
  variable: "--font-public-sans",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700", "800"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700", "800"],
});

const robotoCondensed = Roboto_Condensed({
  variable: "--font-roboto-condensed",
  subsets: ["latin", "latin-ext"],
  weight: ["500", "600", "700"],
});

export const metadata: Metadata = {
  applicationName: "BOS - Bayi Otomasyon Sistemi",
  title: "BOS - Bayi Otomasyon Sistemi",
  description: "BOS bayi ve operasyon paneli",
  manifest: "/manifest.json?v=20260825-mobile-pwa",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "BOS",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [
      { url: "/pwa/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/pwa/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/pwa/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  other: {
    "mobile-web-app-capable": "yes",
    "apple-mobile-web-app-capable": "yes",
    "apple-mobile-web-app-title": "BOS",
    "apple-mobile-web-app-status-bar-style": "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#07150f",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="tr" suppressHydrationWarning data-ui-theme="dark" data-ui-color="custom">
      <head>
        <link rel="manifest" href="/manifest.json?v=20260825-mobile-pwa" />
        <link rel="apple-touch-icon" href="/pwa/apple-touch-icon.png" />
        <script dangerouslySetInnerHTML={{ __html: uiThemeScript }} />
      </head>
      <body
        suppressHydrationWarning
        className={`${publicSans.variable} ${inter.variable} ${robotoCondensed.variable} font-sans antialiased`}
      >
        <ReactQueryProvider>
          <AppProvider>{children}</AppProvider>
          <Toaster richColors position="top-right" closeButton />
        </ReactQueryProvider>
      </body>
    </html>
  );
}
