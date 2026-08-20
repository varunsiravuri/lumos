import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Lumos",
    short_name: "Lumos",
    description: "Graph-native context for coding agents.",
    start_url: "/app/workspace",
    display: "standalone",
    background_color: "#f7fbfe",
    theme_color: "#dff3ff",
    icons: [
      {
        src: "/icon.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
