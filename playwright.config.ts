import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: "./test/e2e",
	workers: 1,
	use: { browserName: "chromium", trace: "retain-on-failure" },
	reporter: [["list"], ["html", { open: "never" }]],
});
