import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTestServer as createServer } from "./config-fixture.ts";
import { completedResponse } from "./model-fixture.ts";

test("archive flags remain independent, enforce read-only and persist without stopping answers", async () => {
	const folder = await mkdtemp(join(tmpdir(), "agent-archive-"));
	const path = join(folder, "db.sqlite");
	let release!: () => void;
	let enter!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	const model: typeof fetch = async () => {
		calls++;
		enter();
		await waiting;
		return completedResponse({
			output: [
				{ type: "message", content: [{ type: "output_text", text: "Answer" }] },
			],
		});
	};
	let server = createServer(model, path).listen(0, "127.0.0.1");
	async function ready() {
		if (!server.listening)
			await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		return `http://127.0.0.1:${address.port}`;
	}
	let url = await ready();
	const request = (path: string, method = "GET", body?: unknown) =>
		fetch(url + path, {
			method,
			...(body === undefined
				? {}
				: {
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					}),
		});
	let pending: Promise<Response> | undefined;
	try {
		const project = await (
			await request("/api/projects", "POST", {
				name: "Work",
				folders: [folder],
			})
		).json();
		const chat = await (
			await request(`/api/projects/${project.id}/chats`, "POST", { name: "A" })
		).json();
		const sibling = await (
			await request(`/api/projects/${project.id}/chats`, "POST", { name: "B" })
		).json();
		pending = request(`/api/chats/${chat.id}`, "POST", { prompt: "Question" });
		const answer = pending;
		await entered;
		assert.equal(
			(
				await request(`/api/chats/${chat.id}/archive`, "PUT", {
					archived: true,
				})
			).status,
			200,
		);
		assert.equal(
			(
				await request(`/api/projects/${project.id}/archive`, "PUT", {
					archived: true,
				})
			).status,
			200,
		);
		for (const [route, method, body] of [
			[`/api/projects/${project.id}`, "PUT", { name: "No", folders: [] }],
			[`/api/projects/${project.id}/chats`, "POST", { name: "No" }],
			[`/api/chats/${sibling.id}`, "PUT", { name: "No" }],
			[`/api/chats/${sibling.id}`, "POST", { prompt: "No" }],
		] as const)
			assert.equal((await request(route, method, body)).status, 409);
		release();
		assert.equal((await answer).status, 200);
		const history = await (await request(`/api/chats/${chat.id}`)).json();
		assert.equal(history.busy, false);
		assert.equal(history.messages[1].content, "Answer");
		assert.equal(calls, 1);
		let list = (await (await request("/api/projects")).json()).projects;
		assert.equal(list[0].archived, true);
		assert.equal(
			list[0].chats.find((c: { id: number }) => c.id === sibling.id).archived,
			false,
		);
		const activity = list[0].chats.find(
			(c: { id: number }) => c.id === chat.id,
		).lastQuestionAt;
		await request(`/api/projects/${project.id}/archive`, "PUT", {
			archived: false,
		});
		assert.equal(
			(await request(`/api/chats/${chat.id}`, "PUT", { name: "No" })).status,
			409,
		);
		await request(`/api/projects/${project.id}/archive`, "PUT", {
			archived: true,
		});
		await request(`/api/chats/${chat.id}/archive`, "PUT", { archived: false });
		assert.equal(
			(await request(`/api/chats/${chat.id}`, "POST", { prompt: "No" })).status,
			409,
		);
		assert.equal(
			(
				await request(`/api/chats/${chat.id}/archive`, "PUT", {
					archived: true,
				})
			).status,
			409,
		);
		await request(`/api/projects/${project.id}/archive`, "PUT", {
			archived: false,
		});
		await request(`/api/chats/${chat.id}/archive`, "PUT", { archived: true });
		await request(`/api/projects/${project.id}/archive`, "PUT", {
			archived: true,
		});
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		server = createServer(model, path).listen(0, "127.0.0.1");
		url = await ready();
		list = (await (await request("/api/projects")).json()).projects;
		assert.equal(list[0].id, project.id);
		assert.deepEqual(list[0].folders, [folder]);
		assert.equal(list[0].archived, true);
		assert.equal(
			list[0].chats.find((c: { id: number }) => c.id === chat.id)
				.lastQuestionAt,
			activity,
		);
		await request(`/api/projects/${project.id}/archive`, "PUT", {
			archived: false,
		});
		assert.equal(
			(await request(`/api/chats/${chat.id}`, "PUT", { name: "No" })).status,
			409,
		);
		await request(`/api/chats/${chat.id}/archive`, "PUT", { archived: false });
		assert.equal(
			(await request(`/api/chats/${chat.id}`, "PUT", { name: "Yes" })).status,
			200,
		);
	} finally {
		release();
		await pending?.catch(() => {});
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(folder, { recursive: true, force: true });
	}
});

test("accepted saves finish after archive while subsequent saves are refused", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-archive-save-"));
	const server = createServer(fetch, join(directory, "db.sqlite")).listen(
		0,
		"127.0.0.1",
	);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const post = async (path: string, body: unknown) =>
		(
			await fetch(base + path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			})
		).json();
	const archive = (path: string) =>
		fetch(`${base}${path}/archive`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ archived: true }),
		});
	try {
		const p = await post("/api/projects", { name: "Before", folders: [] });
		const c = await post(`/api/projects/${p.id}/chats`, { name: "Before" });
		for (const [path, body] of [
			[`/api/chats/${c.id}`, { name: "Saved chat" }],
			[
				`/api/projects/${p.id}`,
				{ name: "Saved project", folders: [directory] },
			],
		] as const) {
			// 100 Continue acknowledges headers before the request body finishes; the server has accepted this save.
			const request = httpRequest(base + path, {
				method: "PUT",
				headers: { "content-type": "application/json", expect: "100-continue" },
			});
			const continued = new Promise<void>((resolve) =>
				request.once("continue", resolve),
			);
			const result = new Promise<number | undefined>((resolve, reject) => {
				request.once("response", (response) => {
					response.resume();
					response.once("end", () => resolve(response.statusCode));
				});
				request.once("error", reject);
			});
			request.flushHeaders();
			await continued;
			assert.equal((await archive(path)).status, 200);
			request.end(JSON.stringify(body));
			assert.equal(await result, 200);
			assert.equal(
				(
					await fetch(base + path, {
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					})
				).status,
				409,
			);
		}
		const saved = (await (await fetch(`${base}/api/projects`)).json())
			.projects[0];
		assert.equal(saved.name, "Saved project");
		assert.deepEqual(saved.folders, [directory]);
		assert.equal(saved.archived, true);
		assert.equal(saved.chats[0].name, "Saved chat");
		assert.equal(saved.chats[0].archived, true);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
