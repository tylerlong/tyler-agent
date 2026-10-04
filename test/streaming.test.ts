import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createTestServer as createServer } from "./config-fixture.ts";
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
	const directory = await mkdtemp(join(tmpdir(), "agent-stream-"));
	const path = join(directory, "db.sqlite");
	let server = createServer(
		fake,
		path,
		"stream-secret",
		"stream-fixture",
	).listen(0, "127.0.0.1");
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
			server = createServer(
				fake,
				path,
				"stream-secret",
				"stream-fixture",
			).listen(0, "127.0.0.1");
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
		assert.equal(body.tools[0].name, "count_files");
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
		const pending = f.post(`/api/chats/${f.chat.id}`, {
			modelId: "stream-fixture",
			prompt: "question",
		});
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
				modelId: "stream-fixture",
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
			(
				await f.post(`/api/chats/${f.chat.id}`, {
					modelId: "stream-fixture",
					prompt: "success",
				})
			).status,
			200,
		);
		assert.equal(
			(
				await f.post(`/api/chats/${f.chat.id}`, {
					modelId: "stream-fixture",
					prompt: "followup",
				})
			).status,
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
			(
				await f.post(`/api/chats/${f.chat.id}`, {
					modelId: "stream-fixture",
					prompt: "not sent",
				})
			).status,
			500,
		);
		assert.equal(requests, 0);
		db.exec("DROP TRIGGER reject_request");
		const pending = f.post(`/api/chats/${f.chat.id}`, {
			modelId: "stream-fixture",
			prompt: "accepted",
		});
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

for (const httpStatus of [200, 503])
	test(`a ${httpStatus} read error retains saved content and raw communication without retrying`, {
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
				{ status: httpStatus },
			);
		});
		try {
			const pending = f.post(`/api/chats/${f.chat.id}`, {
				modelId: "stream-fixture",
				prompt: "question",
			});
			while (!stream) await new Promise((resolve) => setImmediate(resolve));
			const raw =
				httpStatus === 200
					? delta("saved answer")
					: "partial stream-secret body";
			stream.enqueue(new TextEncoder().encode(raw));
			let saved = (await f.get(`/api/chats/${f.chat.id}`)).turns.at(-1);
			while (
				(await f.get(`/api/turns/${saved.id}/calls`)).calls[0].responseBody !==
				raw.replaceAll("stream-secret", "[REDACTED]")
			) {
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
				history.turns.at(-1).output[0]?.content[0]?.text,
				httpStatus === 200 ? "saved answer" : undefined,
			);
			const call = (await f.get(`/api/turns/${saved.id}/calls`)).calls[0];
			assert.equal(
				call.responseBody,
				raw.replaceAll("stream-secret", "[REDACTED]"),
			);
			assert.equal(call.httpStatus, httpStatus);
			assert.equal(call.status, "failed");
			assert.doesNotMatch(call.error, /stream-secret/);
			assert.equal(requests, 1);
		} finally {
			await f.close();
		}
	});

