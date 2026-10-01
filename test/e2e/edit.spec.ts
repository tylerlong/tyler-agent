import { expect, test } from "./fixtures.ts";

test("edit menus preserve hidden drafts, retry failures and sync without changing selection or order", async ({
	page,
	context,
	app,
}) => {
	const p = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const c = await (
		await page.request.post(`${app.url}/api/projects/${p.id}/chats`, {
			data: { name: "First" },
		})
	).json();
	await page.request.post(`${app.url}/api/projects/${p.id}/chats`, {
		data: { name: "Second" },
	});
	await page.goto(`${app.url}/?chat=${c.id}`);
	const other = await context.newPage();
	await other.goto(`${app.url}/?chat=${c.id}`);
	await other
		.getByRole("textbox", { name: "Prompt", exact: true })
		.fill("local draft");
	const section = page.getByRole("region", {
		name: "Project Work",
		exact: true,
	});
	await section
		.getByRole("button", { name: "Project 操作", exact: true })
		.click();
	await section
		.getByRole("button", { name: "编辑 project", exact: true })
		.click();
	const modal = page.getByRole("dialog", { name: "编辑 project", exact: true });
	await modal.getByLabel("名称", { exact: true }).fill("Unsaved");
	await modal.getByRole("button", { name: "取消", exact: true }).click();
	await section
		.getByRole("button", { name: "Project 操作", exact: true })
		.click();
	await section
		.getByRole("button", { name: "编辑 project", exact: true })
		.click();
	await expect(modal.getByLabel("名称", { exact: true })).toHaveValue(
		"Unsaved",
	);
	await modal.getByRole("button", { name: "添加文件夹", exact: true }).click();
	await page
		.getByRole("dialog", { name: "选择文件夹", exact: true })
		.getByRole("button", { name: "选择此目录", exact: true })
		.click();
	let failed = false;
	await page.route("**/api/projects/*", async (route) => {
		if (route.request().method() === "PUT" && !failed) {
			failed = true;
			await route.fulfill({ status: 500, json: { error: "Save failed" } });
		} else await route.continue();
	});
	await modal.getByRole("button", { name: "保存", exact: true }).click();
	await expect(modal.getByRole("alert")).toHaveText("Save failed");
	await expect(modal.getByLabel("名称", { exact: true })).toHaveValue(
		"Unsaved",
	);
	await modal.getByRole("button", { name: "保存", exact: true }).click();
	await expect(modal).not.toBeVisible();
	await expect(
		other.getByRole("region", { name: "Project Unsaved", exact: true }),
	).toBeVisible();
	await expect(
		other.getByRole("textbox", { name: "Prompt", exact: true }),
	).toHaveValue("local draft");
	const renamed = page.getByRole("region", {
		name: "Project Unsaved",
		exact: true,
	});
	await renamed
		.getByRole("button", { name: "Project 操作", exact: true })
		.click();
	await renamed
		.getByRole("button", { name: "编辑 project", exact: true })
		.click();
	await expect(modal.getByLabel("名称", { exact: true })).toHaveValue(
		"Unsaved",
	);
	await modal
		.getByRole("button", { name: `移除 ${app.folder}`, exact: true })
		.click();
	await modal.getByRole("button", { name: "保存", exact: true }).click();
	await expect(modal).not.toBeVisible();
	await renamed
		.getByRole("button", { name: "Chat First 操作", exact: true })
		.click();
	await renamed.getByRole("button", { name: "编辑 chat", exact: true }).click();
	const chatModal = page.getByRole("dialog", {
		name: "编辑 chat",
		exact: true,
	});
	await chatModal.getByLabel("名称", { exact: true }).fill("Changed");
	await chatModal.getByRole("button", { name: "保存", exact: true }).click();
	await expect(
		other.getByRole("heading", { name: "Changed", exact: true }),
	).toBeVisible();
	await expect(renamed.locator("li > button")).toHaveText([
		"Second",
		"Changed",
	]);
	await app.restart();
	await page.goto(`${app.url}/?chat=${c.id}`);
	await expect(
		page.getByRole("heading", { name: "Changed", exact: true }),
	).toBeVisible();
});

test("switching edit targets loads their data and closing does not cancel pending saves", async ({
	page,
	app,
}) => {
	const p = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const a = await (
		await page.request.post(`${app.url}/api/projects/${p.id}/chats`, {
			data: { name: "Alpha" },
		})
	).json();
	await page.request.post(`${app.url}/api/projects/${p.id}/chats`, {
		data: { name: "Beta" },
	});
	await page.goto(`${app.url}/?chat=${a.id}`);
	const section = page.getByRole("region", {
		name: "Project Work",
		exact: true,
	});
	async function edit(name: string) {
		await section
			.getByRole("button", { name: `Chat ${name} 操作`, exact: true })
			.click();
		await section
			.getByRole("button", { name: "编辑 chat", exact: true })
			.click();
	}
	await edit("Alpha");
	const modal = page.getByRole("dialog", { name: "编辑 chat", exact: true });
	await modal.getByLabel("名称", { exact: true }).fill("Alpha draft");
	await modal.getByRole("button", { name: "取消", exact: true }).click();
	await edit("Beta");
	await expect(modal.getByLabel("名称", { exact: true })).toHaveValue("Beta");
	await modal.getByRole("button", { name: "取消", exact: true }).click();
	await edit("Alpha");
	await expect(modal.getByLabel("名称", { exact: true })).toHaveValue("Alpha");
	await modal.getByRole("button", { name: "取消", exact: true }).click();
	const model = app.holdModel();
	await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("Wait");
	await page.getByRole("button", { name: "提交", exact: true }).click();
	await model.entered;
	await edit("Alpha");
	await modal.getByLabel("名称", { exact: true }).fill("While running");
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r));
	let entered!: () => void;
	const started = new Promise<void>((r) => (entered = r));
	await page.route(`**/api/chats/${a.id}`, async (route) => {
		if (route.request().method() === "PUT") {
			entered();
			await held;
		}
		await route.continue();
	});
	await modal.getByRole("button", { name: "保存", exact: true }).click();
	await started;
	await modal.getByRole("button", { name: "取消", exact: true }).click();
	await section
		.getByRole("button", { name: "Chat Beta 操作", exact: true })
		.click();
	await expect(
		section.getByRole("button", { name: "编辑 chat", exact: true }),
	).toBeDisabled();
	release();
	await expect(
		page.getByRole("heading", { name: "While running", exact: true }),
	).toBeVisible();
	model.release();
	await expect(page.getByRole("log")).toContainText("Test answer");
	await edit("While running");
	await expect(modal.getByLabel("名称", { exact: true })).toHaveValue(
		"While running",
	);
});
