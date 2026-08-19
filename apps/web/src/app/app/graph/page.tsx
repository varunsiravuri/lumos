import type { Metadata } from "next";

import { Workstation } from "@/components/workstation";

export const metadata: Metadata = { title: "Graph explorer | Lumos" };

export default function GraphExplorerPage() {
  return <Workstation view="graph" />;
}
