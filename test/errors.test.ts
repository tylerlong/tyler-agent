import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "../src/server.ts";

test("HTTP errors provide stable identifiers independent of interface language", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-errors-"));
	const server = createServer(fetch, join(directory, "app.sqlite")).listen(
		0,
		"127.0.0.1",
	);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}`;
	try {
		for (const language of ["en", "zh-CN"]) {
			await fetch(`${url}/api/language`, {
				method: "PUT",
				body: JSON.stringify({ language }),
			});
			const response = await fetch(`${url}/api/projects`, {
				method: "POST",
				body: JSON.stringify({ name: "", folders: [] }),
			});
			assert.equal(response.status, 400);
			assert.deepEqual(await response.json(), {
				code: "nameRequired",
				error: "Name must not be empty",
			});
		}
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

test("HTTP model failures return concise errors and keep redacted bodies in communication records", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-model-errors-"));
	const oldKey = process.env.OPENROUTER_API_KEY;
	const oldModel = process.env.OPENROUTER_MODEL;
	process.env.OPENROUTER_API_KEY = 'secret"key';
	process.env.OPENROUTER_MODEL = "test-model";
	let failure = "upstream";
	const fake: typeof fetch = async () => {
		if (failure === "network") throw new Error('network secret"key');
		if (failure === "json") return new Response("upstream malformed body");
		if (failure === "empty") return Response.json({ output: [] });
		if (failure === "shape")
			return Response.json({
				output: [null, { type: "message", content: [null] }],
			});
		return new Response(
			JSON.stringify({ error: 'provider detail secret"key' }),
			{ status: 429 },
		);
	};
	const server = createServer(fake, join(directory, "app.sqlite")).listen(
		0,
		"127.0.0.1",
	);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}`;
	const post = (path: string, body: unknown) =>
		fetch(`${url}${path}`, { method: "POST", body: JSON.stringify(body) });
	try {
		const project = await (
			await post("/api/projects", { name: "P", folders: [] })
		).json();
		const chat = await (
			await post(`/api/projects/${project.id}/chats`, { name: "C" })
		).json();
		for (const [kind, code, details] of [
			["upstream", "modelRequestFailed", "HTTP 429"],
			["network", "modelRequestFailed", "Error: network [REDACTED]"],
			["json", "modelInvalidResponse", undefined],
			["empty", "modelNoAnswer", undefined],
			["shape", "modelNoAnswer", undefined],
		] as const) {
			failure = kind;
			const response = await post(`/api/chats/${chat.id}`, {
				prompt: "question",
			});
			assert.equal(response.status, 502);
			const body = await response.json();
			assert.equal(body.code, code);
			assert.equal(body.details, details);
			assert.doesNotMatch(
				JSON.stringify(body),
				/secret|provider detail|malformed body|output/,
			);
			const history = await (await fetch(`${url}/api/chats/${chat.id}`)).json();
			const calls = await (
				await fetch(
					`${url}/api/turns/${history.turns.at(-1).id}/calls?kind=response`,
				)
			).json();
			const expectedBodies = {
				upstream: '{"error":"provider detail [REDACTED]"}',
				network: null,
				json: "upstream malformed body",
				empty: '{"output":[]}',
				shape: '{"output":[null,{"type":"message","content":[null]}]}',
			};
			assert.equal(calls.calls[0].responseBody, expectedBodies[kind]);
			assert.doesNotMatch(JSON.stringify(calls), /secret/);
		}
		const history = await (await fetch(`${url}/api/chats/${chat.id}`)).json();
		assert.equal(history.turns.length, 5);
		assert(
			history.turns.every(
				(turn: { status: string }) => turn.status === "failed",
			),
		);
		assert.doesNotMatch(JSON.stringify(history), /secret/);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
		if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = oldKey;
		if (oldModel === undefined) delete process.env.OPENROUTER_MODEL;
		else process.env.OPENROUTER_MODEL = oldModel;
	}
});
