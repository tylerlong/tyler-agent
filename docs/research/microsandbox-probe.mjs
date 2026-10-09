import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Only self-created fixtures; no model credentials or application service.
const [sdkDirectory, outputFile] = process.argv.slice(2);
assert(
	sdkDirectory && outputFile,
	"Usage: node probe.mjs /absolute/sdk /absolute/results.json",
);
const { Sandbox, NetworkPolicy, Rule, Destination, setDefaultBackend } =
	await import(
		pathToFileURL(
			path.join(sdkDirectory, "node_modules/microsandbox/dist/index.js"),
		)
	);
setDefaultBackend("local");
assert.equal(
	JSON.parse(
		await fs.readFile(
			path.join(sdkDirectory, "node_modules/microsandbox/package.json"),
			"utf8",
		),
	).version,
	"0.7.8",
);
const root = await fs.realpath(await fs.mkdtemp("/tmp/tmsb-probe-"));
const a = path.join(root, "a");
const b = path.join(root, "b");
const outside = path.join(root, "outside");
const special = path.join(root, "target [*?] ü");
const comma = path.join(root, "target,comma");
const tmpA = path.join(root, "tmp-a");
const tmpB = path.join(root, "tmp-b");
const readOnly = path.join(root, "readonly");
for (const folder of [a, b, outside, special, comma, tmpA, tmpB, readOnly])
	await fs.mkdir(folder);
await fs.writeFile(path.join(a, "sentinel"), "A");
await fs.writeFile(path.join(b, "sentinel"), "B");
await fs.writeFile(path.join(outside, "sentinel"), "OUTSIDE");
await fs.writeFile(path.join(tmpB, "sentinel"), "OTHER_AGENT_TMP");
await fs.writeFile(path.join(readOnly, "sentinel"), "READ_ONLY");
await fs.symlink(outside, path.join(a, "outside-link"));
await fs.link(path.join(outside, "sentinel"), path.join(a, "outside-hardlink"));

const image = "node:24-alpine";
const report = {
	version: "0.7.8",
	source: "7b7b9dc89e9a1c77801918f7833c3381d1754579",
	image,
	startedAt: new Date().toISOString(),
	root,
	checks: [],
	creations: [],
	cleanup: [],
};
const boxes = new Map();
const prefix = path.basename(root).replaceAll("-", "");
const summarize = (output) => ({
	code: output.code,
	status: output.status,
	stdout: output.stdout().slice(0, 4000),
	stderr: output.stderr().slice(-4000),
});
async function save() {
	await fs.writeFile(
		outputFile,
		JSON.stringify(
			report,
			(_, v) => (typeof v === "bigint" ? String(v) : v),
			2,
		),
	);
}
async function check(name, fn) {
	const started = performance.now();
	try {
		const details = await fn();
		report.checks.push({
			name,
			pass: true,
			ms: performance.now() - started,
			details,
		});
		console.log(`PASS ${name}`);
	} catch (error) {
		report.checks.push({
			name,
			pass: false,
			ms: performance.now() - started,
			error: { name: error.name, message: error.message, stack: error.stack },
		});
		console.log(`FAIL ${name}: ${error.message}`);
	}
	await save();
}
async function create(
	label,
	{
		mounts = [a, tmpA],
		readOnlyMounts = [],
		policy = NetworkPolicy.none(),
		strict = true,
		tls = false,
		fullFiles = false,
	} = {},
) {
	const name = `${prefix}-${label}`;
	const started = performance.now();
	let builder = Sandbox.builder(name)
		.image(image)
		.cpus(1)
		.memory(512)
		.rootDisk(1024)
		.security("restricted")
		.metricsSampleIntervalMs(200)
		.network((n) => {
			n.policy(policy).strict(strict);
			if (tls) n.tls((t) => t.verifyUpstream(true));
			return n;
		});
	for (const mount of mounts)
		builder = builder.volume(mount, (m) => m.bind(mount).quota(128));
	for (const mount of readOnlyMounts)
		builder = builder.volume(mount, (m) => m.bind(mount).readonly());
	if (fullFiles)
		builder = builder.volume("/host", (m) =>
			m.bind("/").statVirtualization("off").quota(128),
		);
	const creation = await builder.createWithProgress();
	const events = [];
	const progress = (async () => {
		for await (const event of creation) {
			if (!event.kind.endsWith("Progress")) events.push(event);
		}
	})();
	const timeout = setTimeout(() => creation.cancel(), 120000);
	try {
		const box = await creation.awaitSandbox();
		boxes.set(name, box);
		await progress;
		report.creations.push({
			label,
			name,
			ms: performance.now() - started,
			events,
		});
		console.log(
			`CREATED ${label} ${Math.round(performance.now() - started)}ms`,
		);
		return box;
	} finally {
		clearTimeout(timeout);
	}
}
async function run(box, script, options = {}) {
	return summarize(
		await box.execWith("node", (e) =>
			e
				.args(["-e", script, ...(options.args ?? [])])
				.timeout(options.timeout ?? 10000)
				.cwd(options.cwd ?? "/")
				.envs({ TMPDIR: tmpA, ...options.env }),
		),
	);
}
async function rejected(fn) {
	try {
		await fn();
	} catch (error) {
		return { name: error.name, message: error.message };
	}
	assert.fail("operation unexpectedly succeeded");
}
async function bounded(promise, milliseconds) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`operation deadline ${milliseconds}ms`)),
					milliseconds,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
