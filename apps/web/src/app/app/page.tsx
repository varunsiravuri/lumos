import type { Metadata } from "next";
import { Suspense } from "react";

import { Workstation } from "@/components/workstation";

export const metadata: Metadata = { title: "Start | Lumos" };

export default function AppPage() {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-[#f5fbff]" />}>
      <Workstation view="welcome" />
    </Suspense>
  );
}
