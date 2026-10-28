import type { MetadataRoute } from "next";

/** Web app manifest: lets learners install the LMS on their phone or desktop. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "LMS",
    short_name: "LMS",
    description: "Learning management system",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#171717",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
