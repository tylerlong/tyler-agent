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
