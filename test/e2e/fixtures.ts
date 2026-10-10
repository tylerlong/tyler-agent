import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type APIRequestContext, test as base, expect } from "@playwright/test";
import { openDatabase } from "../../src/database.ts";
import { executeTool, type ToolExecution } from "../../src/file-tools.ts";
import { managementTokens } from "../local-fetch.ts";
import { createServer } from "../server-fixture.ts";

export const test = base.extend<{
	app: {
		url: string;
		setCatalog: (
			models: {
				id: string;
				name: string;
				reasoning?: { supported_efforts: string[] };
			}[],
		) => void;
		folder: string;
		failModel: (kind?: "http" | "network", body?: string) => void;
		disconnectClients: () => void;
		restart: () => Promise<void>;
		holdTool: (result: ToolExecution) => {
			entered: Promise<void>;
			release: () => void;
		};
		holdModel: () => { entered: Promise<void>; release: () => void };
		rawStreamModel: () => { push: (text: string) => void; end: () => void };
		streamModel: () => { entered: Promise<void>; release: () => void };
	};
}>({
	page: async ({ page, context, request, app: _app }, use) => {
		// page.request is an API client too; browser networking remains untouched.
		const configurePage = (value: typeof page) =>
			Object.defineProperty(value, "request", {
				value: request,
				configurable: true,
			});
		for (const value of context.pages()) configurePage(value);
		context.on("page", configurePage);
		Object.defineProperty(context, "request", {
			value: request,
			configurable: true,
		});
		await use(page);
		context.off("page", configurePage);
	},
	request: async ({ playwright }, use) => {
		const client = await playwright.request.newContext();
		// Only programmatic API clients supply Origin here; browser requests use it natively.
		const request = new Proxy(client, {
			get(target, key) {
				if (
					["get", "head", "post", "put", "patch", "delete", "fetch"].includes(
						String(key),
					)
				)
					return (
						url: string,
						options: { headers?: Record<string, string> } = {},
					) =>
						target[key as "fetch"](url, {
							...options,
							headers: {
								Origin: new URL(url).origin,
								"x-tyler-management-token":
									managementTokens.get(new URL(url).origin) ?? "",
								...options.headers,
							},
						});
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as APIRequestContext;
		try {
			await use(request);
		} finally {
			await client.dispose();
		}
	},
	app: async ({ browserName: _browserName, context }, use) => {
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
			.run("zkey", "test");
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
		const toolQueue: {
			result: ToolExecution;
			entered: () => void;
			wait: Promise<void>;
		}[] = [];
		function holdTool(result: ToolExecution) {
			let entered!: () => void;
			let release!: () => void;
			const started = new Promise<void>((resolve) => (entered = resolve));
			const wait = new Promise<void>((resolve) => (release = resolve));
			toolQueue.push({ result, entered, wait });
			return { entered: started, release };
		}
		const rawStreams: ReadableStream<Uint8Array>[] = [];
		function rawStreamModel() {
			let controller!: ReadableStreamDefaultController<Uint8Array>;
			rawStreams.push(
				new ReadableStream({
					start(value) {
						controller = value;
					},
				}),
			);
			return {
				push: (text: string) =>
					controller.enqueue(new TextEncoder().encode(text)),
				end: () => controller.close(),
			};
		}
		let catalogModels = [
			{
				id: "test",
				name: "Test",
				reasoning: { supported_efforts: ["low", "high"] },
			},
			{ id: "second", name: "Second" },
		];
		const originalHome = process.env.HOME;
		process.env.HOME = folder;
		const initializeToken = async (url: string) =>
			context.addInitScript(
				({ url, token }) => {
					if (location.origin === url && token)
						sessionStorage.setItem("tyler-management-token", token);
				},
				{ url, token: managementTokens.get(url) },
			);
		const start = () =>
			createServer(
				async () => {
					const rawStream = rawStreams.shift();
					if (rawStream) {
						const body = rawStream;
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
						data: catalogModels.map((model) => ({
							...model,
							architecture: { output_modalities: ["text"] },
						})),
					}),
				async (name, args, roots) => {
					const next = toolQueue.shift();
					if (!next) return executeTool(name, args, roots);
					next.entered();
					await next.wait;
					return next.result;
				},
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
				setCatalog: (models: typeof catalogModels) => {
					catalogModels = models;
				},
				folder,
				holdModel,
				holdTool,
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
					await initializeToken(app.url);
				},
			};
			await initializeToken(app.url);
			await use(app);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(folder, { recursive: true, force: true });
		}
	},
});
export { expect };
