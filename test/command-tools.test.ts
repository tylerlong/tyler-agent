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
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
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
					? "Restricted exec-server policy is verified on macOS; Linux safe-policy support is not implemented"
					: false,
		},
		run,
	);

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
	"coding round trip reads, patches, installs an approved dependency, builds/tests/Git and continues logs",
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
								command: `npm install --offline --ignore-scripts --no-audit --no-fund ${quote(archive)} && node build.cjs && node --test check.cjs && git init -b main && git add . && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m fixture && git status --porcelain && node -e "process.stdout.write('x'.repeat(20000));process.stderr.write('log-tail')"`,
								cwd: root,
								timeout_ms: 20000,
								extra_permissions: {
									paths: [{ path: archive, access: "read" }],
								},
								reason: "Install the fixture package outside Target Folders",
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
			let pending: { toolCallId: number; requestId: string } | undefined;
			for (let attempt = 0; attempt < 1000; attempt++) {
				pending = (await f.request("/api/approvals")).approvals[0];
				if (pending) break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert(pending, "Dependency installation waits for permission");
			assert.equal(requests, 3);
			await assert.rejects(readFile(join(root, "built.txt")), {
				code: "ENOENT",
			});
			await f.request(`/api/approvals/${pending.toolCallId}`, {
				requestId: pending.requestId,
				decision: "once",
			});
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
			const calls = (await f.request(`/api/agents/${id}/calls`)).calls;
			assert.equal(calls.length, 5);
			for (let index = 0; index < calls.length; index++) {
				assert.equal(calls[index].requestBody, recordings[index].request);
				assert.deepEqual(
					JSON.parse(calls[index].responseBody),
					recordings[index].response,
				);
			}
			await f.request("/api/approvals");
			await f.request(`/api/agents/${id}/tools?toolId=${commandId}`);
			assert.equal(requests, 5, "Management/log reads add no model calls");
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
			assert.equal(stdout(saved.output), `${"x".repeat(40000)}tail`);
			assert.equal(
				text(
					saved.output.filter(
						(chunk: { stream: string }) => chunk.stream === "stderr",
					),
				),
				"err\n",
			);
			assert.equal(
				saved.output.reduce(
					(bytes: number, chunk: { byteCount: number }) =>
						bytes + chunk.byteCount,
					0,
				),
				40008,
			);
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
	"restricted commands deny outside user files and preserve literal scope paths",
	async () => {
		let root = "",
			outside = "",
			requests = 0;
		const f = await fixture(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			if (++requests === 1)
				return done([
					call(
						"exec_command",
						{
							command: `printf literal > ${quote(join(root, "literal [x] ;$ file"))}`,
							cwd: root,
							timeout_ms: 10000,
						},
						"literal",
					),
					call(
						"exec_command",
						{
							command: `cat ${quote(outside)}; printf changed > ${quote(outside)}`,
							cwd: root,
							timeout_ms: 10000,
						},
						"outside",
					),
				]);
			const results = body.input
				.filter(
					(item: { type: string }) => item.type === "function_call_output",
				)
				.map((item: { output: string }) => JSON.parse(item.output));
			assert.equal(results[0].exitCode, 0);
			assert.notEqual(results[1].exitCode, 0);
			assert(!text(results[1].output.chunks).includes("outside-secret"));
			return done([answer]);
		});
		root = f.root;
		outside = join(f.directory, "private.txt");
		try {
			await writeFile(outside, "outside-secret");
			const id = await f.ask();
			const agent = await f.wait(id);
			assert.equal(agent.status, "succeeded", JSON.stringify(agent));
			assert.equal(
				await readFile(join(root, "literal [x] ;$ file"), "utf8"),
				"literal",
			);
			assert.equal(await readFile(outside, "utf8"), "outside-secret");
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
	"scratch is supplied to instructions and environment and sibling scratch stays denied",
	async () => {
		let root = "",
			firstScratch = "",
			secondScratch = "",
			request = 0;
		const marker = `scope-${Date.now()}.txt`;
		const f = await fixture(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			const scratch = JSON.parse(
				body.instructions.match(
					/private command scratch directory: ("[^"]+")/,
				)[1],
			);
			if (++request === 1) {
				firstScratch = scratch;
				return done([
					call("exec_command", {
						command: `test "$TMPDIR" = ${quote(scratch)} && printf first > "$TMPDIR/${marker}" && printf scratch-ok`,
						cwd: root,
						timeout_ms: 10000,
					}),
				]);
			}
			if (request === 2) {
				const result = JSON.parse(body.input.at(-1).output);
				assert.equal(result.exitCode, 0, JSON.stringify(result));
				assert.equal(text(result.output.chunks), "scratch-ok");
				return done([answer]);
			}
			if (request === 3) {
				secondScratch = scratch;
				assert.notEqual(secondScratch, firstScratch);
				return done([
					call("exec_command", {
						command: `printf second > "$TMPDIR/${marker}"; cat ${quote(join(firstScratch, marker))}; printf leak > ${quote(join(firstScratch, marker))}`,
						cwd: root,
						timeout_ms: 10000,
					}),
				]);
			}
			const result = JSON.parse(body.input.at(-1).output);
			assert.notEqual(result.exitCode, 0);
			assert(!text(result.output.chunks).includes("first"));
			return done([answer]);
		});
		root = f.root;
		try {
			const first = await f.ask("first");
			assert.equal((await f.wait(first)).status, "succeeded");
			const second = await f.ask("second");
			assert.equal((await f.wait(second)).status, "succeeded");
			assert.equal(await readFile(join(firstScratch, marker), "utf8"), "first");
			assert.equal(
				await readFile(join(secondScratch, marker), "utf8"),
				"second",
			);
		} finally {
			for (const scratch of [firstScratch, secondScratch])
				if (scratch) await rm(join(scratch, marker), { force: true });
			await f.close();
		}
	},
);

