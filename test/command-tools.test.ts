import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { outputPage } from "../src/command-tools.ts";
import { waitForAgent } from "./agent-fixture.ts";
import { createTestServer } from "./config-fixture.ts";
import { localFetch as fetch, managementTokens } from "./local-fetch.ts";
import { completedBody } from "./model-fixture.ts";

const commandTest = (name: string, run: () => Promise<void>) =>
	test(
		name,
		{
			skip:
				platform() !== "darwin"
					? "Native exec-server integration is verified on macOS"
					: false,
		},
		run,
	);

test("output pages accept single-use iterators and preserve character offsets and totals", () => {
	function* chunks() {
		yield { ordinal: 1, stream: "stdout", text: "A🙂" };
		yield { ordinal: 2, stream: "stderr", text: "中!" };
		yield { ordinal: 3, stream: "pty", text: "\rZ" };
	}
	assert.deepEqual(outputPage(chunks(), 0, 3), {
		chunks: [{ ordinal: 1, stream: "stdout", text: "A🙂" }],
		next_offset: 3,
		total_chars: 7,
	});
	assert.deepEqual(outputPage(chunks(), 2, 4), {
		chunks: [
			{ ordinal: 1, stream: "stdout", text: "\ude42" },
			{ ordinal: 2, stream: "stderr", text: "中!" },
			{ ordinal: 3, stream: "pty", text: "\r" },
		],
		next_offset: 6,
		total_chars: 7,
	});
	for (const offset of [7, 9])
		assert.deepEqual(outputPage(chunks(), offset), {
			chunks: [],
			next_offset: 7,
			total_chars: 7,
		});
	assert.deepEqual(outputPage(chunks(), 2, 0), {
		chunks: [],
		next_offset: 2,
		total_chars: 7,
	});
	assert.deepEqual(outputPage([][Symbol.iterator]()), {
		chunks: [],
		next_offset: 0,
		total_chars: 0,
	});
});

const call = (name: string, args: unknown, id = "command") => ({
	id,
	call_id: id,
	type: "function_call",
	name,
	arguments: JSON.stringify(args),
});
const done = (output: unknown[]) =>
	new Response(completedBody({ status: "completed", output }));
const answer = {
	id: "answer",
	type: "message",
	content: [{ type: "output_text", text: "done" }],
};
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const stdout = (chunks: { stream: string; text: string }[]) =>
	text(chunks.filter((chunk) => chunk.stream === "stdout"));
const text = (chunks: { text: string }[]) =>
	chunks.map((chunk) => chunk.text).join("");
async function fixture(model: typeof globalThis.fetch, apiKey = "test") {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "command-http-")),
	);
	const root = join(directory, "project");
	await mkdir(root);
	let server = createTestServer(
		model,
		join(directory, "db.sqlite"),
		apiKey,
	).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	let base = `http://127.0.0.1:${address.port}`;
	const request = async (route: string, body?: unknown, method = "POST") => {
		const response = await fetch(
			base + route,
			body === undefined ? undefined : { method, body: JSON.stringify(body) },
		);
		assert(response.ok, `${route}: ${response.status}`);
		return response.json();
	};
	const project = await request("/api/projects", {
		name: "Command fixture",
		folders: [root],
	});
	const ask = async (prompt = "run") => {
		const chat = await request(`/api/projects/${project.id}/chats`, {
			name: prompt,
		});
		return (await request(`/api/chats/${chat.id}`, { prompt }))
			.agentId as number;
	};
	return {
		directory,
		root,
		projectId: project.id,
		request,
		ask,
		wait: (id: number) => waitForAgent(base, id),
		restart: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			server = createTestServer(
				model,
				join(directory, "db.sqlite"),
				apiKey,
			).listen(0, "127.0.0.1");
			await new Promise<void>((resolve) => server.once("listening", resolve));
			const address = server.address();
			assert(address && typeof address !== "string");
			base = `http://127.0.0.1:${address.port}`;
		},
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		},
	};
}

commandTest(
	"coding round trip reads, patches, installs an outside-project dependency, builds/tests/Git and continues logs",
	async () => {
		let root = "",
			archive = "",
			requests = 0,
			commandId = 0;
		const recordings: { request: string; response: unknown }[] = [];
		const pages: { stream: string; text: string }[] = [];
		const f = await fixture(async (_url, init) => {
			const request = String(init?.body);
			const body = JSON.parse(request);
			const results = body.input.filter(
				(item: { type: string }) => item.type === "function_call_output",
			);
			let output: unknown[];
			switch (++requests) {
				case 1:
					output = [
						call("read_file", { path: join(root, "build.cjs") }, "read"),
					];
					break;
				case 2:
					assert.match(JSON.parse(results.at(-1).output).text, /before/);
					output = [
						call(
							"apply_patch",
							{
								cwd: root,
								patch:
									"*** Begin Patch\n*** Update File: build.cjs\n@@\n-require('node:fs').writeFileSync('built.txt', 'before');\n+require('node:fs').writeFileSync('built.txt', require('fixture-dependency'));\n*** End Patch",
							},
							"patch",
						),
					];
					break;
				case 3:
					assert.equal(JSON.parse(results.at(-1).output).exitCode, 0);
					output = [
						call(
							"exec_command",
							{
								command: `npm install --offline --ignore-scripts --no-audit --no-fund ${quote(archive)} && node build.cjs && env -u NODE_TEST_CONTEXT node --test check.cjs && git init -b main && git add . && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m fixture && git status --porcelain && node -e "process.stdout.write('x'.repeat(20000));process.stderr.write('log-tail')"`,
								cwd: root,
								timeout_ms: 20000,
							},
							"coding",
						),
					];
					break;
				case 4: {
					const result = JSON.parse(results.at(-1).output);
					assert.equal(result.exitCode, 0, JSON.stringify(result));
					assert.match(text(result.output.chunks), /pass 1/);
					assert.equal(text(result.output.chunks).length, 16000);
					assert(result.output.total_chars > 20000);
					pages.push(...result.output.chunks);
					commandId = result.tool_call_id;
					output = [
						call(
							"read_tool_output",
							{ tool_call_id: commandId, offset: result.output.next_offset },
							"continuation",
						),
					];
					break;
				}
				default: {
					const continuation = JSON.parse(results.at(-1).output);
					assert(text(continuation.chunks).length > 0);
					pages.push(...continuation.chunks);
					assert.match(text(pages), /log-tail/);
					output = [answer];
				}
			}
			const response = {
				id: `coding-${requests}`,
				status: "completed",
				output,
				usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
			};
			recordings.push({ request, response });
			return new Response(completedBody(response));
		}, "coding-private-key");
		root = f.root;
		archive = join(f.directory, "dependency.tgz");
		try {
			const dependency = join(f.directory, "package");
			await mkdir(dependency);
			await writeFile(
				join(dependency, "package.json"),
				JSON.stringify({
					name: "fixture-dependency",
					version: "1.0.0",
					main: "index.cjs",
				}),
			);
			await writeFile(
				join(dependency, "index.cjs"),
				"module.exports = 'built';",
			);
			await promisify(execFile)("tar", [
				"-czf",
				archive,
				"-C",
				f.directory,
				"package",
			]);
			await writeFile(
				join(root, "package.json"),
				'{"name":"coding-fixture","version":"1.0.0","private":true}',
			);
			await writeFile(
				join(root, "build.cjs"),
				"require('node:fs').writeFileSync('built.txt', 'before');\n",
			);
			await writeFile(
				join(root, "check.cjs"),
				"require('node:assert/strict').equal(require('node:fs').readFileSync('built.txt','utf8'),'built')",
			);
			const id = await f.ask();
			const agent = await f.wait(id);
			assert.equal(agent.status, "succeeded", JSON.stringify(agent));
			assert.equal(await readFile(join(root, "built.txt"), "utf8"), "built");
			assert.match(
				await readFile(join(root, "package-lock.json"), "utf8"),
				/fixture-dependency/,
			);
			assert.equal(
				(
					await promisify(execFile)("git", ["status", "--porcelain"], {
						cwd: root,
					})
				).stdout,
				"",
			);
			const saved = (
				await f.request(`/api/agents/${id}/tools?toolId=${commandId}`)
			).toolCalls[0];
			assert.match(stdout(saved.output), /x{20000}$/);
			assert.match(
				text(
					saved.output.filter(
						(chunk: { stream: string }) => chunk.stream === "stderr",
					),
				),
				/log-tail$/,
			);
			const allCalls = (await f.request(`/api/agents/${id}/calls`)).calls;
			assert.equal(allCalls.length, 9);
			const calls = allCalls.filter((call: { url: string }) =>
				call.url.endsWith("/responses"),
			);
			assert.equal(calls.length, 5);
			for (let index = 0; index < calls.length; index++) {
				assert.equal(calls[index].requestBody, recordings[index].request);
				assert.deepEqual(
					JSON.parse(calls[index].responseBody),
					recordings[index].response,
				);
			}
			await f.request(`/api/agents/${id}/tools?toolId=${commandId}`);
			assert.equal(requests, 5, "Management/log reads add no model calls");
		} finally {
			await f.close();
		}
	},
);

