import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
const root = await fs.realpath(await fs.mkdtemp("/tmp/tmsb-edge-"));
const report = { version: "0.7.8", root, checks: [], cleanup: [] };
const boxes = [];
const base = {
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	MSB_HOME: process.env.MSB_HOME,
	TMPDIR: process.env.TMPDIR,
};
const file = outputFile;
async function save() {
	await fs.writeFile(
		file,
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
	} catch (e) {
		report.checks.push({
			name,
			pass: false,
			ms: performance.now() - started,
			error: { name: e.name, message: e.message },
		});
		console.log(`FAIL ${name}: ${e.message}`);
	}
	await save();
}
async function create(label, policy, tls = false, mounts = [root]) {
	const start = performance.now();
	let b = Sandbox.builder(`tmsbedge-${path.basename(root)}-${label}`)
		.image("node:24-alpine")
		.rootDisk(1024)
		.memory(512)
		.cpus(1)
		.security("restricted")
		.network((n) => {
			n.policy(policy);
			if (tls) n.tls((t) => t.verifyUpstream(true));
			return n;
		});
	for (const p of mounts) b = b.volume(p, (m) => m.bind(p).quota(128));
	const box = await b.create();
	boxes.push(box);
	console.log(`CREATED ${label} ${Math.round(performance.now() - start)}ms`);
	return box;
}
async function exec(box, cmd, args, timeout = 10000, cwd = "/") {
	const r = await box.execWith(cmd, (e) =>
		e.args(args).timeout(timeout).cwd(cwd),
	);
	return {
		code: r.code,
		stdout: r.stdout().slice(0, 4000),
		stderr: r.stderr().slice(-4000),
	};
}
const get =
	"fetch(process.argv[1],{signal:AbortSignal.timeout(2500)}).then(async r=>{console.log(r.status);await r.arrayBuffer();process.exit(r.ok?0:2)}).catch(e=>{console.error(e.message,e.cause?.code);process.exit(1)})";