commandTest(
	"restricted network rejects localhost binding without escalation or replay",
	async () => {
		let root = "",
			requests = 0;
		const f = await fixture(async (_url, init) => {
			if (++requests === 1)
				return done([
					call("exec_command", {
						command: "node network.cjs",
						cwd: root,
						timeout_ms: 10000,
					}),
				]);
			const result = JSON.parse(
				JSON.parse(String(init?.body)).input.at(-1).output,
			);
			assert.notEqual(result.exitCode, 0);
			assert.match(text(result.output.chunks), /EPERM|EACCES|not permitted/i);
			return done([answer]);
		});
		root = f.root;
		try {
			await writeFile(
				join(root, "network.cjs"),
				"require('node:net').createServer().on('error',e=>{console.error(e.code);process.exitCode=1}).listen(0,'127.0.0.1',()=>{console.log('unexpected binding');process.exit(2)})",
			);
			const id = await f.ask();
			assert.equal((await f.wait(id)).status, "succeeded");
			assert.equal(requests, 2);
		} finally {
			await f.close();
		}
	},
);

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
					data: string;
					byteCount: number;
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
			assert.equal(
				Buffer.concat(
					before
						.filter((chunk) => chunk.stream === "stdout")
						.map((chunk) => Buffer.from(chunk.data, "base64")),
				).toString(),
				"before-restart",
			);
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
			assert.equal(agent.calls.length, 1);
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
	"multiple literal Target Folders permit both roots and reject outside symlink effects",
	async () => {
		let ordinary = "",
			literal = "",
			outside = "",
			requests = 0;
		const f = await fixture(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			if (++requests === 1)
				return done([
					call(
						"exec_command",
						{
							command: `printf ordinary > ${quote(join(ordinary, "ordinary.txt"))}; printf literal > ${quote(join(literal, "literal.txt"))}`,
							cwd: literal,
							timeout_ms: 10000,
						},
						"both",
					),
					call(
						"exec_command",
						{
							command: `cat ${quote(join(ordinary, "escape", "secret"))}; printf changed > ${quote(join(ordinary, "escape", "secret"))}`,
							cwd: ordinary,
							timeout_ms: 10000,
						},
						"link",
					),
					call(
						"exec_command",
						{
							command: `printf outside > ${quote(join(outside, "new.txt"))}`,
							cwd: literal,
							timeout_ms: 10000,
						},
						"outside",
					),
				]);
			const results = body.input
				.filter(
					(item: { type: string }) => item.type === "function_call_output",
				)
				.map((item: { output: string }) => JSON.parse(item.output));
			assert.equal(results[0].exitCode, 0, JSON.stringify(results[0]));
			for (const result of results.slice(1)) {
				assert.notEqual(result.exitCode, 0);
				assert(!text(result.output.chunks).includes("outside-secret"));
			}
			return done([answer]);
		});
		ordinary = f.root;
		literal = join(f.directory, "target [*?] ü");
		outside = join(f.directory, "target neighbor");
		try {
			await mkdir(literal);
			await mkdir(outside);
			await writeFile(join(outside, "secret"), "outside-secret");
			await symlink(outside, join(ordinary, "escape"));
			await f.request(
				`/api/projects/${f.projectId}`,
				{ name: "Literal roots", folders: [ordinary, literal] },
				"PUT",
			);
			const id = await f.ask();
			const agent = await f.wait(id);
			assert.equal(agent.status, "succeeded", JSON.stringify(agent));
			assert.equal(
				await readFile(join(ordinary, "ordinary.txt"), "utf8"),
				"ordinary",
			);
			assert.equal(
				await readFile(join(literal, "literal.txt"), "utf8"),
				"literal",
			);
			assert.equal(
				await readFile(join(outside, "secret"), "utf8"),
				"outside-secret",
			);
			await assert.rejects(readFile(join(outside, "new.txt")), {
				code: "ENOENT",
			});
		} finally {
			await f.close();
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
	"native read, patch and command round trip shares literal scope and denies outside targets",
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
				assert.equal(
					Buffer.from(results.at(-1).content, "base64").toString(),
					"before\n",
				);
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
					...[outside, join(root, "escape")].flatMap((path, index) => [
						call("read_file", { path }, `deny-read-${index}`),
						call(
							"apply_patch",
							{
								cwd: root,
								patch: `*** Begin Patch\n*** Update File: ${path}\n@@\n-outside-secret\n+changed\n*** End Patch`,
							},
							`deny-patch-${index}`,
						),
					]),
					call(
						"exec_command",
						{ cwd: root, timeout_ms: 10000, command: `cat ${quote(outside)}` },
						"deny-command",
					),
				]);
			}
			assert.equal(results[2].exitCode, 0);
			assert.equal(text(results[2].output.chunks), "validated");
			for (const result of [results[3], results[5]])
				assert.equal(typeof result.error, "string");
			for (const result of [results[4], results[6], results[7]])
				assert.notEqual(result.exitCode, 0);
			assert(
				!JSON.stringify(results.slice(3)).includes('"text":"outside-secret'),
			);
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
			await writeFile(join(root, "fixture"), "x".repeat(100000));
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
			assert.equal(result.bytes_read, 51200);
			assert.equal(requests, 3);
		} finally {
			await f.close();
		}
	},
);

