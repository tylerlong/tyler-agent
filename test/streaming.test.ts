import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { waitForAgent, waitForIdle } from "./agent-fixture.ts";
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
		wait: (id: number) => waitForAgent(base, id),
		waitForIdle: (id: number) => waitForIdle(base, id),
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
		assert.equal(body.tools[0].name, "list_files");
		return new Response(
			new ReadableStream({
				start(controller) {
					stream = controller;
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
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
		const pending = await f.post(`/api/chats/${f.chat.id}`, {
			modelId: "stream-fixture",
			prompt: "question",
		});
		assert.equal(pending.status, 202);
		const acceptedId = (await pending.json()).agentId;
		const [acceptedA, acceptedB] = await Promise.all([a(), b()]);
		assert.equal(acceptedA, acceptedB);
		assert.match(acceptedA, /event: agent/);
		const notification = JSON.parse(acceptedA.split("data: ")[1]);
		assert.equal(notification.chatId, f.chat.id);
		const agentId = notification.agentId;
		assert.equal(
			(await f.get(`/api/agents/${agentId}`)).agents[0].status,
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
		let saved = await f.get(`/api/agents/${agentId}`);
		do {
			await a();
			saved = await f.get(`/api/agents/${agentId}`);
		} while (saved.agents[0].output[0]?.content[0]?.text !== "中文");
		assert.equal(saved.busy, true);
		const calls = (await f.get(`/api/agents/${agentId}/calls`)).calls;
		assert.equal(calls[0].responseBody, null);
		const liveDb = new DatabaseSync(f.path);
		assert.match(
			String(
				liveDb
					.prepare("SELECT output_json FROM model_calls WHERE agent_id=?")
					.get(agentId)?.output_json,
			),
			/中文/,
		);
		assert.doesNotMatch(
			JSON.stringify(
				liveDb
					.prepare(
						"SELECT response_body, output_json FROM model_calls WHERE agent_id=?",
					)
					.get(agentId),
			),
			/response.output_text.delta|event:|data:/,
		);
		liveDb.close();
		assert.match(await b(), /event: agent/);
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
		while ((await f.get(`/api/agents/${agentId}`)).agents[0].output.length < 2)
			await new Promise((resolve) => setImmediate(resolve));
		assert.equal(
			(await f.get(`/api/agents/${agentId}`)).agents[0].status,
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
		assert.equal((await f.wait(acceptedId)).status, "succeeded");
		const result = (await f.get(`/api/agents/${agentId}`)).agents[0];
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
		return new Response(raw, {
			headers: { "content-type": "text/event-stream" },
		});
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
			assert.equal(response.status, 202);
			const completedAgent = await f.wait((await response.json()).agentId);
			assert.doesNotMatch(
				JSON.stringify(completedAgent),
				/private provider body|broken/,
			);
			const history = await f.get(`/api/chats/${f.chat.id}`);
			const agent = history.agents.at(-1);
			assert.equal(agent.status, "failed");
			assert.equal(agent.output[0].content[0].text, "partial");
			assert.equal(history.busy, false);
			const call = (await f.get(`/api/agents/${agent.id}/calls`)).calls[0];
			const expected = terminal.includes("response.failed")
				? { error: { message: "private provider body" } }
				: terminal.includes("response.incomplete")
					? { output: [] }
					: null;
			assert.deepEqual(
				call.responseBody && JSON.parse(call.responseBody),
				expected,
			);
			assert.doesNotMatch(
				JSON.stringify(call),
				/event:|data:|response.output_text.delta/,
			);
		}
		raw = completedBody({ output: [item("m0", "saved")] });
		{
			const accepted = await f.post(`/api/chats/${f.chat.id}`, {
				modelId: "stream-fixture",
				prompt: "success",
			});
			assert.equal(accepted.status, 202);
			assert.equal(
				(await f.wait((await accepted.json()).agentId)).status,
				"succeeded",
			);
		}
		{
			const accepted = await f.post(`/api/chats/${f.chat.id}`, {
				modelId: "stream-fixture",
				prompt: "followup",
			});
			assert.equal(accepted.status, 202);
			assert.equal(
				(await f.wait((await accepted.json()).agentId)).status,
				"succeeded",
			);
		}
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

for (const failedWrite of ["progress", "terminal"])
	test(`split credentials are redacted before storage; failed ${failedWrite} writes retain durable partial state across restart`, async () => {
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
				{ headers: { "content-type": "text/event-stream" } },
			);
		});
		const db = new DatabaseSync(f.path);
		try {
			db.exec(
				"CREATE TRIGGER reject_request BEFORE INSERT ON model_calls BEGIN SELECT RAISE(ABORT,'rejected'); END",
			);
			{
				const accepted = await f.post(`/api/chats/${f.chat.id}`, {
					modelId: "stream-fixture",
					prompt: "not sent",
				});
				assert.equal(accepted.status, 202);
				assert.equal(
					(await f.wait((await accepted.json()).agentId)).status,
					"failed",
				);
			}
			assert.equal(requests, 0);
			db.exec("DROP TRIGGER reject_request");
			const pending = await f.post(`/api/chats/${f.chat.id}`, {
				modelId: "stream-fixture",
				prompt: "accepted",
			});
			assert.equal(pending.status, 202);
			const acceptedId = (await pending.json()).agentId;
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
			let agent = (await f.get(`/api/chats/${f.chat.id}`)).agents.at(-1);
			do {
				await new Promise((resolve) => setImmediate(resolve));
				agent = (await f.get(`/api/chats/${f.chat.id}`)).agents.at(-1);
			} while (agent.output[0]?.content[0]?.text !== "saved");
			const calls = (await f.get(`/api/agents/${agent.id}/calls`)).calls;
			assert.equal(calls[0].responseBody, null);
			assert.doesNotMatch(JSON.stringify(calls), /stream-secret/);
			assert.doesNotMatch(JSON.stringify(agent), /stream-secret/);
			assert.doesNotMatch(
				String(
					db
						.prepare("SELECT output_json FROM model_calls WHERE agent_id=?")
						.get(agent.id)?.output_json,
				),
				/stream-secret/,
			);
			db.exec(
				"CREATE TRIGGER reject_progress BEFORE UPDATE ON model_calls BEGIN SELECT RAISE(ABORT,'write rejected'); END",
			);
			stream.enqueue(
				new TextEncoder().encode(
					failedWrite === "progress"
						? delta(" unsaved")
						: completedBody({
								status: "completed",
								output: [item("m0", "saved unsaved")],
							}),
				),
			);
			stream.close();
			await f.waitForIdle(acceptedId);
			const retained = (await f.get(`/api/chats/${f.chat.id}`)).agents.at(-1);
			assert.equal(retained.status, "failed");
			assert.equal(retained.errorCode, "answerWriteFailed");
			assert.equal(
				db.prepare("SELECT status FROM agents WHERE id=?").get(retained.id)
					?.status,
				"failed",
			);
			assert.equal(retained.output[0].content[0].text, "saved");
			assert.equal(retained.calls[0].status, "failed");
			assert.equal(
				(await f.get(`/api/agents/${agent.id}`)).agents[0].calls[0].status,
				"failed",
			);
			for (const kind of ["metadata", "request", "response", ""]) {
				const call = (
					await f.get(
						`/api/agents/${agent.id}/calls${kind ? `?kind=${kind}&callId=${calls[0].id}` : ""}`,
					)
				).calls[0];
				assert.equal(call.status, "failed");
				assert.equal(call.errorCode, "answerWriteFailed");
				if (kind === "response" || !kind) {
					assert.equal(call.responseBody, calls[0].responseBody);
					assert.equal(call.error, "Could not save the answer");
				}
			}
			db.exec("DROP TRIGGER reject_progress");
			await f.restart();
			const history = await f.get(`/api/chats/${f.chat.id}`);
			assert.equal(history.busy, false);
			assert.equal(history.agents.at(-1).errorCode, "modelInterrupted");
			assert.equal(history.agents.at(-1).output[0].content[0].text, "saved");
			assert.equal(
				(await f.get(`/api/agents/${agent.id}/calls`)).calls[0].responseBody,
				calls[0].responseBody,
			);
			assert.equal(requests, 1);
		} finally {
			db.close();
			await f.close();
		}
	});

for (const httpStatus of [200, 503])
	test(`a ${httpStatus} read error retains saved content and actual HTTP diagnostics without retrying`, {
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
				{
					status: httpStatus,
					headers: {
						"content-type":
							httpStatus === 200 ? "text/event-stream" : "text/plain",
					},
				},
			);
		});
		try {
			const pending = await f.post(`/api/chats/${f.chat.id}`, {
				modelId: "stream-fixture",
				prompt: "question",
			});
			assert.equal(pending.status, 202);
			const acceptedId = (await pending.json()).agentId;
			while (!stream) await new Promise((resolve) => setImmediate(resolve));
			const raw =
				httpStatus === 200
					? delta("saved answer")
					: "partial stream-secret body";
			stream.enqueue(new TextEncoder().encode(raw));
			let saved = (await f.get(`/api/chats/${f.chat.id}`)).agents.at(-1);
			while (
				httpStatus === 200
					? saved.output[0]?.content[0]?.text !== "saved answer"
					: (await f.get(`/api/agents/${saved.id}/calls`)).calls[0]
							.responseBody !== raw.replaceAll("stream-secret", "[REDACTED]")
			) {
				await new Promise((resolve) => setImmediate(resolve));
				saved = (await f.get(`/api/chats/${f.chat.id}`)).agents.at(-1);
			}
			stream.error(new Error("private upstream body stream-secret"));
			const completedAgent = await f.wait(acceptedId);
			assert.equal(completedAgent.status, "failed");
			assert.doesNotMatch(JSON.stringify(completedAgent), /stream-secret/);
			const history = await f.get(`/api/chats/${f.chat.id}`);
			assert.equal(history.busy, false);
			assert.equal(history.agents.at(-1).status, "failed");
			assert.equal(
				history.agents.at(-1).output[0]?.content[0]?.text,
				httpStatus === 200 ? "saved answer" : undefined,
			);
			const call = (await f.get(`/api/agents/${saved.id}/calls`)).calls[0];
			assert.equal(
				call.responseBody,
				httpStatus === 200
					? null
					: raw.replaceAll("stream-secret", "[REDACTED]"),
			);
			assert.equal(call.httpStatus, httpStatus);
			assert.equal(call.status, "failed");
			assert.doesNotMatch(call.error, /stream-secret/);
			assert.equal(completedAgent.errorDetails, call.error);
			assert.equal(completedAgent.errorCode, call.errorCode);
			const db = new DatabaseSync(f.path);
			assert.equal(
				db.prepare("SELECT error_code FROM agents WHERE id=?").get(saved.id)
					?.error_code,
				null,
			);
			db.close();
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
				{ headers: { "content-type": "text/event-stream" } },
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
		const pending = await f.post(`/api/chats/${f.chat.id}`, {
			modelId: "stream-fixture",
			prompt: "think",
		});
		assert.equal(pending.status, 202);
		const acceptedId = (await pending.json()).agentId;
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
		while (history.agents[0]?.output.length !== 5) {
			await new Promise((resolve) => setImmediate(resolve));
			history = await f.get(`/api/chats/${f.chat.id}`);
		}
		const id = history.agents[0].id;
		const ordered = history.agents[0].output;
		const callId = history.agents[0].calls[0].id;
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
			JSON.stringify(await f.get(`/api/agents/${id}`)),
			/later body|ciphertext|brief/,
		);
		assert.equal(
			(await f.get(`/api/agents/${id}/reasoning?callId=${callId}`)).output[0]
				.content[0].text,
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
		let details = await f.get(`/api/agents/${id}/reasoning?callId=${callId}`);
		while (details.output[0].content[0].text !== "body grows!") {
			await new Promise((resolve) => setImmediate(resolve));
			details = await f.get(`/api/agents/${id}/reasoning?callId=${callId}`);
		}
		assert.equal(details.output[0].content[1].text, "brief grows!");
		assert.equal(
			(await f.get(`/api/agents/${id}`)).agents[0].status,
			"pending",
		);
		stream.close();
		assert.equal((await f.wait(acceptedId)).status, "failed");
		await f.restart();
		assert.equal((await f.get(`/api/agents/${id}`)).agents[0].status, "failed");
		assert.equal(
			(await f.get(`/api/agents/${id}/reasoning?callId=${callId}`)).output[0]
				.content[0].text,
			"body grows!",
		);
		assert.equal(
			(await f.get(`/api/agents/${id}/reasoning?callId=${callId}`)).output.at(
				-1,
			).content.length,
			0,
		);
	} finally {
		await f.close();
	}
});

