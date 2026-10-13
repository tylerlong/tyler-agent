import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export async function releasePort(port: number) {
	const listeners = () => {
		const result = spawnSync(
			"lsof",
			["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"],
			{ encoding: "utf8" },
		);
		if (result.error) throw result.error;
		if (result.status !== 0 && result.status !== 1)
			throw new Error(`Cannot inspect port ${port}: ${result.stderr.trim()}`);
		return new Set(
			result.stdout.trim().split(/\s+/).filter(Boolean).map(Number),
		);
	};
	const pids = listeners();
	if (!pids.size) return;
	// Stop a Node watcher too, so it cannot restart the occupied listener.
	for (const pid of [...pids]) {
		const parent = spawnSync("ps", ["-p", String(pid), "-o", "ppid="], {
			encoding: "utf8",
		});
		const parentPid = Number(parent.stdout?.trim());
		if (!parentPid || parentPid === process.pid || parentPid === process.ppid)
			continue;
		const command = spawnSync(
			"ps",
			["-p", String(parentPid), "-o", "command="],
			{ encoding: "utf8" },
		).stdout;
		if (
			command &&
			/(?:^|\/)node\s/.test(command.trim()) &&
			/\s--watch(?:\s|=|$)/.test(command)
		)
			pids.add(parentPid);
	}
	console.log(`Releasing port ${port}`);
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGTERM");
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ESRCH")
			)
				throw error;
		}
	}
	for (let attempt = 0; attempt < 800; attempt++) {
		const alive = [...pids].some((pid) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
				throw error;
			}
		});
		if (!listeners().size && !alive) return;
		await delay(50);
	}
	throw new Error(
		`Port ${port} has not finished releasing its previous service`,
	);
}