commandTest(
	"native reads and patches use owning scratch and deny another Agent scratch",
	async () => {
		let firstScratch = "",
			requests = 0;
		const marker = `native-${Date.now()}.txt`;
		const f = await fixture(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			const scratch = JSON.parse(
				body.instructions.match(
					/private command scratch directory: ("[^"]+")/,
				)[1],
			);
			if (++requests === 1) {
				firstScratch = scratch;
				return done([
					call(
						"apply_patch",
						{
							cwd: scratch,
							patch: `*** Begin Patch\n*** Add File: ${marker}\n+own\n*** End Patch`,
						},
						"own-patch",
					),
					call("read_file", { path: join(scratch, marker) }, "own-read"),
				]);
			}
			if (requests === 3)
				return done([
					call(
						"read_file",
						{ path: join(firstScratch, marker) },
						"foreign-read",
					),
					call(
						"apply_patch",
						{
							cwd: scratch,
							patch: `*** Begin Patch\n*** Update File: ${join(firstScratch, marker)}\n@@\n-own\n+foreign\n*** End Patch`,
						},
						"foreign-patch",
					),
				]);
			const results = body.input
				.filter(
					(item: { type: string }) => item.type === "function_call_output",
				)
				.map((item: { output: string }) => JSON.parse(item.output));
			if (requests === 2) {
				assert.equal(results[0].exitCode, 0);
				assert.equal(results[1].text, "own\n");
			} else {
				assert.equal(typeof results[0].error, "string");
				assert.notEqual(results[1].exitCode, 0);
			}
			return done([answer]);
		});
		try {
			assert.equal((await f.wait(await f.ask("first"))).status, "succeeded");
			assert.equal((await f.wait(await f.ask("second"))).status, "succeeded");
			assert.equal(await readFile(join(firstScratch, marker), "utf8"), "own\n");
			assert.equal(requests, 4);
		} finally {
			if (firstScratch) await rm(join(firstScratch, marker), { force: true });
			await f.close();
		}
	},
);

