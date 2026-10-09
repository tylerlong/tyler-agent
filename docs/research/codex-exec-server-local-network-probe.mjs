import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
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
const root = await fs.realpath(await fs.mkdtemp("/tmp/tce-local-probe-"));
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
function network(domains, allowLocalBinding = false) {
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
			allowLocalBinding,
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
		sandbox: options.nativeNetwork
			? {
					...sandbox(target),
					permissions: { ...sandbox(target).permissions, network: "enabled" },
				}
			: (options.sandbox ?? sandbox(target)),
		...(options.domains
			? {
					enforceManagedNetwork: true,
					networkProxy: network(options.domains, options.localBinding ?? false),
				}
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
const existing = createServer((_request, response) =>
	response.end("EXISTING_SERVER_OK"),
);
const listening = new Promise((resolve, reject) => {
	existing.once("error", reject);
	existing.listen(0, "127.0.0.1", resolve);
});
async function check(name, expected, action) {
	let detail;
	try {
		detail = await action();
		assert.equal(detail.exit?.exitCode, expected, JSON.stringify(detail));
		checks.push({ name, status: "passed", expectedExit: expected, detail });
	} catch (error) {
		checks.push({
			name,
			status: "failed",
			expectedExit: expected,
			error: error.message,
			detail,
		});
	}
	console.log(`${checks.at(-1).status}: ${name}`);
}
const internalTest = `
const http = require("node:http");
const server = http.createServer((_req,res)=>res.end("LOCAL_TEST_OK"));
server.once("error", error=>{ console.error(error.code, error.message); process.exit(11); });
server.listen(0,"127.0.0.1",()=>{
  http.get({hostname:"127.0.0.1",port:server.address().port,path:"/"},res=>{
    let body="";res.on("data",x=>body+=x);res.on("end",()=>{
      console.log(body);server.close(()=>process.exit(body==="LOCAL_TEST_OK"?0:12));
    });
  }).once("error",error=>{console.error(error.code,error.message);server.close(()=>process.exit(13));});
});
setTimeout(()=>{console.error("TEST_TIMEOUT");process.exit(14)},6000).unref();
`;
try {
	await listening;
	const response = await rpc("initialize", {
		clientName: "tyler-agent-local-network-probe",
	});
	assert(!response.error, JSON.stringify(response));
	server.stdin.write(
		`${JSON.stringify({ method: "initialized", params: {} })}\n`,
	);
	const url = `http://127.0.0.1:${existing.address().port}/`;
	const viaProxy = [
		"/bin/sh",
		"-c",
		`exec /usr/bin/curl --fail --silent --show-error --max-time 6 --noproxy '' --proxy "$HTTP_PROXY" '${url}'`,
	];
	await check("proxy wildcard false rejects existing loopback server", 22, () =>
		run(viaProxy, { domains: { "*": "allow" } }),
	);
	await check("proxy exact IP false permits existing loopback server", 0, () =>
		run(viaProxy, { domains: { "127.0.0.1": "allow" } }),
	);
	await check("proxy wildcard false rejects internal listener", 11, () =>
		run([process.execPath, "-e", internalTest], { domains: { "*": "allow" } }),
	);
	await check("proxy exact IP false still rejects internal listener", 11, () =>
		run([process.execPath, "-e", internalTest], {
			domains: { "127.0.0.1": "allow" },
		}),
	);
	await check("proxy wildcard true runs internal localhost test", 0, () =>
		run([process.execPath, "-e", internalTest], {
			domains: { "*": "allow" },
			localBinding: true,
		}),
	);
	await check("proxy empty domains true runs internal localhost test", 0, () =>
		run([process.execPath, "-e", internalTest], {
			domains: {},
			localBinding: true,
		}),
	);
	await check(
		"native enabled without proxy runs internal localhost test",
		0,
		() => run([process.execPath, "-e", internalTest], { nativeNetwork: true }),
	);
	await check("restricted without proxy rejects internal listener", 11, () =>
		run([process.execPath, "-e", internalTest]),
	);
	const outsideRead = `try {require("node:fs").readFileSync(${JSON.stringify(path.join(outside, "sentinel"))});console.error("OUTSIDE_READ_ALLOWED");process.exit(15)}catch(error){console.log("FILE_DENIED",error.code);process.exit(["EPERM","EACCES"].includes(error.code)?0:16)}`;
	await check("local binding preserves restricted file policy", 0, () =>
		run([process.execPath, "-e", outsideRead], {
			domains: { "*": "allow" },
			localBinding: true,
		}),
	);
	await check(
		"native network enabled preserves restricted file policy",
		0,
		() => run([process.execPath, "-e", outsideRead], { nativeNetwork: true }),
	);
} finally {
	for (const proc of processes.values())
		if (!proc.closed)
			await rpc("process/terminate", { processId: proc.processId }, 3000).catch(
				() => {},
			);
	existing.close();
	const ended = new Promise((resolve) => server.once("exit", resolve));
	server.stdin.end();
	const timer = setTimeout(() => server.kill("SIGTERM"), 3000);
	await ended;
	clearTimeout(timer);
	assert(root.startsWith("/private/tmp/tce-local-probe-"));
	await fs.rm(root, { recursive: true, force: true });
}
const report = {
	date: new Date().toISOString(),
	version: "0.162.0",
	platform: process.platform,
	arch: process.arch,
	node: process.version,
	passed: checks.filter((x) => x.status === "passed").length,
	failed: checks.filter((x) => x.status === "failed").length,
	checks,
	cleaned: true,
	stderr: stderr.slice(-4000),
};
await fs.writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(
	JSON.stringify({
		passed: report.passed,
		failed: report.failed,
		cleaned: report.cleaned,
	}),
);
process.exitCode = report.failed ? 1 : 0;
