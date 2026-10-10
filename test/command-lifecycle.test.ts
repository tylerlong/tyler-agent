import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { waitForAgent } from "./agent-fixture.ts";
import { configureDatabase, createTestServer } from "./config-fixture.ts";
import { localFetch as fetch } from "./local-fetch.ts";
import { completedResponse } from "./model-fixture.ts";

const call = (name: string, args: unknown, id: string) => ({
	id,
	call_id: id,
	type: "function_call",
	name,
	arguments: JSON.stringify(args),
});
const message = (text: string) => ({
	id: "answer",
	type: "message",
	content: [{ type: "output_text", text }],
});
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
async function until(check: () => Promise<boolean>) {
	for (let attempt = 0; attempt < 1000; attempt++) {
		if (await check()) return;
		await setTimeout(10);
	}
	assert.fail("Expected native command state did not arrive");
}

test("native subtree cancellation preserves sibling work and exact different-model communications", {
	timeout: 30000,
	skip:
		platform() !== "darwin" ? "Native restricted policy requires macOS" : false,
}, async () => {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "command-tree-")),
	);
	const root = join(directory, "project");
	await mkdir(root);
	const database = join(directory, "db.sqlite");
	configureDatabase(database, "lifecycle-private-key", "child-a");
	configureDatabase(database, "lifecycle-private-key", "child-b");
	const recordings: { prompt: string; request: string; response: unknown }[] =
		[];
	const server = createTestServer(
		async (_url, init) => {
			const request = String(init?.body);
			const body = JSON.parse(request);
			const prompt = body.input.find(
				(item: { role?: string }) => item.role === "user",
			).content;
			const continuation = body.input.some(
				(item: { type?: string }) => item.type === "function_call_output",
			);
			const expectedModel =
				prompt === "sibling"
					? "child-b"
					: prompt === "root"
						? "test"
						: "child-a";
			assert.equal(body.model, expectedModel);
			let output: unknown[];
			if (continuation) output = [message(`${prompt} done`)];
			else if (prompt === "root")
				output = [
					call(
						"create_sub_agent",
						{ prompt: "middle", model_id: "child-a" },
						"middle",
					),
					call(
						"create_sub_agent",
						{ prompt: "sibling", model_id: "child-b" },
						"sibling",
					),
				];
			else if (prompt === "middle")
				output = [call("create_sub_agent", { prompt: "leaf" }, "leaf")];
			else
				output = [
					call(
						"exec_command",
						{
							cwd: root,
							timeout_ms: 20000,
							command:
								prompt === "leaf"
									? "printf 'leaf-start:%s\\n' $$; sleep 15 && printf leaf-unexpected-finish"
									: `printf sibling-start; while test ! -f ${quote(join(root, "release"))}; do sleep 0.05; done; printf sibling-finished; printf trailing-stderr >&2`,
						},
						`${prompt}-command`,
					),
				];
			const response = {
				id: `response-${recordings.length}`,
				status: "completed",
				usage: {
					input_tokens: recordings.length + 11,
					output_tokens: 7,
					total_tokens: recordings.length + 18,
				},
				output,
			};
			recordings.push({ prompt, request, response });
			return completedResponse(response);
		},
		database,
		"lifecycle-private-key",
	).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const request = async (route: string, body?: unknown) => {
		const response = await fetch(
			base + route,
			body === undefined
				? undefined
				: { method: "POST", body: JSON.stringify(body) },
		);
		assert(response.ok, `${route}: ${response.status}`);
		return response.json();
	};
	let rootId = 0;
	try {
		const project = await request("/api/projects", {
			name: "Tree",
			folders: [root],
		});
		const chat = await request(`/api/projects/${project.id}/chats`, {
			name: "Tree",
		});
		rootId = (await request(`/api/chats/${chat.id}`, { prompt: "root" }))
			.agentId;
		await until(async () => {
			const tools = (await request(`/api/agents/${rootId}/tools`)).toolCalls;
			return (
				tools.length === 2 &&
				tools.every((tool: { result: string }) => tool.result)
			);
		});
		const creations = (await request(`/api/agents/${rootId}/tools`)).toolCalls;
		const middleId = JSON.parse(creations[0].result).agent_id;
		const siblingId = JSON.parse(creations[1].result).agent_id;
		let leafId = 0;
		await until(async () => {
			const tool = (await request(`/api/agents/${middleId}/tools`))
				.toolCalls[0];
			if (!tool?.result) return false;
			leafId = JSON.parse(tool.result).agent_id;
			return true;
		});
		const output = async (id: number) => {
			const tool = (await request(`/api/agents/${id}/tools`)).toolCalls[0];
			return tool
				? (await request(`/api/agents/${id}/tools?toolId=${tool.id}`))
						.toolCalls[0]
				: null;
		};
		await until(async () => {
			const leaf = await output(leafId),
				sibling = await output(siblingId);
			return Boolean(
				leaf?.output.some((chunk: { text: string }) =>
					chunk.text.includes("leaf-start:"),
				) &&
					sibling?.output.some((chunk: { text: string }) =>
						chunk.text.includes("sibling-start"),
					),
			);
		});
		const beforeLeaf = await output(leafId);
		const leafPid = Number(
			beforeLeaf.output
				.map((chunk: { text: string }) => chunk.text)
				.join("")
				.match(/leaf-start:(\d+)/)[1],
		);
		await request(`/api/agents/${middleId}/cancel`, {});
		assert.equal(
			(await request(`/api/agents/${middleId}`)).agents[0].status,
			"cancelled",
		);
		assert.equal(
			(await request(`/api/agents/${leafId}`)).agents[0].status,
			"cancelled",
		);
		assert.throws(() => process.kill(leafPid, 0), { code: "ESRCH" });
		const leaf = await output(leafId);
		assert.equal(leaf.status, "interrupted");
		assert.deepEqual(
			leaf.output.slice(0, beforeLeaf.output.length),
			beforeLeaf.output,
		);
		for (const [index, chunk] of leaf.output.entries()) {
			const bytes = Buffer.from(chunk.data, "base64");
			assert.equal(chunk.ordinal, index + 1);
			assert(["stdout", "stderr"].includes(chunk.stream));
			assert.equal(chunk.byteCount, bytes.length);
			assert.equal(chunk.text, bytes.toString("utf8"));
		}
		assert.doesNotMatch(
			leaf.output
				.filter((chunk: { stream: string }) => chunk.stream === "stdout")
				.map((chunk: { text: string }) => chunk.text)
				.join(""),
			/leaf-unexpected-finish/,
		);
		assert.equal(
			(await request(`/api/agents/${siblingId}`)).agents[0].status,
			"pending",
		);
		assert.equal((await output(siblingId)).status, "running");
		assert.equal((await request(`/api/chats/${chat.id}`)).busy, true);
		await writeFile(join(root, "release"), "go");
		assert.equal((await waitForAgent(base, rootId)).status, "succeeded");
		assert.deepEqual((await output(leafId)).output, leaf.output);
		assert.equal(
			(await request(`/api/agents/${siblingId}`)).agents[0].status,
			"succeeded",
		);
		const sibling = await output(siblingId);
		assert.equal(sibling.status, "succeeded");
		assert.equal(
			sibling.output
				.filter((chunk: { stream: string }) => chunk.stream === "stdout")
				.map((chunk: { text: string }) => chunk.text)
				.join(""),
			"sibling-startsibling-finished",
		);
		assert.equal(
			sibling.output
				.filter((chunk: { stream: string }) => chunk.stream === "stderr")
				.map((chunk: { text: string }) => chunk.text)
				.join(""),
			"trailing-stderr",
		);
		assert.equal(JSON.parse(sibling.result).exitCode, 0);
		let recordedCount = 0;
		for (const [id, prompt] of [
			[rootId, "root"],
			[middleId, "middle"],
			[leafId, "leaf"],
			[siblingId, "sibling"],
		] as const) {
			const calls = (await request(`/api/agents/${id}/calls`)).calls;
			const actual = recordings.filter(
				(recording) => recording.prompt === prompt,
			);
			assert.equal(calls.length, actual.length);
			recordedCount += calls.length;
			for (let index = 0; index < calls.length; index++) {
				assert.equal(calls[index].requestBody, actual[index].request);
				assert.deepEqual(
					JSON.parse(calls[index].responseBody),
					actual[index].response,
				);
				assert.equal(calls[index].httpStatus, 200);
			}
		}
		assert.equal(recordedCount, recordings.length);
		assert.equal(
			recordings.filter((recording) => recording.prompt === "leaf").length,
			1,
		);
		assert.equal(
			recordings.filter((recording) => recording.prompt === "sibling").length,
			2,
		);
		const count = recordings.length;
		await request("/api/approvals");
		await request(`/api/agents/${rootId}/tree`);
		await output(siblingId);
		await request(`/api/agents/${middleId}/cancel`, {});
		await setTimeout(50);
		assert.equal(
			recordings.length,
			count,
			"Management and log reads never request a model or replay cancelled work",
		);
		assert.equal(await readFile(join(root, "release"), "utf8"), "go");
	} finally {
		if (rootId) await request(`/api/agents/${rootId}/cancel`, {});
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
