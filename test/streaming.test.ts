import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createServer } from "../src/server.ts";
import { completedBody, frame } from "./model-fixture.ts";

const item = (id: string, text: string) => ({
	id,
	type: "message",
	content: [{ type: "output_text", text }],
});
const delta = (text: string, index = 0, part = 0) =>
	frame("response.output_text.delta", {
		item_id: `m${index}`,
		output_index: index,
		content_index: part,
		delta: text,
	});

async function fixture(fake: typeof fetch) {
	process.env.OPENROUTER_API_KEY = "stream-secret";
	process.env.OPENROUTER_MODEL = "stream-fixture";
	const directory = await mkdtemp(join(tmpdir(), "agent-stream-"));
	const path = join(directory, "db.sqlite");
	let server = createServer(fake, path).listen(0, "127.0.0.1");
	let base = "";
	async function listening() {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		base = `http://127.0.0.1:${address.port}`;
	}
	await listening();
	const post = (route: string, body: unknown) =>
		fetch(base + route, {
			method: "POST",
			body: JSON.stringify(body),
		});
	const get = (route: string) =>
		fetch(base + route).then((response) => response.json());
	const project = await (
		await post("/api/projects", { name: "P", folders: [] })
	).json();
	const chat = await (
		await post(`/api/projects/${project.id}/chats`, { name: "C" })
	).json();
	const stop = async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	};
	return {
		path,
		chat,
		post,
		get,
		events: (signal: AbortSignal) => fetch(`${base}/api/events`, { signal }),
		restart: async () => {
			await stop();
			server = createServer(fake, path).listen(0, "127.0.0.1");
			await listening();
		},
		close: async () => {
			await stop();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

async function events(response: Response) {
	assert(response.body);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	return async () => {
		while (true) {
			while (!buffer.includes("\n\n")) {
				const chunk = await reader.read();
				assert(!chunk.done);
				buffer += decoder.decode(chunk.value, { stream: true });
			}
			const end = buffer.indexOf("\n\n");
			const value = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			if (value !== "data: changed") return value;
		}
	};
}

test("two clients read committed ordered UTF-8 increments before protocol completion, and snapshots do not duplicate", {
	timeout: 10000,
}, async () => {
	let stream!: ReadableStreamDefaultController<Uint8Array>;
	let requests = 0;
	const f = await fixture(async (_url, options) => {
		requests++;
		const body = JSON.parse(String(options?.body));
		assert.equal(body.stream, true);
		assert.equal(body.model, "stream-fixture");
		assert(!("tools" in body));
		return new Response(
			new ReadableStream({
				start(controller) {
					stream = controller;
				},
			}),
		);
	});
	const abort = new AbortController();
	try {
		const [a, b] = await Promise.all([
			f.events(abort.signal).then(events),
			f.events(abort.signal).then(events),
		]);
		assert.equal(await a(), ": connected");
		assert.equal(await b(), ": connected");
		const pending = f.post(`/api/chats/${f.chat.id}`, { prompt: "question" });
		const [acceptedA, acceptedB] = await Promise.all([a(), b()]);
		assert.equal(acceptedA, acceptedB);
		assert.match(acceptedA, /event: turn/);
		const notification = JSON.parse(acceptedA.split("data: ")[1]);
		assert.equal(notification.chatId, f.chat.id);
		const turnId = notification.turnId;
		assert.equal(
			(await f.get(`/api/turns/${turnId}`)).turns[0].status,
			"pending",
		);
		while (!stream) await new Promise((resolve) => setImmediate(resolve));
		const prefix =
			frame("response.output_item.added", {
				output_index: 0,
				item: item("m0", ""),
			}) + delta("中文");
		const bytes = new TextEncoder().encode(prefix);
		const split = bytes.indexOf(0xe4) + 1;
		stream.enqueue(bytes.slice(0, split));
		stream.enqueue(bytes.slice(split));
		let saved = await f.get(`/api/turns/${turnId}`);
		do {
			await a();
			saved = await f.get(`/api/turns/${turnId}`);
		} while (saved.turns[0].output[0]?.content[0]?.text !== "中文");
		assert.equal(saved.busy, true);
		const calls = (await f.get(`/api/turns/${turnId}/calls`)).calls;
		assert.equal(calls[0].responseBody, prefix);
		assert.match(await b(), /event: turn/);
		const suffix =
			delta(" second", 0, 1) +
			frame("response.output_item.added", {
				output_index: 1,
				item: { id: "m1", type: "message", content: [] },
			}) +
			frame("response.refusal.delta", {
				item_id: "m1",
				output_index: 1,
				content_index: 0,
				delta: "No",
			}) +
			frame("response.output_item.done", {
				output_index: 0,
				item: {
					...item("m0", "中文"),
					content: [
						{ type: "output_text", text: "中文" },
						{ type: "output_text", text: " second" },
					],
				},
			});
		stream.enqueue(new TextEncoder().encode(suffix));
		while ((await f.get(`/api/turns/${turnId}`)).turns[0].output.length < 2)
			await new Promise((resolve) => setImmediate(resolve));
		assert.equal(
			(await f.get(`/api/turns/${turnId}`)).turns[0].status,
			"pending",
		);
		const final = completedBody({
			output: [
				{
					...item("m0", "中文"),
					content: [
						{ type: "output_text", text: "中文" },
						{ type: "output_text", text: " second" },
					],
				},
				{
					id: "m1",
					type: "message",
					content: [{ type: "refusal", refusal: "No" }],
				},
			],
		});
		stream.enqueue(new TextEncoder().encode(final));
		stream.close();
		assert.equal((await pending).status, 200);
		const result = (await f.get(`/api/turns/${turnId}`)).turns[0];
		assert.equal(result.status, "succeeded");
		assert.deepEqual(
			result.output.map(
				(entry: { id: string; index: number; content: unknown }) => ({
					id: entry.id,
					index: entry.index,
					content: entry.content,
				}),
			),
			[
				{
					id: "m0",
					index: 0,
					content: [
						{ index: 0, type: "output_text", text: "中文" },
						{ index: 1, type: "output_text", text: " second" },
					],
				},
				{
					id: "m1",
					index: 1,
					content: [{ index: 0, type: "refusal", text: "No" }],
				},
			],
		);
		assert.equal(requests, 1);
	} finally {
		abort.abort();
		await f.close();
	}
});

test("failed, incomplete, DONE and truncated streams retain partial data and stay out of future context without retries", async () => {
	let raw = "";
	const inputs: unknown[] = [];
	const f = await fixture(async (_url, options) => {
		inputs.push(JSON.parse(String(options?.body)).input);
		return new Response(raw);
	});
	try {
		for (const terminal of [
			frame("response.failed", {
				response: { error: { message: "private provider body" } },
			}),
			frame("response.incomplete", { response: { output: [] } }),
			"data: [DONE]\n\n",
			"",
			"data: {broken",
		]) {
			raw = delta("partial") + terminal;
			const response = await f.post(`/api/chats/${f.chat.id}`, {
				prompt: "failed question",
			});
			assert.equal(response.status, 502);
			assert.doesNotMatch(
				JSON.stringify(await response.json()),
				/private provider body|broken/,
			);
			const history = await f.get(`/api/chats/${f.chat.id}`);
			const turn = history.turns.at(-1);
			assert.equal(turn.status, "failed");
			assert.equal(turn.output[0].content[0].text, "partial");
			assert.equal(history.busy, false);
			assert.equal(
				(await f.get(`/api/turns/${turn.id}/calls`)).calls[0].responseBody,
				raw,
			);
		}
		raw = completedBody({ output: [item("m0", "saved")] });
		assert.equal(
			(await f.post(`/api/chats/${f.chat.id}`, { prompt: "success" })).status,
			200,
		);
		assert.equal(
			(await f.post(`/api/chats/${f.chat.id}`, { prompt: "followup" })).status,
			200,
		);
		assert.deepEqual(inputs.at(-1), [
			{ role: "user", content: "success" },
			{ role: "assistant", content: "saved" },
			{ role: "user", content: "followup" },
		]);
		assert.equal(inputs.length, 7);
	} finally {
		await f.close();
	}
});

test("split credentials are redacted before storage; later failed writes retain durable partial state across restart", async () => {
	let stream!: ReadableStreamDefaultController<Uint8Array>;
	let requests = 0;
	const f = await fixture(async () => {
		requests++;
		return new Response(
			new ReadableStream({
				start(controller) {
					stream = controller;
				},
			}),
		);
	});
	const db = new DatabaseSync(f.path);
	try {
		db.exec(
			"CREATE TRIGGER reject_request BEFORE INSERT ON model_calls BEGIN SELECT RAISE(ABORT,'rejected'); END",
		);
		assert.equal(
			(await f.post(`/api/chats/${f.chat.id}`, { prompt: "not sent" })).status,
			500,
		);
		assert.equal(requests, 0);
		db.exec("DROP TRIGGER reject_request");
		const pending = f.post(`/api/chats/${f.chat.id}`, { prompt: "accepted" });
		while (!stream) await new Promise((resolve) => setImmediate(resolve));
		const raw =
			frame("unknown.event", { echo: "stream-secret" }) +
			delta("saved") +
			frame("response.output_item.added", {
				output_index: 1,
				item: {
					id: "stream-secret",
					type: "stream-secret",
					content: [{ type: "stream-secret", text: "stream-secret" }],
				},
			});
		const split = raw.indexOf("stream-secret") + 7;
		stream.enqueue(new TextEncoder().encode(raw.slice(0, split)));
		stream.enqueue(new TextEncoder().encode(raw.slice(split)));
		let turn = (await f.get(`/api/chats/${f.chat.id}`)).turns.at(-1);
		do {
			await new Promise((resolve) => setImmediate(resolve));
			turn = (await f.get(`/api/chats/${f.chat.id}`)).turns.at(-1);
		} while (turn.output[0]?.content[0]?.text !== "saved");
		const calls = (await f.get(`/api/turns/${turn.id}/calls`)).calls;
		assert.equal(
			calls[0].responseBody,
			raw.replaceAll("stream-secret", "[REDACTED]"),
		);
		assert.doesNotMatch(JSON.stringify(calls), /stream-secret/);
		assert.doesNotMatch(JSON.stringify(turn), /stream-secret/);
		assert.doesNotMatch(
			String(
				db.prepare("SELECT output_json FROM turns WHERE id=?").get(turn.id)
					?.output_json,
			),
			/stream-secret/,
		);
		db.exec(
			"CREATE TRIGGER reject_progress BEFORE UPDATE ON turns BEGIN SELECT RAISE(ABORT,'write rejected'); END",
		);
		stream.enqueue(new TextEncoder().encode(delta(" unsaved")));
		stream.close();
		assert.equal((await pending).status, 500);
		const retained = (await f.get(`/api/chats/${f.chat.id}`)).turns.at(-1);
		assert.equal(retained.status, "pending");
		assert.equal(retained.output[0].content[0].text, "saved");
		db.exec("DROP TRIGGER reject_progress");
		await f.restart();
		const history = await f.get(`/api/chats/${f.chat.id}`);
		assert.equal(history.busy, false);
		assert.equal(history.turns.at(-1).errorCode, "modelInterrupted");
		assert.equal(history.turns.at(-1).output[0].content[0].text, "saved");
		assert.equal(
			(await f.get(`/api/turns/${turn.id}/calls`)).calls[0].responseBody,
			calls[0].responseBody,
		);
		assert.equal(requests, 1);
	} finally {
		db.close();
		await f.close();
	}
});

test("a read error retains previously saved answer and raw SSE without retrying", {
	timeout: 10000,
}, async () => {
	let stream!: ReadableStreamDefaultController<Uint8Array>;
	let requests = 0;
	const f = await fixture(async () => {
		requests++;
		return new Response(
			new ReadableStream({
				start(controller) {
					stream = controller;
				},
			}),
		);
	});
	try {
		const pending = f.post(`/api/chats/${f.chat.id}`, { prompt: "question" });
		while (!stream) await new Promise((resolve) => setImmediate(resolve));
		const raw = delta("saved answer");
		stream.enqueue(new TextEncoder().encode(raw));
		let saved = (await f.get(`/api/chats/${f.chat.id}`)).turns.at(-1);
		while (saved.output[0]?.content[0]?.text !== "saved answer") {
			await new Promise((resolve) => setImmediate(resolve));
			saved = (await f.get(`/api/chats/${f.chat.id}`)).turns.at(-1);
		}
		stream.error(new Error("private upstream body stream-secret"));
		const response = await pending;
		assert.equal(response.status, 502);
		assert.doesNotMatch(
			JSON.stringify(await response.json()),
			/private upstream body|stream-secret/,
		);
		const history = await f.get(`/api/chats/${f.chat.id}`);
		assert.equal(history.busy, false);
		assert.equal(history.turns.at(-1).status, "failed");
		assert.equal(
			history.turns.at(-1).output[0].content[0].text,
			"saved answer",
		);
		const call = (await f.get(`/api/turns/${saved.id}/calls`)).calls[0];
		assert.equal(call.responseBody, raw);
		assert.equal(call.status, "failed");
		assert.doesNotMatch(call.error, /stream-secret/);
		assert.equal(requests, 1);
	} finally {
		await f.close();
	}
});
