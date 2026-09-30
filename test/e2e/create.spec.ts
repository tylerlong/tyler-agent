import { expect, test } from "./fixtures.ts";

test("native creation modals support validation, keyboard cancellation, focus and shared lists", async ({
	page,
	context,
	app,
}) => {
	await page.goto(app.url);
	const other = await context.newPage();
	await other.goto(app.url);
	const createProject = page.getByRole("button", {
		name: "新建 project",
		exact: true,
	});
	await createProject.click();
	const modal = page.getByRole("dialog", { name: /^新建/ });
	await expect(modal).toBeVisible();
	await expect(modal.getByLabel("名称")).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(modal).not.toBeVisible();
	await expect(createProject).toBeFocused();
	await createProject.click();
	await modal.getByRole("button", { name: "取消" }).click();
	await expect(modal).not.toBeVisible();
	await expect(createProject).toBeFocused();
	await createProject.click();
	await modal.getByLabel("名称").fill(" ");
	await modal.getByLabel("文件夹路径（每行一个）").fill(app.folder);
	await modal.getByRole("button", { name: "创建", exact: true }).click();
	await expect(modal.getByRole("alert")).toHaveText("名称不得为空");
	await expect(modal).toBeVisible();
	await modal.getByLabel("名称").fill("Work");
	await modal
		.getByLabel("文件夹路径（每行一个）")
		.fill(`${app.folder}\n${app.folder}`);
	await modal.getByRole("button", { name: "创建", exact: true }).click();
	await expect(modal.getByRole("alert")).toHaveText("文件夹路径重复");
	await modal.getByLabel("文件夹路径（每行一个）").fill(app.folder);
	await modal.getByRole("button", { name: "创建", exact: true }).click();
	await expect(modal).not.toBeVisible();
	await expect(createProject).toBeFocused();
	await expect(page.getByRole("region", { name: "Chat" })).toBeEmpty();
	await expect(
		other.getByRole("heading", { name: "Work", exact: true }),
	).toBeVisible();
	const createChat = page.getByRole("button", {
		name: "新建 chat",
		exact: true,
	});
	await createChat.click();
	await modal.getByLabel("名称").fill(" ");
	await modal.getByRole("button", { name: "创建", exact: true }).click();
	await expect(modal.getByRole("alert")).toHaveText("名称不得为空");
	await modal.getByLabel("名称").fill("Question");
	await modal.getByRole("button", { name: "创建", exact: true }).click();
	await expect(modal).not.toBeVisible();
	await expect(createChat).toBeFocused();
	await expect(
		page
			.getByRole("region", { name: "Chat" })
			.getByRole("heading", { name: "Question" }),
	).toBeVisible();
	await expect(page.getByRole("region", { name: "Chat" })).toContainText(
		app.folder,
	);
	await expect(
		other.getByRole("button", { name: "Question", exact: true }),
	).toBeVisible();
	await expect(other.getByRole("region", { name: "Chat" })).toBeEmpty();
	await page.getByRole("button", { name: "折叠 Work" }).click();
	await expect(
		page.getByRole("button", { name: "Question", exact: true }),
	).not.toBeVisible();
	await expect(
		other.getByRole("button", { name: "Question", exact: true }),
	).toBeVisible();
});

test("pending project creation can hide and reopen without cancelling or closing settings", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	let release: (() => void) | undefined;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/projects", async (route) => {
		if (route.request().method() === "POST") await held;
		await route.continue();
	});
	await page.getByRole("button", { name: "新建 project", exact: true }).click();
	const modal = page.getByRole("dialog", { name: /^新建/ });
	await modal.getByLabel("名称").fill("First");
	await modal.getByLabel("文件夹路径（每行一个）").fill(app.folder);
	await modal.getByRole("button", { name: "创建", exact: true }).click();
	await expect(modal.getByRole("button", { name: "取消" })).toBeEnabled();
	await page.keyboard.press("Escape");
	await expect(modal).not.toBeVisible();
	await page.getByRole("button", { name: "新建 project", exact: true }).click();
	await expect(modal.getByLabel("名称")).toHaveValue("First");
	await expect(
		modal.getByRole("button", { name: "创建", exact: true }),
	).toBeDisabled();
	await modal.getByRole("button", { name: "取消" }).click();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	const settings = page.getByRole("dialog", { name: "设置", exact: true });
	await expect(settings).toBeVisible();
	if (!release) throw new Error("Missing release");
	release();
	await expect(modal).not.toBeVisible();
	await expect(settings).toBeVisible();
	await settings.getByRole("button", { name: "关闭", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "First", exact: true }),
	).toBeVisible();
});