const fetchScript =
	"fetch(process.argv[1],{signal:AbortSignal.timeout(5000)}).then(async r=>{console.log(r.status);await r.arrayBuffer();process.exit(r.ok?0:2)}).catch(e=>{console.error(e.name,e.message,e.cause?.code);process.exit(1)})";
async function fetchUrl(box, url, env = {}) {
	return run(box, fetchScript, { args: [url], env });
}
async function kill(box) {
	await box.killWithTimeout(15000);
	await Sandbox.remove(box.name);
	boxes.delete(box.name);
}

let A, B, extra, domain, fullNetwork;
try {
	await check("Node Linux image boot without account or model", async () => {
		A = await create("a", {
			mounts: [a, tmpA, special],
			readOnlyMounts: [readOnly],
		});
		const result = summarize(
			await A.exec("node", [
				"-p",
				"JSON.stringify({platform:process.platform,arch:process.arch,version:process.version})",
			]),
		);
		assert.equal(result.code, 0);
		assert.equal(JSON.parse(result.stdout).platform, "linux");
		return result;
	});
	assert(A, "bootstrap failed; cannot execute dependent checks");
	await check("cached image creates separate B permission scope", async () => {
		B = await create("b", { mounts: [b, tmpB] });
		return { ping: await B.ping(), config: await B.config() };
	});
	await check("concurrent filesystem scopes, target and own tmp", async () => {
		const results = await Promise.all([
			A.fs().readToString(path.join(a, "sentinel")),
			B.fs().readToString(path.join(b, "sentinel")),
			rejected(() => A.fs().readToString(path.join(b, "sentinel"))),
			rejected(() => B.fs().readToString(path.join(a, "sentinel"))),
			rejected(() => A.fs().readToString(path.join(tmpB, "sentinel"))),
		]);
		assert.equal(results[0], "A");
		assert.equal(results[1], "B");
		await A.fs().write(path.join(tmpA, "own"), "OWN_TMP");
		assert.equal(await fs.readFile(path.join(tmpA, "own"), "utf8"), "OWN_TMP");
		return results;
	});
	await check(
		"commands cannot read/write outside or other agent tmp",
		async () => {
			const result = await run(
				A,
				"const fs=require('fs'),p=process.argv.slice(1);for(const x of p){for(const fn of [()=>fs.readFileSync(x),()=>fs.writeFileSync(x,'ESCAPE')]){try{fn();process.exit(2)}catch(e){console.log(e.code)}}}",
				{ args: [path.join(outside, "sentinel"), path.join(tmpB, "sentinel")] },
			);
			assert.equal(result.code, 0);
			assert.equal(
				await fs.readFile(path.join(outside, "sentinel"), "utf8"),
				"OUTSIDE",
			);
			return result;
		},
	);
	await check("literal glob characters and Unicode Target paths", async () => {
		const filename = path.join(special, "value [*?] ü");
		await A.fs().write(filename, "LITERAL");
		assert.equal(await fs.readFile(filename, "utf8"), "LITERAL");
		const result = await run(
			A,
			"console.log(require('fs').readFileSync(process.argv[1],'utf8'))",
			{ args: [filename] },
		);
		assert.equal(result.code, 0);
		assert.equal(result.stdout.trim(), "LITERAL");
		return result;
	});
	await check(
		"read-only host mount cannot be modified by guest root",
		async () => {
			assert.equal(
				await A.fs().readToString(path.join(readOnly, "sentinel")),
				"READ_ONLY",
			);
			const error = await rejected(() =>
				A.fs().write(path.join(readOnly, "sentinel"), "ESCAPE"),
			);
			const result = await run(
				A,
				"try{require('fs').writeFileSync(process.argv[1],'ESCAPE');process.exit(2)}catch(e){console.log(e.code)}",
				{ args: [path.join(readOnly, "sentinel")] },
			);
			assert.equal(result.code, 0);
			assert.equal(
				await fs.readFile(path.join(readOnly, "sentinel"), "utf8"),
				"READ_ONLY",
			);
			return { error, result };
		},
	);
	await check(
		"unapproved symlink target denied through fs and command",
		async () => {
			const filename = path.join(a, "outside-link/sentinel");
			const errors = [
				await rejected(() => A.fs().readToString(filename)),
				await rejected(() => A.fs().write(filename, "ESCAPE")),
			];
			const result = await run(
				A,
				"try{require('fs').readFileSync(process.argv[1]);process.exit(2)}catch(e){console.log(e.code)}",
				{ args: [filename] },
			);
			assert.equal(result.code, 0);
			assert.equal(
				await fs.readFile(path.join(outside, "sentinel"), "utf8"),
				"OUTSIDE",
			);
			return { errors, result };
		},
	);
	await check("fs rename/delete link modifies link entry only", async () => {
		const first = path.join(a, "outside-link"),
			second = path.join(a, "moved-link");
		await A.fs().rename(first, second);
		await A.fs().remove(second);
		assert.equal(
			await fs.readFile(path.join(outside, "sentinel"), "utf8"),
			"OUTSIDE",
		);
		await fs.symlink(outside, first);
		return { outsidePreserved: true };
	});
	await check(
		"existing cross-scope hardlink remains accepted best-efforts limit",
		async () => {
			await A.fs().write(path.join(a, "outside-hardlink"), "HARDLINK");
			assert.equal(
				await fs.readFile(path.join(outside, "sentinel"), "utf8"),
				"HARDLINK",
			);
			await fs.writeFile(path.join(outside, "sentinel"), "OUTSIDE");
			return {
				warning:
					"writes through an existing hardlink affect an outside inode; accepted v1 limitation",
			};
		},
	);
	await check(
		"approval once: new VM adds target, next baseline command denied",
		async () => {
			extra = await create("extra", { mounts: [a, tmpA, outside] });
			assert.equal(
				await extra.fs().readToString(path.join(a, "outside-link/sentinel")),
				"OUTSIDE",
			);
			await extra.fs().write(path.join(outside, "approved"), "APPROVED");
			assert.equal(
				await fs.readFile(path.join(outside, "approved"), "utf8"),
				"APPROVED",
			);
			return {
				nextBaselineDenied: await rejected(() =>
					A.fs().readToString(path.join(outside, "approved")),
				),
				newInstanceRequired: true,
			};
		},
	);
	await check(
		"host copy methods are trusted operations, not guest isolation",
		async () => {
			await A.fs().copyFromHost(
				path.join(outside, "sentinel"),
				path.join(a, "copied-from-host"),
			);
			assert.equal(
				await A.fs().readToString(path.join(a, "copied-from-host")),
				"OUTSIDE",
			);
			await A.fs().copyToHost(
				path.join(a, "sentinel"),
				path.join(outside, "copied-to-host"),
			);
			assert.equal(
				await fs.readFile(path.join(outside, "copied-to-host"), "utf8"),
				"A",
			);
			return {
				warning:
					"SDK host copy bypasses guest mount scope; must omit or validate host arguments in trusted adapter",
			};
		},
	);
	await check("network deny and direct IP bypass denied", async () => {
		const results = await Promise.all([
			fetchUrl(A, "https://registry.npmjs.org/is-number"),
			fetchUrl(A, "http://1.1.1.1/", {
				HTTP_PROXY: "",
				HTTPS_PROXY: "",
				ALL_PROXY: "",
			}),
		]);
		for (const r of results) assert.notEqual(r.code, 0);
		return results;
	});
	const policy = {
		defaultEgress: "deny",
		defaultIngress: "deny",
		rules: [Rule.allowEgress(Destination.domain("registry.npmjs.org"))],
	};
	await check(
		"domain allowed with strict TLS interception; outside domain denied",
		async () => {
			domain = await create("domain", { policy, tls: true });
			const allowed = await fetchUrl(
				domain,
				"https://registry.npmjs.org/is-number",
			);
			const denied = await fetchUrl(domain, "https://example.com/");
			assert.equal(allowed.code, 0);
			assert.notEqual(denied.code, 0);
			return { allowed, denied, config: await domain.config() };
		},
	);
	await check(
		"independent network policies concurrent, no scope leakage",
		async () => {
			assert(domain, "domain VM missing");
			const results = await Promise.all([
				fetchUrl(domain, "https://registry.npmjs.org/is-number"),
				fetchUrl(B, "https://registry.npmjs.org/is-number"),
			]);
			assert.equal(results[0].code, 0);
			assert.notEqual(results[1].code, 0);
			return results;
		},
	);
	await check("full network keeps filesystem restricted", async () => {
		fullNetwork = await create("fullnetwork", {
			policy: { defaultEgress: "allow", defaultIngress: "deny", rules: [] },
		});
		const results = await Promise.all([
			fetchUrl(fullNetwork, "https://registry.npmjs.org/is-number"),
			fetchUrl(fullNetwork, "https://example.com/"),
		]);
		for (const r of results) assert.equal(r.code, 0);
		return {
			results,
			outsideDenied: await rejected(() =>
				fullNetwork.fs().readToString(path.join(outside, "sentinel")),
			),
		};
	});
	await check("full host filesystem bind retains network deny", async () => {
		assert(root.startsWith("/private/tmp/tmsb-probe-"));
		const full = await create("fullfiles", { mounts: [], fullFiles: true });
		const hostPath = `/host${path.join(outside, "fullfiles")}`;
		try {
			await bounded(full.fs().write(hostPath, "FULL_FILES"), 10000);
			assert.equal(
				await fs.readFile(path.join(outside, "fullfiles"), "utf8"),
				"FULL_FILES",
			);
			const denied = await fetchUrl(
				full,
				"https://registry.npmjs.org/is-number",
			);
			assert.notEqual(denied.code, 0);
			return { hostPath, denied };
		} finally {
			await kill(full);
		}
	});
	await check("8 MiB binary stdout stream is complete", async () => {
		const handle = await A.execStream("node", [
			"-e",
			"process.stdout.write(Buffer.alloc(8*1024*1024,97))",
		]);
		let bytes = 0;
		const hash = createHash("sha256");
		let exited;
		for await (const event of handle) {
			if (event.kind === "stdout") {
				bytes += event.data.length;
				hash.update(event.data);
			}
			if (event.kind === "exited") exited = event.code;
		}
		assert.equal(bytes, 8 * 1024 * 1024);
		assert.equal(exited, 0);
		const digest = hash.digest("hex");
		assert.equal(
			digest,
			createHash("sha256").update(Buffer.alloc(bytes, 97)).digest("hex"),
		);
		return { bytes, digest, exited };
	});
	for (const tty of [false, true])
		await check(`interactive input ${tty ? "PTY" : "pipe"}`, async () => {
			const handle = await A.execStreamWith("sh", (e) =>
				e
					.args(["-c", "read answer; printf 'REPLY:%s\\n' \"$answer\""])
					.stdinPipe()
					.tty(tty)
					.timeout(5000),
			);
			const stdin = await handle.takeStdin();
			assert(stdin);
			await stdin.write("hello\n");
			if (!tty) await stdin.close();
			const result = summarize(await handle.collect());
			assert.equal(result.code, 0);
			assert.match(result.stdout, /REPLY:hello/);
			return result;
		});
	await check("command timeout kills ordinary process", async () => {
		const pidFile = path.join(a, "timeout.pid");
		const started = performance.now();
		const error = await rejected(() =>
			run(
				A,
				"require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",
				{ timeout: 350, args: [pidFile] },
			),
		);
		assert.match(error.message, /timed out/i);
		assert(performance.now() - started < 5000);
		const pid = Number(await fs.readFile(pidFile, "utf8"));
		const alive = await run(
			A,
			"try{process.kill(Number(process.argv[1]),0);process.exit(2)}catch(e){console.log(e.code)}",
			{ args: [String(pid)] },
		);
		assert.equal(alive.code, 0);
		return { error, alive, ms: performance.now() - started };
	});
	await check(
		"kill ordinary descendants while sibling command survives",
		async () => {
			const pidFile = path.join(a, "ordinary.pid");
			const handle = await A.execStream("node", [
				"-e",
				"const cp=require('child_process'),fs=require('fs');const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(c.pid));console.log('READY');setInterval(()=>{},1000)",
				pidFile,
			]);
			while ((await handle.recv())?.kind !== "stdout") {}
			const sibling = A.execWith("node", (e) =>
				e
					.args(["-e", "setTimeout(()=>console.log('SIBLING'),500)"])
					.timeout(5000),
			);
			await handle.kill();
			const result = summarize(await handle.collect());
			const pid = Number(await fs.readFile(pidFile, "utf8"));
			const alive = await run(
				A,
				"try{process.kill(Number(process.argv[1]),0);process.exit(2)}catch(e){console.log(e.code)}",
				{ args: [String(pid)] },
			);
			const survivor = summarize(await sibling);
			assert.equal(alive.code, 0);
			assert.equal(survivor.code, 0);
			assert.match(survivor.stdout, /SIBLING/);
			return { result, alive, survivor };
		},
	);
	await check("command kill intentionally detached descendant", async () => {
		const pidFile = path.join(a, "detached.pid");
		const handle = await A.execStream("node", [
			"-e",
			"const cp=require('child_process'),fs=require('fs');const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(process.argv[1],String(c.pid));c.unref();console.log('READY');setInterval(()=>{},1000)",
			pidFile,
		]);
		while ((await handle.recv())?.kind !== "stdout") {}
		await handle.kill();
		await handle.collect();
		const pid = Number(await fs.readFile(pidFile, "utf8"));
		const alive = await run(
			A,
			"try{process.kill(Number(process.argv[1]),0);console.log('ALIVE');process.exit(2)}catch(e){console.log(e.code)}",
			{ args: [String(pid)] },
		);
		if (alive.code !== 0) {
			await run(A, "process.kill(Number(process.argv[1]),9)", {
				args: [String(pid)],
			});
		}
		assert.equal(alive.code, 0, "detached descendant survived command kill");
		return alive;
	});
	await check(
		"VM kill stops detached heartbeat and leaves B functional",
		async () => {
			const heartbeat = path.join(tmpA, "heartbeat");
			const handle = await extra.execStream("node", [
				"-e",
				"const cp=require('child_process');const c=cp.spawn(process.execPath,['-e',`const fs=require('fs');setInterval(()=>fs.writeFileSync(process.argv[1],String(Date.now())),40)`,process.argv[1]],{detached:true,stdio:'ignore'});c.unref();console.log('READY');setInterval(()=>{},1000)",
				heartbeat,
			]);
			while ((await handle.recv())?.kind !== "stdout") {}
			await new Promise((r) => setTimeout(r, 200));
			await handle.kill();
			await handle.collect();
			const before = await fs.readFile(heartbeat, "utf8");
			await new Promise((r) => setTimeout(r, 150));
			const running = await fs.readFile(heartbeat, "utf8");
			assert.notEqual(
				before,
				running,
				"detached heartbeat must still run before VM kill",
			);
			const started = performance.now();
			await kill(extra);
			const killMs = performance.now() - started;
			const stopped = await fs.readFile(heartbeat, "utf8");
			await new Promise((r) => setTimeout(r, 250));
			assert.equal(await fs.readFile(heartbeat, "utf8"), stopped);
			assert.equal(await B.fs().readToString(path.join(b, "sentinel")), "B");
			return {
				before,
				running,
				stopped,
				killMs,
				wasRunning: before !== running,
			};
		},
	);
	await check(
		"real Linux git and pnpm online install with artifact",
		async () => {
			assert(fullNetwork, "full network VM missing");
			const preparation = summarize(
				await fullNetwork.execWith("sh", (e) =>
					e
						.args([
							"-c",
							"apk add --no-cache git curl && npm install --global pnpm@11.22.0",
						])
						.timeout(90000),
				),
			);
			assert.equal(preparation.code, 0, JSON.stringify(preparation));
			const folder = path.join(a, "project");
			await fs.mkdir(folder);
			await fs.writeFile(
				path.join(folder, "package.json"),
				JSON.stringify({
					name: "probe-project",
					private: true,
					dependencies: { "is-number": "7.0.0" },
				}),
			);
			const install = summarize(
				await fullNetwork.execWith("pnpm", (e) =>
					e
						.args([
							"install",
							"--ignore-scripts",
							"--store-dir",
							path.join(tmpA, "pnpm-store"),
						])
						.cwd(folder)
						.timeout(60000)
						.env("HOME", tmpA),
				),
			);
			assert.equal(install.code, 0, JSON.stringify(install));
			const artifact = await run(
				fullNetwork,
				"const fs=require('fs'),assert=require('assert');assert(require('is-number')(3));fs.writeFileSync('verified.json',JSON.stringify({isNumber:true,platform:process.platform}));console.log('VERIFIED')",
				{ cwd: folder },
			);
			assert.equal(artifact.code, 0);
			assert.equal(
				JSON.parse(
					await fs.readFile(path.join(folder, "verified.json"), "utf8"),
				).isNumber,
				true,
			);
			const git = summarize(
				await fullNetwork.execWith("sh", (e) =>
					e
						.args([
							"-c",
							"git init && git add package.json && git -c user.name=Probe -c user.email=probe@example.invalid commit -m initial && printf '\\n' >> package.json && git diff --stat",
						])
						.cwd(folder)
						.timeout(15000),
				),
			);
			assert.equal(git.code, 0, JSON.stringify(git));
			assert.match(git.stdout, /package.json/);
			return { preparation, install, artifact, git };
		},
	);
	await check("literal comma Target rejected with explicit error", async () => {
		const error = await rejected(() => create("comma", { mounts: [comma] }));
		assert.match(error.message, /comma|mount|parse|invalid/i);
		return { error, requiresPreflightRejection: true };
	});
	report.metrics = await A.metrics();
} catch (error) {
	report.fatal = {
		name: error.name,
		message: error.message,
		stack: error.stack,
	};
	process.exitCode = 1;
} finally {
	for (const [name, box] of [...boxes]) {
		try {
			await kill(box);
			report.cleanup.push({ name, pass: true });
		} catch (error) {
			report.cleanup.push({ name, pass: false, error: String(error) });
			process.exitCode = 1;
		}
	}
	const known = await Sandbox.list();
	for (const handle of known.sandboxes) {
		if (handle.name.startsWith(prefix)) {
			try {
				await handle.killWithTimeout(10000);
				await Sandbox.remove(handle.name);
				report.cleanup.push({
					name: handle.name,
					pass: true,
					recoveredCreation: true,
				});
			} catch (error) {
				report.cleanup.push({
					name: handle.name,
					pass: false,
					error: String(error),
				});
			}
		}
	}
	report.finishedAt = new Date().toISOString();
	report.passed = report.checks.filter((x) => x.pass).length;
	report.failed = report.checks.filter((x) => !x.pass).length;
	await save();
	if (
		!process.env.MSB_PROBE_KEEP_FIXTURES &&
		report.cleanup.every((x) => x.pass)
	)
		await fs.rm(root, { recursive: true, force: true });
	if (report.failed) process.exitCode = 1;
	console.log(
		JSON.stringify({
			passed: report.passed,
			failed: report.failed,
			fatal: report.fatal,
			outputFile,
		}),
	);
}