commandTest(
	"text-only command logs retain split UTF-8, invalid-byte markers and every stream",
	async () => {
		let root = "",
			requests = 0,
			toolId = 0;
		const f = await fixture(async (_url, init) => {
			if (++requests === 1)
				return done([
					call("exec_command", {
						cmd: "node text.cjs",
						workdir: root,
						timeout_ms: 10000,
					}),
				]);
			const result = JSON.parse(
				JSON.parse(String(init?.body)).input.at(-1).output,
			);
			assert.equal(result.exitCode, 0);
			assert.equal(stdout(result.output.chunks), "中��");
			toolId = result.tool_call_id;
			return done([answer]);
		});
		root = f.root;
		try {
			await writeFile(
				join(root, "text.cjs"),
				"process.stdout.write(Buffer.from([0xe4,0xb8]));setTimeout(()=>{process.stdout.write(Buffer.from([0xad,0xff,0xe2]));process.stderr.write('stderr\\n')},30)",
			);
			const id = await f.ask();
			assert.equal((await f.wait(id)).status, "succeeded");
			const saved = (
				await f.request(`/api/agents/${id}/tools?toolId=${toolId}`)
			).toolCalls[0].output;
			assert.equal(stdout(saved), "中��");
			assert.equal(
				text(
					saved.filter(
						(chunk: { stream: string }) => chunk.stream === "stderr",
					),
				),
				"stderr\n",
			);
			for (const [index, chunk] of saved.entries()) {
				assert.deepEqual(Object.keys(chunk).sort(), [
					"ordinal",
					"stream",
					"text",
				]);
				assert.equal(chunk.ordinal, index + 1);
			}
		} finally {
			await f.close();
		}
	},
);

commandTest(
	"command logs archive every stream and trailing chunk beyond bounded model output",
	async () => {
		let root = "",
			requests = 0,
			toolId = 0;
		const pages: { ordinal: number; stream: string; text: string }[] = [];
		const f = await fixture(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			if (++requests === 1)
				return done([
					call("exec_command", {
						command: "node logs.cjs",
						cwd: root,
						timeout_ms: 10000,
					}),
				]);
			if (requests === 5)
				return done([
					call("read_tool_output", { tool_call_id: toolId }, "foreign"),
				]);
			const result = JSON.parse(body.input.at(-1).output);
			if (requests === 6) {
				assert.match(result.error, /only for this Agent/);
				return done([answer]);
			}
			if (requests === 2) {
				assert.equal(result.exitCode, 0, JSON.stringify(result));
				toolId = result.tool_call_id;
				pages.push(...result.output.chunks);
				assert.equal(text(result.output.chunks).length, 16000);
				assert.equal(result.output.next_offset, 16000);
				assert.equal(result.output.total_chars, 40008);
				return done([
					call(
						"read_tool_output",
						{ tool_call_id: toolId, offset: 16000, limit: 16000 },
						"page",
					),
				]);
			}
			if (requests === 3) {
				pages.push(...result.chunks);
				assert.equal(text(result.chunks).length, 16000);
				assert.equal(result.next_offset, 32000);
				return done([
					call(
						"read_tool_output",
						{ tool_call_id: toolId, offset: 32000 },
						"tail",
					),
				]);
			}
			assert.equal(result.next_offset, 40008);
			pages.push(...result.chunks);
			assert.equal(text(result.chunks).length, 8008);
			// Independent pipes preserve their own bytes; cross-stream delivery order is not write order.
			assert.equal(stdout(pages), `${"x".repeat(40000)}tail`);
			assert.equal(
				text(pages.filter((chunk) => chunk.stream === "stderr")),
				"err\n",
			);
			assert(
				pages.every(
					(chunk, index) =>
						index === 0 || chunk.ordinal >= pages[index - 1].ordinal,
				),
			);
			return done([answer]);
		});
		root = f.root;
		try {
			await writeFile(
				join(root, "logs.cjs"),
				"process.stdout.write('x'.repeat(40000),()=>process.stderr.write('err\\n',()=>process.stdout.write('tail')))",
			);
			const id = await f.ask();
			const agent = await f.wait(id);
			assert.equal(agent.status, "succeeded", JSON.stringify(agent));
			const saved = (
				await f.request(`/api/agents/${id}/tools?toolId=${toolId}`)
			).toolCalls[0];
			assert(Array.isArray(saved.output));
			assert.equal(stdout(saved.output), `${"x".repeat(40000)}tail`);
			assert.equal(
				text(
					saved.output.filter(
						(chunk: { stream: string }) => chunk.stream === "stderr",
					),
				),
				"err\n",
			);
			assert.equal(text(saved.output).length, 40008);
			assert(
				saved.output.some(
					(chunk: { stream: string }) => chunk.stream === "stderr",
				),
			);
			assert.deepEqual(
				saved.output.map((chunk: { ordinal: number }) => chunk.ordinal),
				saved.output.map((_chunk: unknown, index: number) => index + 1),
			);
			const other = await f.ask("other");
			// A fresh Agent's first model response is deliberately a read of the old log.
			assert.equal((await f.wait(other)).status, "succeeded");
		} finally {
			await f.close();
		}
	},
);

