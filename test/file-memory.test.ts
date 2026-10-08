import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { executeTool } from "../src/file-tools.ts";

test("read/search scanning memory does not scale with a whole single-line file", {
	timeout: 60000,
}, async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "file-memory-")));
	try {
		const samples: { size: number; read: number; search: number }[] = [];
		for (const size of [8, 20, 80]) {
			const path = join(root, "line.txt");
			const file = await open(path, "w");
			try {
				const block = Buffer.from("x".repeat(65536));
				for (
					let written = 0;
					written < size * 1024 * 1024;
					written += block.length
				)
					await file.write(block);
				await file.write("needle");
			} finally {
				await file.close();
			}
			const sample = { size, read: 0, search: 0 };
			for (const name of ["read_file", "search_files"] as const) {
				const args =
					name === "read_file" ? { path } : { path: root, query: "needle" };
				const child = spawnSync(
					process.execPath,
					[
						"--expose-gc",
						"--max-old-space-size=48",
						"--input-type=module",
						"-e",
						`
					import { executeTool } from ${JSON.stringify(new URL("../src/file-tools.ts", import.meta.url).href)};
					global.gc();
					const before = process.resourceUsage().maxRSS;
					const result = await executeTool(${JSON.stringify(name)}, ${JSON.stringify(JSON.stringify(args))}, ${JSON.stringify([root])});
					if (result.status !== "succeeded") throw new Error(result.result);
					const page = JSON.parse(result.result);
					if (${JSON.stringify(name)} === "read_file" && (Buffer.byteLength(page.text) !== 51200 || page.nextColumn !== 51201)) throw new Error("Wrong read page");
					if (${JSON.stringify(name)} === "search_files" && (page.matches.length !== 1 || page.matches[0].column !== ${size * 1024 * 1024 + 1} || page.matches[0].text !== "x".repeat(128) + "needle")) throw new Error("Wrong search excerpt");
					console.log(process.resourceUsage().maxRSS - before);
				`,
					],
					{ encoding: "utf8", timeout: 20000 },
				);
				assert.equal(child.status, 0, child.stderr);
				const growth = Number(child.stdout.trim());
				assert(Number.isFinite(growth));
				if (name === "read_file") sample.read = growth;
				else sample.search = growth;
			}
			samples.push(sample);
		}
		// Compare growth with input growth, not a machine-specific absolute RSS ceiling.
		const inputGrowthKiB = (samples[2].size - samples[0].size) * 1024;
		for (const operation of ["read", "search"] as const)
			assert(
				samples[2][operation] - samples[0][operation] < inputGrowthKiB / 2,
				JSON.stringify(samples),
			);
		console.info("Isolated peak-RSS growth (KiB):", samples);
		for (const name of ["read_file", "search_files"]) {
			const controller = new AbortController();
			const work = executeTool(
				name,
				JSON.stringify({
					path: name === "read_file" ? join(root, "line.txt") : root,
					...(name === "search_files" ? { query: "absent" } : {}),
				}),
				[root],
				controller.signal,
			);
			await setTimeout(10);
			controller.abort();
			assert.equal((await work).status, "interrupted");
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
