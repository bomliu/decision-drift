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
    // decisiondrift.dev is added with `railway domain` (custom domains cannot be registered from config)
  });

  return project("decision-drift", { resources: [collector, site] });
});
