import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { waitForAgent } from "./agent-fixture.ts";
import { createTestServer as createServer } from "./config-fixture.ts";
import { localFetch as fetch } from "./local-fetch.ts";
import { completedResponse } from "./model-fixture.ts";

test("two SSE clients see creations and language changes; reconnection reads current shared state", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-sse-"));
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const server = createServer(
		async () => {
			await held;
			return completedResponse({
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: "answer" }],
					},
				],
			});
		},
		join(directory, "db.sqlite"),
	).listen(0, "127.0.0.1");
	const controllers: AbortController[] = [];
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		async function connect() {
			const controller = new AbortController();
			controllers.push(controller);
			const response = await fetch(`${base}/api/events`, {
				signal: controller.signal,
			});
			assert(response.body);
			const reader = response.body.getReader();
			let buffer = "";
			async function next(kind?: "agent" | "changed") {
				while (true) {
					while (!buffer.includes("\n\n")) {
						const chunk = await reader.read();
						assert(!chunk.done);
						buffer += new TextDecoder().decode(chunk.value);
					}
					const end = buffer.indexOf("\n\n");
					const frame = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					if (
						!kind ||
						(kind === "agent"
							? frame.startsWith("event: agent")
							: frame === "data: changed")
					)
						return frame;
				}
			}
			assert.equal(await next(), ": connected");
			return { next, controller };
		}
		const first = await connect();
		const second = await connect();
		const sharedState = async (chatId?: number) => ({
			projects: (await (await fetch(`${base}/api/projects`)).json()).projects,
			language: await (await fetch(`${base}/api/language`)).json(),
			enterBehavior: await (await fetch(`${base}/api/enter-behavior`)).json(),
			chat:
				chatId === undefined
					? null
					: await (await fetch(`${base}/api/chats/${chatId}`)).json(),
		});
		async function agree(chatId?: number) {
			const [a, b] = await Promise.all([
				sharedState(chatId),
				sharedState(chatId),
			]);
			assert.deepEqual(a, b);
			return a;
		}
		assert.deepEqual(await (await fetch(`${base}/api/language`)).json(), {
			language: "en",
		});
		await fetch(`${base}/api/enter-behavior`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ behavior: "newline" }),
		});
		assert.deepEqual(
			await Promise.all([first.next("changed"), second.next("changed")]),
			["data: changed", "data: changed"],
		);
		assert.deepEqual(await (await fetch(`${base}/api/enter-behavior`)).json(), {
			behavior: "newline",
		});

		const project = await (
			await fetch(`${base}/api/projects`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "Work", folders: [directory] }),
			})
		).json();
		assert.deepEqual(
			await Promise.all([first.next("changed"), second.next("changed")]),
			["data: changed", "data: changed"],
		);
		assert.equal((await agree()).projects[0].id, project.id);
		const chat = await (
			await fetch(`${base}/api/projects/${project.id}/chats`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "Question" }),
			})
		).json();
		assert.deepEqual(
			await Promise.all([first.next("changed"), second.next("changed")]),
			["data: changed", "data: changed"],
		);
		assert.equal((await agree(chat.id)).projects[0].chats[0].id, chat.id);
		const accepted = await fetch(`${base}/api/chats/${chat.id}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ modelId: "test", prompt: "question" }),
		});
		assert.equal(accepted.status, 202);
		const { agentId } = await accepted.json();
		await Promise.all([first.next("agent"), second.next("agent")]);
		const active = await agree(chat.id);
		assert.equal(active.chat.busy, true);
		assert.equal(typeof active.projects[0].chats[0].lastQuestionAt, "number");
		release();
		assert.equal((await waitForAgent(base, agentId)).status, "succeeded");
		await Promise.all([first.next("agent"), second.next("agent")]);
		const shared = (await agree(chat.id)).chat;
		assert.equal(shared.busy, false);
		assert.equal(shared.messages.length, 2);
		first.controller.abort();
		await fetch(`${base}/api/projects`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Missed", folders: [directory] }),
		});
		await second.next("changed");
		const reconnected = await connect();
		const restored = await agree(chat.id);
		assert.equal(restored.projects.length, 2);
		assert.equal(restored.chat.messages.length, 2);
		assert.equal(
			(await (await fetch(`${base}/api/projects`)).json()).projects.find(
				(p: { id: number }) => p.id === project.id,
			).chats.length,
			1,
		);
		const db = new DatabaseSync(join(directory, "db.sqlite"));
		db.exec(
			"CREATE TRIGGER reject_language BEFORE UPDATE OF language ON settings BEGIN SELECT RAISE(ABORT,'write failed'); END",
		);
		try {
			assert.equal(
				(
					await fetch(`${base}/api/language`, {
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ language: "zh-CN" }),
					})
				).status,
				500,
			);
			assert.deepEqual(await (await fetch(`${base}/api/language`)).json(), {
				language: "en",
			});
			assert.equal(
				db.prepare("SELECT language FROM settings").get()?.language,
				"en",
			);
		} finally {
			db.exec("DROP TRIGGER reject_language");
			db.close();
		}
		await fetch(`${base}/api/language`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ language: "zh-CN" }),
		});
		assert.deepEqual(
			await Promise.all([second.next("changed"), reconnected.next("changed")]),
			["data: changed", "data: changed"],
		);
		assert.deepEqual(await (await fetch(`${base}/api/language`)).json(), {
			language: "zh-CN",
		});
		assert.equal(
			(
				await fetch(`${base}/api/language`, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ language: "fr" }),
				})
			).status,
			400,
		);
	} finally {
		for (const controller of controllers) controller.abort();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
