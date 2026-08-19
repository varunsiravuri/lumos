import type { Metadata } from "next";

import { Workstation } from "@/components/workstation";

export const metadata: Metadata = { title: "Connect agent | Lumos" };

export default function ConnectAgentPage() {
  return <Workstation view="connect" />;
}
