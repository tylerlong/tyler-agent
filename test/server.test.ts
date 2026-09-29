import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createServer } from "../src/server.ts";

const directory = await mkdtemp(join(tmpdir(), "tyler-agent-"));
const file = join(directory, "note.txt");
await writeFile(file, "A teh example.");
after(() => rm(directory, { recursive: true, force: true }));

test("a prompt returns the model answer without sending the folder or changing files", async () => {
	const requests: Array<{ url: string; headers: Headers; body: unknown }> = [];
	const upstream: typeof fetch = async (input, init) => {
		requests.push({
			url: String(input),
			headers: new Headers(init?.headers),
			body: JSON.parse(String(init?.body)),
		});
		return Response.json({
			output: [
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "2" }],
				},
			],
		});
	};
	const server = createServer(upstream).listen(0, "127.0.0.1");
	const previousKey = process.env.OPENROUTER_API_KEY;
	const previousModel = process.env.OPENROUTER_MODEL;
	process.env.OPENROUTER_API_KEY = "test-key";
	process.env.OPENROUTER_MODEL = "test-model";
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		const page = await fetch(base);
		assert.equal(page.status, 200);
		const html = await page.text();
		assert.match(html, /name="folder"/);
		assert.match(html, /name="prompt"/);
		assert.match(html, /name="debug" value="false"/);
		assert.match(html, /name="debug" value="true"/);
		assert.match(html, /Tyler Agent/);

		const response = await fetch(`${base}/api/task`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ folder: directory, prompt: "1 + 1 = ?" }),
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { answer: "2" });
		assert.equal(requests.length, 1);
		assert.equal(requests[0]?.url, "https://openrouter.ai/api/v1/responses");
		assert.equal(requests[0]?.headers.get("authorization"), "Bearer test-key");
		assert.deepEqual(requests[0]?.body, {
			model: "test-model",
			input: [{ role: "user", content: "1 + 1 = ?" }],
			stream: false,
		});
		assert.equal(await readFile(file, "utf8"), "A teh example.");
	} finally {
		server.close();
		if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = previousKey;
		if (previousModel === undefined) delete process.env.OPENROUTER_MODEL;
		else process.env.OPENROUTER_MODEL = previousModel;
	}
});

test("successful turns form one shared conversation across requests and server instances", async () => {
	const previousKey = process.env.OPENROUTER_API_KEY;
	const previousModel = process.env.OPENROUTER_MODEL;
	process.env.OPENROUTER_API_KEY = "test-key";
	process.env.OPENROUTER_MODEL = "test-model";
	const sent: unknown[] = [];
	const answers = ["11", "22"];
	const upstream: typeof fetch = async (_url, init) => {
		sent.push(JSON.parse(String(init?.body)));
		return Response.json({
			output: [
				{
					type: "message",
					content: [{ type: "output_text", text: answers.shift() }],
				},
			],
		});
	};
	const server = createServer(upstream).listen(0, "127.0.0.1");
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		const getHistory = () =>
			fetch(`${base}/api/chat`).then((response) => response.json());
		const submit = (folder: string, prompt: string) =>
			fetch(`${base}/api/task`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ folder, prompt }),
			});
		assert.deepEqual(await getHistory(), { messages: [] });
		assert.deepEqual(await (await submit(directory, "5 + 6?")).json(), {
			answer: "11",
		});
		assert.deepEqual(await getHistory(), {
			messages: [
				{ role: "user", content: "5 + 6?" },
				{ role: "assistant", content: "11" },
			],
		});
		assert.deepEqual(await (await submit(tmpdir(), "double it?")).json(), {
			answer: "22",
		});
		assert.deepEqual(sent, [
			{
				model: "test-model",
				input: [{ role: "user", content: "5 + 6?" }],
				stream: false,
			},
			{
				model: "test-model",
				input: [
					{ role: "user", content: "5 + 6?" },
					{ role: "assistant", content: "11" },
					{ role: "user", content: "double it?" },
				],
				stream: false,
			},
		]);
		assert.deepEqual(await getHistory(), {
			messages: [
				{ role: "user", content: "5 + 6?" },
				{ role: "assistant", content: "11" },
				{ role: "user", content: "double it?" },
				{ role: "assistant", content: "22" },
			],
		});
		const failed = await submit(directory, "one more?");
		assert.equal(failed.status, 400);
		assert.deepEqual(await failed.json(), {
			error: "OpenRouter 没有返回文本答案",
		});
		assert.deepEqual(await getHistory(), {
			messages: [
				{ role: "user", content: "5 + 6?" },
				{ role: "assistant", content: "11" },
				{ role: "user", content: "double it?" },
				{ role: "assistant", content: "22" },
			],
		});
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = previousKey;
		if (previousModel === undefined) delete process.env.OPENROUTER_MODEL;
		else process.env.OPENROUTER_MODEL = previousModel;
	}
	const restarted = createServer(upstream).listen(0, "127.0.0.1");
	try {
		await new Promise<void>((resolve) => restarted.once("listening", resolve));
		const address = restarted.address();
		assert(address && typeof address !== "string");
		assert.deepEqual(
			await (await fetch(`http://127.0.0.1:${address.port}/api/chat`)).json(),
			{ messages: [] },
		);
	} finally {
		restarted.close();
	}
});

