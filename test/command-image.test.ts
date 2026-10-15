import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CommandExecutor } from "../src/command-executor.ts";
import { emptyPermissions } from "../src/execution-permissions.ts";
import { MAX_IMAGE_BYTES } from "../src/image-content.ts";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1cAAAAASUVORK5CYII=",
	"base64",
);

test("native image reads preserve complete bytes and enforce file permissions", {
	skip:
		process.platform !== "darwin"
			? "Native restricted policy requires macOS"
			: false,
}, async () => {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "command-image-")),
	);
	const root = join(directory, "target");
	await mkdir(root);
	const executor = new CommandExecutor();
	const options = {
		targetFolders: [root],
		agentId: `image-${process.pid}`,
		signal: new AbortController().signal,
	};
	try {
		const path = join(root, "image with no extension");
		await writeFile(path, png);
		const expected = [
			{
				type: "input_image",
				image_url: `data:image/png;base64,${png.toString("base64")}`,
			},
		];
		const content = await executor.readImage({ ...options, path });
		assert.deepEqual(content, expected);
		await writeFile(path, "changed");
		assert.deepEqual(content, expected);
		await assert.rejects(executor.readImage({ ...options, path }), /image/i);

		await writeFile(path, Buffer.alloc(MAX_IMAGE_BYTES + 1));
		await assert.rejects(executor.readImage({ ...options, path }), /exceeds/i);

		const outside = join(directory, "outside.png");
		await writeFile(outside, png);
		const escapedPath = join(root, "escape.png");
		await symlink(outside, escapedPath);
		for (const path of [outside, escapedPath])
			await assert.rejects(executor.readImage({ ...options, path }));
		assert.deepEqual(
			await executor.readImage({
				...options,
				path: outside,
				extraPermissions: {
					...emptyPermissions(),
					paths: [{ path: outside, access: "read" }],
				},
			}),
			expected,
		);
	} finally {
		await executor.close();
		await rm(directory, { recursive: true, force: true });
	}
});
