import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { waitForAgent } from "./agent-fixture.ts";
import { createTestServer as createServer } from "./config-fixture.ts";
import { completedBody, completedResponse } from "./model-fixture.ts";

async function complete(base: string, submitted: Promise<Response>) {
	const response = await submitted;
	assert.equal(response.status, 202);
	const { agentId } = await response.json();
	return waitForAgent(base, agentId);
}

test("chat histories are isolated; busy rejects duplicates and allows parallel chats; failures release busy", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-chat-"));
	const inputs: unknown[] = [];
	let release: (() => void) | undefined;
	let fail = false;
	const server = createServer(
		async (_url, options) => {
			inputs.push(JSON.parse(String(options?.body)).input);
			if (inputs.length === 1)
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			if (fail) return new Response("broken", { status: 500 });
			return completedResponse({
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: "Answer" }],
					},
				],
			});
		},
		join(directory, "db.sqlite"),
	).listen(0, "127.0.0.1");
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		const post = (path: string, body: unknown) =>
			fetch(base + path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const project = await (
			await post("/api/projects", { name: "Work", folders: [directory] })
		).json();
		const a = await (
			await post(`/api/projects/${project.id}/chats`, { name: "A" })
		).json();
		const b = await (
			await post(`/api/projects/${project.id}/chats`, { name: "B" })
		).json();
		assert.equal((await fetch(`${base}/api/chats/999`)).status, 404);
		assert.equal(
			(await post(`/api/chats/${a.id}`, { modelId: "test", prompt: " " }))
				.status,
			400,
		);
		const first = post(`/api/chats/${a.id}`, {
			modelId: "test",
			prompt: "first",
		});
		while (!release) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(
			(await (await fetch(`${base}/api/chats/${a.id}`)).json()).busy,
			true,
		);
		assert.equal(
			(
				await post(`/api/chats/${a.id}`, {
					modelId: "test",
					prompt: "duplicate",
				})
			).status,
			409,
		);
		assert.equal(
			(
				await complete(
					base,
					post(`/api/chats/${b.id}`, {
						modelId: "test",
						prompt: "separate",
					}),
				)
			).status,
			"succeeded",
		);
		release();
		assert.equal((await complete(base, first)).status, "succeeded");
		assert.equal(
			(
				await complete(
					base,
					post(`/api/chats/${a.id}`, {
						modelId: "test",
						prompt: "followup",
					}),
				)
			).status,
			"succeeded",
		);
		assert.deepEqual(inputs, [
			[{ role: "user", content: "first" }],
			[{ role: "user", content: "separate" }],
			[
				{ role: "user", content: "first" },
				{ role: "assistant", content: "Answer" },
				{ role: "user", content: "followup" },
			],
		]);
		fail = true;
		assert.equal(
			(
				await complete(
					base,
					post(`/api/chats/${a.id}`, { modelId: "test", prompt: "failure" }),
				)
			).status,
			"failed",
		);
		const saved = await (await fetch(`${base}/api/chats/${a.id}`)).json();
		assert.equal(saved.messages.length, 6);
		assert.equal(saved.agents.at(-1).status, "failed");
		assert.equal(saved.busy, false);
		fail = false;
		assert.equal(
			(
				await complete(
					base,
					post(`/api/chats/${a.id}`, { modelId: "test", prompt: "retry" }),
				)
			).status,
			"succeeded",
		);
		assert.deepEqual(inputs.at(-1), [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "Answer" },
			{ role: "user", content: "followup" },
			{ role: "assistant", content: "Answer" },
			{ role: "user", content: "retry" },
		]);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