const policy = {
	defaultEgress: "deny",
	defaultIngress: "deny",
	rules: [Rule.allowEgress(Destination.domainSuffix("npmjs.org"))],
};
let opaque, domain;
try {
	await check(
		"strict domain HTTPS without interception fails closed",
		async () => {
			opaque = await create("opaque", policy);
			const r = await exec(opaque, "node", [
				"-e",
				get,
				"https://registry.npmjs.org/is-number",
			]);
			assert.notEqual(r.code, 0);
			return r;
		},
	);
	await check(
		"domain suffix allows HTTPS subdomain with interception",
		async () => {
			domain = await create("tls", policy, true);
			const r = await exec(domain, "node", [
				"-e",
				get,
				"https://registry.npmjs.org/is-number",
			]);
			assert.equal(r.code, 0);
			return {
				r,
				ca: await exec(domain, "node", [
					"-p",
					"JSON.stringify({NODE_EXTRA_CA_CERTS:process.env.NODE_EXTRA_CA_CERTS,SSL_CERT_FILE:process.env.SSL_CERT_FILE})",
				]),
			};
		},
	);
	await check(
		"pnpm install under restricted TLS-intercepted registry scope",
		async () => {
			const prep = await exec(
				domain,
				"npm",
				["install", "-g", "pnpm@11.22.0"],
				30000,
			);
			assert.equal(prep.code, 0, JSON.stringify(prep));
			const folder = path.join(root, "project");
			await fs.mkdir(folder);
			await fs.writeFile(
				path.join(folder, "package.json"),
				JSON.stringify({
					name: "restricted-project",
					private: true,
					dependencies: { "is-number": "7.0.0" },
				}),
			);
			const r = await exec(
				domain,
				"pnpm",
				[
					"install",
					"--ignore-scripts",
					"--store-dir",
					path.join(root, "store"),
				],
				30000,
				folder,
			);
			assert.equal(r.code, 0, JSON.stringify(r));
			const verified = await exec(
				domain,
				"node",
				[
					"-e",
					"require('assert')(require('is-number')(3));console.log('VERIFIED')",
				],
				10000,
				folder,
			);
			assert.equal(verified.code, 0);
			return { prep, r, verified };
		},
	);
	await check(
		"clearing proxy variables cannot bypass denied domain",
		async () => {
			const r = await exec(domain, "node", [
				"-e",
				"for(const p of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])delete process.env[p];" +
					get,
				"https://example.com/",
			]);
			assert.notEqual(r.code, 0);
			return r;
		},
	);
	await check("filesystem stream/rename/delete and binary bytes", async () => {
		const p = path.join(root, "binary"),
			q = path.join(root, "renamed");
		const bytes = Buffer.from([0, 255, 127, 10, 0]);
		const sink = await domain.fs().writeStream(p);
		await sink.write(bytes);
		await sink.close();
		const reader = await domain.fs().readStream(p);
		assert.deepEqual(Buffer.from(await reader.collect()), bytes);
		await domain.fs().rename(p, q);
		assert.deepEqual(Buffer.from(await fs.readFile(q)), bytes);
		await domain.fs().remove(q);
		await assert.rejects(fs.stat(q));
		return { bytes: [...bytes], renamedAndRemoved: true };
	});
	await check(
		"cached clean sandbox baseline survives repeated creation",
		async () => {
			const times = [];
			for (let i = 0; i < 3; i++) {
				const start = performance.now();
				const b = await create(`warm${i}`, NetworkPolicy.none());
				times.push(performance.now() - start);
				assert.equal((await exec(b, "node", ["-e", "console.log(1)"])).code, 0);
				await b.killWithTimeout(10000);
				await Sandbox.remove(b.name);
				boxes.splice(boxes.indexOf(b), 1);
			}
			return { timesMs: times };
		},
	);
	await check("literal colon target is supported", async () => {
		const target = path.join(root, "target:colon");
		await fs.mkdir(target);
		const b = await create("colon", NetworkPolicy.none(), false, [target]);
		await b.fs().write(path.join(target, "sentinel"), "COLON");
		assert.equal(
			await fs.readFile(path.join(target, "sentinel"), "utf8"),
			"COLON",
		);
		return { target };
	});
	await check(
		"attached VM terminates after host SDK process exits",
		async () => {
			const name = `tmsb-edge-host-exit-${path.basename(root)}`;
			const code = `import {Sandbox} from ${JSON.stringify(pathToFileURL(path.join(sdkDirectory, "node_modules/microsandbox/dist/index.js")).href)};await Sandbox.builder('${name}').image('node:24-alpine').memory(256).network(n=>n.policy({defaultEgress:'deny',defaultIngress:'deny',rules:[]})).create();console.log('READY');process.exit(0);`;
			const r = spawnSync(
				process.execPath,
				["--input-type=module", "-e", code],
				{ env: base, encoding: "utf8", timeout: 15000 },
			);
			assert.equal(
				r.status,
				0,
				JSON.stringify({ status: r.status, stderr: r.stderr }),
			);
			assert.match(r.stdout, /READY/);
			await new Promise((resolve) => setTimeout(resolve, 350));
			const handle = await Sandbox.get(name);
			const stopped = await handle.waitForStatus("stopped");
			await Sandbox.remove(name);
			return { stdout: r.stdout, stderr: r.stderr, status: stopped.name };
		},
	);
	report.logs = await domain.logs({ sources: ["system"], tail: 10 });
	report.metrics = await domain.metrics();
} finally {
	for (const b of boxes) {
		try {
			await b.killWithTimeout(10000);
			await Sandbox.remove(b.name);
			report.cleanup.push({ name: b.name, pass: true });
		} catch (e) {
			report.cleanup.push({ name: b.name, pass: false, error: String(e) });
		}
	}
	const all = await Sandbox.list();
	for (const b of all.sandboxes) {
		if (b.name.includes(path.basename(root))) {
			try {
				await b.killWithTimeout(10000);
				await Sandbox.remove(b.name);
				report.cleanup.push({ name: b.name, pass: true, recovered: true });
			} catch (e) {
				report.cleanup.push({ name: b.name, pass: false, error: String(e) });
			}
		}
	}
	report.passed = report.checks.filter((c) => c.pass).length;
	report.failed = report.checks.filter((c) => !c.pass).length;
	await save();
	if (report.cleanup.every((c) => c.pass))
		await fs.rm(root, { recursive: true, force: true });
	console.log(JSON.stringify({ passed: report.passed, failed: report.failed }));
	if (report.failed) process.exitCode = 1;
}