test("reconnecting reads the latest durable pending reasoning and answer without another model call", async () => {
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
			{ headers: { "content-type": "text/event-stream" } },
		);
	});
	const first = new AbortController();
	const reconnect = new AbortController();
	try {
		const initial = await f.events(first.signal).then(events);
		assert.equal(await initial(), ": connected");
		const submitted = await f.post(`/api/chats/${f.chat.id}`, {
			modelId: "stream-fixture",
			prompt: "recover",
		});
		assert.equal(submitted.status, 202);
		const acceptedId = (await submitted.json()).agentId;
		const agentId = JSON.parse((await initial()).split("data: ")[1]).agentId;
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
		while ((await f.get(`/api/agents/${agentId}`)).agents[0].output.length < 2)
			await new Promise((resolve) => setImmediate(resolve));
		const next = await f.events(reconnect.signal).then(events);
		assert.equal(await next(), ": connected");
		const recovered = await f.get(`/api/agents/${agentId}`);
		assert.equal(recovered.busy, true);
		assert.equal(recovered.agents[0].status, "pending");
		assert.equal(
			recovered.agents[0].output[1].content[0].text,
			"durable answer",
		);
		assert.equal(
			(
				await f.get(
					`/api/agents/${agentId}/reasoning?callId=${recovered.agents[0].calls[0].id}`,
				)
			).output[0].content[0].text,
			"durable thinking",
		);
		assert.equal(
			(await f.get(`/api/agents/${agentId}/calls`)).calls[0].responseBody,
			null,
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
		assert.equal((await f.wait(acceptedId)).status, "failed");
		assert.equal((await f.get(`/api/agents/${agentId}`)).busy, false);
		assert.equal(requests, 1);
	} finally {
		first.abort();
		reconnect.abort();
		await f.close();
	}
});

