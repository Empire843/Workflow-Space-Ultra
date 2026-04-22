import type { Metadata } from "next";

import Toaster from "@/components/common/Toaster";

import "./globals.css";

export const metadata: Metadata = {
  title: "Workflow Space Ultra",
  description: "Node-based AI workflow canvas with VEO 3 Ultra + Grok Imagine",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
