// Railway project for decisiondrift.dev. Plan with `railway config plan`; apply only after review.
import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  // Daily collector at 10:17 UTC. Code changes (not data commits) rebuild it.
  const collector = service("collector", {
    source: github("bomliu/decision-drift", { branch: "main" }),
    build: { builder: "DOCKERFILE", dockerfilePath: "deploy/collector.Dockerfile", watchPatterns: ["deploy/collector.Dockerfile", "scripts/collect.sh"] },
    deploy: { cronSchedule: "17 10 * * *", restartPolicyType: "NEVER" },
    env: { OPENROUTER_API_KEY: preserve(), GITHUB_TOKEN: preserve(), BUDGET_STOP: "22" },
    volumeMounts: { "/data": volume("collector-data", { sizeMB: 2048, region: "us-west2" }) },
  });

  // Static site, rebuilt on every push (each daily data commit included).
  const site = service("site", {
    source: github("bomliu/decision-drift", { branch: "main" }),
    build: { builder: "DOCKERFILE", dockerfilePath: "deploy/site.Dockerfile" },
    healthcheck: "/status.json",
    // Cookieless analytics on the self-hosted Umami (public values; they appear in every page).
    env: {
      UMAMI_SRC: "https://umami-production-fd66.up.railway.app/script.js",
      UMAMI_WEBSITE_ID: "dba030fe-7ca9-463d-b3a9-f68f061dd7c9",
    },
    // decisiondrift.dev is added with `railway domain` (custom domains cannot be registered from config)
  });

  return project("decision-drift", { resources: [collector, site] });
});
