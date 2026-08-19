import type { Metadata } from "next";

import { Workstation } from "@/components/workstation";

export const metadata: Metadata = { title: "Evidence | Lumos" };

export default async function RunProofPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return <Workstation view="proof" runId={runId} />;
}
