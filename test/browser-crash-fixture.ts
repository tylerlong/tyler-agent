import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

// Capture the real report location before a test supplies its temporary user HOME.
const reportDirectories = [
	join(homedir(), "Library/Logs/DiagnosticReports"),
	"/Library/Logs/DiagnosticReports",
];

export async function useTemporaryHome(t: TestContext, directory: string) {
	const original = process.env.HOME;
	const home = join(directory, "user-home");
	await mkdir(home);
	process.env.HOME = home;
	t.after(() => {
		if (original === undefined) delete process.env.HOME;
		else process.env.HOME = original;
	});
}

export function isRelatedBrowserCrash(
	report: string,
	pids: ReadonlySet<number>,
	startedAt: number,
) {
	// Read only the correlation fields, including while ReportCrash is still writing.
	const pid = Number(report.match(/"pid"\s*:\s*(\d+)/)?.[1]);
	const captureTime = report.match(/"captureTime"\s*:\s*"([^"\n]+)"/)?.[1];
	return (
		pids.has(pid) &&
		captureTime !== undefined &&
		Date.parse(captureTime) >= startedAt
	);
}

export async function browserCrashCheck() {
	const startedAt = Date.now();
	const pids = new Set<number>();
	const reports = async () => {
		const paths: string[] = [];
		for (const directory of reportDirectories) {
			let names: string[];
			try {
				names = await readdir(directory);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			paths.push(
				...names
					.filter((name) => name.endsWith(".ips"))
					.map((name) => join(directory, name)),
			);
		}
		return paths;
	};
	const existing = new Set(await reports());
	return {
		async capture(openOutput: string) {
			const daemon = Number(openOutput.match(/opened with pid (\d+)/)?.[1]);
			assert(daemon, openOutput);
			const { stdout } = await promisify(execFile)("/bin/ps", [
				"-axo",
				"pid=,ppid=,command=",
			]);
			const processes = stdout.split("\n").map((line) => {
				const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
				return match
					? {
							pid: Number(match[1]),
							parent: Number(match[2]),
							command: match[3],
						}
					: null;
			});
			pids.add(daemon);
			let size: number;
			do {
				size = pids.size;
				for (const proc of processes)
					if (proc && pids.has(proc.parent)) pids.add(proc.pid);
			} while (pids.size !== size);
			assert(
				processes.some(
					(proc) =>
						proc &&
						pids.has(proc.pid) &&
						/Google Chrome for Testing|Chromium|chrome-headless-shell/i.test(
							proc.command,
						),
				),
				"This CLI daemon must own a real Chromium process",
			);
		},
		async assertNoCrashes() {
			assert(
				pids.size > 1,
				"Capture the launched browser's PID tree before closing it",
			);
			// ReportCrash writes asynchronously after process exit.
			for (let attempt = 0; attempt < 3; attempt++) {
				await setTimeout(500);
				for (const path of await reports()) {
					if (existing.has(path)) continue;
					assert(
						!isRelatedBrowserCrash(
							await readFile(path, "utf8"),
							pids,
							startedAt,
						),
						`This run's browser crashed: ${path}`,
					);
				}
			}
		},
	};
}
