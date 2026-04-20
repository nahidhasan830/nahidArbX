import { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        disallow: [
          "/api/",
          "/login",
          "/value-bets",
          "/setup-password",
          "/reset-password",
          "/forgot-password",
        ],
      },
    ],
    // Explicitly declare this is NOT a public website
    host: "https://nahidarbx.store",
  };
}
