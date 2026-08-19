import type { Metadata } from "next";

import { Workstation } from "@/components/workstation";

export const metadata: Metadata = { title: "Run library | Lumos" };

export default function RunLibraryPage() {
  return <Workstation view="runs" />;
}
