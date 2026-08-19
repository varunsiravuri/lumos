import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lumos | Graph-native context for coding agents",
  description:
    "Lumos uses HydraDB to find the files, proof chains, and tests a coding agent needs before it edits your repository.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className="min-h-[100dvh] bg-background font-sans text-foreground antialiased">{children}</body>
    </html>
  );
}
