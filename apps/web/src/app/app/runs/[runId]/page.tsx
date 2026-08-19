import type { Metadata } from "next";

import { Workstation } from "@/components/workstation";

export const metadata: Metadata = { title: "Run summary | Lumos" };

export default async function RunSummaryPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return <Workstation view="live" runId={runId} />;
}
