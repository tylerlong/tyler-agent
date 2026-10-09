import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

// Only isolated downloads, gateway state, and self-created fixtures; no model.
const [root, outputFile, image = "node:24-bookworm-slim"] =
	process.argv.slice(2);
assert(root?.startsWith("/private/tmp/tos-verify-") && outputFile);
const env = {
	HOME: path.join(root, "home"),
	XDG_CONFIG_HOME: path.join(root, "home/config"),
	XDG_DATA_HOME: path.join(root, "home/data"),
	XDG_STATE_HOME: path.join(root, "home/state"),
	XDG_CACHE_HOME: path.join(root, "home/cache"),
	TMPDIR: path.join(root, "tmp"),
	PATH: `${root}/bin:${root}/tools/e2fsprogs/1.47.4/sbin:/usr/bin:/bin`,
	OPENSHELL_COLOR: "never",
	OPENSHELL_TELEMETRY_ENABLED: "false",
	OTEL_SDK_DISABLED: "true",
};
await fs.mkdir(env.TMPDIR, { recursive: true });
const report = {
	version: "0.1.3",
	source: "e1f3c82caa3ed3b65de22889ae7ef32a774878ef",
	image,
	startedAt: new Date().toISOString(),
	root,
	telemetryDisabled: true,
	checks: [],
	creations: [],
	cleanup: [],
};
async function save() {
	await fs.writeFile(outputFile, JSON.stringify(report, null, 2));
}
async function freePort() {
	const server = net.createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	return port;
}
const port = await freePort();
const healthPort = await freePort();
const endpoint = `http://127.0.0.1:${port}`;
report.endpoint = endpoint;
const config = path.join(root, "gateway.toml");
const configText = (await fs.readFile(config, "utf8"))
	.replace(/^grpc_endpoint = .*\n/gm, "")
	.replace(/^default_image = .*$/m, `default_image = "${image}"`)
	.replace(/^bootstrap_image = .*$/m, `bootstrap_image = "${image}"`)
	.replace(
		"[openshell.drivers.vm]",
		`[openshell.drivers.vm]\ngrpc_endpoint = "${endpoint}"`,
	);
