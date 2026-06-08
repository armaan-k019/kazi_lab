import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { PointField } from "@/components/point-field";
import "./globals.css";

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
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen bg-background text-text-primary">
        <PointField />
        <div className="relative z-10">{children}</div>
      </body>
    </html>
  );
}
