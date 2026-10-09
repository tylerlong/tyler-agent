// macOS experiment; see pi-sandbox-feasibility.md for isolated setup and expected failure.
// Usage: PI_PROBE_PNPM_ROOT=<installed-pnpm-root> node pi-sandbox-probe.mjs <runtime-root> <results.json>
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
	mkdir,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const self = fileURLToPath(import.meta.url);
const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const emit = (x) => process.stdout.write(JSON.stringify(x) + "\n");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) =>
	stat(p).then(
		() => true,
		() => false,
	);
const role = process.argv[2];
if (role === "worker") {
	const root = process.argv[3];
	const input = createInterface({ input: process.stdin });
	const lines = input[Symbol.asyncIterator]();
	const job = JSON.parse((await lines.next()).value);
	const controller = new AbortController();
	void (async () => {
		for await (const line of lines)
			if (JSON.parse(line).cancel) controller.abort();
	})();
	const attempts = [];
	const http = (await import("node:http")).default;
	const https = (await import("node:https")).default;
	const net = (await import("node:net")).default;
	const { syncBuiltinESMExports } = await import("node:module");
	const blocked =
		(label) =>
		(...args) => {
			attempts.push({ label, target: String(args[0]).slice(0, 160) });
			throw new Error("Unexpected worker network: " + label);
		};
	globalThis.fetch = blocked("fetch");
	for (const [name, m] of [
		["http", http],
		["https", https],
	])
		for (const method of ["request", "get"])
			m[method] = blocked(name + "." + method);
	net.Socket.prototype.connect = blocked("Socket.connect");
	syncBuiltinESMExports();
	const started = performance.now();
	const pi = await import(
		pathToFileURL(
			join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
		).href
	);
	const importMs = performance.now() - started;
	const tools = {
		read: pi.createReadTool(job.cwd),
		write: pi.createWriteTool(job.cwd),
		edit: pi.createEditTool(job.cwd),
		ls: pi.createLsTool(job.cwd),
		grep: pi.createGrepTool(job.cwd),
		find: pi.createFindTool(job.cwd),
		bash: pi.createBashTool(job.cwd, {
			shellPath: "/bin/bash",
			exposeSessionEnvironment: false,
		}),
	};
	const results = [];
	for (const call of job.calls) {
		let updates = 0;
		const rssBefore = process.memoryUsage().rss;
		try {
			const result = await tools[call.name].execute(
				"owned-call",
				call.args,
				controller.signal,
				(update) => {
					updates++;
					if (
						job.abortAfterMs !== undefined &&
						update.content?.some((c) => c.text)
					)
						emit({
							kind: "update",
							text: update.content
								.filter((c) => c.type === "text")
								.map((c) => c.text)
								.join("\n"),
						});
				},
			);
			const text =
				result.content
					?.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("\n") ?? "";
			const full =
				result.details?.fullOutputPath ??
				result.structuredContent?.full_output_path;
			results.push({
				ok: true,
				result: job.compact
					? {
							isError: result.isError,
							details: result.details,
							structuredContent: {
								...result.structuredContent,
								output: result.structuredContent?.output?.slice(0, 120),
							},
						}
					: result,
				stats: {
					textBytes: Buffer.byteLength(text),
					structuredBytes: Buffer.byteLength(
						result.structuredContent?.output ?? "",
					),
					fullPath: full,
					fullSize: full ? (await stat(full)).size : undefined,
					updates,
					rssDelta: process.memoryUsage().rss - rssBefore,
				},
			});
		} catch (error) {
			results.push({ ok: false, error: error.message, updates });
		}
	}
	emit({ kind: "done", results, attempts, importMs });
	input.close();
	process.exit(attempts.length ? 2 : 0);
} else if (role === "host") {
	const root = process.argv[3];
	const input = createInterface({ input: process.stdin });
	const job = JSON.parse((await input[Symbol.asyncIterator]().next()).value);
	input.close();
	process.env.CLAUDE_CODE_TMPDIR = job.tmp;
	const { SandboxManager, getDefaultWritePaths, SandboxRuntimeConfigSchema } =
		await import(
			pathToFileURL(
				join(root, "node_modules/@anthropic-ai/sandbox-runtime/dist/index.js"),
			).href
		);
	const runtimeRead = [
		job.pnpmRoot,
		join(root, "node_modules"),
		join(root, "bin"),
		self,
		resolve(dirname(process.execPath), ".."),
	];
	const policy = {
		network: {
			allowedDomains: job.domains ?? [],
			deniedDomains: [],
			strictAllowlist: !job.fullNetwork,
		},
		filesystem: {
			denyRead: job.fullFiles ? [] : ["/Users", "/Volumes", root],
			allowRead: job.fullFiles ? [] : [...runtimeRead, ...job.roots, job.tmp],
			allowWrite: job.fullFiles ? ["/"] : [...job.roots, job.tmp],
			denyWrite: job.fullFiles
				? []
				: getDefaultWritePaths().filter((p) => !p.startsWith("/dev/")),
		},
	};
	SandboxRuntimeConfigSchema.parse(policy);
	let callbackCalls = 0;
	let child;
	try {
		await SandboxManager.initialize(
			policy,
			job.fullNetwork
				? async () => {
						callbackCalls++;
						return true;
					}
				: undefined,
			false,
		);
		const wrapped = await SandboxManager.wrapWithSandbox(
			`${q(process.execPath)} ${q(self)} worker ${q(root)}`,
			"/bin/sh",
			undefined,
			undefined,
			{ commandId: job.id, commandText: job.id },
		);
		child = spawn("/bin/sh", ["-c", wrapped], {
			cwd: job.cwd,
			detached: true,
			env: {
				PATH: job.path,
				HOME: job.tmp,
				TMPDIR: job.tmp,
				XDG_CACHE_HOME: job.tmp,
				npm_config_cache: join(job.tmp, "npm-cache"),
				npm_config_store_dir: join(job.tmp, "pnpm-store"),
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				CI: "true",
				LANG: "en_US.UTF-8",
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stderr = "",
			done,
			abortSent = false;
		const parser = createInterface({ input: child.stdout });
		parser.on("line", (line) => {
			try {
				const x = JSON.parse(line);
				if (x.kind === "done") done = x;
				if (x.kind === "update" && !abortSent) {
					abortSent = true;
					setTimeout(
						() => child.stdin.write('{"cancel":true}\n'),
						job.abortAfterMs ?? 0,
					);
				}
			} catch {}
		});
		child.stderr.on("data", (data) => (stderr += data));
		child.stdin.write(JSON.stringify(job) + "\n");
		const hard = setTimeout(() => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
		}, 25000);
		const code = await new Promise((r, j) => {
			child.once("error", j);
			child.once("close", r);
		});
		clearTimeout(hard);
		const violations =
			SandboxManager.getSandboxViolationStore().getViolations();
		emit({
			code,
			done,
			stderr: stderr.slice(-2500),
			violations,
			callbackCalls,
			abortSent,
		});
	} finally {
		await SandboxManager.reset();
	}
} else {
	assert.equal(process.platform, "darwin");
	const root = await realpath(resolve(process.argv[2]));
	const output = resolve(process.argv[3]);
	const fixture = join(root, "fixture"),
		a = join(fixture, "a"),
		b = join(fixture, "b"),
		outside = join(fixture, "outside");
	await rm(fixture, { recursive: true, force: true });
	const pnpmRoot = process.env.PI_PROBE_PNPM_ROOT;
	assert(
		pnpmRoot,
		"Set PI_PROBE_PNPM_ROOT to the installed pnpm package directory",
	);
	await rm(join(root, "bin/pnpm"), { force: true });
	await symlink(join(pnpmRoot, "bin/pnpm.cjs"), join(root, "bin/pnpm"));
	for (const p of [a, b, outside]) await mkdir(p, { recursive: true });
	await writeFile(join(outside, "sentinel"), "PRIVATE_SENTINEL");
	await symlink(outside, join(a, "external-link"));
	const rg = execFileSync("/bin/sh", ["-c", "command -v rg"], {
		encoding: "utf8",
	}).trim();
	const path = [
		join(root, "bin"),
		dirname(process.execPath),
		dirname(rg),
		"/opt/homebrew/bin",
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
	].join(":");
	const checks = [];
	let seq = 0;
	async function run(calls, extra = {}) {
		const id = "case-" + ++seq,
			tmp = join(fixture, "t", id),
			hostTmp = join(root, "m", id);
		await mkdir(tmp, { recursive: true });
		await mkdir(hostTmp, { recursive: true });
		const job = {
			id,
			cwd: a,
			roots: [a],
			tmp,
			path,
			pnpmRoot,
			calls,
			...extra,
		};
		const child = spawn(process.execPath, [self, "host", root], {
			cwd: hostTmp,
			env: { PATH: path, HOME: hostTmp, TMPDIR: hostTmp, LANG: "en_US.UTF-8" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "",
			stderr = "";
		child.stdout.on("data", (c) => (stdout += c));
		child.stderr.on("data", (c) => (stderr += c));
		child.stdin.end(JSON.stringify(job) + "\n");
		const code = await new Promise((r, j) => {
			child.once("error", j);
			child.once("close", r);
		});
		assert.equal(code, 0, stderr);
		const result = JSON.parse(stdout.trim().split("\n").at(-1));
		assert.equal(result.code, 0, JSON.stringify(result));
		assert(result.done, JSON.stringify(result));
		assert.deepEqual(result.done.attempts, []);
		return { ...result, tmp };
	}
	const bash = (command, timeout = 10) => ({
		name: "bash",
		args: { command, timeout },
	});
	const item = (x) => x.done.results[0];
	const text = (x) =>
		item(x)
			.result?.content?.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n") ?? item(x).error;
	const success = (x) => {
		assert.equal(item(x).ok, true, JSON.stringify(x));
		assert.equal(item(x).result.structuredContent?.exit_code ?? 0, 0, text(x));
		assert(!item(x).result.isError, text(x));
	};
	const denied = (x) =>
		assert(item(x).result?.isError || !item(x).ok, JSON.stringify(x));
	async function check(name, fn) {
		if (
			process.env.PI_PROBE_FILTER &&
			!name.includes(process.env.PI_PROBE_FILTER)
		)
			return;
		const start = performance.now();
		try {
			const detail = await fn();
			checks.push({
				name,
				passed: true,
				ms: Math.round(performance.now() - start),
				detail,
			});
			console.error("PASS " + name);
		} catch (e) {
			checks.push({
				name,
				passed: false,
				ms: Math.round(performance.now() - start),
				error: e.message,
			});
			console.error("FAIL " + name + ": " + e.message.slice(0, 800));
		}
	}
	const get = (url) =>
		`/usr/bin/curl -fsS --connect-timeout 5 --max-time 8 ${q(url)} -o /dev/null -w 'STATUS:%{http_code}'`;
	await check(
		"restricted unknown HTTPS denied with destination fact",
		async () => {
			const x = await run([bash(get("https://registry.npmjs.org/is-number"))]);
			denied(x);
			assert(
				x.violations.some((v) =>
					JSON.stringify(v).includes("registry.npmjs.org"),
				),
			);
			return { text: text(x), violations: x.violations };
		},
	);
	await check("approved HTTPS domain succeeds", async () => {
		const x = await run([bash(get("https://registry.npmjs.org/is-number"))], {
			domains: ["registry.npmjs.org"],
		});
		success(x);
		assert.match(text(x), /STATUS:200/);
		return { text: text(x), callbackCalls: x.callbackCalls };
	});
	await check("allowed domain does not permit other domain", async () => {
		const x = await run([bash(get("https://example.com"))], {
			domains: ["registry.npmjs.org"],
		});
		denied(x);
		return { text: text(x), violations: x.violations };
	});
	await check("concurrent domain policies do not mix", async () => {
		const [x, y] = await Promise.all([
			run([bash(get("https://registry.npmjs.org/is-number"))], {
				domains: ["registry.npmjs.org"],
			}),
			run([bash(get("https://registry.npmjs.org/is-number"))], {
				cwd: b,
				roots: [b],
			}),
		]);
		success(x);
		denied(y);
		return { allowed: text(x), denied: text(y) };
	});
	await check("unsetting proxy cannot bypass OS network fence", async () => {
		const x = await run(
			[
				bash(
					`env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy ${get("https://registry.npmjs.org/is-number")}`,
				),
			],
			{ domains: ["registry.npmjs.org"] },
		);
		denied(x);
		return { text: text(x) };
	});
	await check("subdomain wildcard works", async () => {
		const x = await run([bash(get("https://registry.npmjs.org/is-number"))], {
			domains: ["*.npmjs.org"],
		});
		success(x);
		return { text: text(x) };
	});
	await check("full network via official constant-allow callback", async () => {
		const x = await run(
			[
				bash(
					get("https://registry.npmjs.org/is-number") +
						" && " +
						get("https://example.com"),
				),
			],
			{ fullNetwork: true },
		);
		success(x);
		assert(x.callbackCalls >= 2);
		return { text: text(x), callbackCalls: x.callbackCalls };
	});
	await check("full network preserves restricted files", async () => {
		const x = await run(
			[{ name: "read", args: { path: join(outside, "sentinel") } }],
			{ fullNetwork: true },
		);
		denied(x);
		return { error: item(x).error };
	});
	await check("full files preserves restricted network", async () => {
		const target = join(outside, "full-write");
		const x = await run(
			[
				bash(
					`printf full > ${q(target)}; ${get("https://registry.npmjs.org/is-number")}`,
				),
			],
			{ fullFiles: true },
		);
		denied(x);
		assert.equal(await readFile(target, "utf8"), "full");
		return { text: text(x) };
	});
	await check("extra folder once and revoked next launch", async () => {
		const target = join(b, "extra-once");
		const allowed = await run(
			[{ name: "write", args: { path: target, content: "approved" } }],
			{ roots: [a, b] },
		);
		assert(item(allowed).ok);
		const rejected = await run([
			{ name: "write", args: { path: target, content: "unapproved" } },
		]);
		denied(rejected);
		assert.equal(await readFile(target, "utf8"), "approved");
		return { rejected: item(rejected).error };
	});
	await check("Pi native timeout stops ordinary descendants", async () => {
		const pidFile = join(a, "timeout.pid");
		const x = await run([
			bash(`sleep 30 & printf '%s' $! > ${q(pidFile)}; wait`, 0.15),
		]);
		assert(!item(x).ok);
		assert.match(text(x), /timed out/);
		const pid = Number(await readFile(pidFile, "utf8"));
		await delay(100);
		assert.throws(() => process.kill(pid, 0));
		return { error: text(x), descendantPid: pid };
	});
	await check("host IPC abort stops ordinary descendants", async () => {
		const pidFile = join(a, "cancel.pid");
		const x = await run(
			[bash(`sleep 30 & printf '%s' $! > ${q(pidFile)}; printf 'READY'; wait`)],
			{ abortAfterMs: 80 },
		);
		assert(x.abortSent);
		assert(!item(x).ok);
		assert.match(text(x), /aborted/);
		const pid = Number(await readFile(pidFile, "utf8"));
		await delay(100);
		assert.throws(() => process.kill(pid, 0));
		return { error: text(x), descendantPid: pid };
	});
	await check(
		"finite 8MiB output is bounded and saved in own tmp",
		async () => {
			const x = await run(
				[
					bash(
						`${q(process.execPath)} -e ${q("process.stdout.write('x'.repeat(8*1024*1024))")}`,
					),
				],
				{ compact: true },
			);
			success(x);
			const s = item(x).stats;
			assert(s.textBytes < 60 * 1024);
			assert(s.structuredBytes < 1100 * 1024);
			assert.equal(s.fullSize, 8 * 1024 * 1024);
			assert(s.fullPath.startsWith(x.tmp + "/"));
			return s;
		},
	);
	await check(
		"all seven tools and failure path produce zero worker HTTP attempts",
		async () => {
			const file = join(a, "tools.txt");
			const x = await run([
				{ name: "write", args: { path: file, content: "hello world\n" } },
				{
					name: "edit",
					args: { path: file, edits: [{ oldText: "world", newText: "Pi" }] },
				},
				{ name: "read", args: { path: file } },
				{ name: "ls", args: { path: a } },
				{ name: "grep", args: { pattern: "Pi", path: a } },
				{ name: "find", args: { pattern: "*.txt", path: a } },
				bash("printf local"),
				{
					name: "edit",
					args: { path: file, edits: [{ oldText: "missing", newText: "bad" }] },
				},
			]);
			assert(
				x.done.results.slice(0, 7).every((r) => r.ok && !r.result.isError),
			);
			assert(!x.done.results[7].ok);
			assert.deepEqual(x.done.attempts, []);
			return {
				attempts: x.done.attempts,
				importMs: x.done.importMs,
				tools: x.done.results.length,
			};
		},
	);
	await check(
		"real pnpm install and Node test inside approved targets",
		async () => {
			const project = join(a, "project");
			await mkdir(project, { recursive: true });
			await writeFile(
				join(project, "package.json"),
				JSON.stringify({
					private: true,
					scripts: { test: "node --test test.cjs" },
					dependencies: { "is-number": "7.0.0" },
				}),
			);
			await writeFile(
				join(project, "test.cjs"),
				"const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');test('dependency and artifact',()=>{assert.equal(require('is-number')(42),true);fs.writeFileSync('artifact','verified')});",
			);
			const x = await run(
				[
					bash(
						`cd ${q(project)} && ${q(process.execPath)} ${q(join(pnpmRoot, "bin/pnpm.cjs"))} --version && ${q(process.execPath)} ${q(join(pnpmRoot, "bin/pnpm.cjs"))} install --ignore-scripts --registry=https://registry.npmjs.org --store-dir ${q(join(project, ".store"))} && ${q(process.execPath)} ${q(join(pnpmRoot, "bin/pnpm.cjs"))} test`,
						20,
					),
				],
				{ domains: ["registry.npmjs.org"] },
			);
			success(x);
			assert.equal(
				await readFile(join(project, "artifact"), "utf8"),
				"verified",
			);
			return { text: text(x) };
		},
	);
	await check("real git init/add/commit/diff", async () => {
		const project = join(a, "git-project");
		await mkdir(project, { recursive: true });
		const x = await run([
			bash(
				`cd ${q(project)} && git init -q && printf original > file && git add file && git -c user.name=Probe -c user.email=probe@example.invalid -c commit.gpgsign=false commit -qm probe && printf changed > file && git diff --exit-code >/dev/null; test $? = 1`,
			),
		]);
		success(x);
		assert(await exists(join(project, ".git/HEAD")));
		return { text: text(x) };
	});
	await check(
		"cancel must also stop intentionally detached descendant",
		async () => {
			const pidFile = join(a, "detached.pid");
			const script =
				"const fs=require('node:fs'),cp=require('node:child_process');const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(process.argv[1],String(c.pid));c.unref();console.log('READY');setInterval(()=>{},1000);";
			const x = await run(
				[bash(`${q(process.execPath)} -e ${q(script)} ${q(pidFile)}`)],
				{ abortAfterMs: 100 },
			);
			assert(!item(x).ok);
			const pid = Number(await readFile(pidFile, "utf8"));
			await delay(100);
			try {
				assert.throws(
					() => process.kill(pid, 0),
					"detached descendant survived Pi abort",
				);
				return { descendantPid: pid };
			} finally {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		},
	);
	const failed = checks.filter((c) => !c.passed);
	await writeFile(
		output,
		JSON.stringify(
			{
				versions: {
					pi: "1.1.0",
					srt: "0.0.78",
					node: process.version,
					platform: process.platform,
					arch: process.arch,
				},
				checks,
				passed: checks.length - failed.length,
				failed: failed.length,
			},
			null,
			2,
		) + "\n",
	);
	emit({
		passed: checks.length - failed.length,
		failed: failed.length,
		output,
	});
	process.exitCode = failed.length ? 1 : 0;
}