commandTest(
	"validated command budgets reject invalid input and timeout retains received output",
	async () => {
		let root = "",
			requests = 0;
		const invalid = [0, -1, 1.5, 3600001, "100"];
		const f = await fixture(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			if (++requests === 1)
				return done([
					...invalid.map((budget, index) =>
						call(
							"exec_command",
							{
								command: "touch should-not-exist",
								cwd: root,
								timeout_ms: budget,
							},
							`invalid-${index}`,
						),
					),
					call(
						"exec_command",
						{
							command: "printf before; sleep 30; printf after",
							cwd: root,
							timeout_ms: 500,
						},
						"timeout",
					),
				]);
			const results = body.input
				.filter(
					(item: { type: string }) => item.type === "function_call_output",
				)
				.map((item: { output: string }) => JSON.parse(item.output));
			for (const result of results.slice(0, invalid.length))
				assert.equal(typeof result.error, "string");
			const timedOut = results.at(-1);
			assert.equal(timedOut.timedOut, true);
			assert.equal(stdout(timedOut.output.chunks), "before");
			return done([answer]);
		});
		root = f.root;
		try {
			const id = await f.ask();
			const agent = await f.wait(id);
			assert.equal(agent.status, "succeeded", JSON.stringify(agent));
			await assert.rejects(readFile(join(root, "should-not-exist")), {
				code: "ENOENT",
			});
		} finally {
			await f.close();
		}
	},
);

