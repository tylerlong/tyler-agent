import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { browserCacheDirectory, playwrightRoot } from "../src/browser-tools.ts";
import { waitForAgent } from "./agent-fixture.ts";
import {
	browserCrashCheck,
	useTemporaryHome,
} from "./browser-crash-fixture.ts";
import { createTestServer } from "./config-fixture.ts";
import { localFetch as fetch } from "./local-fetch.ts";
import { httpMcpFixture } from "./mcp-http-fixture.ts";
import { completedResponse } from "./model-fixture.ts";

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
test("instructions, explicit Skills, user images and MCP coexist with official CLI browser diagnosis and native screenshot results", {
	skip: process.platform !== "darwin",
	timeout: 120000,
}, async (t) => {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "browser-diagnostics-")),
	);
	await useTemporaryHome(t, directory);
	const crashes = await browserCrashCheck();
	const target = join(directory, "target");
	await mkdir(target);
	await writeFile(join(target, "AGENTS.md"), "PROJECT-BROWSER-INTEGRATION");
	const skillDirectory = join(target, ".agents/skills/diagnosis");
	await mkdir(skillDirectory, { recursive: true });
	const selectedSkill = join(skillDirectory, "SKILL.md");
	await writeFile(
		selectedSkill,
		"---\nname: diagnosis\ndescription: Controlled integration guidance\ndisable-model-invocation: true\n---\nEXPLICIT-BROWSER-INTEGRATION",
	);
	const userImage = {
		type: "input_image",
		image_url:
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYioAAAAASUVORK5CYII=",
	};
	const mcp = await httpMcpFixture();
	await writeFile(
		join(target, "browser.json"),
		JSON.stringify({
			browser: { browserName: "chromium" },
			outputMode: "stdout",
		}),
	);
	await writeFile(
		join(target, "website.cjs"),
		`
const {createServer} = require('node:http');
const server = createServer((req, res) => {
  if (req.url === '/api/diagnose') {
    let body = ''; req.on('data', chunk => body += chunk);
    req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({received:body, proof:'response-body-proof'})); });
  } else {
    res.setHeader('content-type', 'text/html');
    res.end('<title>Weft browser fixture</title><button id="send">Send</button><p id="result">Waiting</p><script>document.querySelector("#send").onclick=async()=>{console.log("browser-console-proof"); const r=await fetch("/api/diagnose",{method:"POST",body:"request-body-proof"}); document.querySelector("#result").textContent=(await r.json()).proof;};</script>');
  }
}).listen(0, '127.0.0.1', () => console.log('SITE:http://127.0.0.1:' + server.address().port));
`,
	);
	const maxReadinessPolls = 5;
	let readinessPolls = 0;
	let websiteOutput = "";
	let step = 0,
		session = 0,
		requestIndex = "",
		scratch = "",
		closed = false;
	const screenshots: unknown[] = [];
	const recordings: string[] = [];
	const cli = "playwright-cli -s=weft-fixture";
	const server = createTestServer(
		async (_url, init) => {
			const requestBody = String(init?.body);
			recordings.push(requestBody);
			const body = JSON.parse(requestBody);
			const last = body.input
				.filter(
					(item: { type?: string }) => item.type === "function_call_output",
				)
				.at(-1);
			const result = last
				? typeof last.output === "string"
					? JSON.parse(last.output)
					: last.output
				: null;
			const text =
				result?.output?.chunks
					?.map((chunk: { text: string }) => chunk.text)
					.join("") ??
				result?.text ??
				"";
			if (result?.error) assert.fail(JSON.stringify(result));
			if (
				step !== 16 &&
				result?.exitCode !== undefined &&
				result?.running !== true
			)
				assert.equal(result.exitCode, 0, text);
			let name = "exec_command",
				args: unknown;
			// Finite CLI steps need complete output; the website uses a resumable session.
			const command = (cmd: string) => ({
				cmd,
				workdir: target,
				max_output_tokens: 8000,
				timeout_ms: 30000,
			});
			switch (++step) {
				case 1:
					assert.match(body.instructions, /PROJECT-BROWSER-INTEGRATION/);
					assert.match(body.instructions, /EXPLICIT-BROWSER-INTEGRATION/);
					assert.match(body.instructions, /playwright-cli/);
					assert.deepEqual(body.input.at(-1).content.at(-1), userImage);
					assert(
						body.tools.some((tool: { description?: string }) =>
							tool.description?.includes("controlled HTTP tool"),
						),
					);
					args = {
						cmd: 'printf "SCRATCH:%s\\n" "$TMPDIR"; exec node website.cjs',
						workdir: target,
						max_output_tokens: 8000,
						yield_time_ms: 1000,
					};
					break;
				case 2: {
					assert.equal(result.running, true);
					session = result.session_id;
					websiteOutput += text;
					const url = websiteOutput.match(
						/SITE:(http:\/\/127\.0\.0\.1:\d+)/,
					)?.[1];
					if (!url) {
						assert(++readinessPolls <= maxReadinessPolls, websiteOutput);
						name = "write_stdin";
						args = { session_id: session, yield_time_ms: 1000 };
						step--;
						break;
					}
					scratch = websiteOutput.match(/SCRATCH:(\S+)/)?.[1] ?? "";
					assert(scratch);
					args = command(`${cli} open ${quote(url)} --config=browser.json`);
					break;
				}
				case 3:
					await crashes.capture(text);
					assert.match(text, /Weft browser fixture/);
					args = command(`${cli} tracing-start`);
					break;
				case 4:
					args = command(`${cli} click '#send'`);
					break;
				case 5:
					args = command(`${cli} console`);
					break;
				case 6:
					assert.match(text, /browser-console-proof/);
					args = command(`${cli} requests`);
					break;
				case 7:
					requestIndex =
						text.match(/(\d+)\. \[POST\].*\/api\/diagnose/)?.[1] ?? "";
					assert(requestIndex, text);
					args = command(`${cli} request ${requestIndex}`);
					break;
				case 8:
					assert.match(text, /status:.*\[200\]/);
					assert.match(text, /application\/json/);
					args = command(`${cli} request-body ${requestIndex}`);
					break;
				case 9:
					assert.match(text, /request-body-proof/);
					args = command(`${cli} response-body ${requestIndex}`);
					break;
				case 10:
					assert.match(text, /response-body-proof/);
					args = command(
						`${cli} run-code ${quote("async page => await page.locator('#result').textContent()")}`,
					);
					break;
				case 11:
					assert.match(text, /response-body-proof/);
					args = command(`${cli} screenshot --filename=screenshot.png`);
					break;
				case 12:
					name = "read_image";
					args = { path: join(target, "screenshot.png") };
					break;
				case 13:
					assert(Array.isArray(result));
					assert.equal(result[0].type, "input_image");
					assert.match(result[0].image_url, /^data:image\/png;base64,/);
					screenshots.push(result);
					args = command(`${cli} tracing-stop`);
					break;
				case 14:
					args = command(`${cli} close`);
					break;
				case 15:
					closed = true;
					args = command(`${cli} list`);
					break;
				case 16:
					assert.doesNotMatch(text, /status: open/);
					name = "write_stdin";
					args = { session_id: session, chars: "\u0003", yield_time_ms: 1000 };
					break;
				case 17:
					assert.equal(result.running, false);
					assert.equal(result.exitCode, 130);
					name = body.tools.find((tool: { description?: string }) =>
						tool.description?.includes("controlled HTTP tool"),
					).name;
					args = { mode: "mixed", payload: { diagnosis: "browser complete" } };
					break;
				case 18:
					assert(Array.isArray(result));
					assert.match(JSON.stringify(result), /HTTP result/);
					assert.match(JSON.stringify(result), /browser complete/);
					assert.match(body.instructions, /PROJECT-BROWSER-INTEGRATION/);
					assert.match(body.instructions, /EXPLICIT-BROWSER-INTEGRATION/);
					return completedResponse({
						output: [
							{
								id: "answer",
								type: "message",
								content: [
									{ type: "output_text", text: "Browser diagnosis complete" },
								],
							},
						],
					});
				default:
					assert.fail(`Unexpected step ${step}`);
			}
			return completedResponse({
				output: [
					{
						id: `tool-${step}`,
						call_id: `tool-${step}`,
						type: "function_call",
						name,
						arguments: JSON.stringify(args),
					},
				],
			});
		},
		join(directory, "db.sqlite"),
		"browser-fixture-private-api-key",
	).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const request = async (
		path: string,
		body?: unknown,
		method = body === undefined ? "GET" : "POST",
	) => {
		const res = await fetch(base + path, {
			method,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		assert(res.ok, await res.clone().text());
		return res.json();
	};
	try {
		await request(
			"/api/execution-limits",
			{ modelCallLimit: 18 + 17 + 2 * maxReadinessPolls },
			"PATCH",
		);
		await request(
			"/api/mcp-settings",
			{
				services: [
					{
						id: "browser-integration",
						name: "Browser integration",
						enabled: true,
						config: JSON.stringify({ url: mcp.url, startup_timeout_sec: 5 }),
						env: [],
					},
				],
			},
			"PUT",
		);
		const project = await request("/api/projects", {
			name: "Browser",
			folders: [target],
		});
		const chat = await request(`/api/projects/${project.id}/chats`, {
			name: "Browser",
		});
		const { agentId } = await request(`/api/chats/${chat.id}`, {
			prompt:
				"Inspect the controlled website using the installed official browser skill",
			skillSources: [selectedSkill],
			images: [userImage],
		});
		const agent = await waitForAgent(base, agentId);
		assert.equal(agent.status, "succeeded", JSON.stringify(agent));
		assert.equal(step, 18);
		await crashes.assertNoCrashes();
		assert.deepEqual(agent.images, [userImage]);
		assert(mcp.requests.some((request) => request.method === "DELETE"));
		assert.equal(mcp.streams.size, 0);
		assert.equal(screenshots.length, 1);
		const tools = (await request(`/api/agents/${agentId}/tools`)).toolCalls;
		assert.equal(tools.length, 17);
		const image = tools.find(
			(tool: { name: string }) => tool.name === "read_image",
		);
		assert.deepEqual(JSON.parse(image.result), screenshots[0]);
		const detail = (
			await request(`/api/agents/${agentId}/tools?toolId=${tools[0].id}`)
		).toolCalls[0];
		assert.match(
			detail.output.map((chunk: { text: string }) => chunk.text).join(""),
			/SITE:http/,
		);
		const calls = (await request(`/api/agents/${agentId}/calls`)).calls;
		assert.deepEqual(
			calls
				.filter((call: { url: string }) => call.url.endsWith("/responses"))
				.map((call: { requestBody: string }) => call.requestBody),
			recordings,
		);
		assert.deepEqual(screenshots[0], [
			{
				type: "input_image",
				image_url: `data:image/png;base64,${(await readFile(join(target, "screenshot.png"))).toString("base64")}`,
			},
		]);
		const traces = await readdir(join(target, ".playwright-cli"), {
			recursive: true,
		});
		assert(traces.some((name) => name.endsWith(".trace")));
		assert(traces.some((name) => name.endsWith(".network")));
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		if (scratch && !closed)
			await promisify(execFile)(
				process.execPath,
				[join(playwrightRoot, "cli.js"), "cli", "-s=weft-fixture", "close"],
				{
					cwd: target,
					env: {
						HOME: scratch,
						TMPDIR: scratch,
						PLAYWRIGHT_BROWSERS_PATH: browserCacheDirectory,
					},
					timeout: 10000,
				},
			).catch(() => {});
		await mcp.close();
		await rm(directory, { recursive: true, force: true });
	}
});
