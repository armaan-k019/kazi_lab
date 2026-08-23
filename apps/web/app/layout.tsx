import type { Metadata } from "next";
import { IBM_Plex_Mono, Nunito } from "next/font/google";
import { cssVariables } from "@/lib/design-tokens";
import "./globals.css";

// ONE friendly sans for display and body: Nunito (rounded terminals, real
// warmth, clean at every size; playful without being a toy). Not a serif,
// not a corporate grotesk. IBM Plex Mono stays reserved for machine-computed
// values. Loaded through next/font: no FOUT, no external assets.
const nunito = Nunito({
  subsets: ["latin"],
  variable: "--font-nunito",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
});

export const metadata: Metadata = {
  title: "kazi lab",
  description: "applied CS for spatial reasoning",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${nunito.variable} ${plexMono.variable}`}>
      <head>
        {/* The design tokens, injected from the ONE token module. */}
        <style dangerouslySetInnerHTML={{ __html: cssVariables() }} />
      </head>
      <body className="min-h-screen bg-paper text-ink">
        <div className="relative z-10">{children}</div>
      </body>
    </html>
  );
}
