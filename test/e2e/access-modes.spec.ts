import { openChatPicker } from "./chat-picker.ts";
import { expect, test } from "./fixtures.ts";

test("keyboard-accessible Chat modes save while busy and synchronize across pages", async ({
	page,
	context,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Modes", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Modes" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const peer = await context.newPage();
	await peer.goto(`${app.url}/?chat=${chat.id}`);
	const hold = app.holdModel();
	await page.getByLabel("Prompt", { exact: true }).fill("hold");
	await page.getByRole("button", { name: /^Send/ }).click();
	await hold.entered;
	try {
		await openChatPicker(page);
		const file = page
			.getByRole("radiogroup", { name: "File access" })
			.getByRole("radio", { name: "Full", exact: true });
		await file.focus();
		await file.press("Space");
		await expect(file).toBeChecked();
		await page.keyboard.press("Escape");
		await openChatPicker(peer);
		await expect(
			peer
				.getByRole("radiogroup", { name: "File access" })
				.getByRole("radio", { name: "Full", exact: true }),
		).toBeChecked();
		await expect(
			peer
				.getByRole("radiogroup", { name: "Network access" })
				.getByRole("radio", { name: "Restricted", exact: true }),
		).toBeChecked();
	} finally {
		hold.release();
	}
});

test("Settings defaults synchronize and initialize only new Chats, with localized controls", async ({
	page,
	context,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Modes", folders: [] },
		})
	).json();
	const existing = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Existing" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${existing.id}`);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "Execution", exact: true }).click();
	const peer = await context.newPage();
	await peer.goto(app.url);
	await peer.getByRole("button", { name: "Settings", exact: true }).click();
	await peer.getByRole("tab", { name: "Execution", exact: true }).click();
	await page.getByLabel("File access", { exact: true }).selectOption("full");
	await expect(peer.getByLabel("File access", { exact: true })).toHaveValue(
		"full",
	);
	await expect(peer.getByLabel("Network access", { exact: true })).toHaveValue(
		"restricted",
	);
	const newer = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "New" },
		})
	).json();
	expect(
		(
			await (
				await page.request.get(`${app.url}/api/chats/${existing.id}`)
			).json()
		).chatOptions.fileAccess,
	).toBe("restricted");
	expect(
		(await (await page.request.get(`${app.url}/api/chats/${newer.id}`)).json())
			.chatOptions.fileAccess,
	).toBe("full");
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "zh-CN" },
	});
	await page.reload();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("tab", { name: "执行", exact: true }).click();
	await expect(page.getByLabel("文件访问", { exact: true })).toHaveValue(
		"full",
	);
	await expect(page.getByLabel("网络访问", { exact: true })).toHaveValue(
		"restricted",
	);
});

test("access-default errors clear after successful Retry and initial loading is not an error", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	let failed = true;
	await page.route("**/api/access-defaults", async (route) => {
		if (failed)
			await route.fulfill({
				status: 500,
				contentType: "application/json",
				body: '{"error":"failed"}',
			});
		else await route.continue();
	});
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "Execution", exact: true }).click();
	const section = page.locator("section", {
		has: page.getByRole("heading", { name: "New Chat access defaults" }),
	});
	await expect(section.getByRole("alert")).toContainText(
		"Unable to read or save access defaults",
	);
	failed = false;
	await section.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(section.getByRole("alert")).toHaveCount(0);
	await expect(
		section.getByLabel("File access", { exact: true }),
	).toBeEnabled();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	await page.route("**/api/access-defaults", async (route) => {
		await gate;
		await route.continue();
	});
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "Execution", exact: true }).click();
	try {
		await expect(section.getByRole("alert")).toHaveCount(0);
	} finally {
		release();
	}
});

test("Settings Close waits for an access-default save and failed saves remain retryable", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "Execution", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	const section = dialog.locator("section", {
		has: page.getByRole("heading", { name: "New Chat access defaults" }),
	});
	let entered!: () => void, release!: () => void;
	const started = new Promise<void>((resolve) => (entered = resolve)),
		gate = new Promise<void>((resolve) => (release = resolve));
	await page.route("**/api/access-defaults", async (route) => {
		if (route.request().method() === "PATCH") {
			entered();
			await gate;
		}
		await route.continue();
	});
	await section.getByLabel("File access", { exact: true }).selectOption("full");
	await started;
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeVisible();
	release();
	await expect(dialog).not.toBeVisible();
	await page.unroute("**/api/access-defaults");
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "Execution", exact: true }).click();
	let fail = true;
	await page.route("**/api/access-defaults", async (route) => {
		if (fail && route.request().method() === "PATCH")
			await route.fulfill({ status: 500, body: "{}" });
		else await route.continue();
	});
	await section
		.getByLabel("Network access", { exact: true })
		.selectOption("full");
	await expect(section.getByRole("alert")).toBeVisible();
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeVisible();
	fail = false;
	await page.unroute("**/api/access-defaults");
	let retryEntered!: () => void, retryRelease!: () => void;
	const retryStarted = new Promise<void>((resolve) => (retryEntered = resolve)),
		retryGate = new Promise<void>((resolve) => (retryRelease = resolve));
	await page.route("**/api/access-defaults", async (route) => {
		if (route.request().method() === "PATCH") {
			retryEntered();
			await retryGate;
		}
		await route.continue();
	});
	await section.getByRole("button", { name: "Retry", exact: true }).click();
	await retryStarted;
	await expect(
		section.getByLabel("File access", { exact: true }),
	).toBeDisabled();
	await expect(
		section.getByLabel("Network access", { exact: true }),
	).toBeDisabled();
	await expect(
		section.getByRole("button", { name: "Retry", exact: true }),
	).toBeDisabled();
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeVisible();
	retryRelease();
	await expect(dialog).not.toBeVisible();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "Execution", exact: true }).click();
	await expect(section.getByRole("alert")).toHaveCount(0);
	await expect(
		section.getByLabel("Network access", { exact: true }),
	).toHaveValue("full");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).not.toBeVisible();
});
