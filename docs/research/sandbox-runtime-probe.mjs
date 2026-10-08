// Run with an isolated installed package's dist/index.js; never use real projects.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

assert.equal(process.platform, "darwin", "This experiment targets macOS");
assert(process.argv[2], "Pass the installed package's dist/index.js path");
const modulePath = resolve(process.argv[2]);
const pnpmEntry = join(dirname(modulePath), "../../../pnpm/dist/pnpm.mjs");
const { SandboxManager, getDefaultWritePaths } = await import(
	pathToFileURL(modulePath).href
);
const { version } = JSON.parse(
	await readFile(join(dirname(modulePath), "../package.json"), "utf8"),
);
const originalCwd = process.cwd();
const base = await realpath(
	await mkdtemp(join(tmpdir(), "tyler-agent-srt-targets-")),
);
const a = join(base, "target-a");
const b = join(base, "target-b");
const outside = join(base, "outside");
const prefix = join(base, "target-a-sibling");
const runner = join(base, "runner");
const literal = join(base, "target [literal]*");
const defaultScratch = `/private/tmp/claude/tyler-agent-probe-${randomUUID()}`;
const results = [];
const failures = [];
const q = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
const exists = async (path) =>
	stat(path).then(
		() => true,
		() => false,
	);
const contents = (path) => readFile(path, "utf8");
const defaults = getDefaultWritePaths();
const defaultDirectories = defaults.filter((path) => !path.startsWith("/dev/"));
const worker = `
const fs = require('node:fs');
const cp = require('node:child_process');
const x = JSON.parse(process.argv[1]);
try {
  if (x.action === 'write') fs.writeFileSync(x.path, x.text ?? 'changed');
  if (x.action === 'append') fs.appendFileSync(x.path, 'changed');
  if (x.action === 'mkdir') fs.mkdirSync(x.path);
  if (x.action === 'delete') fs.rmSync(x.path, { recursive: true });
  if (x.action === 'rename') fs.renameSync(x.path, x.destination);
  if (x.action === 'chmod') fs.chmodSync(x.path, 0o600);
  if (x.action === 'link') fs.linkSync(x.path, x.destination);
  if (x.action === 'read') console.log(fs.readFileSync(x.path, 'utf8'));
  if (x.action === 'writeBoth') for (const path of x.paths) fs.writeFileSync(path, 'changed');
  if (x.action === 'descendant') {
    const child = cp.spawnSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], "changed")', x.path], { encoding: 'utf8' });
    process.stderr.write(child.stderr);
    process.exit(child.status ?? 1);
  }
  if (x.action === 'scope') {
    const until = Date.now() + 150;
    while (Date.now() < until) {
      fs.writeFileSync(x.path, 'changed');
      try { fs.writeFileSync(x.forbidden, 'escaped'); process.exit(2); }
      catch(e) { if (!['EPERM', 'EACCES'].includes(e.code)) throw e; }
    }
  }
} catch(e) { console.error(e.code + ': ' + e.message); process.exit(1); }
`;

