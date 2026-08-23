import type { Metadata, Viewport } from "next";
import "./globals.css";
import { firaSans, firaCode } from "./fonts";
import { I18nProvider } from "@/lib/i18n";
import { SessionProvider } from "@/lib/hooks/useSession";

export const metadata: Metadata = {
  title: "TriageGrid",
  description:
    "Real-time, offline-tolerant mass-casualty incident coordination",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#0a0e16",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${firaSans.variable} ${firaCode.variable}`}>
      <body>
        <I18nProvider>
          <SessionProvider>{children}</SessionProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
