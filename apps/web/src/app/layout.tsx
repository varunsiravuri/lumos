import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://lumos.uno"),
  title: "Lumos | Graph-native context for coding agents",
  description:
    "Lumos uses HydraDB to find the files, proof chains, and tests a coding agent needs before it edits your repository.",
  applicationName: "Lumos",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-icon.png", type: "image/png", sizes: "180x180" }],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className="min-h-[100dvh] bg-background font-sans text-foreground antialiased">{children}</body>
    </html>
  );
}