test("a Agent finalization write failure keeps a successfully saved Model Call succeeded", async () => {
	const raw = completedBody({
		status: "completed",
		output: [item("m0", "saved")],
	});
	const f = await fixture(
		async () =>
			new Response(raw, { headers: { "content-type": "text/event-stream" } }),
	);
	const db = new DatabaseSync(f.path);
	try {
		db.exec(
			"CREATE TRIGGER reject_final BEFORE UPDATE ON agents WHEN NEW.status != 'pending' BEGIN SELECT RAISE(ABORT,'write rejected'); END",
		);
		const accepted = await (
			await f.post(`/api/chats/${f.chat.id}`, {
				modelId: "stream-fixture",
				prompt: "answer",
			})
		).json();
		await f.waitForIdle(accepted.agentId);
		const agent = (await f.get(`/api/chats/${f.chat.id}`)).agents[0];
		assert.equal(agent.status, "failed");
		assert.equal(agent.errorCode, "answerWriteFailed");
		assert.equal(agent.calls[0].status, "succeeded");
		const call = (await f.get(`/api/agents/${agent.id}/calls?kind=response`))
			.calls[0];
		assert.equal(call.status, "succeeded");
		assert.equal(call.error, null);
		assert.deepEqual(JSON.parse(call.responseBody), {
			status: "completed",
			output: [item("m0", "saved")],
		});
	} finally {
		db.close();
		await f.close();
	}
});