await fs.writeFile(config, configText);
async function command(binary, args, { timeout = 30000, input } = {}) {
	const started = performance.now();
	const child = spawn(path.join(root, "bin", binary), args, {
		env,
		cwd: root,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	child.stdin.end(input);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
	}, timeout);
	try {
		const status = await new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => resolve({ code, signal }));
		});
		return {
			...status,
			timedOut,
			ms: performance.now() - started,
			stdout: stdout.slice(0, 16000),
			stderr: stderr.slice(-16000),
		};
	} finally {
		clearTimeout(timer);
	}
}
async function cli(args, options) {
	return command(
		"openshell",
		["--gateway-endpoint", endpoint, ...args],
		options,
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
			error: error.message,
		});
		console.log(`FAIL ${name}: ${error.message}`);
	}
	await save();
}
let gateway;
let gatewayLog = "";
const boxes = new Set();
async function create(name, policy = path.join(root, "policy.yaml")) {
	boxes.add(name);
	const result = await cli(
		[
			"sandbox",
			"create",
			"--name",
			name,
			"--from",
			image,
			"--policy",
			policy,
			"--detach",
			"--no-auto-providers",
			"--no-tty",
			"--",
			"/bin/sh",
			"-c",
			"while :; do sleep 60; done",
		],
		{ timeout: 150000 },
	);
	report.creations.push({ name, ...result });
	await save();
	assert.equal(result.code, 0, JSON.stringify(result));
	return name;
}
async function exec(name, script) {
	return cli([
		"sandbox",
		"exec",
		name,
		"--no-login-shell",
		"--no-tty",
		"--timeout",
		"10",
		"--",
		"node",
		"-e",
		script,
	]);
}
try {
	await check("Fixed CLI and gateway versions", async () => {
		const versions = [];
		for (const binary of ["openshell", "openshell-gateway"]) {
			const result = await command(binary, ["--version"]);
			assert.equal(result.code, 0);
			assert.match(result.stdout, /0\.1\.3/);
			versions.push({ binary, ...result });
		}
		return versions;
	});
	await check("Isolated native MicroVM gateway ready", async () => {
		const started = performance.now();
		gateway = spawn(
			path.join(root, "bin/openshell-gateway"),
			[
				"--config",
				config,
				"--port",
				String(port),
				"--health-port",
				String(healthPort),
				"--db-url",
				`sqlite://${root}/gateway.db`,
			],
			{ env, cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] },
		);
		gateway.stdout.on("data", (chunk) => {
			gatewayLog += chunk;
		});
		gateway.stderr.on("data", (chunk) => {
			gatewayLog += chunk;
		});
		for (;;) {
			assert.equal(gateway.exitCode, null, gatewayLog.slice(-8000));
			try {
				const response = await fetch(`http://127.0.0.1:${healthPort}/readyz`, {
					signal: AbortSignal.timeout(1000),
				});
				if (response.ok)
					return { pid: gateway.pid, ms: performance.now() - started };
			} catch {}
			assert(performance.now() - started < 60000, gatewayLog.slice(-8000));
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
	});
	assert(report.checks.at(-1).pass, "gateway did not start");
	await check(
		"Direct host Target Folder mount through public VM config",
		async () => {
			const result = await cli([
				"sandbox",
				"create",
				"--name",
				"tos-mount",
				"--from",
				image,
				"--driver-config-json",
				JSON.stringify({
					vm: {
						mounts: [
							{
								type: "bind",
								source: path.join(root, "target"),
								target: "/project",
								read_only: false,
							},
						],
					},
				}),
				"--policy",
				path.join(root, "policy.yaml"),
				"--detach",
				"--no-auto-providers",
				"--",
				"/bin/sh",
				"-c",
				"sleep 60",
			]);
			report.hostMountAttempt = result;
			assert.equal(result.code, 0, JSON.stringify(result));
			const written = await exec(
				"tos-mount",
				"require('fs').writeFileSync('/project/sentinel','GUEST_WRITE')",
			);
			assert.equal(written.code, 0);
			assert.equal(
				await fs.readFile(path.join(root, "target/sentinel"), "utf8"),
				"GUEST_WRITE",
			);
			boxes.add("tos-mount");
			return result;
		},
	);
	let A;
	await check("Node Linux sandbox boot", async () => {
		A = await create("tos-a");
		const result = await exec(
			A,
			"console.log(process.platform,process.version);require('fs').writeFileSync('/sandbox/probe','OK')",
		);
		assert.equal(result.code, 0, JSON.stringify(result));
		assert.match(result.stdout, /linux v24/);
		return result;
	});
	if (A) {
		await check("Host Target Folder is not projected into guest", async () => {
			const result = await exec(
				A,
				`require('fs').readFileSync(${JSON.stringify(path.join(root, "target/sentinel"))})`,
			);
			assert.notEqual(result.code, 0);
			assert.equal(
				await fs.readFile(path.join(root, "target/sentinel"), "utf8"),
				"HOST_TARGET_BEFORE",
			);
			return result;
		});
		await check("Warm new sandbox boot", async () => {
			const B = await create("tos-b");
			const result = await exec(
				B,
				"console.log(process.platform);console.log(require('fs').existsSync('/sandbox/probe'))",
			);
			assert.equal(result.code, 0, JSON.stringify(result));
			assert.match(result.stdout, /false/);
			return result;
		});
		await check("Explicit empty network policy blocks HTTPS", async () => {
			const result = await exec(
				A,
				"fetch('https://registry.npmjs.org',{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(2)).catch(e=>{console.log(e.message);process.exit(0)})",
			);
			assert.equal(result.code, 0, JSON.stringify(result));
			assert.match(result.stdout, /fetch failed|timeout|abort/i);
			return result;
		});
	}
} catch (error) {
	report.fatal = error.message;
} finally {
	for (const name of boxes) {
		const result = await cli(["sandbox", "delete", name], { timeout: 30000 });
		report.cleanup.push({ name, ...result });
	}
	if (gateway?.exitCode === null) {
		const exit = new Promise((resolve) => gateway.once("exit", resolve));
		try {
			process.kill(-gateway.pid, "SIGTERM");
		} catch {}
		const timer = setTimeout(() => {
			try {
				process.kill(-gateway.pid, "SIGKILL");
			} catch {}
		}, 12000);
		await exit;
		clearTimeout(timer);
	}
	report.gatewayLog = gatewayLog.slice(-30000);
	report.finishedAt = new Date().toISOString();
	await fs.writeFile(path.join(root, "results/gateway.log"), gatewayLog);
	await save();
}
