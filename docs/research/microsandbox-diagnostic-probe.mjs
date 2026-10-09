import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [sdkDirectory, outputFile] = process.argv.slice(2);
assert(
	sdkDirectory && outputFile,
	"Usage: node probe.mjs /absolute/sdk /absolute/results.json",
);
const { Sandbox, NetworkPolicy, setDefaultBackend } = await import(
	pathToFileURL(
		path.join(sdkDirectory, "node_modules/microsandbox/dist/index.js"),
	)
);
setDefaultBackend("local");
const root = await fs.realpath(await fs.mkdtemp("/tmp/tmsb-diag-"));
const boxes = [];
const file = outputFile;
const report = { version: "0.7.8", root, checks: [], cleanup: [] };
async function check(name, fn) {
	const start = performance.now();
	try {
		const details = await fn();
		report.checks.push({
			name,
			pass: true,
			ms: performance.now() - start,
			details,
		});
		console.log(`PASS ${name}`);
	} catch (e) {
		report.checks.push({
			name,
			pass: false,
			ms: performance.now() - start,
			error: { name: e.name, message: e.message },
		});
		console.log(`FAIL ${name}: ${e.message}`);
	}
	await fs.writeFile(file, JSON.stringify(report, null, 2));
}
async function make(label, configure) {
	const start = performance.now();
	const box = await configure(
		Sandbox.builder(`tmsbdiag-${path.basename(root)}-${label}`)
			.image("node:24-alpine")
			.memory(256)
			.cpus(1)
			.security("restricted")
			.network((n) => n.policy(NetworkPolicy.none())),
	).create();
	boxes.push(box);
	console.log(`CREATED ${label} ${Math.round(performance.now() - start)}ms`);
	return box;
}
async function kill(b) {
	await b.killWithTimeout(10000);
	await Sandbox.remove(b.name);
	boxes.splice(boxes.indexOf(b), 1);
}
async function bounded(promise, ms) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`operation deadline ${ms}ms`)),
					ms,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
try {
	await check("colon host target works with a legal guest alias", async () => {
		const target = path.join(root, "target:colon");
		await fs.mkdir(target);
		const box = await make("colon", (b) =>
			b.volume("/work", (m) => m.bind(target)),
		);
		await box.fs().write("/work/value", "COLON");
		assert.equal(
			await fs.readFile(path.join(target, "value"), "utf8"),
			"COLON",
		);
		await kill(box);
		return { hostTarget: target, guestAlias: "/work" };
	});
	await check(
		"full root bind reads fixture promptly but first write exceeds 10s",
		async () => {
			const target = path.join(root, "value");
			await fs.writeFile(target, "BEFORE");
			const box = await make("root", (b) =>
				b.volume("/host", (m) => m.bind("/").statVirtualization("off")),
			);
			const readStart = performance.now();
			assert.equal(
				await bounded(box.fs().readToString(`/host${target}`), 5000),
				"BEFORE",
			);
			const readMs = performance.now() - readStart;
			const writeStart = performance.now();
			let error;
			try {
				await bounded(box.fs().write(`/host${target}`, "AFTER"), 10000);
			} catch (e) {
				error = e.message;
			}
			const writeMs = performance.now() - writeStart;
			const beforeKill = await fs.readFile(target, "utf8");
			await kill(box);
			assert.match(error ?? "", /deadline/);
			assert.equal(beforeKill, "BEFORE");
			return {
				readMs,
				writeMs,
				error,
				beforeKill,
				quotaExplicitlyOmitted: true,
				warning:
					"full root first write still blocked; probe expectation confirms the documented performance defect, not a product acceptance pass",
			};
		},
	);
	await check("10,000-file target first-write quota cost", async () => {
		const target = path.join(root, "large");
		await fs.mkdir(target);
		for (let dir = 0; dir < 100; dir++) {
			const folder = path.join(target, String(dir));
			await fs.mkdir(folder);
			await Promise.all(
				Array.from({ length: 100 }, (_, i) =>
					fs.writeFile(path.join(folder, String(i)), Buffer.alloc(512)),
				),
			);
		}
		const box = await make("large", (b) =>
			b.volume("/work", (m) => m.bind(target).quota(128)),
		);
		const one = performance.now();
		await bounded(box.fs().write("/work/first", "ONE"), 10000);
		const firstWriteMs = performance.now() - one;
		const two = performance.now();
		await box.fs().write("/work/second", "TWO");
		const secondWriteMs = performance.now() - two;
		assert.equal(await fs.readFile(path.join(target, "first"), "utf8"), "ONE");
		await kill(box);
		return {
			files: 10000,
			logicalFixtureBytes: 5120000,
			firstWriteMs,
			secondWriteMs,
		};
	});
} finally {
	for (const box of [...boxes]) {
		try {
			await kill(box);
			report.cleanup.push({ name: box.name, pass: true });
		} catch (e) {
			report.cleanup.push({ name: box.name, pass: false, error: String(e) });
		}
	}
	report.passed = report.checks.filter((x) => x.pass).length;
	report.failed = report.checks.filter((x) => !x.pass).length;
	await fs.writeFile(file, JSON.stringify(report, null, 2));
	if (report.cleanup.every((c) => c.pass))
		await fs.rm(root, { recursive: true, force: true });
	if (report.failed) process.exitCode = 1;
	console.log(JSON.stringify({ passed: report.passed, failed: report.failed }));
}