test("Model Call saves only the actual final JSON and survives restart", async () => {
	const body =
		":\n\n: keepalive\r\n\r\n" +
		'event: vendor.unknown\r\n: inside\r\ndata: {"text":"你好: world"}\r\n\r\n' +
		": another\n\n" +
		completedBody({ output: [item("m", "answer")] }) +
		": trailing";
	const expected = JSON.stringify({
		status: "completed",
		output: [item("m", "answer")],
	});
	const f = await fixture(
		async () =>
			new Response(body, {
				headers: { "content-type": "Text/Event-Stream; charset=utf-8" },
			}),
	);
	try {
		const accepted = await (
			await f.post(`/api/chats/${f.chat.id}`, {
				modelId: "stream-fixture",
				prompt: "question",
			})
		).json();
		assert.equal((await f.wait(accepted.agentId)).status, "succeeded");
		const calls = await f.get(`/api/agents/${accepted.agentId}/calls`);
		assert.equal(calls.calls[0].responseBody, expected);
		await f.restart();
		assert.equal(
			(await f.get(`/api/agents/${accepted.agentId}/calls`)).calls[0]
				.responseBody,
			expected,
		);
	} finally {
		await f.close();
	}
});

for (const scenario of [
	{
		name: "mixed CR/LF boundaries around removed comments",
		status: 200,
		type: "text/event-stream",
		body: "data: one\r: comment\n\ndata: two\n\n",
		expected: null,
	},
	{
		name: "CR frames, unknown fields and unfinished data",
		status: 200,
		type: "text/event-stream",
		body: ': ping\r\revent: vendor.raw\r: inside\rid: 7\rretry: 10\rdata: 你好: not-json\r\r: again\r\r : not a comment\rdata: {"unfinished":',
		expected: null,
	},
	{
		name: "failed SSE with a partial credential and trailing comment",
		status: 503,
		type: "text/event-stream",
		body: ": ping\n\ndata: stream-secret\n\n: tail",
		expected: null,
	},
	{
		name: "only SSE comments",
		status: 200,
		type: "text/event-stream",
		body: ":\r\n\r\n: keepalive\n\n: unfinished",
		expected: null,
	},
	{
		name: "empty SSE",
		status: 503,
		type: "text/event-stream",
		body: "",
		expected: null,
	},
	{
		name: "ordinary colon-prefixed text",
		status: 503,
		type: "text/plain",
		body: ": diagnostic\n\nstream-secret",
		expected: ": diagnostic\n\n[REDACTED]",
	},
	{
		name: "ordinary JSON",
		status: 503,
		type: "application/json",
		body: '{"error":": stream-secret"}',
		expected: '{"error":": [REDACTED]"}',
	},
]) {
	test(`Model Call records diagnostics without transcripts for ${scenario.name} across byte-sized chunks`, async () => {
		const bytes = new TextEncoder().encode(scenario.body);
		let position = 0;
		const f = await fixture(
			async () =>
				new Response(
					new ReadableStream({
						pull(controller) {
							if (position < bytes.length)
								controller.enqueue(bytes.slice(position, ++position));
							else controller.close();
						},
					}),
					{
						status: scenario.status,
						headers: { "content-type": scenario.type },
					},
				),
		);
		try {
			const accepted = await (
				await f.post(`/api/chats/${f.chat.id}`, {
					modelId: "stream-fixture",
					prompt: "question",
				})
			).json();
			assert.equal((await f.wait(accepted.agentId)).status, "failed");
			const call = (await f.get(`/api/agents/${accepted.agentId}/calls`))
				.calls[0];
			assert.equal(call.responseBody, scenario.expected);
			assert.equal(call.httpStatus, scenario.status);
			assert.equal(call.status, "failed");
			assert.equal(typeof call.durationMs, "number");
			assert(call.error);
		} finally {
			await f.close();
		}
	});
}

