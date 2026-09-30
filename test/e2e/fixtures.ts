import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect } from "@playwright/test";
import { createServer } from "../../src/server.ts";

export const test = base.extend<{
	app: {
		url: string;
		folder: string;
		failModel: () => void;
		holdModel: () => { entered: Promise<void>; release: () => void };
	};
}>({
	app: async ({ browserName: _browserName }, use) => {
		process.env.OPENROUTER_API_KEY = "test";
		process.env.OPENROUTER_MODEL = "test";
		const folder = await mkdtemp(join(tmpdir(), "agent-e2e-"));
		let fail = false;
		const failModel = () => {
			fail = true;
		};
		let gate: { entered: () => void; wait: Promise<void> } | undefined;
		function holdModel() {
			let enter!: () => void;
			let release!: () => void;
			const entered = new Promise<void>((resolve) => {
				enter = resolve;
			});
			const wait = new Promise<void>((resolve) => {
				release = resolve;
			});
			gate = { entered: enter, wait };
			return { entered, release };
		}
		const server = createServer(
			async () => {
				if (fail) {
					fail = false;
					return new Response("upstream failure", { status: 500 });
				}
				const current = gate;
				gate = undefined;
				if (current) {
					current.entered();
					await current.wait;
				}
				return Response.json({
					output: [
						{
							type: "message",
							content: [{ type: "output_text", text: "Test answer" }],
						},
					],
				});
			},
			false,
			join(folder, "db.sqlite"),
		).listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Missing test server address");
		try {
			await use({
				url: `http://127.0.0.1:${address.port}`,
				folder,
				holdModel,
				failModel,
			});
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(folder, { recursive: true, force: true });
		}
	},
});
export { expect };
