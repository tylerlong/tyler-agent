import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

// Throwaway fixtures only; no application service, credentials, or model calls.
const [binaryArgument, outputFile] = process.argv.slice(2);
assert(
	binaryArgument && outputFile,
	"Usage: node probe.mjs /absolute/codex /absolute/results.json",
);
const binary = await fs.realpath(binaryArgument);
assert.equal(
	spawnSync(binary, ["--version"], {
		env: { PATH: "/usr/bin:/bin" },
		encoding: "utf8",
	}).stdout.trim(),
	"codex-cli 0.162.0",
);
const root = await fs.realpath(await fs.mkdtemp("/tmp/tce-probe-"));
const a = path.join(root, "a");
const b = path.join(root, "b");
const outside = path.join(root, "outside");
const special = path.join(root, "target [*?] ü");
const home = path.join(root, "server");
const tmpA = path.join(root, "tmp-a");
const tmpB = path.join(root, "tmp-b");
for (const folder of [a, b, outside, special, home, tmpA, tmpB])
	await fs.mkdir(folder);
await fs.writeFile(path.join(outside, "sentinel"), "OUTSIDE");
await fs.writeFile(path.join(a, "sentinel"), "A");
await fs.writeFile(path.join(tmpB, "sentinel"), "OTHER_AGENT_TMP");
await fs.symlink(outside, path.join(a, "outside-link"));
await fs.writeFile(
	path.join(home, "config.toml"),
	'[analytics]\nenabled = false\n[otel]\nexporter = "none"\ntrace_exporter = "none"\n',
);
await fs.mkdir(path.join(home, "tmp"), { recursive: true });
const nodeRoot = path.dirname(
	path.dirname(await fs.realpath(process.execPath)),
);
const pnpmRoot = process.env.CODEX_PROBE_PNPM_ROOT;
const rgPath = process.env.CODEX_PROBE_RG;
const uri = (value) => pathToFileURL(value).href;
const entry = (value, access) => ({
	path: { type: "path", path: uri(value) },
	access,
});
function sandbox(target = a, extra = [], fullFiles = false) {
	return {
		permissions: {
			type: "managed",
			file_system: fullFiles
				? { type: "unrestricted" }
				: {
						type: "restricted",
						entries: [
							{
								path: { type: "special", value: { kind: "minimal" } },
								access: "read",
							},
							entry("/private/tmp", "deny"),
							entry("/private/var/tmp", "deny"),
							entry(nodeRoot, "read"),
							entry("/System/Library/OpenSSL", "read"),
							entry("/Library/Developer/CommandLineTools", "read"),
							entry(binary, "read"),
							...(pnpmRoot ? [entry(pnpmRoot, "read")] : []),
							...(rgPath ? [entry(rgPath, "read")] : []),
							entry(target, "write"),
							entry(target === b ? tmpB : tmpA, "write"),
							...[".git", ".agents", ".codex", ".aws"].map((name) =>
								entry(path.join(target, name), "write"),
							),
							...extra,
						],
					},
			network: "restricted",
		},
		cwd: uri(target),
		workspaceRoots: [uri(target)],
		windowsSandboxLevel: "disabled",
		useLegacyLandlock: false,
	};
}
function network(domains) {
	return {
		proxy: {
			enabled: true,
			enableSocks5: false,
			enableSocks5Udp: false,
			allowUpstreamProxy: false,
			dangerouslyAllowAllUnixSockets: false,
			mode: "full",
			domains,
			unixSockets: {},
			allowLocalBinding: false,
		},
	};
}
const server = spawn(
	binary,
	[
		"exec-server",
		"--listen",
		"stdio://",
		"--concurrent-requests",
		"8",
		"--strict-config",
	],
	{
		cwd: home,
		env: {
			PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
			HOME: home,
			CODEX_HOME: home,
			TMPDIR: path.join(home, "tmp"),
			LANG: "en_US.UTF-8",
		},
		stdio: ["pipe", "pipe", "pipe"],
	},
);
let stderr = "";
server.stderr.on("data", (chunk) => {
	stderr = (stderr + chunk).slice(-12000);
});
let nextId = 1;
const pending = new Map();
const processes = new Map();
const events = [];
createInterface({ input: server.stdout }).on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		stderr += line;
		return;
	}
	if (message.id !== undefined) {
		const waiting = pending.get(message.id);
		if (waiting) {
			pending.delete(message.id);
			clearTimeout(waiting.timer);
			waiting.resolve(message);
		}
		return;
	}
	const proc = processes.get(message.params?.processId);
	if (message.method === "process/output" && proc) {
		const chunk = Buffer.from(message.params.chunk, "base64");
		proc.bytes += chunk.length;
		proc.hash.update(chunk);
		if (proc.head.length < 4000)
			proc.head += chunk.toString().slice(0, 4000 - proc.head.length);
		proc.tail = (proc.tail + chunk.toString()).slice(-4000);
		proc.sequences.push(message.params.seq);
	} else {
		events.push(message);
		if (message.method === "process/exited" && proc) proc.exit = message.params;
		if (message.method === "process/closed" && proc) proc.closed = true;
	}
});
server.on("exit", (code) => {
	for (const waiting of pending.values()) {
		clearTimeout(waiting.timer);
		waiting.reject(new Error(`server exited ${code}: ${stderr}`));
	}
	pending.clear();
});
function rpc(method, params, timeout = 25000) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`RPC timeout: ${method}`));
		}, timeout);
		pending.set(id, { resolve, reject, timer });
		server.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
	});
}
async function wait(predicate, timeout = 25000) {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		assert(Date.now() < deadline, "event wait timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
async function start(argv, options = {}) {
	const processId = `probe-${nextId}`;
	const target = options.target ?? a;
	const proc = {
		processId,
		bytes: 0,
		head: "",
		tail: "",
		hash: createHash("sha256"),
		sequences: [],
		closed: false,
	};
	processes.set(processId, proc);
	const result = await rpc("process/start", {
		processId,
		argv,
		cwd: uri(target),
		env: {
			PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
			HOME: target,
			TMPDIR: target === b ? tmpB : tmpA,
			XDG_CACHE_HOME: path.join(target === b ? tmpB : tmpA, "cache"),
			LANG: "en_US.UTF-8",
			GIT_CONFIG_NOSYSTEM: "1",
			DEVELOPER_DIR: "/Library/Developer/CommandLineTools",
			...options.env,
		},
		tty: options.tty ?? false,
		pipeStdin: options.pipeStdin ?? false,
		arg0: null,
		sandbox: options.sandbox ?? sandbox(target),
		...(options.domains
			? { enforceManagedNetwork: true, networkProxy: network(options.domains) }
			: {}),
	});
	assert(!result.error, JSON.stringify(result));
	assert.equal(result.result.sandboxType, "macosSeatbelt");
	return proc;
}
async function finish(proc, timeout) {
	await wait(() => proc.closed, timeout);
	return {
		processId: proc.processId,
		bytes: proc.bytes,
		head: proc.head,
		tail: proc.tail,
		exit: proc.exit,
		sha256: proc.hash.digest("hex"),
	};
}
async function run(argv, options) {
	return finish(await start(argv, options));
}
const checks = [];
async function check(name, fn) {
	const began = Date.now();
	try {
		const detail = await fn();
		checks.push({
			name,
			status: "passed",
			elapsedMs: Date.now() - began,
			detail,
		});
	} catch (error) {
		checks.push({
			name,
			status: "failed",
			elapsedMs: Date.now() - began,
			error: error.message,
		});
	}
	console.log(`${checks.at(-1).status}: ${name}`);
}
const managedPids = new Set();
async function rememberPid(file) {
	const pid = Number(await fs.readFile(file, "utf8"));
	assert(Number.isInteger(pid) && pid > 1);
	managedPids.add(pid);
	return pid;
}
try {
	await check("initialize without account or model", async () => {
		const response = await rpc("initialize", {
			clientName: "tyler-agent-exec-probe",
		});
		assert(!response.error, JSON.stringify(response));
		server.stdin.write(
			`${JSON.stringify({ method: "initialized", params: {} })}\n`,
		);
		return response.result;
	});
	await check("same server concurrent A/B filesystem scopes", async () => {
		const requests = [
			[
				"fs/readFile",
				{
					path: uri(path.join(a, "sentinel")),
					followSymlinks: true,
					sandbox: sandbox(a),
				},
			],
			[
				"fs/readFile",
				{
					path: uri(path.join(a, "sentinel")),
					followSymlinks: true,
					sandbox: sandbox(b),
				},
			],
			[
				"fs/writeFile",
				{
					path: uri(path.join(a, "new")),
					dataBase64: Buffer.from("ALLOWED").toString("base64"),
					sandbox: sandbox(a),
				},
			],
			[
				"fs/writeFile",
				{
					path: uri(path.join(a, "forbidden")),
					dataBase64: Buffer.from("BAD").toString("base64"),
					sandbox: sandbox(b),
				},
			],
		];
		const results = await Promise.all(
			requests.map(([method, params]) => rpc(method, params)),
		);
		assert.equal(
			Buffer.from(results[0].result.dataBase64, "base64").toString(),
			"A",
		);
		assert(results[1].error && results[3].error);
		assert(!results[2].error);
		await assert.rejects(fs.stat(path.join(a, "forbidden")));
		return results;
	});
	await check(
		"literal special-character target for fs and command",
		async () => {
			const response = await rpc("fs/writeFile", {
				path: uri(path.join(special, "x")),
				dataBase64: Buffer.from("SPECIAL").toString("base64"),
				sandbox: sandbox(special),
			});
			assert(!response.error, JSON.stringify(response));
			const result = await run(["/bin/cat", path.join(special, "x")], {
				target: special,
			});
			assert.equal(result.exit.exitCode, 0);
			assert.equal(result.head, "SPECIAL");
			return result;
		},
	);
	await check(
		"symlink outside target denied; own tmp allowed; other tmp denied",
		async () => {
			const responses = await Promise.all([
				rpc("fs/readFile", {
					path: uri(path.join(a, "outside-link", "sentinel")),
					followSymlinks: true,
					sandbox: sandbox(),
				}),
				rpc("fs/writeFile", {
					path: uri(path.join(tmpA, "x")),
					dataBase64: "QQ==",
					sandbox: sandbox(),
				}),
				rpc("fs/writeFile", {
					path: uri(path.join(tmpB, "x")),
					dataBase64: "QQ==",
					sandbox: sandbox(),
				}),
			]);
			assert(responses[0].error && responses[2].error);
			assert(!responses[1].error);
			return responses;
		},
	);
	await check("extra target once then next request revoked", async () => {
		const allowed = await rpc("fs/writeFile", {
			path: uri(path.join(b, "extra")),
			dataBase64: "T05DRQ==",
			sandbox: sandbox(a, [entry(b, "write")]),
		});
		const revoked = await rpc("fs/writeFile", {
			path: uri(path.join(b, "extra")),
			dataBase64: "QkFE",
			sandbox: sandbox(),
		});
		assert(!allowed.error && revoked.error);
		assert.equal(await fs.readFile(path.join(b, "extra"), "utf8"), "ONCE");
		return { allowed, revoked };
	});
	await check(
		"running process keeps grant snapshot while next command loses grant",
		async () => {
			const proc = await start(
				[
					"/bin/sh",
					"-c",
					'echo READY; sleep 0.5; cat "$1"',
					"sh",
					path.join(b, "extra"),
				],
				{ sandbox: sandbox(a, [entry(b, "read")]) },
			);
			await wait(() => proc.head.includes("READY"));
			const next = await run(["/bin/cat", path.join(b, "extra")]);
			const old = await finish(proc);
			assert.notEqual(next.exit.exitCode, 0, JSON.stringify(next));
			assert.equal(old.exit.exitCode, 0, JSON.stringify(old));
			assert.match(old.tail, /ONCE/);
			return { old, next };
		},
	);
	await check(
		"process outside read and write denied without network proxy",
		async () => {
			const read = await run(["/bin/cat", path.join(outside, "sentinel")]);
			const write = await run([
				"/bin/sh",
				"-c",
				'echo BAD > "$1"',
				"sh",
				path.join(outside, "process-write"),
			]);
			assert.notEqual(read.exit.exitCode, 0, JSON.stringify(read));
			assert.notEqual(write.exit.exitCode, 0, JSON.stringify(write));
			await assert.rejects(fs.stat(path.join(outside, "process-write")));
			return { read, write };
		},
	);
	await check(
		"process own tmp succeeds but other Agent tmp read and write denied",
		async () => {
			const own = await run([
				"/bin/sh",
				"-c",
				'echo OWN > "$1"; cat "$1"',
				"sh",
				path.join(tmpA, "own"),
			]);
			const otherRead = await run(["/bin/cat", path.join(tmpB, "sentinel")]);
			const otherWrite = await run([
				"/bin/sh",
				"-c",
				'echo BAD > "$1"',
				"sh",
				path.join(tmpB, "process-write"),
			]);
			assert.equal(own.exit.exitCode, 0, JSON.stringify(own));
			assert.match(own.head, /OWN/);
			assert.notEqual(otherRead.exit.exitCode, 0, JSON.stringify(otherRead));
			assert.notEqual(otherWrite.exit.exitCode, 0, JSON.stringify(otherWrite));
			await assert.rejects(fs.stat(path.join(tmpB, "process-write")));
			return { own, otherRead, otherWrite };
		},
	);
	const curl = (url) => [
		"/usr/bin/curl",
		"-sS",
		"--max-time",
		"12",
		"--connect-timeout",
		"5",
		url,
	];
	await check(
		"unknown domain denied with policy fact and no approval callback",
		async () => {
			const began = events.length;
			const result = await run(curl("https://example.com"), {
				domains: { "registry.npmjs.org": "allow" },
			});
			assert.notEqual(result.exit.exitCode, 0);
			const decisions = events
				.slice(began)
				.filter((event) => event.method.startsWith("network/"));
			assert(
				decisions.some(
					(event) =>
						event.method === "network/policyDecision" &&
						event.params.host === "example.com" &&
						event.params.decision === "deny",
				),
			);
			assert(
				!decisions.some((event) => event.method === "network/policyRequest"),
			);
			return { result, decisions };
		},
	);
	await check("allowed HTTPS domain succeeds", async () => {
		const result = await run(
			curl("https://registry.npmjs.org/is-number/latest"),
			{ domains: { "registry.npmjs.org": "allow" } },
		);
		assert.equal(result.exit.exitCode, 0, JSON.stringify(result));
		assert.match(result.head, /"name":"is-number"/);
		return result;
	});
	await check(
		"concurrent processes have different domain permissions",
		async () => {
			const results = await Promise.all([
				run(curl("https://example.com"), {
					domains: { "example.com": "allow" },
				}),
				run(curl("https://example.com"), {
					target: b,
					domains: { "registry.npmjs.org": "allow" },
				}),
			]);
			assert.equal(results[0].exit.exitCode, 0);
			assert.notEqual(results[1].exit.exitCode, 0);
			return results;
		},
	);
	await check(
		"deleting proxy env cannot bypass OS network boundary",
		async () => {
			const result = await run(
				[
					"/usr/bin/env",
					"-u",
					"HTTP_PROXY",
					"-u",
					"HTTPS_PROXY",
					"-u",
					"ALL_PROXY",
					"-u",
					"http_proxy",
					"-u",
					"https_proxy",
					"-u",
					"all_proxy",
					...curl("https://example.com"),
				],
				{ domains: { "registry.npmjs.org": "allow" } },
			);
			assert.notEqual(result.exit.exitCode, 0);
			return result;
		},
	);
	await check("subdomain wildcard allows registry", async () => {
		const result = await run(
			curl("https://registry.npmjs.org/is-number/latest"),
			{ domains: { "*.npmjs.org": "allow" } },
		);
		assert.equal(result.exit.exitCode, 0, JSON.stringify(result));
		return result;
	});
	await check(
		"all-domain wildcard works while outside files remain denied",
		async () => {
			const results = await Promise.all([
				run(curl("https://example.com"), { domains: { "*": "allow" } }),
				run(curl("https://registry.npmjs.org/is-number/latest"), {
					domains: { "*": "allow" },
				}),
				run(["/bin/cat", path.join(outside, "sentinel")], {
					domains: { "*": "allow" },
				}),
			]);
			assert.equal(results[0].exit.exitCode, 0);
			assert.equal(results[1].exit.exitCode, 0);
			assert.notEqual(results[2].exit.exitCode, 0, JSON.stringify(results));
			return results;
		},
	);
	await check("full file access keeps network restricted", async () => {
		const file = path.join(outside, "full-access");
		const scope = sandbox(a, [], true);
		const results = await Promise.all([
			run(
				[
					process.execPath,
					"-e",
					'require("fs").writeFileSync(process.argv[1], "FULL")',
					file,
				],
				{ sandbox: scope },
			),
			run(curl("https://example.com"), {
				sandbox: scope,
				domains: { "registry.npmjs.org": "allow" },
			}),
		]);
		assert.equal(results[0].exit.exitCode, 0, JSON.stringify(results[0]));
		assert.notEqual(results[1].exit.exitCode, 0);
		assert.equal(await fs.readFile(file, "utf8"), "FULL");
		return results;
	});
	await check(
		"finite 8 MiB output streamed completely; replay is bounded",
		async () => {
			const proc = await start([
				process.execPath,
				"-e",
				'process.stdout.write("x".repeat(8*1024*1024));setTimeout(()=>{},1500)',
			]);
			await wait(() => proc.bytes === 8 * 1024 * 1024 || proc.closed);
			assert.equal(
				proc.bytes,
				8 * 1024 * 1024,
				JSON.stringify({ head: proc.head, bytes: proc.bytes, exit: proc.exit }),
			);
			const replay = await rpc("process/read", {
				processId: proc.processId,
				afterSeq: 0,
				maxBytes: 65536,
				waitMs: 0,
			});
			assert(!replay.error, JSON.stringify(replay));
			const replayBytes = replay.result.chunks.reduce(
				(sum, chunk) => sum + Buffer.from(chunk.chunk, "base64").length,
				0,
			);
			assert(replayBytes <= 65536);
			const result = await finish(proc);
			assert.equal(result.exit.exitCode, 0);
			assert.equal(
				result.sha256,
				createHash("sha256")
					.update("x".repeat(8 * 1024 * 1024))
					.digest("hex"),
			);
			return {
				bytes: result.bytes,
				sha256: result.sha256,
				replayBytes,
				nextSeq: replay.result.nextSeq,
			};
		},
	);
	for (const tty of [false, true])
		await check(
			`interactive input works: ${tty ? "PTY" : "pipe stdin"}`,
			async () => {
				const proc = await start(
					[
						"/bin/sh",
						"-c",
						'printf "READY\\n"; read answer; printf "GOT:%s\\n" "$answer"',
					],
					{ tty, pipeStdin: !tty },
				);
				await wait(() => proc.head.includes("READY"));
				const response = await rpc("process/write", {
					processId: proc.processId,
					chunk: Buffer.from("hello\n").toString("base64"),
					writeId: "input-1",
				});
				assert.equal(response.result.status, "accepted");
				const result = await finish(proc);
				assert.match(result.head, /GOT:hello/);
				assert.equal(result.exit.exitCode, 0);
				return result;
			},
		);
	await check(
		"terminate ordinary descendant without stopping sibling process",
		async () => {
			const pidFile = path.join(a, "ordinary.pid");
			const proc = await start([
				"/bin/sh",
				"-c",
				'sleep 120 & echo $! > "$1"; echo READY; wait',
				"sh",
				pidFile,
			]);
			const sibling = await start(["/bin/sh", "-c", "sleep 1; echo SIBLING"]);
			await wait(() => proc.head.includes("READY") || proc.closed);
			assert(
				proc.head.includes("READY"),
				JSON.stringify({ head: proc.head, exit: proc.exit }),
			);
			const pid = await rememberPid(pidFile);
			const terminated = await rpc("process/terminate", {
				processId: proc.processId,
			});
			assert(terminated.result.running);
			await finish(proc);
			await wait(() => {
				try {
					process.kill(pid, 0);
					return false;
				} catch {
					return true;
				}
			}, 2500);
			const result = await finish(sibling);
			assert.equal(result.exit.exitCode, 0);
			assert.match(result.head, /SIBLING/);
			return { terminated, descendantPid: pid, sibling: result };
		},
	);
	await check("client timeout uses terminate for long command", async () => {
		const began = Date.now();
		const proc = await start(["/bin/sleep", "120"]);
		await new Promise((resolve) => setTimeout(resolve, 150));
		const result = await rpc("process/terminate", {
			processId: proc.processId,
		});
		assert(result.result.running);
		const completed = await finish(proc);
		assert.notEqual(completed.exit.exitCode, 0);
		assert(Date.now() - began < 3000);
		return completed;
	});
	await check(
		"stronger criterion: terminate intentionally detached descendant",
		async () => {
			const pidFile = path.join(a, "detached.pid");
			const script =
				'const cp=require("child_process"),fs=require("fs");const child=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});fs.writeFileSync(process.argv[1],String(child.pid));child.unref();console.log("READY");setInterval(()=>{},1000)';
			const proc = await start([process.execPath, "-e", script, pidFile]);
			await wait(() => proc.head.includes("READY"));
			const pid = await rememberPid(pidFile);
			await rpc("process/terminate", { processId: proc.processId });
			await finish(proc);
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.throws(
				() => process.kill(pid, 0),
				"detached descendant survived terminate",
			);
			return { descendantPid: pid };
		},
	);
	await check(
		"real pnpm online install and Node verification artifact",
		async () => {
			assert(pnpmRoot, "CODEX_PROBE_PNPM_ROOT is required");
			await fs.writeFile(
				path.join(a, "package.json"),
				JSON.stringify({
					name: "exec-probe",
					private: true,
					dependencies: { "is-number": "7.0.0" },
				}),
			);
			const installed = await run(
				[
					process.execPath,
					path.join(pnpmRoot, "bin/pnpm.cjs"),
					"install",
					"--ignore-scripts",
					"--registry=https://registry.npmjs.org",
					"--store-dir",
					path.join(tmpA, "pnpm-store"),
				],
				{
					domains: { "registry.npmjs.org": "allow" },
					env: {
						npm_config_cache: path.join(tmpA, "npm-cache"),
						npm_config_userconfig: "/dev/null",
						npm_config_globalconfig: "/dev/null",
						COREPACK_ENABLE_PROJECT_SPEC: "0",
					},
				},
			);
			assert.equal(installed.exit.exitCode, 0, JSON.stringify(installed));
			const verified = await run([
				process.execPath,
				"-e",
				'require("assert").equal(require("is-number")(42),true);require("fs").writeFileSync("verified", "OK")',
			]);
			assert.equal(verified.exit.exitCode, 0, JSON.stringify(verified));
			assert.equal(await fs.readFile(path.join(a, "verified"), "utf8"), "OK");
			return { installed, verified };
		},
	);
	await check("git init add commit and diff", async () => {
		const commands = [
			["init"],
			["add", "sentinel"],
			[
				"-c",
				"user.name=Probe",
				"-c",
				"user.email=probe@example.invalid",
				"commit",
				"-m",
				"probe",
			],
		];
		const results = [];
		for (const args of commands) {
			const result = await run([
				"/Library/Developer/CommandLineTools/usr/bin/git",
				...args,
			]);
			assert.equal(result.exit.exitCode, 0, JSON.stringify(result));
			results.push(result);
		}
		await fs.writeFile(path.join(a, "sentinel"), "CHANGED\n");
		const diff = await run([
			"/Library/Developer/CommandLineTools/usr/bin/git",
			"diff",
			"--stat",
		]);
		assert.equal(diff.exit.exitCode, 0, JSON.stringify(diff));
		assert.match(diff.head, /sentinel/);
		return [...results, diff];
	});
	if (rgPath)
		await check(
			"existing rg can search target under same process sandbox",
			async () => {
				const result = await run([rgPath, "A", "sentinel"]);
				assert.equal(result.exit.exitCode, 0, JSON.stringify(result));
				assert.match(result.head, /A/);
				return result;
			},
		);
	await check(
		"bundled apply_patch can add edit rename and delete target files",
		async () => {
			const patches = [
				"*** Begin Patch\n*** Add File: edited.txt\n+Hello\n*** End Patch",
				"*** Begin Patch\n*** Update File: edited.txt\n*** Move to: moved.txt\n@@\n-Hello\n+World\n*** End Patch",
				"*** Begin Patch\n*** Delete File: moved.txt\n*** End Patch",
			];
			const results = [];
			for (let index = 0; index < patches.length; index++) {
				const result = await run([
					binary,
					"--codex-run-as-apply-patch",
					patches[index],
				]);
				assert.equal(result.exit.exitCode, 0, JSON.stringify(result));
				results.push(result);
				if (index === 0)
					assert.equal(
						await fs.readFile(path.join(a, "edited.txt"), "utf8"),
						"Hello\n",
					);
				if (index === 1) {
					assert.equal(
						await fs.readFile(path.join(a, "moved.txt"), "utf8"),
						"World\n",
					);
					await assert.rejects(fs.stat(path.join(a, "edited.txt")));
				}
			}
			await assert.rejects(fs.stat(path.join(a, "moved.txt")));
			return results;
		},
	);
	await check(
		"bundled apply_patch cannot edit outside files or follow outside link",
		async () => {
			const results = [];
			for (const file of [
				path.join(outside, "sentinel"),
				"outside-link/sentinel",
			]) {
				const patch = `*** Begin Patch\n*** Update File: ${file}\n@@\n-OUTSIDE\n+BAD\n*** End Patch`;
				const result = await run([binary, "--codex-run-as-apply-patch", patch]);
				assert.notEqual(result.exit.exitCode, 0, JSON.stringify(result));
				results.push(result);
			}
			assert.equal(
				await fs.readFile(path.join(outside, "sentinel"), "utf8"),
				"OUTSIDE",
			);
			return results;
		},
	);
	await check("closing stdio terminates managed ordinary process", async () => {
		const pidFile = path.join(a, "disconnect.pid");
		const proc = await start([
			"/bin/sh",
			"-c",
			'sleep 120 & echo $! > "$1"; echo READY; wait',
			"sh",
			pidFile,
		]);
		await wait(() => proc.head.includes("READY"));
		const pid = await rememberPid(pidFile);
		server.stdin.end();
		await wait(() => server.exitCode !== null, 5000);
		await wait(() => {
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				return true;
			}
		}, 2500);
		assert.equal(server.exitCode, 0);
		return { serverExit: server.exitCode, descendantPid: pid };
	});
} finally {
	server.stdin.end();
	if (server.exitCode === null) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		if (server.exitCode === null) server.kill("SIGKILL");
	}
	for (const pid of managedPids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	const result = {
		version: "0.162.0",
		platform: process.platform,
		node: process.version,
		root,
		checks,
		networkEvents: events.filter((event) =>
			event.method.startsWith("network/"),
		),
		stderr,
		serverExit: server.exitCode,
	};
	await fs.writeFile(outputFile, JSON.stringify(result, null, 2));
	await fs.rm(root, { recursive: true, force: true });
}
console.log(
	JSON.stringify({
		passed: checks.filter((c) => c.status === "passed").length,
		failed: checks.filter((c) => c.status === "failed").length,
		outputFile,
	}),
);
process.exitCode = checks.some((c) => c.status === "failed") ? 1 : 0;
