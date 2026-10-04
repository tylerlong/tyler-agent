import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createTestServer as createServer } from "./config-fixture.ts";
import { completedResponse } from "./model-fixture.ts";
import { waitForTurn } from "./turn-fixture.ts";

test("edits preserve identity/history and persist atomically, including missing unchanged folders", async () => {
	const folder = await mkdtemp(join(tmpdir(), "agent-edit-"));
	const child = join(folder, "child");
	await mkdir(child);
	let release!: () => void;
	let entered!: () => void;
	const wait = new Promise<void>((r) => (release = r));
	const started = new Promise<void>((r) => (entered = r));
	const model = async () => {
		entered();
		await wait;
		return completedResponse({
			output: [
				{ type: "message", content: [{ type: "output_text", text: "answer" }] },
			],
		});
	};
	let server = createServer(model, join(folder, "db.sqlite")).listen(
		0,
		"127.0.0.1",
	);
	async function base() {
		if (!server.listening)
			await new Promise<void>((r) => server.once("listening", r));
		const a = server.address();
		assert(a && typeof a !== "string");
		return `http://127.0.0.1:${a.port}`;
	}
	async function request(path: string, method = "GET", input?: unknown) {
		return fetch(`${await base()}${path}`, {
			method,
			...(input === undefined
				? {}
				: {
						headers: { "content-type": "application/json" },
						body: JSON.stringify(input),
					}),
		});
	}
	try {
		const p = await (
			await request("/api/projects", "POST", { name: "Work", folders: [child] })
		).json();
		const c = await (
			await request(`/api/projects/${p.id}/chats`, "POST", { name: "Chat" })
		).json();
		const pending = request(`/api/chats/${c.id}`, "POST", {
			modelId: "test",
			prompt: "hi",
		});
		await started;
		const before = (await (await request("/api/projects")).json()).projects[0];
		await rm(child, { recursive: true });
		assert.equal(
			(
				await request(`/api/projects/${p.id}`, "PUT", {
					name: "Renamed",
					folders: [child],
				})
			).status,
			200,
		);
		assert.equal(
			(await request(`/api/chats/${c.id}`, "PUT", { name: " Renamed chat " }))
				.status,
			200,
		);
		assert.equal(
			(
				await request(`/api/projects/${p.id}`, "PUT", {
					name: "Wrong",
					folders: [join(folder, "missing")],
				})
			).status,
			400,
		);
		assert.equal(
			(await request(`/api/chats/${c.id}`, "PUT", { name: " " })).status,
			400,
		);
		let after = (await (await request("/api/projects")).json()).projects[0];
		assert.equal(after.name, "Renamed");
		assert.deepEqual(after.folders, [child]);
		assert.equal(after.createdAt, before.createdAt);
		assert.deepEqual(after.chats[0], {
			...before.chats[0],
			name: "Renamed chat",
		});
		const faults = new DatabaseSync(join(folder, "db.sqlite"));
		try {
			faults.exec(
				"CREATE TRIGGER fail_folder_insert BEFORE INSERT ON folders BEGIN SELECT RAISE(ABORT,'test failure'); END",
			);
			assert.equal(
				(
					await request(`/api/projects/${p.id}`, "PUT", {
						name: "Partial",
						folders: [folder],
					})
				).status,
				500,
			);
			assert.deepEqual(
				(await (await request("/api/projects")).json()).projects[0],
				after,
			);
			faults.exec("DROP TRIGGER fail_folder_insert");
		} finally {
			faults.close();
		}
		assert.equal(
			(
				await request(`/api/projects/${p.id}`, "PUT", {
					name: "Renamed",
					folders: [],
				})
			).status,
			200,
		);
		release();
		const accepted = await pending;
		assert.equal(accepted.status, 202);
		await waitForTurn(await base(), (await accepted.json()).turnId);
		const history = await (await request(`/api/chats/${c.id}`)).json();
		assert.equal(history.messages.length, 2);
		assert.equal(
			(await request("/api/projects/999", "PUT", { name: "x", folders: [] }))
				.status,
			404,
		);
		await new Promise<void>((r) => server.close(() => r()));
		server = createServer(model, join(folder, "db.sqlite")).listen(
			0,
			"127.0.0.1",
		);
		after = (await (await request("/api/projects")).json()).projects[0];
		assert.equal(after.id, p.id);
		assert.deepEqual(after.folders, []);
		assert.equal(after.chats[0].name, "Renamed chat");
		assert.deepEqual(
			await (await request(`/api/chats/${c.id}`)).json(),
			history,
		);
	} finally {
		release();
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
		await rm(folder, { recursive: true, force: true });
	}
});
