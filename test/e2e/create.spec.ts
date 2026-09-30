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
	const modal = page.getByRole("dialog");
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

test("a pending creation cannot dismiss and overwrite a new modal draft", async ({
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
	const modal = page.getByRole("dialog");
	await modal.getByLabel("名称").fill("First");
	await modal.getByLabel("文件夹路径（每行一个）").fill(app.folder);
	await modal.getByRole("button", { name: "创建", exact: true }).click();
	await expect(modal.getByRole("button", { name: "取消" })).toBeDisabled();
	await page.keyboard.press("Escape");
	await expect(modal).toBeVisible();
	if (!release) throw new Error("Missing release");
	release();
	await expect(modal).not.toBeVisible();
	await expect(
		page.getByRole("heading", { name: "First", exact: true }),
	).toBeVisible();
});