test("pending readable snapshots protect split credentials and survive an interrupted read without saving frames", async () => {
	let stream!: ReadableStreamDefaultController<Uint8Array>;
	const f = await fixture(
		async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						stream = controller;
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
	);
	try {
		const accepted = await (
			await f.post(`/api/chats/${f.chat.id}`, {
				modelId: "stream-fixture",
				prompt: "question",
			})
		).json();
		async function expectPartial(text: string) {
			for (let attempt = 0; attempt < 100; attempt++) {
				const call = (await f.get(`/api/agents/${accepted.agentId}/calls`))
					.calls[0];
				assert.equal(call.status, "pending");
				assert.equal(call.responseBody, null);
				assert.doesNotMatch(
					JSON.stringify(call),
					/stream-secret|response.output_text.delta|event:|data:/,
				);
				if (call.partialOutput?.[0]?.content[0]?.text === text) return;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			assert.fail(`Partial output never became ${text}`);
		}
		stream.enqueue(
			new TextEncoder().encode(": keepalive\r\n\r\n" + delta("stream-")),
		);
		await expectPartial("");
		stream.enqueue(
			new TextEncoder().encode(delta("secret visible") + ": trailing"),
		);
		await expectPartial("[REDACTED] visible");
		stream.error(new Error("interrupted stream-secret"));
		assert.equal((await f.wait(accepted.agentId)).status, "failed");
		const call = (await f.get(`/api/agents/${accepted.agentId}/calls`))
			.calls[0];
		assert.equal(call.responseBody, null);
		assert.equal(call.partialOutput[0].content[0].text, "[REDACTED] visible");
		assert.equal(call.httpStatus, 200);
		assert(!call.error.includes("stream-secret"));
		await f.restart();
		assert.equal(
			(await f.get(`/api/agents/${accepted.agentId}/calls`)).calls[0]
				.responseBody,
			null,
		);
	} finally {
		await f.close();
	}
});

test("accepted final JSON replaces provisional parts across output, lazy reasoning, storage and future history", {
	timeout: 10000,
}, async () => {
	let stream!: ReadableStreamDefaultController<Uint8Array>;
	const inputs: unknown[] = [];
	const finalResponse = {
		id: "provider-response",
		status: "completed",
		usage: { input_tokens: 12, output_tokens: 7 },
		provider: { trace: "stream-secret" },
		output: [
			{
				id: "r",
				type: "reasoning",
				content: [{ type: "reasoning_text", text: "final reasoning" }],
				summary: [{ type: "summary_text", text: "final summary" }],
			},
			item("m1", "final answer"),
		],
	};
	const f = await fixture(async (_url, options) => {
		inputs.push(JSON.parse(String(options?.body)).input);
		if (inputs.length > 1)
			return new Response(
				completedBody({ output: [item("followup", "done")] }),
				{ headers: { "content-type": "text/event-stream" } },
			);
		return new Response(
			new ReadableStream({
				start(controller) {
					stream = controller;
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);
	});
	const db = new DatabaseSync(f.path);
	try {
		const accepted = await (
			await f.post(`/api/chats/${f.chat.id}`, {
				modelId: "stream-fixture",
				prompt: "replace",
			})
		).json();
		while (!stream) await new Promise((resolve) => setImmediate(resolve));
		stream.enqueue(
			new TextEncoder().encode(
				frame("response.reasoning_text.delta", {
					output_index: 0,
					item_id: "r",
					content_index: 0,
					delta: "provisional reasoning",
				}) +
					delta("provisional answer", 1) +
					delta("omitted part", 1, 1) +
					delta("omitted item", 2),
			),
		);
		while (
			(await f.get(`/api/agents/${accepted.agentId}`)).agents[0].output
				.length !== 3
		)
			await new Promise((resolve) => setImmediate(resolve));
		const row = db
			.prepare(
				"SELECT response_body, output_json FROM model_calls WHERE agent_id=?",
			)
			.get(accepted.agentId);
		assert.equal(row?.response_body, null);
		assert.match(
			String(row?.output_json),
			/provisional reasoning|omitted part/,
		);
		assert.doesNotMatch(String(row?.output_json), /delta|data:|event:/);
		stream.enqueue(new TextEncoder().encode(completedBody(finalResponse)));
		stream.close();
		assert.equal((await f.wait(accepted.agentId)).status, "succeeded");
		const agent = (await f.get(`/api/agents/${accepted.agentId}`)).agents[0];
		assert.equal(agent.output.length, 2);
		assert.equal(agent.output[1].content.length, 1);
		assert.equal(agent.output[1].content[0].text, "final answer");
		assert.doesNotMatch(JSON.stringify(agent), /provisional|omitted/);
		const reasoning = await f.get(
			`/api/agents/${agent.id}/reasoning?callId=${agent.calls[0].id}`,
		);
		assert.deepEqual(
			reasoning.output[0].content.map((part: { text: string }) => part.text),
			["final reasoning", "final summary"],
		);
		const saved = db
			.prepare(
				"SELECT response_body, output_json FROM model_calls WHERE agent_id=?",
			)
			.get(agent.id);
		assert.equal(saved?.output_json, "[]");
		assert.deepEqual(JSON.parse(String(saved?.response_body)), {
			...finalResponse,
			provider: { trace: "[REDACTED]" },
		});
		assert.equal(
			(
				await f.get(
					`/api/agents/${agent.id}/calls?kind=response&callId=${agent.calls[0].id}`,
				)
			).calls[0].responseBody,
			saved?.response_body,
		);
		await f.restart();
		assert.equal(
			(await f.get(`/api/agents/${agent.id}`)).agents[0].output[1].content[0]
				.text,
			"final answer",
		);
		const next = await (
			await f.post(`/api/chats/${f.chat.id}`, {
				modelId: "stream-fixture",
				prompt: "next",
			})
		).json();
		await f.wait(next.agentId);
		assert.deepEqual(inputs[1], [
			{ role: "user", content: "replace" },
			{ role: "assistant", content: "final answer" },
			{ role: "user", content: "next" },
		]);
	} finally {
		db.close();
		await f.close();
	}
});