test("debug setting is shared by clients, resets with server, and logs a successful exchange without credentials", async () => {
	const secret = 'fake"secret-for-debug';
	const previousKey = process.env.OPENROUTER_API_KEY;
	const previousModel = process.env.OPENROUTER_MODEL;
	process.env.OPENROUTER_API_KEY = secret;
	process.env.OPENROUTER_MODEL = "test-model";
	const logs: string[] = [];
	const originalLog = console.log;
	console.log = (...values) => {
		logs.push(values.join(" "));
	};
	const upstream: typeof fetch = async () =>
		new Response(
			JSON.stringify({
				output: [
					{ type: "message", content: [{ type: "output_text", text: "2" }] },
				],
				echo: secret,
			}),
			{
				status: 200,
				headers: {
					"content-type": "application/json",
					"x-example": "raw-header",
					"x-token-count": "42",
					authorization: "Bearer another-token",
					"x-api-key": "different-secret",
				},
			},
		);
	const server = createServer(upstream).listen(0, "127.0.0.1");
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		assert.deepEqual(await (await fetch(`${base}/api/debug`)).json(), {
			enabled: false,
		});
		const submit = () =>
			fetch(`${base}/api/task`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ folder: directory, prompt: "1 + 1 = ?" }),
			});
		assert.deepEqual(await (await submit()).json(), { answer: "2" });
		assert.equal(logs.length, 0);
		assert.deepEqual(
			await (
				await fetch(`${base}/api/debug`, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ enabled: true }),
				})
			).json(),
			{ enabled: true },
		);
		assert.deepEqual(await (await fetch(`${base}/api/debug`)).json(), {
			enabled: true,
		});
		const invalid = await fetch(`${base}/api/debug`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: "false" }),
		});
		assert.equal(invalid.status, 400);
		assert.deepEqual(await (await fetch(`${base}/api/debug`)).json(), {
			enabled: true,
		});
		assert.deepEqual(await (await submit()).json(), { answer: "2" });
		const record = logs.join("\n");
		assert.match(record, /\[OpenRouter #1\] request\n\{/);
		assert.match(record, /https:\/\/openrouter\.ai\/api\/v1\/responses/);
		assert.match(record, /"method": "POST"/);
		assert.match(record, /body:\n\{\n {2}"model": "test-model"/);
		assert.match(record, /1 \+ 1 = \?/);
		assert.match(record, /"role": "assistant",\n\s+"content": "2"/);
		assert.match(record, /"status": 200/);
		assert.match(record, /body:\n\{\n {2}"output": \[/);
		assert.match(record, /output_text/);
		assert.match(record, /"durationMs": /);
		assert.match(record, /\[REDACTED\]/);
		assert.doesNotMatch(
			record,
			/"headers":|raw-header|x-token-count|x-api-key/,
		);
		assert.doesNotMatch(record, new RegExp(secret));
		assert.equal(record.includes(JSON.stringify(secret).slice(1, -1)), false);
		assert.equal(record.includes("another-token"), false);
		assert.equal(record.includes("different-secret"), false);
		assert.deepEqual(
			await (
				await fetch(`${base}/api/debug`, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ enabled: false }),
				})
			).json(),
			{ enabled: false },
		);
		const count = logs.length;
		await submit();
		assert.equal(logs.length, count);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		console.log = originalLog;
		if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = previousKey;
		if (previousModel === undefined) delete process.env.OPENROUTER_MODEL;
		else process.env.OPENROUTER_MODEL = previousModel;
	}
	const restarted = createServer(upstream).listen(0, "127.0.0.1");
	try {
		await new Promise<void>((resolve) => restarted.once("listening", resolve));
		const address = restarted.address();
		assert(address && typeof address !== "string");
		assert.deepEqual(
			await (await fetch(`http://127.0.0.1:${address.port}/api/debug`)).json(),
			{ enabled: false },
		);
	} finally {
		restarted.close();
	}
});