commandTest(
	"cancelling one running command settles cleanup while another Agent completes",
	async () => {
		let root = "";
		const f = await fixture(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			if (
				body.input.some(
					(item: { type: string }) => item.type === "function_call_output",
				)
			)
				return done([answer]);
			const slow = body.input.some((item: { content?: unknown }) =>
				JSON.stringify(item).includes("slow"),
			);
			return done([
				call("exec_command", {
					command: slow
						? "printf started; sleep 30; printf escaped > escaped"
						: "sleep 1; printf sibling > sibling",
					cwd: root,
					timeout_ms: 10000,
				}),
			]);
		});
		root = f.root;
		try {
			const slow = await f.ask("slow");
			let saved: { id: number } | undefined;
			for (let attempt = 0; attempt < 500; attempt++) {
				saved = (await f.request(`/api/agents/${slow}/tools`)).toolCalls[0];
				if (saved) {
					const detail = (
						await f.request(`/api/agents/${slow}/tools?toolId=${saved.id}`)
					).toolCalls[0];
					if (detail.output && text(detail.output).includes("started")) break;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert(saved, "slow command started");
			const sibling = await f.ask("fast");
			await f.request(`/api/agents/${slow}/cancel`, {});
			assert.equal((await f.wait(slow)).status, "cancelled");
			assert.equal((await f.wait(sibling)).status, "succeeded");
			assert.equal(await readFile(join(root, "sibling"), "utf8"), "sibling");
			await assert.rejects(readFile(join(root, "escaped")), { code: "ENOENT" });
			const detail = (
				await f.request(`/api/agents/${slow}/tools?toolId=${saved.id}`)
			).toolCalls[0];
			assert.equal(stdout(detail.output), "started");
		} finally {
			await f.close();
		}
	},
);

test("command and output-read validation return recorded errors without starting native work", async () => {
	const operations = [
		call(
			"exec_command",
			{ command: "touch forbidden", cwd: "/", timeout_ms: 0 },
			"zero",
		),
		call(
			"exec_command",
			{ command: "touch forbidden", cwd: "relative", timeout_ms: 10 },
			"cwd",
		),
		call("exec_command", { command: " ", cwd: "/", timeout_ms: 10 }, "empty"),
		call(
			"exec_command",
			{ command: "touch forbidden", cwd: "/", timeout_ms: 10, sandbox: {} },
			"policy",
		),
		call(
			"exec_command",
			{ command: "touch forbidden", cwd: "/", extra_permissions: {} },
			"removed-extra",
		),
		call(
			"exec_command",
			{ command: "touch forbidden", cwd: "/", reason: "old approval" },
			"removed-reason",
		),
		call(
			"read_file",
			{ path: "/", extra_permissions: {} },
			"removed-file-extra",
		),
		call(
			"apply_patch",
			{ cwd: "/", patch: "unused", reason: "old approval" },
			"removed-patch-reason",
		),
		call("read_tool_output", { tool_call_id: 1, offset: -1 }, "offset"),
		call("read_tool_output", { tool_call_id: 1, limit: 16001 }, "limit"),
		call("read_tool_output", { tool_call_id: 0 }, "id"),
		call("read_tool_output", { tool_call_id: 1, process: "raw" }, "handle"),
		call("read_tool_output", { tool_call_id: 999999 }, "unknown"),
	];
	let requests = 0;
	const f = await fixture(async (_url, init) => {
		if (++requests === 1) return done(operations);
		const results = JSON.parse(String(init?.body)).input.filter(
			(item: { type: string }) => item.type === "function_call_output",
		);
		assert.equal(results.length, operations.length);
		for (const result of results)
			assert.equal(typeof JSON.parse(result.output).error, "string");
		assert.match(
			JSON.parse(results.at(-1).output).error,
			/only for this Agent/,
		);
		return done([answer]);
	});
	try {
		const id = await f.ask();
		const agent = await f.wait(id);
		assert.equal(agent.status, "succeeded", JSON.stringify(agent));
		const tools = (await f.request(`/api/agents/${id}/tools`)).toolCalls;
		assert.equal(tools.length, operations.length);
		assert(tools.every((tool: { status: string }) => tool.status === "failed"));
		assert.equal(requests, 2);
	} finally {
		await f.close();
	}
});

commandTest(
	"root cancellation waits for real root and child command cleanup",
	async () => {
		let root = "";
		const f = await fixture(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			if (
				body.input.some(
					(item: { type: string }) => item.type === "function_call_output",
				)
			)
				return done([answer]);
			const child = JSON.stringify(body.input).includes("child-work");
			const operation = call("exec_command", {
				command: `printf ${child ? "child-start" : "root-start"}; sleep 30; printf escaped > ${child ? "child-escaped" : "root-escaped"}`,
				cwd: root,
				timeout_ms: 10000,
			});
			return done(
				child
					? [operation]
					: [
							call("create_sub_agent", { prompt: "child-work" }, "child"),
							operation,
						],
			);
		});
		root = f.root;
		try {
			const id = await f.ask("subtree");
			let childId = 0,
				rootTool = 0,
				childTool = 0;
			for (let attempt = 0; attempt < 500; attempt++) {
				const tools = (await f.request(`/api/agents/${id}/tools`)).toolCalls;
				const creation = tools.find(
					(tool: { name: string }) => tool.name === "create_sub_agent",
				);
				if (creation) {
					const detail = (
						await f.request(`/api/agents/${id}/tools?toolId=${creation.id}`)
					).toolCalls[0];
					if (detail.result) childId = JSON.parse(detail.result).agent_id ?? 0;
				}
				rootTool =
					tools.find((tool: { name: string }) => tool.name === "exec_command")
						?.id ?? 0;
				if (childId)
					childTool =
						(await f.request(`/api/agents/${childId}/tools`)).toolCalls.find(
							(tool: { name: string }) => tool.name === "exec_command",
						)?.id ?? 0;
				if (rootTool && childTool) {
					const rootLog = (
						await f.request(`/api/agents/${id}/tools?toolId=${rootTool}`)
					).toolCalls[0].output;
					const childLog = (
						await f.request(`/api/agents/${childId}/tools?toolId=${childTool}`)
					).toolCalls[0].output;
					if (
						text(rootLog).includes("root-start") &&
						text(childLog).includes("child-start")
					)
						break;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert(
				childId && childTool && rootTool,
				JSON.stringify(await f.request(`/api/agents/${id}/tools?toolId=1`)),
			);
			await f.request(`/api/agents/${id}/cancel`, {});
			assert.equal((await f.wait(id)).status, "cancelled");
			assert.equal((await f.wait(childId)).status, "cancelled");
			for (const name of ["root-escaped", "child-escaped"])
				await assert.rejects(readFile(join(root, name)), { code: "ENOENT" });
			assert.equal(
				stdout(
					(await f.request(`/api/agents/${id}/tools?toolId=${rootTool}`))
						.toolCalls[0].output,
				),
				"root-start",
			);
			assert.equal(
				stdout(
					(await f.request(`/api/agents/${childId}/tools?toolId=${childTool}`))
						.toolCalls[0].output,
				),
				"child-start",
			);
		} finally {
			await f.close();
		}
	},
);

commandTest(
	"service restart retains interrupted command chunks and never replays native work",
	async () => {
		const directory = await realpath(
			await mkdtemp(join(tmpdir(), "command-restart-")),
		);
		const root = join(directory, "project"),
			database = join(directory, "db.sqlite");
		await mkdir(root);
		const fixtureUrl = new URL("./config-fixture.ts", import.meta.url).href;
		const modelUrl = new URL("./model-fixture.ts", import.meta.url).href;
		const child = spawn(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				`
 import { createTestServer } from ${JSON.stringify(fixtureUrl)};
 import { completedBody } from ${JSON.stringify(modelUrl)};
 const server = createTestServer(async () => new Response(completedBody({status:'completed',output:[{
 id:'command',call_id:'command',type:'function_call',name:'exec_command',
 arguments:JSON.stringify({command:'printf before-restart; sleep 30; printf replayed > replayed',cwd:${JSON.stringify(root)},timeout_ms:30000})
 }]})), ${JSON.stringify(database)}).listen(0,'127.0.0.1');
 server.once('listening',()=>console.log(JSON.stringify({port:server.address().port,token:server.managementToken})));
 `,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		const exited = once(child, "exit");
		let restarted: ReturnType<typeof createTestServer> | undefined;
		try {
			const port = await new Promise<number>((resolve, reject) => {
				let output = "";
				const timer = setTimeout(
					() => reject(new Error(`Fixture startup timed out: ${stderr}`)),
					10000,
				);
				child.stdout.on("data", (chunk) => {
					output += String(chunk);
					if (output.includes("\n")) {
						clearTimeout(timer);
						const startup = JSON.parse(output.trim());
						managementTokens.set(
							`http://127.0.0.1:${startup.port}`,
							startup.token,
						);
						resolve(startup.port);
					}
				});
				child.once("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
				child.once("exit", () => {
					clearTimeout(timer);
					reject(new Error(`Fixture exited: ${stderr}`));
				});
			});
			assert(Number.isInteger(port) && port > 0);
			const base = `http://127.0.0.1:${port}`;
			const request = async (route: string, body?: unknown) => {
				const response = await fetch(
					base + route,
					body === undefined
						? undefined
						: { method: "POST", body: JSON.stringify(body) },
				);
				assert(response.ok);
				return response.json();
			};
			const project = await request("/api/projects", {
				name: "Restart",
				folders: [root],
			});
			const chat = await request(`/api/projects/${project.id}/chats`, {
				name: "Command",
			});
			const { agentId } = await request(`/api/chats/${chat.id}`, {
				prompt: "run",
			});
			let before: {
					ordinal: number;
					stream: string;
					text: string;
				}[] = [],
				toolId = 0;
			for (let attempt = 0; attempt < 500; attempt++) {
				const tool = (await request(`/api/agents/${agentId}/tools`))
					.toolCalls[0];
				if (tool) {
					toolId = tool.id;
					before = (
						await request(`/api/agents/${agentId}/tools?toolId=${toolId}`)
					).toolCalls[0].output;
					if (stdout(before).includes("before-restart")) break;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.equal(stdout(before), "before-restart");
			child.kill("SIGKILL");
			await exited;
			let requests = 0;
			restarted = createTestServer(async () => {
				requests++;
				return done([answer]);
			}, database).listen(0, "127.0.0.1");
			await new Promise<void>((resolve) =>
				restarted?.once("listening", resolve),
			);
			const address = restarted.address();
			assert(address && typeof address !== "string");
			const restartBase = `http://127.0.0.1:${address.port}`;
			const saved = await (
				await fetch(
					`${restartBase}/api/agents/${agentId}/tools?toolId=${toolId}`,
				)
			).json();
			assert.equal(saved.toolCalls[0].status, "interrupted");
			assert.deepEqual(saved.toolCalls[0].output, before);
			const agent = await waitForAgent(restartBase, agentId);
			assert.equal(agent.status, "failed");
			assert.equal(agent.calls.length, 2);
			assert.equal(requests, 0);
			await assert.rejects(readFile(join(root, "replayed")), {
				code: "ENOENT",
			});
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await exited;
			}
			if (restarted) {
				restarted.closeAllConnections();
				await new Promise<void>((resolve) => restarted?.close(() => resolve()));
			}
			await rm(directory, { recursive: true, force: true });
		}
	},
);

commandTest(
	"native executor disconnect returns failure with saved partial output without replay",
	async () => {
		const executorPids = async () => {
			const { stdout: processes } = await promisify(execFile)("ps", [
				"-axo",
				"pid=,ppid=,command=",
			]);
			return processes.split("\n").flatMap((line) => {
				const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
				return match &&
					Number(match[2]) === process.pid &&
					match[3].includes("exec-server --listen stdio://")
					? [Number(match[1])]
					: [];
			});
		};
		const beforePids = new Set(await executorPids());
		let root = "",
			requests = 0;
		const f = await fixture(async (_url, init) => {
			if (++requests === 1)
				return done([
					call("exec_command", {
						command: "printf partial-before-disconnect; sleep 5",
						cwd: root,
						timeout_ms: 10000,
					}),
				]);
			const result = JSON.parse(
				JSON.parse(String(init?.body)).input.at(-1).output,
			);
			assert.match(result.error, /disconnected/i);
			assert.equal(stdout(result.output.chunks), "partial-before-disconnect");
			return done([answer]);
		});
		root = f.root;
		try {
			const id = await f.ask();
			let toolId = 0,
				ready = false;
			for (let attempt = 0; attempt < 500; attempt++) {
				const tool = (await f.request(`/api/agents/${id}/tools`)).toolCalls[0];
				if (tool) {
					toolId = tool.id;
					const detail = (
						await f.request(`/api/agents/${id}/tools?toolId=${toolId}`)
					).toolCalls[0];
					if (stdout(detail.output).includes("partial-before-disconnect")) {
						ready = true;
						break;
					}
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert(ready, "native output persisted before disconnection");
			const owned = (await executorPids()).filter(
				(pid) => !beforePids.has(pid),
			);
			assert.equal(
				owned.length,
				1,
				"identify only this fixture's native executor child",
			);
			process.kill(owned[0], "SIGKILL");
			const agent = await f.wait(id);
			assert.equal(agent.status, "succeeded", JSON.stringify(agent));
			const detail = (
				await f.request(`/api/agents/${id}/tools?toolId=${toolId}`)
			).toolCalls[0];
			assert.equal(detail.status, "interrupted");
			assert.match(JSON.parse(detail.result).error, /disconnected/i);
			assert.equal(stdout(detail.output), "partial-before-disconnect");
			assert.equal(requests, 2);
			assert.equal(
				(await f.request(`/api/agents/${id}/tools`)).toolCalls.length,
				1,
			);
		} finally {
			await f.close();
		}
	},
);

commandTest(
	"native read, patch and command round trip preserves literal project paths",
	async () => {
		let root = "",
			literal = "",
			outside = "",
			requests = 0;
		const f = await fixture(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			const results = body.input
				.filter(
					(item: { type: string }) => item.type === "function_call_output",
				)
				.map((item: { output: string }) => JSON.parse(item.output));
			if (++requests === 1) {
				assert.deepEqual(
					body.tools.map((tool: { name: string }) => tool.name).sort(),
					[
						"apply_patch",
						"cancel_sub_agent",
						"create_sub_agent",
						"exec_command",
						"read_file",
						"read_image",
						"read_tool_output",
						"write_stdin",
					],
				);
				return done([call("read_file", { path: join(root, "input.txt") })]);
			}
			if (requests === 2) {
				assert.equal(results.at(-1).text, "before\n");
				assert.deepEqual(results.at(-1), {
					path: join(root, "input.txt"),
					text: "before\n",
					encoding: "utf-8",
					next_line: null,
				});
				return done([
					call(
						"apply_patch",
						{
							cwd: literal,
							patch: `*** Begin Patch\n*** Update File: ${join(root, "input.txt")}\n@@\n-before\n+after\n*** Add File: .git/config\n+fixture\n*** End Patch`,
						},
						"patch",
					),
				]);
			}
			if (requests === 3) {
				assert.equal(results.at(-1).exitCode, 0, JSON.stringify(results));
				return done([
					call(
						"exec_command",
						{
							cwd: root,
							timeout_ms: 10000,
							command: `test "$(cat input.txt)" = after && test "$(cat ${quote(join(literal, ".git/config"))})" = fixture && printf validated`,
						},
						"check",
					),
				]);
			}
			assert.equal(results[2].exitCode, 0);
			assert.equal(text(results[2].output.chunks), "validated");
			return done([answer]);
		});
		root = f.root;
		literal = join(f.directory, "target [*?] ü");
		outside = join(f.directory, "private.txt");
		try {
			await mkdir(literal);
			await writeFile(join(root, "input.txt"), "before\n");
			await writeFile(outside, "outside-secret\n");
			await symlink(outside, join(root, "escape"));
			await f.request(
				`/api/projects/${f.projectId}`,
				{ name: "Native", folders: [root, literal] },
				"PUT",
			);
			const id = await f.ask();
			assert.equal((await f.wait(id)).status, "succeeded");
			assert.equal(await readFile(join(root, "input.txt"), "utf8"), "after\n");
			assert.equal(await readFile(outside, "utf8"), "outside-secret\n");
			const tools = (await f.request(`/api/agents/${id}/tools`)).toolCalls;
			const patch = tools.find(
				(tool: { name: string }) => tool.name === "apply_patch",
			);
			assert.match(
				text(
					(await f.request(`/api/agents/${id}/tools?toolId=${patch.id}`))
						.toolCalls[0].output,
				),
				/Success/,
			);
			assert.equal(requests, 4);
		} finally {
			await f.close();
		}
	},
);

commandTest(
	"executor disconnect marks native file reads interrupted without replay",
	async () => {
		let root = "",
			requests = 0;
		const f = await fixture(async (_url, init) => {
			if (++requests === 1)
				return done([
					call("exec_command", {
						command: "printf ready",
						cwd: root,
						timeout_ms: 10000,
					}),
				]);
			if (requests === 2) {
				const { stdout: processes } = await promisify(execFile)("ps", [
					"-axo",
					"pid=,ppid=,command=",
				]);
				const owned = processes.split("\n").flatMap((line) => {
					const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
					return match &&
						Number(match[2]) === process.pid &&
						match[3].includes("exec-server --listen stdio://")
						? [Number(match[1])]
						: [];
				});
				assert.equal(owned.length, 1);
				process.kill(owned[0], "SIGKILL");
				await new Promise((resolve) => setTimeout(resolve, 50));
				return done([
					call("read_file", { path: join(root, "fixture") }, "read"),
				]);
			}
			const result = JSON.parse(
				JSON.parse(String(init?.body)).input.at(-1).output,
			);
			assert.match(result.error, /disconnected/i);
			return done([answer]);
		});
		root = f.root;
		try {
			await writeFile(join(root, "fixture"), "preserved");
			const id = await f.ask();
			assert.equal((await f.wait(id)).status, "succeeded");
			const tools = (await f.request(`/api/agents/${id}/tools`)).toolCalls;
			assert.equal(tools[1].status, "interrupted");
			assert.equal(requests, 3);
			assert.equal(await readFile(join(root, "fixture"), "utf8"), "preserved");
		} finally {
			await f.close();
		}
	},
);

commandTest(
	"cancelled native reads settle before Agent completion and later reads still work",
	async () => {
		let root = "",
			requests = 0;
		const f = await fixture(async (_url, init) => {
			requests++;
			const body = JSON.parse(String(init?.body));
			if (
				body.input.some(
					(item: { type: string }) => item.type === "function_call_output",
				)
			)
				return done([answer]);
			return done([call("read_file", { path: join(root, "fixture") })]);
		});
		root = f.root;
		try {
			await writeFile(join(root, "fixture"), "x\n".repeat(50000));
			const id = await f.ask();
			for (let attempt = 0; attempt < 500; attempt++) {
				const tools = (await f.request(`/api/agents/${id}/tools`)).toolCalls;
				if (tools[0]?.status === "running") break;
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			await f.request(`/api/agents/${id}/cancel`, {});
			assert.equal((await f.wait(id)).status, "cancelled");
			assert.equal(
				(await f.request(`/api/agents/${id}/tools`)).toolCalls[0].status,
				"interrupted",
			);
			assert.equal(requests, 1);
			const next = await f.ask("next");
			assert.equal((await f.wait(next)).status, "succeeded");
			const tools = (await f.request(`/api/agents/${next}/tools`)).toolCalls;
			const result = JSON.parse(
				(await f.request(`/api/agents/${next}/tools?toolId=${tools[0].id}`))
					.toolCalls[0].result,
			);
			assert.equal(result.text, "x\n".repeat(2000));
			assert.equal(result.next_line, 2001);
			assert.equal(requests, 3);
		} finally {
			await f.close();
		}
	},
);

for (const delivery of ["automatic", "cancel"] as const) {
	commandTest(
		`child ${delivery} results retain actual Tool Results without complete command-log attachments`,
		async () => {
			let root = "",
				childId = 0,
				childCalls = 0,
				parentCalls = 0;
			let releaseParent!: () => void;
			const parentReady = new Promise<void>((resolve) => {
				releaseParent = resolve;
			});
			const fullLog = "command-log-".repeat(100000);
			const captures: unknown[][] = [];
			const f = await fixture(async (_url, init) => {
				const request = JSON.parse(String(init?.body));
				const prompt = request.input.find(
					(item: { role?: string }) => item.role === "user",
				)?.content;
				if (prompt === "child-log") {
					if (++childCalls === 1)
						return done([
							call("exec_command", {
								command: "node large.cjs",
								cwd: root,
								timeout_ms: 10000,
							}),
						]);
					const actual = JSON.parse(request.input.at(-1).output);
					if (childCalls === 2) {
						assert.equal(actual.exitCode, 7);
						assert.equal(actual.output.total_chars, fullLog.length);
						assert.equal(actual.output.next_offset, 16000);
						return done([
							call(
								"read_tool_output",
								{
									tool_call_id: actual.tool_call_id,
									offset: fullLog.length - 20,
									limit: 20,
								},
								"continuation",
							),
						]);
					}
					assert.equal(
						actual.chunks.map((chunk: { text: string }) => chunk.text).join(""),
						fullLog.slice(-20),
					);
					return new Response("child provider failed", { status: 503 });
				}
				captures.push(request.input);
				if (++parentCalls === 1)
					return done([
						call("create_sub_agent", { prompt: "child-log" }, "create"),
					]);
				if (parentCalls === 2) {
					await parentReady;
					return done(
						delivery === "cancel"
							? [call("cancel_sub_agent", { agent_id: childId }, "cancel")]
							: [answer],
					);
				}
				const notifications = request.input.filter(
					(item: { content?: string }) =>
						typeof item.content === "string" &&
						item.content.startsWith("[Runtime service:"),
				);
				assert.equal(notifications.length, delivery === "automatic" ? 1 : 0);
				const terminal =
					delivery === "automatic"
						? JSON.parse(
								notifications[0].content.slice(
									notifications[0].content.indexOf("{"),
								),
							)
						: JSON.parse(request.input.at(-1).output);
				assert.equal(terminal.agent_id, childId);
				assert.equal(terminal.status, "failed");
				assert.equal(terminal.errors[0].message, "OpenRouter request failed");
				assert.equal(terminal.errors[0].code, "modelRequestFailed");
				assert.equal(terminal.tool_calls.length, 2);
				for (const tool of terminal.tool_calls)
					assert(
						!("output" in tool),
						"Separately saved Command Output must not be attached",
					);
				const command = terminal.tool_calls[0];
				assert.equal(command.status, "failed");
				assert.equal(JSON.parse(command.arguments).cwd, root);
				assert.equal(JSON.parse(command.result).exitCode, 7);
				assert.equal(JSON.parse(command.result).output.next_offset, 16000);
				assert.equal(
					text(JSON.parse(terminal.tool_calls[1].result).chunks),
					fullLog.slice(-20),
				);
				assert(
					String(init?.body).length < 100000,
					"Complete raw/base64 log copies must stay out of parent inputs",
				);
				return done([answer]);
			});
			root = f.root;
			try {
				await writeFile(
					join(root, "large.cjs"),
					`process.stdout.write(${JSON.stringify(fullLog)}, () => process.exit(7))`,
				);
				const id = await f.ask("parent-log");
				for (let attempt = 0; attempt < 500; attempt++) {
					const tools = (await f.request(`/api/agents/${id}/tools`)).toolCalls;
					if (tools[0]?.result) {
						childId = JSON.parse(tools[0].result).agent_id;
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				assert(childId);
				for (let attempt = 0; attempt < 500; attempt++) {
					if (
						(await f.request(`/api/agents/${childId}`)).agents[0].status ===
						"failed"
					)
						break;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				assert.equal(
					(await f.request(`/api/agents/${childId}`)).agents[0].status,
					"failed",
				);
				const tools = (await f.request(`/api/agents/${childId}/tools`))
					.toolCalls;
				assert.equal(stdout(tools[0].output), fullLog);
				releaseParent();
				const parent = await f.wait(id);
				assert.equal(parent.status, "succeeded", JSON.stringify(parent));
				assert.equal(parentCalls, 3);
				assert.equal(captures.length, 3);
			} finally {
				releaseParent();
				await f.close();
			}
		},
	);
}

commandTest(
	"interactive commands yield, preserve PTY output and accept input while other tools run",
	async () => {
		let root = "",
			session = 0,
			toolId = 0,
			requests = 0;
		const f = await fixture(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			const last = body.input
				.filter(
					(item: { type: string }) => item.type === "function_call_output",
				)
				.at(-1);
			switch (++requests) {
				case 1:
					return done([
						call("exec_command", {
							cmd: "printf 'ready\\n'; read value; printf 'received:%s\\n' \"$value\"",
							workdir: root,
							tty: true,
							shell: "/bin/bash",
							login: false,
							yield_time_ms: 20,
							max_output_tokens: 4,
						}),
					]);
				case 2: {
					const result = JSON.parse(last.output);
					assert.equal(result.running, true, last.output);
					assert.equal(typeof result.session_id, "number");
					session = result.session_id;
					toolId = result.tool_call_id;
					return done([
						call("read_file", { path: join(root, "test.txt") }, "read"),
					]);
				}
				case 3:
					assert.equal(JSON.parse(last.output).text, "fixture");
					return done([
						call(
							"write_stdin",
							{ session_id: session, chars: "hello\n", yield_time_ms: 600000 },
							"input",
						),
					]);
				case 4: {
					const result = JSON.parse(last.output);
					assert.equal(result.exitCode, 0, last.output);
					assert.equal(result.running, false);
					assert.equal(result.tool_call_id, toolId);
					return done([
						call("read_tool_output", { tool_call_id: toolId }, "logs"),
					]);
				}
				default: {
					const output = JSON.parse(last.output);
					assert.match(text(output.chunks), /received:hello/);
					assert(
						output.chunks.some(
							(chunk: { stream: string }) => chunk.stream === "pty",
						),
					);
					return done([answer]);
				}
			}
		});
		root = f.root;
		try {
			await writeFile(join(root, "test.txt"), "fixture");
			const id = await f.ask();
			await f.wait(id);
			assert.equal(requests, 5);
			const detail = (
				await f.request(`/api/agents/${id}/tools?toolId=${toolId}`)
			).toolCalls[0];
			assert.equal(detail.commandState.running, false);
			assert.equal(detail.commandState.exitCode, 0);
		} finally {
			await f.close();
		}
	},
);

commandTest(
	"interactive output budget retains full history, non-PTY rejects input and Ctrl-C stops the process",
	async () => {
		let root = "",
			requests = 0,
			session = 0,
			toolId = 0;
		const f = await fixture(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			const last = body.input
				.filter(
					(item: { type: string }) => item.type === "function_call_output",
				)
				.at(-1);
			const result = last ? JSON.parse(last.output) : null;
			switch (++requests) {
				case 1:
					return done([
						call("exec_command", {
							cmd: "node -e \"process.stdout.write('x'.repeat(30000));setInterval(()=>{},1000)\"",
							workdir: root,
							yield_time_ms: 1000,
							max_output_tokens: 2,
						}),
					]);
				case 2:
					assert.equal(result.running, true, JSON.stringify(result));
					assert.equal(text(result.output.chunks).length, 8);
					assert.equal(result.output.total_chars, 30000);
					session = result.session_id;
					toolId = result.tool_call_id;
					return done([
						call(
							"write_stdin",
							{ session_id: session, chars: "bad", yield_time_ms: 250 },
							"bad-input",
						),
					]);
				case 3:
					assert.match(result.error, /stdin is closed/);
					return done([
						call(
							"write_stdin",
							{ session_id: session, chars: "\u0003", yield_time_ms: 1000 },
							"stop",
						),
					]);
				case 4:
					assert.equal(result.running, false, JSON.stringify(result));
					assert.notEqual(result.exitCode, 0);
					return done([
						call(
							"read_tool_output",
							{ tool_call_id: toolId, offset: 29990 },
							"history",
						),
					]);
				default:
					assert.equal(text(result.chunks), "xxxxxxxxxx");
					return done([answer]);
			}
		});
		root = f.root;
		try {
			const id = await f.ask();
			await f.wait(id);
			assert.equal(requests, 5);
		} finally {
			await f.close();
		}
	},
);

commandTest(
	"yielded sessions remain Agent-owned and cancellation drains the process before returning",
	async () => {
		let root = "",
			session = 0,
			toolId = 0,
			requests = 0,
			heldResolve!: () => void;
		const held = new Promise<void>((resolve) => {
			heldResolve = resolve;
		});
		let foreign = false;
		const f = await fixture(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			const last = body.input
				.filter(
					(item: { type: string }) => item.type === "function_call_output",
				)
				.at(-1);
			if (foreign) {
				if (!last)
					return done([
						call(
							"write_stdin",
							{ session_id: session, chars: "\u0003" },
							"foreign",
						),
					]);
				assert.match(JSON.parse(last.output).error, /only to the Agent/);
				return done([answer]);
			}
			if (++requests === 1)
				return done([
					call("exec_command", {
						cmd: "printf '%s' $$ > process.pid; exec sleep 60",
						workdir: root,
						yield_time_ms: 250,
					}),
				]);
			const result = JSON.parse(last.output);
			session = result.session_id;
			toolId = result.tool_call_id;
			heldResolve();
			return new Promise<Response>((_, reject) =>
				init?.signal?.addEventListener(
					"abort",
					() => reject(init.signal?.reason),
					{ once: true },
				),
			);
		});
		root = f.root;
		try {
			const id = await f.ask();
			await held;
			foreign = true;
			const other = await f.ask("foreign");
			await f.wait(other);
			const pid = Number(await readFile(join(root, "process.pid"), "utf8"));
			assert.doesNotThrow(() => process.kill(pid, 0));
			await f.request(`/api/agents/${id}/cancel`, {});
			assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
			const saved = (
				await f.request(`/api/agents/${id}/tools?toolId=${toolId}`)
			).toolCalls[0];
			assert.equal(saved.commandState.cancelled, true);
			assert.equal(saved.commandState.running, false);
		} finally {
			await f.close();
		}
	},
);

commandTest(
	"native command startup errors retain protocol code and do not poison later operations",
	async () => {
		let root = "",
			requests = 0;
		const f = await fixture(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			const last = body.input
				.filter(
					(item: { type: string }) => item.type === "function_call_output",
				)
				.at(-1);
			switch (++requests) {
				case 1:
					return done([
						call("exec_command", {
							cmd: "echo test",
							workdir: root,
							shell: "/missing-shell",
						}),
					]);
				case 2: {
					const result = JSON.parse(last.output);
					assert.equal(typeof result.error_code, "number", last.output);
					assert.equal(typeof result.error, "string", last.output);
					return done([
						call(
							"read_file",
							{ path: join(root, "..", "native-secret") },
							"native-error",
						),
					]);
				}
				case 3:
					assert.equal(
						typeof JSON.parse(last.output).error_code,
						"number",
						last.output,
					);
					return done([
						call(
							"exec_command",
							{ cmd: "printf recovered", workdir: root, yield_time_ms: 60000 },
							"recover",
						),
					]);
				default:
					assert.equal(JSON.parse(last.output).exitCode, 0, last.output);
					return done([answer]);
			}
		});
		root = f.root;

		try {
			const id = await f.ask();
			await f.wait(id);
			assert.equal(requests, 4);
		} finally {
			await f.close();
		}
	},
);

commandTest(
	"process state persistence failure preserves output and drains without crashing the service",
	async () => {
		let root = "",
			requests = 0;
		const f = await fixture(async (_url, init) => {
			if (++requests === 1)
				return done([
					call("exec_command", {
						cmd: "printf retained",
						workdir: root,
						timeout_ms: 1000,
					}),
				]);
			const body = JSON.parse(String(init?.body));
			const result = JSON.parse(body.input.at(-1).output);
			assert.match(result.error, /Command state persistence failed/);
			assert.equal(text(result.output.chunks), "retained");
			return done([answer]);
		});
		root = f.root;
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(join(f.directory, "db.sqlite"));
		try {
			db.exec(
				"CREATE TRIGGER fail_command_state BEFORE UPDATE OF command_state ON tool_calls BEGIN SELECT RAISE(ABORT,'command state full'); END;",
			);
			const id = await f.ask();
			const agent = await f.wait(id);
			assert.equal(agent.status, "succeeded");
			assert.equal(requests, 2);
			const tool = (await f.request(`/api/agents/${id}/tools`)).toolCalls[0];
			assert.equal(tool.status, "interrupted");
			assert.equal(tool.reason, "toolSaveFailed");
		} finally {
			db.close();
			await f.close();
		}
	},
);

commandTest(
	"Full Access reads and patches outside project and commands reach localhost",
	async () => {
		const http = createHttpServer((_req, res) =>
			res.end("local-network-ok"),
		).listen(0, "127.0.0.1");
		await once(http, "listening");
		const address = http.address();
		assert(address && typeof address !== "string");
		let outside = "",
			root = "",
			requests = 0;
		const f = await fixture(async (_url, init) => {
			if (++requests === 1)
				return done([
					call("read_file", { path: outside }, "outside-read"),
					call(
						"apply_patch",
						{
							cwd: root,
							patch: `*** Begin Patch\n*** Update File: ${outside}\n@@\n-before\n+after\n*** End Patch`,
						},
						"outside-patch",
					),
					call(
						"exec_command",
						{
							cmd: `cat ${quote(outside)}; node -e ${quote(`fetch('http://127.0.0.1:${address.port}').then(r=>r.text()).then(console.log)`)}`,
							workdir: root,
							yield_time_ms: 1000,
						},
						"outside-command",
					),
				]);
			const results = JSON.parse(String(init?.body))
				.input.filter(
					(item: { type: string }) => item.type === "function_call_output",
				)
				.map((item: { output: string }) => JSON.parse(item.output));
			assert.equal(results[0].text, "before\n");
			assert.equal(results[1].exitCode, 0);
			assert.equal(results[2].exitCode, 0);
			assert.match(text(results[2].output.chunks), /after\nlocal-network-ok/);
			return done([answer]);
		});
		root = f.root;
		outside = join(f.directory, "outside.txt");
		try {
			await writeFile(outside, "before\n");
			const agent = await f.wait(await f.ask());
			assert.equal(agent.status, "succeeded", JSON.stringify(agent));
			assert.equal(await readFile(outside, "utf8"), "after\n");
		} finally {
			await f.close();
			http.closeAllConnections();
			await new Promise<void>((resolve) => http.close(() => resolve()));
		}
	},
);

commandTest(
	"commands discover normal user tools and fake git, gh and npm configuration without management credentials",
	async () => {
		const savedEnvironment = { ...process.env };
		let root = "";
		let requests = 0;
		const f = await fixture(async (_url, init) => {
			if (++requests === 1)
				return done([
					call("exec_command", {
						cmd: "node environment.cjs",
						workdir: root,
						login: false,
						timeout_ms: 10000,
					}),
					call(
						"exec_command",
						{
							cmd: "node environment.cjs",
							workdir: root,
							yield_time_ms: 10000,
						},
						"login",
					),
				]);
			const results = JSON.parse(String(init?.body)).input.filter(
				(item: { type: string }) => item.type === "function_call_output",
			);
			assert.equal(results.length, 2);
			for (const item of results) {
				const result = JSON.parse(item.output);
				assert.equal(result.exitCode, 0, JSON.stringify(result));
				assert.match(text(result.output.chunks), /user-environment-ok/);
			}
			return done([answer]);
		});
		root = f.root;
		try {
			const home = join(f.directory, "user");
			const bin = join(home, "bin");
			await mkdir(join(home, ".config", "gh"), { recursive: true });
			await mkdir(bin);
			await writeFile(
				join(home, ".gitconfig"),
				"[user]\n name = Fixture User\n",
			);
			await writeFile(join(home, ".npmrc"), "user-agent=fixture-npm-agent\n");
			await writeFile(
				join(home, ".config", "gh", "config.yml"),
				"git_protocol: ssh\n",
			);
			await writeFile(
				join(home, ".config", "gh", "hosts.yml"),
				"github.com:\n    oauth_token: fake-gh-token\n    user: fixture\n",
			);
			await writeFile(
				join(bin, "fixture-tool"),
				"#!/bin/sh\nprintf fixture-path-tool",
				{ mode: 0o755 },
			);
			for (const name of Object.keys(process.env))
				if (/^(GIT_CONFIG|GH_|GITHUB_|NPM_CONFIG_|npm_config_)/.test(name))
					delete process.env[name];
			Object.assign(process.env, {
				HOME: home,
				PATH: `${bin}:${savedEnvironment.PATH}`,
				XDG_CONFIG_HOME: join(home, ".config"),
				FIXTURE_DEVELOPMENT_ENV: "fixture-development",
				TYLER_MANAGEMENT_TOKEN: "fake-management-token",
			});
			await writeFile(
				join(root, "environment.cjs"),
				`
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const run = (file, args=[]) => execFileSync(file, args, {encoding:'utf8'}).trim();
assert.equal(process.env.HOME, ${JSON.stringify(home)});
assert.equal(process.env.FIXTURE_DEVELOPMENT_ENV, 'fixture-development');
assert.equal(process.env.TYLER_MANAGEMENT_TOKEN, undefined);
assert.equal(process.env.CODEX_HOME, ${JSON.stringify(process.env.CODEX_HOME)});
assert.match(process.env.TMPDIR, /tyler-agent/);
assert.equal(run('fixture-tool'), 'fixture-path-tool');
assert.equal(run('git', ['config', '--global', 'user.name']), 'Fixture User');
assert.equal(run('npm', ['config', 'get', 'user-agent']), 'fixture-npm-agent');
assert.equal(run('gh', ['config', 'get', 'git_protocol']), 'ssh');
assert.equal(run('gh', ['auth', 'token', '--hostname', 'github.com']), 'fake-gh-token');
console.log('user-environment-ok');
`,
			);
			const agent = await f.wait(await f.ask());
			assert.equal(agent.status, "succeeded", JSON.stringify(agent));
			assert.equal(requests, 2);
		} finally {
			for (const name of Object.keys(process.env)) delete process.env[name];
			Object.assign(process.env, savedEnvironment);
			await f.close();
		}
	},
);
