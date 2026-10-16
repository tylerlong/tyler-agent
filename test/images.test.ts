import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { imageFromBytes } from "../src/image-content.ts";
import { jiraMcpService } from "../src/mcp-config.ts";
import { waitForAgent } from "./agent-fixture.ts";
import { createTestServer } from "./config-fixture.ts";
import { localFetch as fetch } from "./local-fetch.ts";
import { completedBody } from "./model-fixture.ts";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYioAAAAASUVORK5CYII=",
	"base64",
);
const answer = {
	type: "message",
	content: [{ type: "output_text", text: "accepted visual answer" }],
};
test("user and native tool images preserve exact protocol, record ownership and successful history", {
	skip: process.platform !== "darwin",
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "image-http-"));
	const imagePath = join(directory, "shot.png");
	const submittedPng = Buffer.concat([png, Buffer.alloc(9000)]);
	await writeFile(imagePath, submittedPng);
	const path = join(directory, "db.sqlite");
	const requests: { input: { type?: string; content: unknown }[] }[] = [];
	const server = createTestServer(
		async (_url, init) => {
			const request = JSON.parse(String(init?.body));
			requests.push(request);
			return new Response(
				completedBody({
					status: "completed",
					output:
						requests.length === 1
							? [
									{
										type: "function_call",
										name: "read_image",
										call_id: "image-call",
										arguments: JSON.stringify({ path: imagePath }),
									},
								]
							: [answer],
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
		path,
		"iVBOR",
	).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const send = (route: string, input: unknown) =>
		fetch(base + route, { method: "POST", body: JSON.stringify(input) });
	try {
		const service = jiraMcpService();
		service.env.push(
			...["type", "text", "image_url", "input_image", "input_text"].map(
				(value, index) => ({ name: `ENVELOPE_${index}`, value }),
			),
		);
		assert.equal(
			(
				await fetch(`${base}/api/mcp-settings`, {
					method: "PUT",
					body: JSON.stringify({ services: [service] }),
				})
			).status,
			200,
		);
		const project = await (
			await send("/api/projects", { name: "images", folders: [directory] })
		).json();
		const chat = await (
			await send(`/api/projects/${project.id}/chats`, { name: "vision" })
		).json();
		const image = imageFromBytes(submittedPng);
		const accepted = await send(`/api/chats/${chat.id}`, {
			prompt: "inspect image",
			images: [image],
		});
		assert.equal(accepted.status, 202);
		const { agentId } = await accepted.json();
		const agent = await waitForAgent(base, agentId);
		assert.equal(agent.status, "succeeded");
		assert.deepEqual(requests[0].input.at(-1), {
			role: "user",
			content: [{ type: "input_text", text: "inspect image" }, image],
		});
		assert.deepEqual(requests[1].input.at(-1), {
			type: "function_call_output",
			call_id: "image-call",
			output: [image],
		});

		// Actual Tool Result remains inspectable after the source file changes.
		await rm(imagePath);
		const db = new DatabaseSync(path);
		const record = db
			.prepare("SELECT result FROM tool_calls WHERE call_id='image-call'")
			.get();
		assert.deepEqual(JSON.parse(String(record?.result)), [image]);
		const firstRequest = db
			.prepare(
				"SELECT request_body FROM model_calls WHERE agent_id=? ORDER BY id LIMIT 1",
			)
			.get(agentId);
		assert.deepEqual(
			JSON.parse(String(firstRequest?.request_body)).input,
			requests[0].input,
		);
		assert.deepEqual(agent.images, [image]);
		const next = await send(`/api/chats/${chat.id}`, { prompt: "continue" });
		const nextId = (await next.json()).agentId;
		assert.equal((await waitForAgent(base, nextId)).status, "succeeded");
		assert.deepEqual(requests[2].input[0], requests[0].input[0]);
		assert.equal(
			requests[2].input.some((part) => part.type === "function_call_output"),
			false,
		);
		assert.equal(requests[2].input[1].content, "accepted visual answer");
		db.prepare("UPDATE managed_models SET metadata=?").run(
			JSON.stringify({
				reasoningRequired: false,
				inputModalities: ["text"],
			}),
		);
		db.close();
		const rejected = await send(`/api/chats/${chat.id}`, {
			prompt: "image again",
			images: [image],
		});
		assert.equal(rejected.status, 400);
		assert.equal((await rejected.json()).code, "modelImageUnsupported");
		assert.equal(requests.length, 3);
		const invalid = await send(`/api/chats/${chat.id}`, {
			prompt: "bad image",
			images: [
				{ type: "input_image", image_url: "https://example.com/picture.png" },
			],
		});
		assert.equal(invalid.status, 400);
		assert.equal((await invalid.json()).code, "invalidImages");
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

test("known text-only model gets a tool error and chooses its next action without retry", async () => {
	const directory = await mkdtemp(join(tmpdir(), "image-capability-"));
	const path = join(directory, "db.sqlite");
	let count = 0;
	const server = createTestServer(async (_url, init) => {
		count++;
		const body = JSON.parse(String(init?.body));
		if (count === 2) {
			assert.equal(body.input.at(-1).type, "function_call_output");
			assert.match(body.input.at(-1).output, /does not support image/);
		}
		return new Response(
			completedBody({
				status: "completed",
				output:
					count === 1
						? [
								{
									type: "function_call",
									name: "read_image",
									call_id: "no-image",
									arguments: JSON.stringify({ path: "/tmp/unused.png" }),
								},
							]
						: [answer],
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);
	}, path).listen(0, "127.0.0.1");
	await new Promise<void>((r) => server.once("listening", r));
	const address = server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const db = new DatabaseSync(path);
	db.prepare("UPDATE managed_models SET metadata=?").run(
		JSON.stringify({
			reasoningRequired: false,
			inputModalities: ["text"],
		}),
	);
	db.close();
	const send = (route: string, input: unknown) =>
		fetch(base + route, { method: "POST", body: JSON.stringify(input) });
	try {
		const project = await (
			await send("/api/projects", { name: "P", folders: [] })
		).json();
		const chat = await (
			await send(`/api/projects/${project.id}/chats`, { name: "C" })
		).json();
		const response = await send(`/api/chats/${chat.id}`, {
			prompt: "read screenshot",
		});
		const { agentId } = await response.json();
		const agent = await waitForAgent(base, agentId);
		assert.equal(agent.status, "succeeded");
		assert.equal(agent.toolCalls[0].status, "failed");
		assert.equal(count, 2);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
		await rm(directory, { recursive: true, force: true });
	}
});
