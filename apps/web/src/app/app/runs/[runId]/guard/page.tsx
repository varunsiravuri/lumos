import type { Metadata } from "next";

import { Workstation } from "@/components/workstation";

export const metadata: Metadata = { title: "Patch Guard | Lumos" };

export default async function PatchGuardPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return <Workstation view="guard" runId={runId} />;
}
