import { Suspense } from "react";

import { Workstation } from "@/components/workstation";

export default function AppPage() {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-[#f5fbff]" />}>
      <Workstation />
    </Suspense>
  );
}
