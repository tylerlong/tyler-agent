import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures.ts";

test("real directory picker selects one folder at a time, preserves position and rejects vanished folders", async ({
	page,
	app,
}) => {
	for (const child of ["Zulu", "Alpha", ".hidden"])
		await mkdir(join(app.folder, child));
	await writeFile(join(app.folder, "file.txt"), "text");
	await symlink(join(app.folder, "Alpha"), join(app.folder, "Link"));
	await symlink(join(app.folder, "missing"), join(app.folder, "Broken"));
	await page.goto(app.url);
	await page.getByRole("button", { name: "新建 project", exact: true }).click();
	const project = page.getByRole("dialog", {
		name: "新建 project",
		exact: true,
	});
	const picker = page.getByRole("dialog", { name: "选择文件夹", exact: true });
	const add = project.getByRole("button", { name: "添加文件夹" });
	await project.getByLabel("名称").fill("Work");
	await add.click();
	await expect(
		picker.getByRole("button", { name: "选择此目录" }),
	).toBeEnabled();
	await expect(
		picker.getByRole("list", { name: "子目录" }).getByRole("button"),
	).toHaveText(["Alpha", "Link", "Zulu"]);
	await expect(picker.getByLabel("当前目录")).toHaveText(app.folder);
	await picker.getByRole("button", { name: "Alpha", exact: true }).click();
	await expect(picker.getByLabel("当前目录")).toHaveText(
		join(app.folder, "Alpha"),
	);
	await expect(picker.getByRole("list")).toBeEmpty();
	await picker.getByRole("button", { name: "选择此目录" }).click();
	await expect(picker).not.toBeVisible();
	await expect(add).toBeFocused();
	await add.click();
	await expect(picker.getByRole("button", { name: "已添加" })).toBeDisabled();
	await page.keyboard.press("Escape");
	await expect(add).toBeFocused();
	await expect(project.getByLabel("名称")).toHaveValue("Work");
	await add.click();
	await picker.getByRole("button", { name: "返回上级" }).click();
	await expect(picker.getByLabel("当前目录")).toHaveText(app.folder);
	await picker.getByRole("button", { name: "Zulu", exact: true }).click();
	await expect(picker.getByLabel("当前目录")).toHaveText(
		join(app.folder, "Zulu"),
	);
	await picker.getByRole("button", { name: "选择此目录" }).click();
	await project
		.getByRole("button", {
			name: `移除 ${join(app.folder, "Alpha")}`,
			exact: true,
		})
		.click();
	await expect(
		project.getByRole("region", { name: "已选文件夹" }),
	).not.toContainText(join(app.folder, "Alpha"));
	await rm(join(app.folder, "Zulu"), { recursive: true });
	await project.getByRole("button", { name: "创建", exact: true }).click();
	await expect(project.getByRole("alert")).toHaveText("目标文件夹不存在");
	await expect(project.getByLabel("名称")).toHaveValue("Work");
	await project
		.getByRole("button", {
			name: `移除 ${join(app.folder, "Zulu")}`,
			exact: true,
		})
		.click();
	await add.click();
	await expect(picker.getByRole("alert")).toHaveText("目标文件夹不存在");
	await picker.getByRole("button", { name: "返回上级" }).click();
	await expect(picker.getByLabel("当前目录")).toHaveText(app.folder);
	await picker.getByRole("button", { name: "选择此目录" }).click();
	await project.getByRole("button", { name: "创建", exact: true }).click();
	await expect(project).not.toBeVisible();
	await page.getByRole("button", { name: "新建 project", exact: true }).click();
	await expect(project.getByLabel("名称")).toHaveValue("");
	await add.click();
	await expect(picker.getByLabel("当前目录")).toHaveText(app.folder);
});

test("hidden directory loads finish normally and stale navigation cannot replace newer results", async ({
	page,
	app,
}) => {
	await mkdir(join(app.folder, "Alpha"));
	await mkdir(join(app.folder, "Beta"));
	await page.goto(app.url);
	await page.getByRole("button", { name: "新建 project", exact: true }).click();
	const project = page.getByRole("dialog", {
		name: "新建 project",
		exact: true,
	});
	const picker = page.getByRole("dialog", { name: "选择文件夹", exact: true });
	const add = project.getByRole("button", { name: "添加文件夹" });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/directories*", async (route) => {
		const response = await route.fetch();
		await gate;
		await route.fulfill({ response });
	});
	await add.click();
	await expect(
		picker.getByRole("button", { name: "选择此目录" }),
	).toBeDisabled();
	await page.keyboard.press("Escape");
	await expect(picker).not.toBeVisible();
	release();
	await expect(
		page.locator('dialog[aria-labelledby="folder-title"]'),
	).toContainText("Alpha");
	await page.unroute("**/api/directories*");
	await add.click();
	await expect(
		picker.getByRole("button", { name: "选择此目录" }),
	).toBeEnabled();
	let releaseAlpha!: () => void;
	const alphaGate = new Promise<void>((resolve) => {
		releaseAlpha = resolve;
	});
	await page.route("**/api/directories*", async (route) => {
		const response = await route.fetch();
		if (
			new URL(route.request().url()).searchParams.get("path") ===
			join(app.folder, "Alpha")
		)
			await alphaGate;
		await route.fulfill({ response });
	});
	await picker.getByRole("button", { name: "Alpha", exact: true }).click();
	await expect(picker.getByRole("status")).toHaveText("加载中…");
	await picker.getByRole("button", { name: "Beta", exact: true }).click();
	await expect(picker.getByLabel("当前目录")).toHaveText(
		join(app.folder, "Beta"),
	);
	const done = page.waitForResponse(
		(response) =>
			new URL(response.url()).searchParams.get("path") ===
			join(app.folder, "Alpha"),
	);
	releaseAlpha();
	await done;
	await expect(picker.getByLabel("当前目录")).toHaveText(
		join(app.folder, "Beta"),
	);
	await picker.getByRole("button", { name: "取消" }).click();
	await expect(add).toBeFocused();
});