test("thinking summaries stay lazy while ordered parent-typed body and summaries persist live and after failure", async () => {
	let stream!: ReadableStreamDefaultController<Uint8Array>;
	const f = await fixture(
		async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						stream = controller;
					},
				}),
			),
	);
	const thinking = (index: number, text: string) =>
		frame("response.output_item.added", {
			output_index: index,
			item: {
				id: `r${index}`,
				type: "reasoning",
				content: [{ type: "output_text", text }],
				summary: [{ type: "summary_text", text: "brief" }],
			},
		});
	try {
		const pending = f.post(`/api/chats/${f.chat.id}`, {
			modelId: "stream-fixture",
			prompt: "think",
		});
		while (!stream) await new Promise((resolve) => setImmediate(resolve));
		stream.enqueue(
			new TextEncoder().encode(
				thinking(0, "body") +
					delta("answer one", 1) +
					thinking(2, "later body") +
					delta("answer two", 3, 0) +
					delta("second part", 3, 1) +
					frame("response.output_item.added", {
						output_index: 4,
						item: {
							id: "encrypted",
							type: "reasoning",
							content: [{ type: "encrypted", text: "ciphertext" }],
						},
					}),
			),
		);
		let history = await f.get(`/api/chats/${f.chat.id}`);
		while (history.turns[0]?.output.length !== 5) {
			await new Promise((resolve) => setImmediate(resolve));
			history = await f.get(`/api/chats/${f.chat.id}`);
		}
		const id = history.turns[0].id;
		const ordered = history.turns[0].output;
		assert.deepEqual(
			ordered.map((item: { type: string }) => item.type),
			["reasoning", "message", "reasoning", "message", "reasoning"],
		);
		assert.deepEqual(ordered[0].content, [
			{ index: 0, type: "output_text" },
			{ index: 0, type: "summary_text" },
		]);
		assert.equal(ordered[1].content[0].text, "answer one");
		assert.doesNotMatch(JSON.stringify(history), /later body|ciphertext|brief/);
		assert.doesNotMatch(
			JSON.stringify(await f.get(`/api/turns/${id}`)),
			/later body|ciphertext|brief/,
		);
		assert.equal(
			(await f.get(`/api/turns/${id}/reasoning`)).output[0].content[0].text,
			"body",
		);
		stream.enqueue(
			new TextEncoder().encode(
				frame("response.output_text.delta", {
					output_index: 0,
					content_index: 0,
					item_id: "r0",
					delta: " grows!",
				}) +
					frame("response.reasoning_summary_text.delta", {
						output_index: 0,
						summary_index: 0,
						item_id: "r0",
						delta: " grows!",
					}),
			),
		);
		let details = await f.get(`/api/turns/${id}/reasoning`);
		while (details.output[0].content[0].text !== "body grows!") {
			await new Promise((resolve) => setImmediate(resolve));
			details = await f.get(`/api/turns/${id}/reasoning`);
		}
		assert.equal(details.output[0].content[1].text, "brief grows!");
		assert.equal((await f.get(`/api/turns/${id}`)).turns[0].status, "pending");
		stream.close();
		assert.equal((await pending).status, 502);
		await f.restart();
		assert.equal((await f.get(`/api/turns/${id}`)).turns[0].status, "failed");
		assert.equal(
			(await f.get(`/api/turns/${id}/reasoning`)).output[0].content[0].text,
			"body grows!",
		);
		assert.equal(
			(await f.get(`/api/turns/${id}/reasoning`)).output.at(-1).content.length,
			0,
		);
	} finally {
		await f.close();
	}
});

test("reconnecting reads the latest durable pending thinking, answer and raw stream without another model call", async () => {
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
	const first = new AbortController();
	const reconnect = new AbortController();
	try {
		const initial = await f.events(first.signal).then(events);
		assert.equal(await initial(), ": connected");
		const submitted = f.post(`/api/chats/${f.chat.id}`, {
			modelId: "stream-fixture",
			prompt: "recover",
		});
		const turnId = JSON.parse((await initial()).split("data: ")[1]).turnId;
		while (!stream) await new Promise((resolve) => setImmediate(resolve));
		first.abort();
		const raw =
			frame("response.reasoning_text.delta", {
				output_index: 0,
				content_index: 0,
				item_id: "r",
				delta: "durable thinking",
			}) + delta("durable answer", 1);
		stream.enqueue(new TextEncoder().encode(raw));
		while ((await f.get(`/api/turns/${turnId}`)).turns[0].output.length < 2)
			await new Promise((resolve) => setImmediate(resolve));
		const next = await f.events(reconnect.signal).then(events);
		assert.equal(await next(), ": connected");
		const recovered = await f.get(`/api/turns/${turnId}`);
		assert.equal(recovered.busy, true);
		assert.equal(recovered.turns[0].status, "pending");
		assert.equal(
			recovered.turns[0].output[1].content[0].text,
			"durable answer",
		);
		assert.equal(
			(await f.get(`/api/turns/${turnId}/reasoning`)).output[0].content[0].text,
			"durable thinking",
		);
		assert.equal(
			(await f.get(`/api/turns/${turnId}/calls`)).calls[0].responseBody,
			raw,
		);
		assert.equal(
			(
				await f.post(`/api/chats/${f.chat.id}`, {
					modelId: "stream-fixture",
					prompt: "busy",
				})
			).status,
			409,
		);
		stream.close();
		assert.equal((await submitted).status, 502);
		assert.equal((await f.get(`/api/turns/${turnId}`)).busy, false);
		assert.equal(requests, 1);
	} finally {
		first.abort();
		reconnect.abort();
		await f.close();
	}
});