function capture(command, cwd = a) {
	return new Promise((done, reject) => {
		const child = spawn("/bin/sh", ["-c", command], {
			cwd,
			detached: true,
			env: {
				PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`,
				HOME: join(a, "home"),
				TMPDIR: join(a, "tmp"),
				XDG_CACHE_HOME: join(a, "cache"),
				npm_config_cache: join(a, "cache"),
				CI: "true",
			},
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
		}, 15000);
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			done({ code, signal, stdout: stdout.trim(), stderr: stderr.trim() });
		});
	});
}

async function wrapped(folders, command, hardened = true) {
	return SandboxManager.wrapWithSandbox(command, "/bin/sh", {
		filesystem: {
			denyRead: [homedir(), base],
			allowRead: [dirname(process.execPath), ...folders],
			allowWrite: folders,
			denyWrite: hardened ? defaultDirectories : [],
		},
	});
}
async function run(folders, input, hardened = true) {
	return capture(
		await wrapped(
			folders,
			`${q(process.execPath)} -e ${q(worker)} ${q(JSON.stringify(input))}`,
			hardened,
		),
	);
}
async function check(name, action) {
	try {
		const detail = await action();
		results.push({ name, passed: true, ...(detail ? { detail } : {}) });
		console.error(`PASS ${name}`);
	} catch (error) {
		results.push({ name, passed: false, error: error.message });
		failures.push(name);
		console.error(`FAIL ${name}: ${error.message}`);
	}
}
async function writeCheck(name, folders, path, allowed) {
	await check(name, async () => {
		const result = await run(folders, { action: "write", path });
		assert.equal(await exists(path), allowed, JSON.stringify(result));
		if (allowed) {
			assert.equal(result.code, 0, JSON.stringify(result));
			assert.equal(await contents(path), "changed");
		} else {
			assert.notEqual(result.code, 0, JSON.stringify(result));
			assert.match(result.stderr, /EPERM|EACCES|Operation not permitted/);
		}
		return result;
	});
}

try {
	for (const path of [
		a,
		b,
		outside,
		prefix,
		runner,
		literal,
		defaultScratch,
		join(a, "home"),
		join(a, "tmp"),
		join(a, "cache"),
	])
		await mkdir(path, { recursive: true });
	process.chdir(runner);
	await SandboxManager.initialize({
		network: { allowedDomains: [], deniedDomains: [] },
		filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
	});
	await writeCheck("A: create within target", [a], join(a, "created"), true);
	await writeCheck(
		"A: deny outside target",
		[a],
		join(outside, "created"),
		false,
	);
	await writeCheck(
		"A: deny sibling with same prefix",
		[a],
		join(prefix, "created"),
		false,
	);
	await writeCheck(
		"A: deny traversal",
		[a],
		`${a}/../outside/traversal`,
		false,
	);
	await writeCheck(
		"B: dynamically switch target",
		[b],
		join(b, "created"),
		true,
	);
	await writeCheck(
		"B: previous target A is no longer writable",
		[b],
		join(a, "revoked"),
		false,
	);
	await writeCheck(
		"A: B is no longer writable",
		[a],
		join(b, "revoked"),
		false,
	);
	await writeCheck(
		"empty targets: deny project writes",
		[],
		join(a, "empty"),
		false,
	);
	await check("multiple targets: write A and B", async () => {
		const result = await run([a, b], {
			action: "writeBoth",
			paths: [join(a, "multi"), join(b, "multi")],
		});
		assert.equal(result.code, 0, JSON.stringify(result));
		assert.equal(await contents(join(a, "multi")), "changed");
		assert.equal(await contents(join(b, "multi")), "changed");
		return result;
	});
	for (const action of ["write", "append", "delete", "chmod", "descendant"]) {
		await check(`outside existing file: deny ${action}`, async () => {
			const path = join(outside, action);
			await writeFile(path, "original");
			await chmod(path, 0o644);
			const result = await run([a], { action, path });
			assert.notEqual(result.code, 0, JSON.stringify(result));
			assert.equal(await contents(path), "original");
			assert.equal((await stat(path)).mode & 0o777, 0o644);
			return result;
		});
	}
	await check("outside directory: deny recursive deletion", async () => {
		const result = await run([a], { action: "delete", path: outside });
		assert.notEqual(result.code, 0, JSON.stringify(result));
		assert.equal(await contents(join(outside, "write")), "original");
		return result;
	});
	for (const [name, source, destination, allowed] of [
		["rename within target", join(a, "move-in"), join(a, "moved-in"), true],
		[
			"deny moving outside into target",
			join(outside, "move-in"),
			join(a, "moved-outside"),
			false,
		],
		[
			"deny moving target outside",
			join(a, "move-out"),
			join(outside, "moved-target"),
			false,
		],
	]) {
		await check(name, async () => {
			await writeFile(source, "original");
			const result = await run([a], {
				action: "rename",
				path: source,
				destination,
			});
			assert.equal(await exists(destination), allowed, JSON.stringify(result));
			assert.equal(await contents(allowed ? destination : source), "original");
			return result;
		});
	}
	await writeFile(join(outside, "linked"), "original");
	await symlink(join(outside, "linked"), join(a, "file-link"));
	await symlink(outside, join(a, "directory-link"));
	await check("symlink file: deny out-of-scope target mutation", async () => {
		const result = await run([a], {
			action: "write",
			path: join(a, "file-link"),
		});
		assert.notEqual(result.code, 0, JSON.stringify(result));
		assert.equal(await contents(join(outside, "linked")), "original");
		return result;
	});
	await writeCheck(
		"symlink parent: deny outside creation",
		[a],
		join(a, "directory-link", "created-through-link"),
		false,
	);
	await symlink(b, join(a, "b-link"));
	await writeCheck(
		"symlink to another selected target: allowed",
		[a, b],
		join(a, "b-link", "authorized-link"),
		true,
	);
	await writeCheck(
		"symlink to unselected target: denied",
		[a],
		join(a, "b-link", "unauthorized-link"),
		false,
	);
	await writeCheck(
		"literal target path containing glob characters",
		[literal],
		join(literal, "created"),
		true,
	);
	await check("glob target must not authorize sibling paths", async () => {
		const selected = join(base, "glob-*");
		const unselected = join(base, "glob-outsider");
		await mkdir(selected);
		const result = await run([selected], { action: "write", path: unselected });
		assert.equal(await exists(unselected), false, JSON.stringify(result));
		return result;
	});
	await check(
		"concurrent commands retain independent target sets",
		async () => {
			const [first, second] = await Promise.all([
				run([a], {
					action: "scope",
					path: join(a, "own"),
					forbidden: join(b, "from-a"),
				}),
				run([b], {
					action: "scope",
					path: join(b, "own"),
					forbidden: join(a, "from-b"),
				}),
			]);
			assert.equal(first.code, 0, JSON.stringify(first));
			assert.equal(second.code, 0, JSON.stringify(second));
			assert.equal(await exists(join(b, "from-a")), false);
			assert.equal(await exists(join(a, "from-b")), false);
			return { first, second };
		},
	);
	await check("read scope: outside fixture is unreadable", async () => {
		const result = await run([a], {
			action: "read",
			path: join(outside, "linked"),
		});
		assert.notEqual(result.code, 0, JSON.stringify(result));
		assert.equal(result.stdout, "");
		return result;
	});
	await check(
		"unhardened default permits non-target scratch writes",
		async () => {
			const path = join(defaultScratch, "unhardened");
			const result = await run([a], { action: "write", path }, false);
			assert.equal(result.code, 0, JSON.stringify(result));
			assert.equal(await contents(path), "changed");
			return result;
		},
	);
	await writeCheck(
		"hardened policy denies non-target scratch",
		[a],
		join(defaultScratch, "hardened"),
		false,
	);
	await check("Git initializes, stages and commits inside target", async () => {
		const result = await capture(
			await wrapped(
				[a],
				"git init -q && git add created && git -c user.name=Probe -c user.email=probe@example.invalid -c commit.gpgsign=false commit -qm probe && git diff --exit-code",
			),
		);
		assert.equal(result.code, 0, JSON.stringify(result));
		assert.equal(await exists(join(a, ".git", "HEAD")), true);
		return result;
	});
	await check(
		"pnpm test launches Node and writes only within target",
		async () => {
			await writeFile(
				join(a, "package.json"),
				JSON.stringify({
					private: true,
					scripts: { test: "node --test test.cjs" },
				}),
			);
			await writeFile(
				join(a, "test.cjs"),
				"const {test}=require('node:test');const fs=require('node:fs');test('write fixture',()=>fs.writeFileSync('test-output','verified'));",
			);
			const result = await capture(
				await wrapped(
					[a],
					`${q(process.execPath)} ${q(pnpmEntry)} install --offline --ignore-scripts && ${q(process.execPath)} ${q(pnpmEntry)} test`,
				),
			);
			assert.equal(result.code, 0, JSON.stringify(result));
			assert.equal(await contents(join(a, "test-output")), "verified");
			return result;
		},
	);
	await check("deny creating hardlink from outside into target", async () => {
		const path = join(outside, "new-hardlink-source");
		const destination = join(a, "new-hardlink");
		await writeFile(path, "original");
		const result = await run([a], { action: "link", path, destination });
		assert.notEqual(result.code, 0, JSON.stringify(result));
		assert.equal(await exists(destination), false);
		assert.equal(await contents(path), "original");
		return result;
	});
	await check(
		"hardlink alias: observe whether outside inode stays unchanged",
		async () => {
			const path = join(outside, "hardlinked");
			await writeFile(path, "original");
			await link(path, join(a, "hardlink"));
			const result = await run([a], {
				action: "write",
				path: join(a, "hardlink"),
			});
			assert.equal(await contents(path), "original", JSON.stringify(result));
			return result;
		},
	);
} finally {
	try {
		await SandboxManager.reset();
	} finally {
		process.chdir(originalCwd);
		await rm(base, { recursive: true, force: true });
		await rm(defaultScratch, { recursive: true, force: true });
	}
}
console.log(
	JSON.stringify(
		{
			platform: process.platform,
			node: process.version,
			version,
			defaultWritePaths: defaults,
			results,
			failures,
		},
		null,
		2,
	),
);
process.exitCode = failures.length ? 1 : 0;
