import type { Metadata } from "next";

import { Workstation } from "@/components/workstation";

export const metadata: Metadata = { title: "Repositories | Lumos" };

export default function RepositoriesPage() {
  return <Workstation view="repositories" />;
}
