import type { Metadata } from "next";

import { Workstation } from "@/components/workstation";

export const metadata: Metadata = { title: "Django demo | Lumos" };

export default function WorkspacePage() {
  return <Workstation view="overview" />;
}