test("debug can start enabled", async () => {
	const server = createServer(fetch, true).listen(0, "127.0.0.1");
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		assert.deepEqual(
			await (await fetch(`http://127.0.0.1:${address.port}/api/debug`)).json(),
			{ enabled: true },
		);
	} finally {
		server.close();
	}
});

test("invalid folders are rejected before the model request", async () => {
	let requests = 0;
	const server = createServer(async () => {
		requests++;
		throw new Error("model should not be called");
	}).listen(0, "127.0.0.1");
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		for (const [folder, message] of [
			[join(directory, "missing"), "目标文件夹不存在"],
			[file, "目标路径不是文件夹"],
		]) {
			const response: Response = await fetch(
				`http://127.0.0.1:${address.port}/api/task`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ folder, prompt: "1 + 1 = ?" }),
				},
			);
			assert.equal(response.status, 400);
			assert.deepEqual(await response.json(), { error: message });
		}
		assert.equal(requests, 0);
		assert.equal(await readFile(file, "utf8"), "A teh example.");
	} finally {
		server.close();
	}
});

test("configuration and upstream failures return safe errors without touching the folder", async () => {
	const secret = "test-secret-never-return";
	const upstreamBody = `private upstream details ${secret}`;
	let requests = 0;
	const sentBodies: string[] = [];
	let upstream: () => Promise<Response> = async () => Response.json({});
	const server = createServer(async (_input, init) => {
		requests++;
		sentBodies.push(String(init?.body));
		return upstream();
	}).listen(0, "127.0.0.1");
	const previousKey = process.env.OPENROUTER_API_KEY;
	const previousModel = process.env.OPENROUTER_MODEL;
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		const submit = () =>
			fetch(`http://127.0.0.1:${address.port}/api/task`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ folder: directory, prompt: "1 + 1 = ?" }),
			});
		const expectError = async (message: string) => {
			const response = await submit();
			assert.equal(response.status, 400);
			const body = await response.text();
			assert.equal(body === JSON.stringify({ error: message }), true);
			assert.equal(
				body.includes(secret) || body.includes("private upstream details"),
				false,
			);
		};

		delete process.env.OPENROUTER_API_KEY;
		process.env.OPENROUTER_MODEL = "test-model";
		await expectError("OpenRouter 配置缺失");
		process.env.OPENROUTER_API_KEY = secret;
		delete process.env.OPENROUTER_MODEL;
		await expectError("OpenRouter 配置缺失");
		assert.equal(requests, 0);

		process.env.OPENROUTER_MODEL = "test-model";
		upstream = async () => new Response(upstreamBody, { status: 500 });
		await expectError("OpenRouter 请求失败");
		upstream = async () => {
			throw new Error(upstreamBody);
		};
		await expectError("请求失败");
		upstream = async () => new Response(upstreamBody, { status: 200 });
		await expectError("请求失败");
		upstream = async () =>
			Response.json({
				output: [
					{ type: "message", content: [{ type: "output_text", text: "  " }] },
				],
			});
		await expectError("OpenRouter 没有返回文本答案");
		assert.equal(requests, 4);
		assert.equal(
			sentBodies.every(
				(body) =>
					body ===
					JSON.stringify({
						model: "test-model",
						input: [{ role: "user", content: "1 + 1 = ?" }],
						stream: false,
					}),
			),
			true,
		);
		assert.deepEqual(
			await (await fetch(`http://127.0.0.1:${address.port}/api/chat`)).json(),
			{ messages: [] },
		);
		assert.equal(await readFile(file, "utf8"), "A teh example.");
	} finally {
		server.close();
		if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = previousKey;
		if (previousModel === undefined) delete process.env.OPENROUTER_MODEL;
		else process.env.OPENROUTER_MODEL = previousModel;
	}
});

