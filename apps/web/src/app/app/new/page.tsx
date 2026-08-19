import type { Metadata } from "next";

import { Workstation } from "@/components/workstation";

export const metadata: Metadata = { title: "New preflight | Lumos" };

export default function NewPreflightPage() {
  return <Workstation view="request" />;
}
