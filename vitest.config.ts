import { defineConfig } from "vitest/config";

// Two projects are planned:
//  - "unit": pure logic and disk fixtures, runs in plain Node.
//  - "workers": agent and workflow tests inside workerd (added with the agent).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node"
        }
      }
    ]
  }
});