test("all model and database failures preserve complete history and release chat lock; restart preserves successful history", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-chat-fail-"));
	const path = join(directory, "db.sqlite");
	let mode = "ok";
	const fake: typeof fetch = async () => {
		if (mode === "network") throw new Error("offline");
		if (mode === "parse") return new Response("{");
		if (mode === "empty") return completedResponse({ output: [] });
		return completedResponse({
			output: [
				{ type: "message", content: [{ type: "output_text", text: "saved" }] },
			],
		});
	};
	let server = createServer(fake, path).listen(0, "127.0.0.1");
	async function base() {
		if (!server.listening)
			await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		return `http://127.0.0.1:${address.port}`;
	}
	try {
		const folder = join(directory, "folder");
		await mkdir(folder);
		let url = await base();
		const post = (route: string, body: unknown) =>
			fetch(url + route, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const project = await (
			await post("/api/projects", { name: "Work", folders: [folder] })
		).json();
		const chat = await (
			await post(`/api/projects/${project.id}/chats`, { name: "Chat" })
		).json();
		const route = `/api/chats/${chat.id}`;
		assert.equal(
			(
				await complete(
					url,
					post(route, { modelId: "test", prompt: "saved question" }),
				)
			).status,
			"succeeded",
		);
		for (mode of ["network", "parse", "empty", "db"]) {
			const db = new DatabaseSync(path);
			if (mode === "db")
				db.exec(
					"CREATE TRIGGER reject_turn BEFORE INSERT ON agents BEGIN SELECT RAISE(ABORT,'write failed'); END",
				);
			try {
				assert.equal(
					(mode === "db"
						? await post(route, { modelId: "test", prompt: "failed question" })
						: await complete(
								url,
								post(route, { modelId: "test", prompt: "failed question" }),
							)
					).status,
					mode === "db" ? 500 : "failed",
				);
				const state = await (await fetch(url + route)).json();
				assert.equal(
					state.agents.filter(
						(agent: { status: string }) => agent.status === "succeeded",
					).length,
					1,
				);
				assert.equal(state.busy, false);
			} finally {
				if (mode === "db") db.exec("DROP TRIGGER reject_turn");
				db.close();
			}
		}
		mode = "ok";
		await rm(folder, { recursive: true });
		assert.equal(
			(await complete(url, post(route, { modelId: "test", prompt: "retry" })))
				.status,
			"succeeded",
		);
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		server = createServer(fake, path).listen(0, "127.0.0.1");
		url = await base();
		const state = await (await fetch(url + route)).json();
		assert.equal(state.agents.length, 5);
		assert.equal(state.busy, false);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

test("agent communication is exact, redacted, independently readable and survives interrupted completion", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-records-"));
	const path = join(directory, "db.sqlite");
	let mode = "hold";
	let release: (() => void) | undefined;
	let count = 0;
	const actual = {
		status: "completed",
		output: [
			{ type: "message", content: [{ type: "output_text", text: "Answer" }] },
		],
		echo: "record-secret",
	};
	const raw = completedBody(actual);
	const fake: typeof fetch = async () => {
		count++;
		if (mode === "hold")
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		if (mode === "network") throw new Error("offline record-secret");
		if (mode === "read")
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.error(new Error("read record-secret"));
					},
				}),
				{ status: 201 },
			);
		if (mode === "bad") return new Response("not JSON record-secret");
		return new Response(raw);
	};
	let server = createServer(fake, path, "record-secret", "fixture").listen(
		0,
		"127.0.0.1",
	);
	const base = async () => {
		if (!server.listening)
			await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		return `http://127.0.0.1:${address.port}`;
	};
	let url = await base();
	const post = (route: string, body: unknown) =>
		fetch(url + route, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const get = (route: string) =>
		fetch(url + route).then((response) => response.json());
	const stop = () =>
		new Promise<void>((resolve) => {
			server.closeAllConnections();
			server.close(() => resolve());
		});
	try {
		const project = await (
			await post("/api/projects", { name: "P", folders: [] })
		).json();
		const chat = await (
			await post(`/api/projects/${project.id}/chats`, { name: "C" })
		).json();
		const route = `/api/chats/${chat.id}`;
		const first = post(route, {
			modelId: "fixture",
			prompt: "question record-secret",
		});
		while (!release) await new Promise((resolve) => setImmediate(resolve));
		let history = await get(route);
		const agentId = history.agents[0].id;
		assert.equal(history.agents[0].status, "pending");
		assert.doesNotMatch(
			JSON.stringify(history),
			/record-secret|requestBody|responseBody/,
		);
		let calls = (await get(`/api/agents/${agentId}/calls`)).calls;
		assert.equal(calls.length, 1);
		assert.equal(calls[0].agentId, agentId);
		assert.equal(calls[0].responseBody, null);
		assert.equal(calls[0].method, "POST");
		assert.equal(calls[0].url, "https://openrouter.ai/api/v1/responses");
		assert.deepEqual(JSON.parse(calls[0].requestBody).input, [
			{ role: "user", content: "question [REDACTED]" },
		]);
		release();
		assert.equal((await complete(url, first)).status, "succeeded");
		calls = (await get(`/api/agents/${agentId}/calls`)).calls;
		assert.equal(
			calls[0].responseBody,
			JSON.stringify(actual).replaceAll("record-secret", "[REDACTED]"),
		);
		assert.equal(calls[0].httpStatus, 200);
		assert.equal(calls[0].status, "succeeded");
		assert.equal(typeof calls[0].durationMs, "number");
		const requestOnly = (await get(`/api/agents/${agentId}/calls?kind=request`))
			.calls[0];
		assert.equal(requestOnly.requestBody, calls[0].requestBody);
		assert.equal(requestOnly.responseBody, null);
		const responseOnly = (
			await get(`/api/agents/${agentId}/calls?kind=response`)
		).calls[0];
		assert.equal(responseOnly.requestBody, null);
		assert.equal(responseOnly.responseBody, calls[0].responseBody);
		assert.equal((await fetch(`${url}/api/debug`)).status, 404);
		assert(!("headers" in calls[0]));
		for (mode of ["network", "read", "bad"]) {
			const submission = await complete(
				url,
				post(route, {
					modelId: "fixture",
					prompt: mode,
				}),
			);
			assert.equal(submission.status, "failed");
			if (mode === "bad")
				assert.doesNotMatch(JSON.stringify(submission), /not JSON/);
			history = await get(route);
			if (mode === "bad")
				assert.doesNotMatch(JSON.stringify(history), /not JSON/);
			const failed = history.agents.at(-1);
			assert.equal(failed.status, "failed");
			const call = (await get(`/api/agents/${failed.id}/calls`)).calls[0];
			assert.equal(call.status, "failed");
			assert.equal(
				call.httpStatus,
				mode === "network" ? null : mode === "read" ? 201 : 200,
			);
			assert.equal(
				call.responseBody,
				mode === "bad" ? "not JSON [REDACTED]" : null,
			);
			assert.doesNotMatch(JSON.stringify(call), /record-secret/);
		}
		await fetch(`${await base()}/api/model-settings`, {
			method: "PUT",
			body: JSON.stringify({ removeApiKey: true }),
		});
		const configuredCount = count;
		assert.equal(
			(
				await post(route, {
					modelId: "fixture",
					prompt: "missing configuration",
				})
			).status,
			400,
		);
		history = await get(route);
		assert.equal(count, configuredCount);
		await fetch(`${await base()}/api/model-settings`, {
			method: "PUT",
			body: JSON.stringify({
				apiKey: "record-secret",
				defaultModelId: "fixture",
			}),
		});
		mode = "ok";
		const db = new DatabaseSync(path);
		db.exec(
			"CREATE TRIGGER reject_request BEFORE INSERT ON model_calls BEGIN SELECT RAISE(ABORT,'no request write');END",
		);
		const before = count;
		assert.equal(
			(
				await complete(
					url,
					post(route, { modelId: "fixture", prompt: "not sent" }),
				)
			).status,
			"failed",
		);
		assert.equal(count, before);
		db.exec("DROP TRIGGER reject_request");
		db.exec(
			"CREATE TRIGGER reject_complete BEFORE UPDATE ON agents BEGIN SELECT RAISE(ABORT,'no result write');END",
		);
		assert.equal(
			(
				await complete(
					url,
					post(route, { modelId: "fixture", prompt: "interrupted" }),
				)
			).status,
			"failed",
		);
		history = await get(route);
		const interrupted = history.agents.at(-1);
		assert.equal(interrupted.status, "failed");
		assert.equal(interrupted.errorCode, "answerWriteFailed");
		assert.equal(
			db.prepare("SELECT status FROM agents WHERE id=?").get(interrupted.id)
				?.status,
			"pending",
		);
		assert.equal(
			(await get(`/api/agents/${interrupted.id}/calls`)).calls[0].responseBody,
			calls[0].responseBody,
		);
		db.exec("DROP TRIGGER reject_complete");
		db.close();
		await stop();
		const sent = count;
		server = createServer(fake, path, "record-secret", "fixture").listen(
			0,
			"127.0.0.1",
		);
		url = await base();
		history = await get(route);
		assert.equal(history.agents.at(-1).errorCode, "agentInterrupted");
		assert.equal(history.busy, false);
		assert.equal(count, sent);
		const interruptedCall = (await get(`/api/agents/${interrupted.id}/calls`))
			.calls[0];
		assert.equal(interruptedCall.status, "succeeded");
		assert.equal(interruptedCall.responseBody, calls[0].responseBody);
		assert.equal(interruptedCall.error, null);
		await fetch(`${url}/api/projects/${project.id}/archive`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ archived: true }),
		});
		assert.equal(
			(await get(`/api/agents/${agentId}/calls`)).calls[0].responseBody,
			JSON.stringify(actual).replaceAll("record-secret", "[REDACTED]"),
		);
	} finally {
		release?.();
		await stop();
		await rm(directory, { recursive: true, force: true });
	}
});
