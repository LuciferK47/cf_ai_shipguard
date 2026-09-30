import { cloudflareTest } from "@cloudflare/vitest-plugin";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";
import { createGithubMock } from "./test/helpers/github-mock.ts";

const github = createGithubMock();

// Two projects:
//  - "unit": pure logic and disk fixtures, runs in plain Node.
//  - "workers": the agent and the audit workflow running inside workerd, with
//    a fixture-backed fake GitHub and a mock Workers AI (test/workers/mock-ai.mjs).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node"
        }
      },
      {
        plugins: [
          agents(),
          cloudflareTest({
            main: "./src/server/index.ts",
            remoteBindings: false,
            wrangler: { configPath: "./test/workers/wrangler.jsonc" },
            miniflare: {
              serviceBindings: { AI: "mock-ai" },
              outboundService: github.handler,
              workers: [
                {
                  name: "mock-ai",
                  modules: true,
                  scriptPath: "./test/workers/mock-ai.mjs",
                  compatibilityDate: "2026-06-11"
                }
              ]
            }
          })
        ],
        test: {
          name: "workers",
          include: ["test/workers/**/*.test.ts"],
          testTimeout: 30_000
        }
      }
    ]
  }
});
