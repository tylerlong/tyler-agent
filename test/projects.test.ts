import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "../src/server.ts";

test("projects and empty chats survive restart without default records", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-projects-"));
	const path = join(directory, "app.sqlite");
	let server = createServer(fetch, path).listen(0, "127.0.0.1");
	async function base() {
		if (!server.listening)
			await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		return `http://127.0.0.1:${address.port}`;
	}
	try {
		const url = await base();
		assert.deepEqual(await (await fetch(`${url}/api/projects`)).json(), {
			projects: [],
		});
		const project = await (
			await fetch(`${url}/api/projects`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: " Work ", folders: [directory] }),
			})
		).json();
		assert.equal(project.name, "Work");
		const chat = await (
			await fetch(`${url}/api/projects/${project.id}/chats`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: " Question " }),
			})
		).json();
		assert.equal(chat.name, "Question");
		await new Promise<void>((resolve) => server.close(() => resolve()));
		server = createServer(fetch, path).listen(0, "127.0.0.1");
		const projects = (
			await (await fetch(`${await base()}/api/projects`)).json()
		).projects;
		assert.equal(projects.length, 1);
		assert.deepEqual(projects[0].folders, [directory]);
		assert.equal(projects[0].chats[0].id, chat.id);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
