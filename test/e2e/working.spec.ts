import { expect, test } from "./fixtures.ts";

for (const layout of [
	{ width: 1280, height: 720, sidebar: 240 },
	{ width: 1280, height: 720, sidebar: 600 },
	{ width: 1600, height: 900, sidebar: 240 },
	{ width: 1600, height: 900, sidebar: 600 },
]) {
	test(`chat work stays rightmost without moving names or menus and respects reduced motion at ${layout.width}x${layout.height}, sidebar ${layout.sidebar}`, async ({
		page,
		app,
	}) => {
		const project = await (
			await page.request.post(`${app.url}/api/projects`, {
				data: { name: "Work", folders: [] },
			})
		).json();
		const chat = await (
			await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
				data: { name: "A long chat name to wrap in the narrow sidebar" },
			})
		).json();
		await page.setViewportSize({ width: layout.width, height: layout.height });
		await page.request.put(`${app.url}/api/sidebar-width`, {
			data: { width: layout.sidebar },
		});
		await page.goto(`${app.url}/?chat=${chat.id}`);
		const name = page.getByRole("button", {
			name: "A long chat name to wrap in the narrow sidebar",
			exact: true,
		});
		const row = page.getByRole("listitem").filter({ has: name });
		const menu = row.getByRole("button", {
			name: "Chat A long chat name to wrap in the narrow sidebar actions",
		});
		await expect(name).toBeVisible();
		await expect(
			row.getByRole("status", { name: "Working", exact: true }),
		).toHaveCount(0);
		const before = await Promise.all(
			[name, menu].map((el) => el.boundingBox()),
		);
		const stream = app.streamModel();
		const submitted = page.request.post(`${app.url}/api/chats/${chat.id}`, {
			data: { modelId: "test", prompt: "work" },
		});
		await stream.entered;
		const status = row.getByRole("status", { name: "Working", exact: true });
		await expect(status).toBeVisible();
		expect(
			await Promise.all([name, menu].map((el) => el.boundingBox())),
		).toEqual(before);
		const iconBox = await status.boundingBox();
		const menuBox = await menu.boundingBox();
		if (!iconBox || !menuBox) throw new Error("Missing row bounds");
		expect(iconBox.x).toBeGreaterThanOrEqual(menuBox.x + menuBox.width);
		await expect(status).toHaveCSS("width", "16px");
		await expect(status).toHaveCSS("animation-name", "spin");
		await page.screenshot({
			path: `/tmp/tyler-agent88-${layout.width}-${layout.sidebar}.png`,
		});
		await page.emulateMedia({ reducedMotion: "reduce" });
		await expect(status).toHaveCSS("animation-name", "none");
		stream.release();
		await submitted;
		await expect(status).toHaveCount(0);
		expect(
			await Promise.all([name, menu].map((el) => el.boundingBox())),
		).toEqual(before);
	});
}

test("server acceptance drives parallel, archived and unselected work across refresh and reconnect until success or failure", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const chats = [];
	for (const name of ["Alpha", "Beta"])
		chats.push(
			await (
				await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
					data: { name },
				})
			).json(),
		);
	await page.goto(`${app.url}/?chat=${chats[0].id}`);
	const statuses = () =>
		page.getByRole("status", { name: "Working", exact: true });
	let releaseRequest!: () => void;
	let requestStarted!: () => void;
	const held = new Promise<void>((resolve) => {
		releaseRequest = resolve;
	});
	const started = new Promise<void>((resolve) => {
		requestStarted = resolve;
	});
	await page.route(`**/api/chats/${chats[0].id}`, async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		requestStarted();
		await held;
		await route.continue();
	});
	const first = app.streamModel();
	await page.getByLabel("Prompt").fill("first");
	await page.getByRole("button", { name: /^Submit(?: \(.+\))?$/ }).click();
	await started;
	await expect(statuses()).toHaveCount(0);
	releaseRequest();
	await first.entered;
	await expect(statuses()).toHaveCount(1);
	await page.getByRole("button", { name: "Beta", exact: true }).click();
	const second = app.rawStreamModel();
	const submitted = page.request
		.post(`${app.url}/api/chats/${chats[1].id}`, {
			data: { modelId: "test", prompt: "second" },
		})
		.catch(() => undefined);
	await expect(statuses()).toHaveCount(2);
	await page.reload();
	await expect(statuses()).toHaveCount(2);
	const reconnect = page.waitForResponse(
		(response) => response.url() === `${app.url}/api/events`,
	);
	app.disconnectClients();
	await reconnect;
	await expect(statuses()).toHaveCount(2);
	await page.request.put(`${app.url}/api/chats/${chats[0].id}/archive`, {
		data: { archived: true },
	});
	const archived = page.getByRole("group", { name: "Archived", exact: true });
	await archived.locator("summary").click();
	await expect(
		archived.getByRole("status", { name: "Working", exact: true }),
	).toBeVisible();
	await expect(statuses()).toHaveCount(2);
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "zh-CN" },
	});
	await expect(
		page.getByRole("status", { name: "运行中", exact: true }),
	).toHaveCount(2);
	first.release();
	await expect(
		page.getByRole("status", { name: "运行中", exact: true }),
	).toHaveCount(1);
	second.push(
		'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"message":"fake failure"}}}\n\n',
	);
	second.end();
	await submitted.catch(() => undefined);
	await expect(
		page.getByRole("status", { name: "运行中", exact: true }),
	).toHaveCount(0);
});