commandTest(
	"different database services cannot reuse another Agent's retained scratch",
	async () => {
		let firstScratch = "",
			firstRequests = 0;
		const first = await fixture(async (_url, init) => {
			firstRequests++;
			const body = JSON.parse(String(init?.body));
			firstScratch = JSON.parse(
				body.instructions.match(
					/private command scratch directory: ("[^"]+")/,
				)[1],
			);
			if (
				body.input.some(
					(item: { type: string }) => item.type === "function_call_output",
				)
			)
				return done([answer]);
			return done([
				call("apply_patch", {
					cwd: firstScratch,
					patch:
						"*** Begin Patch\n*** Add File: secret\n+private-scratch\n*** End Patch",
				}),
			]);
		});
		let secondScratch = "";
		const second = await fixture(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			secondScratch = JSON.parse(
				body.instructions.match(
					/private command scratch directory: ("[^"]+")/,
				)[1],
			);
			const results = body.input
				.filter(
					(item: { type: string }) => item.type === "function_call_output",
				)
				.map((item: { output: string }) => JSON.parse(item.output));
			if (results.length) {
				assert.equal(typeof results[0].error, "string");
				assert.notEqual(results[1].exitCode, 0);
				assert.notEqual(results[2].exitCode, 0);
				assert(!JSON.stringify(results).includes('"text":"private-scratch'));
				return done([answer]);
			}
			return done([
				call("read_file", { path: join(firstScratch, "secret") }, "read"),
				call(
					"apply_patch",
					{
						cwd: secondScratch,
						patch: `*** Begin Patch\n*** Update File: ${join(firstScratch, "secret")}\n@@\n-private-scratch\n+leaked\n*** End Patch`,
					},
					"patch",
				),
				call(
					"exec_command",
					{
						cwd: secondScratch,
						command: `cat ${quote(join(firstScratch, "secret"))}`,
						timeout_ms: 10000,
					},
					"command",
				),
			]);
		});
		try {
			const firstId = await first.ask();
			assert.equal((await first.wait(firstId)).status, "succeeded");
			const secondId = await second.ask();
			assert.equal(
				firstId,
				secondId,
				"Isolated databases reuse numeric Agent IDs",
			);
			assert.equal((await second.wait(secondId)).status, "succeeded");
			assert.notEqual(firstScratch, secondScratch);
			assert.equal(
				await readFile(join(firstScratch, "secret"), "utf8"),
				"private-scratch\n",
			);
			const retainedScratch = firstScratch;
			const count = firstRequests;
			await first.restart();
			assert.equal(
				firstRequests,
				count,
				"Restart does not replay model requests",
			);
			assert.equal(
				(await first.wait(await first.ask("after restart"))).status,
				"succeeded",
			);
			assert.notEqual(
				firstScratch.replace(/-\d+$/, ""),
				retainedScratch.replace(/-\d+$/, ""),
				"Restart creates a fresh namespace",
			);
			assert.equal(
				await readFile(join(firstScratch, "secret"), "utf8"),
				"private-scratch\n",
			);
			await rm(join(retainedScratch, "secret"), { force: true });
		} finally {
			if (firstScratch) await rm(join(firstScratch, "secret"), { force: true });
			await first.close();
			await second.close();
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
	"full file native read, command and patch ignore deleted restricted scopes and still validate actual paths",
	async () => {
		let root = "",
			missing = "",
			requests = 0;
		const f = await fixture(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			if (++requests === 1)
				return done([
					call("read_file", { path: join(root, "input.txt") }, "read"),
					call(
						"exec_command",
						{ cwd: root, command: "cat input.txt", timeout_ms: 10000 },
						"command",
					),
					call(
						"apply_patch",
						{
							cwd: root,
							patch:
								"*** Begin Patch\n*** Update File: input.txt\n@@\n-before\n+after\n*** End Patch",
						},
						"patch",
					),
					call(
						"exec_command",
						{ cwd: missing, command: "echo must-not-run", timeout_ms: 10000 },
						"missing-cwd",
					),
					call(
						"read_file",
						{ path: join(missing, "input.txt") },
						"missing-read",
					),
					call(
						"apply_patch",
						{
							cwd: missing,
							patch:
								"*** Begin Patch\n*** Add File: unexpected\n+no\n*** End Patch",
						},
						"missing-patch",
					),
					call(
						"exec_command",
						{
							cwd: root,
							command: "echo rechecked",
							timeout_ms: 10000,
							extra_permissions: { domains: ["example.com"] },
							reason: "Synthetic network approval",
						},
						"network-approval",
					),
				]);
			const results = body.input
				.filter(
					(item: { type: string }) => item.type === "function_call_output",
				)
				.map((item: { output: string }) => JSON.parse(item.output));
			assert.equal(results[0].text, "before\n");
			assert.equal(results[1].exitCode, 0);
			assert.equal(text(results[1].output.chunks), "before\n");
			assert.equal(results[2].exitCode, 0);
			for (const result of results.slice(3, 6))
				assert.equal(typeof result.error, "string");
			assert.equal(results[6].exitCode, 0);
			assert.equal(text(results[6].output.chunks), "rechecked\n");
			return done([answer]);
		});
		root = f.root;
		missing = join(f.directory, "removed");
		try {
			await mkdir(missing);
			await writeFile(join(root, "input.txt"), "before\n");
			await f.request(
				`/api/projects/${f.projectId}`,
				{ name: "Full", folders: [root, missing] },
				"PUT",
			);
			const chat = await f.request(`/api/projects/${f.projectId}/chats`, {
				name: "Full",
			});
			await f.request(`/api/chats/${chat.id}`, { fileAccess: "full" }, "PUT");
			// Synthetic persisted grants may outlive their paths, just like Target Folders.
			const { DatabaseSync } = await import("node:sqlite");
			const db = new DatabaseSync(join(f.directory, "db.sqlite"));
			db.prepare("UPDATE projects SET grants=? WHERE id=?").run(
				JSON.stringify({
					paths: [{ path: missing, access: "write" }],
					domains: [],
					localNetwork: false,
				}),
				f.projectId,
			);
			db.close();
			await rm(missing, { recursive: true });
			const { agentId } = await f.request(`/api/chats/${chat.id}`, {
				prompt: "full",
			});
			let pending = false;
			for (let n = 0; n < 500; n++) {
				if ((await f.request("/api/approvals")).approvals.length) {
					pending = true;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert(
				pending,
				"full file mode retains explicit network approval despite stale file scopes",
			);
			await f.request(
				`/api/chats/${chat.id}`,
				{ networkAccess: "full" },
				"PUT",
			);
			assert.equal((await f.wait(agentId)).status, "succeeded");
			assert.equal(requests, 2);
			assert.equal(await readFile(join(root, "input.txt"), "utf8"), "after\n");
		} finally {
			await f.close();
		}
	},
);

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
					assert.equal(result.sandboxDenied, true, last.output);
					assert.notEqual(result.exitCode, 0);
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
		await writeFile(join(root, "..", "native-secret"), "private");
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