test("pending chat creation keeps its input while hidden and completes in its original project", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [app.folder] },
		})
	).json();
	await page.goto(app.url);
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(`**/api/projects/${project.id}/chats`, async (route) => {
		await held;
		await route.continue();
	});
	const trigger = page.getByRole("button", { name: "新建 chat", exact: true });
	await trigger.click();
	const modal = page.getByRole("dialog", { name: "新建 chat", exact: true });
	await modal.getByLabel("名称").fill("Pending chat");
	await modal.getByRole("button", { name: "取消" }).click();
	await trigger.click();
	await expect(modal.getByLabel("名称")).toHaveValue("Pending chat");
	await modal.getByRole("button", { name: "创建", exact: true }).click();
	await expect(modal.getByLabel("名称")).toBeDisabled();
	await page.keyboard.press("Escape");
	await expect(modal).not.toBeVisible();
	await trigger.click();
	await expect(modal.getByLabel("名称")).toHaveValue("Pending chat");
	await modal.getByRole("button", { name: "取消" }).click();
	release();
	await expect(
		page
			.getByRole("region", { name: "Chat", exact: true })
			.getByRole("heading", { name: "Pending chat" }),
	).toBeVisible();
	await trigger.click();
	await expect(modal.getByLabel("名称")).toHaveValue("");
});

test("settings stays synchronized while hidden and failed updates can retry without losing errors", async ({
	page,
	context,
	app,
}) => {
	await page.goto(app.url);
	const trigger = page.getByRole("button", { name: "设置", exact: true });
	const modal = page.getByRole("dialog", { name: "设置", exact: true });
	await expect(page.getByRole("complementary").getByRole("radio")).toHaveCount(
		0,
	);
	await trigger.click();
	await expect(modal.getByLabel("关闭", { exact: true })).toBeChecked();
	await page.keyboard.press("Escape");
	await expect(trigger).toBeFocused();
	const other = await context.newPage();
	await other.goto(app.url);
	await other.getByRole("button", { name: "设置", exact: true }).click();
	await other.getByLabel("开启", { exact: true }).click();
	await trigger.click();
	await expect(modal.getByLabel("开启", { exact: true })).toBeChecked();
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/debug", async (route) => {
		if (route.request().method() !== "PUT") return route.continue();
		await held;
		await route.fulfill({ status: 500, json: { error: "test failure" } });
	});
	await modal.getByLabel("关闭", { exact: true }).click();
	await expect(modal.getByLabel("开启", { exact: true })).toBeDisabled();
	await modal.getByRole("button", { name: "关闭", exact: true }).click();
	release();
	await trigger.click();
	await expect(modal.getByRole("alert")).toHaveText("无法确认日志设置，请重试");
	await page.keyboard.press("Escape");
	await trigger.click();
	await expect(modal.getByRole("alert")).toHaveText("无法确认日志设置，请重试");
	await page.unroute("**/api/debug");
	await modal.getByLabel("关闭", { exact: true }).click();
	await expect(modal.getByRole("alert")).toHaveCount(0);
	await expect(other.getByLabel("关闭", { exact: true })).toBeChecked();
});

test("settings read errors remain in settings and a successful reread clears them", async ({
	page,
	app,
}) => {
	await page.route("**/api/debug", (route) =>
		route.fulfill({ status: 503, json: { error: "offline" } }),
	);
	await page.goto(app.url);
	await expect(page.getByRole("complementary").getByRole("alert")).toHaveCount(
		0,
	);
	const trigger = page.getByRole("button", { name: "设置", exact: true });
	await trigger.click();
	const modal = page.getByRole("dialog", { name: "设置", exact: true });
	await expect(modal.getByRole("alert")).toHaveText("读取日志设置失败，请重试");
	await expect(modal.getByLabel("开启", { exact: true })).toBeDisabled();
	await page.keyboard.press("Escape");
	await trigger.click();
	await expect(modal.getByRole("alert")).toBeVisible();
	await page.unroute("**/api/debug");
	await modal.getByRole("button", { name: "重试", exact: true }).click();
	await expect(modal.getByRole("alert")).toHaveCount(0);
	await expect(modal.getByLabel("关闭", { exact: true })).toBeChecked();
});
