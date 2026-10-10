import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
import { waitForAgent } from "./agent-fixture.ts";
import { createTestServer } from "./config-fixture.ts";
import { localFetch as fetch } from "./local-fetch.ts";
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
async function fixture(model: typeof globalThis.fetch) {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "command-http-")),
	);
	const root = join(directory, "project");
	await mkdir(root);
	const server = createTestServer(model, join(directory, "db.sqlite")).listen(
		0,
		"127.0.0.1",
	);
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
		request,
		ask,
		wait: (id: number) => waitForAgent(base, id),
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		},
	};
}

commandTest(
	"real command Tool Call builds, tests and writes Git metadata through HTTP",
	async () => {
		let root = "",
			requests = 0;
		const f = await fixture(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			if (++requests === 1) {
				assert(
					body.tools.some(
						(tool: { name: string }) => tool.name === "exec_command",
					),
				);
				return done([
					call("exec_command", {
						command:
							"node build.cjs && node --test check.cjs && git init && git add . && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m fixture && git status --porcelain",
						cwd: root,
						timeout_ms: 10000,
					}),
				]);
			}
			const result = JSON.parse(body.input.at(-1).output);
			assert.equal(result.exitCode, 0, JSON.stringify(result));
			assert.equal(result.error, undefined);
			assert.match(text(result.output.chunks), /pass 1/);
			return done([answer]);
		});
		root = f.root;
		try {
			await writeFile(
				join(root, "build.cjs"),
				"require('node:fs').writeFileSync('built.txt', 'built');console.log('built')",
			);
			await writeFile(
				join(root, "check.cjs"),
				"require('node:assert/strict').equal(require('node:fs').readFileSync('built.txt','utf8'),'built')",
			);
			const id = await f.ask();
			const agent = await f.wait(id);
			assert.equal(agent.status, "succeeded", JSON.stringify(agent));
			assert.equal(await readFile(join(root, "built.txt"), "utf8"), "built");
			const tools = (await f.request(`/api/agents/${id}/tools`)).toolCalls;
			assert.equal(tools[0].status, "succeeded");
			const detail = await f.request(
				`/api/agents/${id}/tools?toolId=${tools[0].id}`,
			);
			assert.match(text(detail.toolCalls[0].output), /built/);
			assert.equal(requests, 2);
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
			assert.equal(text(result.chunks), `${"x".repeat(8000)}err\ntail`);
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
			assert.equal(text(saved.output), `${"x".repeat(40000)}err\ntail`);
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
 server.once('listening',()=>console.log(server.address().port));
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
						resolve(Number(output.trim()));
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