test("debug logs failed and concurrent calls with their starting setting and no credentials", async () => {
	const secret = "fake-debug-key";
	const previousKey = process.env.OPENROUTER_API_KEY;
	const previousModel = process.env.OPENROUTER_MODEL;
	process.env.OPENROUTER_API_KEY = secret;
	process.env.OPENROUTER_MODEL = "test-model";
	const logs: string[] = [];
	const originalLog = console.log;
	console.log = (...values) => {
		logs.push(values.join(" "));
	};
	const pending = new Map<string, (response: Response) => void>();
	let upstreamCalls = 0;
	const upstream: typeof fetch = async (_url, init) => {
		upstreamCalls++;
		const lastInput = (
			JSON.parse(String(init?.body)) as { input: Array<{ content: string }> }
		).input.at(-1);
		assert(lastInput);
		const prompt = lastInput.content;
		if (prompt === "network") throw new Error(`network failed with ${secret}`);
		if (prompt === "bad json")
			return new Response("invalid JSON", { status: 200 });
		if (prompt === "read failure")
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.error(new Error(`body failed with ${secret}`));
					},
				}),
				{ status: 206, headers: { "x-token-count": "42" } },
			);
		return new Promise<Response>((resolve) => {
			pending.set(prompt, resolve);
		});
	};
	const server = createServer(upstream).listen(0, "127.0.0.1");
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		const toggle = (enabled: boolean) =>
			fetch(`${base}/api/debug`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ enabled }),
			});
		const submit = (prompt: string) =>
			fetch(`${base}/api/task`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ folder: directory, prompt }),
			});
		const waitFor = async (prompt: string) => {
			while (!pending.has(prompt))
				await new Promise((resolve) => setTimeout(resolve, 1));
			const resolve = pending.get(prompt);
			assert(resolve);
			return resolve;
		};
		await toggle(true);
		assert.deepEqual(
			await (
				await fetch(`${base}/api/task`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						folder: join(directory, "missing"),
						prompt: "invalid folder",
					}),
				})
			).json(),
			{ error: "目标文件夹不存在" },
		);
		delete process.env.OPENROUTER_API_KEY;
		assert.deepEqual(await (await submit("missing key")).json(), {
			error: "OpenRouter 配置缺失",
		});
		process.env.OPENROUTER_API_KEY = secret;
		assert.equal(logs.length, 0);
		assert.equal(upstreamCalls, 0);
		const first = submit("first");
		const second = submit("second");
		const resolveFirst = await waitFor("first");
		const resolveSecond = await waitFor("second");
		await toggle(false);
		resolveSecond(
			new Response(`failure ${secret}`, {
				status: 502,
				headers: { "x-debug": secret },
			}),
		);
		resolveFirst(
			Response.json({
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: "first answer" }],
					},
				],
			}),
		);
		assert.deepEqual(await (await first).json(), { answer: "first answer" });
		assert.deepEqual(await (await second).json(), {
			error: "OpenRouter 请求失败",
		});
		assert.equal(upstreamCalls, 2);
		const requestLines = logs.filter((line) => line.includes("] request\n"));
		const responseLines = logs.filter((line) => line.includes("] response\n"));
		assert.equal(requestLines.length, 2);
		assert.equal(responseLines.length, 2);
		const firstId = /\[OpenRouter #(\d+)\]/.exec(
			requestLines.find((line) => line.includes("first")) ?? "",
		)?.[1];
		const secondId = /\[OpenRouter #(\d+)\]/.exec(
			requestLines.find((line) => line.includes("second")) ?? "",
		)?.[1];
		assert(firstId && secondId && firstId !== secondId);
		const firstResponse = responseLines.find((line) =>
			line.includes(`#${firstId}]`),
		);
		const secondResponse = responseLines.find((line) =>
			line.includes(`#${secondId}]`),
		);
		assert(firstResponse && secondResponse);
		assert.match(firstResponse, /first answer/);
		assert.match(secondResponse, /"status": 502/);
		assert.match(secondResponse, /body:\nfailure \[REDACTED\]/);
		assert.doesNotMatch(logs.join("\n"), /"headers":|x-debug/);
		assert.equal(logs.join("\n").includes(secret), false);
		const count = logs.length;
		const unlogged = submit("unlogged");
		(await waitFor("unlogged"))(
			Response.json({
				output: [
					{ type: "message", content: [{ type: "output_text", text: "done" }] },
				],
			}),
		);
		assert.deepEqual(await (await unlogged).json(), { answer: "done" });
		assert.equal(logs.length, count);
		assert.equal(upstreamCalls, 3);
		await toggle(true);
		assert.deepEqual(await (await submit("network")).json(), {
			error: "请求失败",
		});
		assert.deepEqual(await (await submit("bad json")).json(), {
			error: "请求失败",
		});
		assert.deepEqual(await (await submit("read failure")).json(), {
			error: "请求失败",
		});
		assert.match(logs.join("\n"), /network failed with \[REDACTED\]/);
		assert.match(logs.join("\n"), /body:\ninvalid JSON/);
		const readFailure = logs.find((line) =>
			line.includes("body failed with [REDACTED]"),
		);
		assert(readFailure);
		assert.match(readFailure, /\] error\n/);
		assert.match(readFailure, /"status": 206/);
		assert.doesNotMatch(readFailure, /x-token-count/);
		assert.equal(logs.join("\n").includes(secret), false);
		assert.equal(upstreamCalls, 6);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		console.log = originalLog;
		if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = previousKey;
		if (previousModel === undefined) delete process.env.OPENROUTER_MODEL;
		else process.env.OPENROUTER_MODEL = previousModel;
	}
});
