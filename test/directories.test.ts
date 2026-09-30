import assert from "node:assert/strict";
import {
	chmod,
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { createServer } from "../src/server.ts";

test("directory browsing uses isolated home, lexical paths and visible sorted direct directories; failures leave projects untouched", async () => {
	const folder = await mkdtemp(join(tmpdir(), "agent-directory-"));
	for (const child of ["Zulu", "Alpha", ".hidden", "locked"])
		await mkdir(join(folder, child));
	await mkdir(join(folder, "Alpha", "nested"));
	await writeFile(join(folder, "file.txt"), "content");
	await symlink(join(folder, "Alpha"), join(folder, "Link"));
	await symlink(join(folder, "missing"), join(folder, "Broken"));
	await symlink(join(folder, "file.txt"), join(folder, "FileLink"));
	const originalHome = process.env.HOME;
	process.env.HOME = folder;
	const server = createServer(fetch, join(folder, "db.sqlite")).listen(
		0,
		"127.0.0.1",
	);
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		const browse = (path?: string) =>
			fetch(
				`${base}/api/directories${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}`,
			);
		const home = await (await browse()).json();
		assert.equal(home.path, folder);
		assert.equal(home.parent, dirname(folder));
		assert.deepEqual(
			home.directories.map((entry: { name: string }) => entry.name),
			["Alpha", "Link", "Zulu", "locked"],
		);
		assert.deepEqual(
			await (await browse(relative(process.cwd(), folder))).json(),
			home,
		);
		const link = await (await browse(join(folder, "Link"))).json();
		assert.equal(link.path, join(folder, "Link"));
		assert.deepEqual(link.directories, [
			{ name: "nested", path: join(folder, "Link", "nested") },
		]);
		assert.deepEqual(
			(await (await browse(join(folder, "Zulu"))).json()).directories,
			[],
		);
		assert.equal((await (await browse("/")).json()).parent, null);
		assert.equal((await browse("")).status, 400);
		assert.equal(
			(await fetch(`${base}/api/directories?path=a&path=b`)).status,
			400,
		);
		assert.equal((await browse(join(folder, "missing"))).status, 404);
		assert.equal((await browse(join(folder, "file.txt"))).status, 400);
		await chmod(join(folder, "locked"), 0);
		try {
			assert.equal((await browse(join(folder, "locked"))).status, 403);
		} finally {
			await chmod(join(folder, "locked"), 0o700);
		}
		await rm(join(folder, "Zulu"), { recursive: true });
		const create = (folders: string[]) =>
			fetch(`${base}/api/projects`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "Work", folders }),
			});
		assert.equal((await create([folder, join(folder, "Zulu")])).status, 400);
		assert.equal((await create([folder, join(folder, ".")])).status, 400);
		assert.deepEqual(await (await fetch(`${base}/api/projects`)).json(), {
			projects: [],
		});
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(folder, { recursive: true, force: true });
	}
});
