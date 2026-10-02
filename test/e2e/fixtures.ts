import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect } from "@playwright/test";
import { createServer } from "../../src/server.ts";

export const test = base.extend<{
	app: {
		url: string;
		folder: string;
		failModel: (kind?: "http" | "network") => void;
		disconnectClients: () => void;
		restart: () => Promise<void>;
		holdModel: () => { entered: Promise<void>; release: () => void };
	};
}>({
	app: async ({ browserName: _browserName }, use) => {
		process.env.OPENROUTER_API_KEY = "test";
		process.env.OPENROUTER_MODEL = "test";
		const folder = await mkdtemp(join(tmpdir(), "agent-e2e-"));
		let fail: "http" | "network" | null = null;
		const failModel = (kind: "http" | "network" = "http") => {
			fail = kind;
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
		const originalHome = process.env.HOME;
		process.env.HOME = folder;
		const start = () =>
			createServer(
				async () => {
					if (fail) {
						const failure = fail;
						fail = null;
						if (failure === "network") throw new Error("network disconnected");
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
				join(folder, "db.sqlite"),
			).listen(0, "127.0.0.1");
		let server = start();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Missing test server address");
		try {
			const app = {
				url: `http://127.0.0.1:${address.port}`,
				folder,
				holdModel,
				failModel,
				disconnectClients: () => server.closeAllConnections(),
				restart: async () => {
					server.closeAllConnections();
					await new Promise<void>((resolve) => server.close(() => resolve()));
					server = start();
					await new Promise<void>((resolve) =>
						server.once("listening", resolve),
					);
					const address = server.address();
					if (!address || typeof address === "string")
						throw new Error("Missing restarted server address");
					app.url = `http://127.0.0.1:${address.port}`;
				},
			};
			await use(app);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(folder, { recursive: true, force: true });
		}
	},
});
export { expect };
