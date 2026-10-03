import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect } from "@playwright/test";
import { openDatabase } from "../../src/database.ts";
import { createServer } from "../../src/server.ts";

export const test = base.extend<{
	app: {
		url: string;
		folder: string;
		failModel: (kind?: "http" | "network", body?: string) => void;
		disconnectClients: () => void;
		restart: () => Promise<void>;
		holdModel: () => { entered: Promise<void>; release: () => void };
		rawStreamModel: () => { push: (text: string) => void; end: () => void };
		streamModel: () => { entered: Promise<void>; release: () => void };
	};
}>({
	app: async ({ browserName: _browserName }, use) => {
		const folder = await mkdtemp(join(tmpdir(), "agent-e2e-"));
		const configured = openDatabase(join(folder, "db.sqlite"), false);
		configured
			.prepare("INSERT INTO managed_models(id,name,metadata) VALUES(?,?,?)")
			.run(
				"test",
				"Test",
				JSON.stringify({
					reasoningRequired: false,
					catalogMissing: false,
					supportedEfforts: ["low", "high"],
				}),
			);
		configured
			.prepare("UPDATE settings SET api_key=?,default_model_id=? WHERE id=1")
			.run("test", "test");
		configured.close();
		let fail: "http" | "network" | null = null;
		let failedBody = "upstream failure";
		const failModel = (
			kind: "http" | "network" = "http",
			body = "upstream failure",
		) => {
			failedBody = body;
			fail = kind;
		};
		let gate: { entered: () => void; wait: Promise<void> } | undefined;
		let streamGate: { entered: () => void; wait: Promise<void> } | undefined;
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
		function streamModel() {
			const held = holdModel();
			streamGate = gate;
			gate = undefined;
			return held;
		}
		let rawStream: ReadableStream<Uint8Array> | undefined;
		function rawStreamModel() {
			let controller!: ReadableStreamDefaultController<Uint8Array>;
			rawStream = new ReadableStream({
				start(value) {
					controller = value;
				},
			});
			return {
				push: (text: string) =>
					controller.enqueue(new TextEncoder().encode(text)),
				end: () => controller.close(),
			};
		}
		const originalHome = process.env.HOME;
		process.env.HOME = folder;
		const start = () =>
			createServer(
				async () => {
					if (rawStream) {
						const body = rawStream;
						rawStream = undefined;
						return new Response(body, {
							headers: { "content-type": "text/event-stream" },
						});
					}
					if (fail) {
						const failure = fail;
						fail = null;
						if (failure === "network") throw new Error("network disconnected");
						return new Response(failedBody, { status: 500 });
					}
					const current = gate;
					gate = undefined;
					if (current) {
						current.entered();
						await current.wait;
					}
					const streaming = streamGate;
					streamGate = undefined;
					const output = [
						{
							id: "answer",
							type: "message",
							content: [{ type: "output_text", text: "Test answer" }],
						},
					];
					const encoder = new TextEncoder();
					const body = new ReadableStream<Uint8Array>({
						async start(controller) {
							const send = (type: string, value: object) =>
								controller.enqueue(
									encoder.encode(
										`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`,
									),
								);
							if (streaming) {
								send("response.output_item.added", {
									output_index: 0,
									item: { id: "answer", type: "message", content: [] },
								});
								send("response.output_text.delta", {
									item_id: "answer",
									output_index: 0,
									content_index: 0,
									delta: "Test ",
								});
								streaming.entered();
								await streaming.wait;
								send("response.output_text.delta", {
									item_id: "answer",
									output_index: 0,
									content_index: 0,
									delta: "answer",
								});
							}
							send("response.completed", {
								response: { status: "completed", output },
							});
							controller.close();
						},
					});
					return new Response(body, {
						headers: { "content-type": "text/event-stream" },
					});
				},
				join(folder, "db.sqlite"),
				async () =>
					Response.json({
						data: [
							{
								id: "test",
								name: "Test",
								architecture: { output_modalities: ["text"] },
								supported_parameters: ["reasoning"],
								reasoning: { supported_efforts: ["low", "high"] },
							},
							{
								id: "second",
								name: "Second",
								architecture: { output_modalities: ["text"] },
							},
						],
					}),
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
				streamModel,
				rawStreamModel,
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
