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
	await page.getByRole("button", { name: "New project", exact: true }).click();
	const project = page.getByRole("dialog", {
		name: "New project",
		exact: true,
	});
	const picker = page.getByRole("dialog", {
		name: "Select folder",
		exact: true,
	});
	const add = project.getByRole("button", { name: "Add folder" });
	await project.getByLabel("Name").fill("Work");
	await add.click();
	await expect(
		picker.getByRole("button", { name: "Select current folder" }),
	).toBeEnabled();
	await expect(
		picker.getByRole("list", { name: "Subdirectories" }).getByRole("button"),
	).toHaveText(["📁Alpha→", "📁Link→", "📁Zulu→"]);
	await expect(picker.getByLabel("Current directory")).toHaveText(app.folder);
	await picker.getByRole("button", { name: "Alpha", exact: true }).click();
	await expect(picker.getByLabel("Current directory")).toHaveText(
		join(app.folder, "Alpha"),
	);
	await expect(picker.getByRole("list")).toHaveText("No subfolders");
	await expect(
		project.getByRole("region", { name: "Selected folders" }),
	).not.toContainText(join(app.folder, "Alpha"));
	await picker.getByRole("button", { name: "Select current folder" }).click();
	await expect(picker).not.toBeVisible();
	await add.click();
	await expect(
		picker.getByRole("button", { name: "Already added" }),
	).toBeDisabled();
	await picker.getByRole("button", { name: "Cancel" }).click();
	await expect(project.getByLabel("Name")).toHaveValue("Work");
	await add.click();
	await picker.getByRole("button", { name: "Up one level" }).click();
	await expect(picker.getByLabel("Current directory")).toHaveText(app.folder);
	await picker.getByRole("button", { name: "Zulu", exact: true }).click();
	await expect(picker.getByLabel("Current directory")).toHaveText(
		join(app.folder, "Zulu"),
	);
	await picker.getByRole("button", { name: "Select current folder" }).click();
	await project
		.getByRole("button", {
			name: `Remove ${join(app.folder, "Alpha")}`,
			exact: true,
		})
		.click();
	await expect(
		project.getByRole("region", { name: "Selected folders" }),
	).not.toContainText(join(app.folder, "Alpha"));
	await rm(join(app.folder, "Zulu"), { recursive: true });
	await project.getByRole("button", { name: "Create", exact: true }).click();
	await expect(project.getByRole("alert")).toHaveText(
		"Target folder does not exist.",
	);
	await expect(project.getByLabel("Name")).toHaveValue("Work");
	await project
		.getByRole("button", {
			name: `Remove ${join(app.folder, "Zulu")}`,
			exact: true,
		})
		.click();
	await add.click();
	await expect(picker.getByLabel("Current directory")).toHaveText(
		join(app.folder, "Zulu"),
	);
	await picker.getByRole("button", { name: "Up one level" }).click();
	await expect(picker.getByLabel("Current directory")).toHaveText(app.folder);
	await picker.getByRole("button", { name: "Select current folder" }).click();
	await project.getByRole("button", { name: "Create", exact: true }).click();
	await expect(project).not.toBeVisible();
	await page.getByRole("button", { name: "New project", exact: true }).click();
	await expect(project.getByLabel("Name")).toHaveValue("New project");
	await add.click();
	await expect(picker.getByLabel("Current directory")).toHaveText(app.folder);
});

test("hidden directory loads finish normally and stale navigation cannot replace newer results", async ({
	page,
	app,
}) => {
	await mkdir(join(app.folder, "Alpha"));
	await mkdir(join(app.folder, "Beta"));
	await page.goto(app.url);
	await page.getByRole("button", { name: "New project", exact: true }).click();
	const project = page.getByRole("dialog", {
		name: "New project",
		exact: true,
	});
	const picker = page.getByRole("dialog", {
		name: "Select folder",
		exact: true,
	});
	const add = project.getByRole("button", { name: "Add folder" });
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
		picker.getByRole("button", { name: "Select current folder" }),
	).toBeDisabled();
	await picker.getByRole("button", { name: "Cancel" }).click();
	await expect(picker).not.toBeVisible();
	release();
	await expect(
		page.locator('dialog[aria-labelledby="folder-title"]'),
	).toContainText("Alpha");
	await page.unroute("**/api/directories*");
	await add.click();
	await expect(
		picker.getByRole("button", { name: "Select current folder" }),
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
	await expect(picker.getByRole("status")).toHaveText(
		`Loading ${join(app.folder, "Alpha")}…`,
	);
	await expect(
		picker.getByRole("button", { name: "Select current folder" }),
	).toBeDisabled();
	await picker.getByRole("button", { name: "Beta", exact: true }).click();
	await expect(picker.getByLabel("Current directory")).toHaveText(
		join(app.folder, "Beta"),
	);
	const done = page.waitForResponse(
		(response) =>
			new URL(response.url()).searchParams.get("path") ===
			join(app.folder, "Alpha"),
	);
	releaseAlpha();
	await done;
	await expect(picker.getByLabel("Current directory")).toHaveText(
		join(app.folder, "Beta"),
	);
	await picker.getByRole("button", { name: "Cancel" }).click();
});

test("showing a hidden picker sends no new browse request and preserves a navigation error", async ({
	page,
	app,
}) => {
	await mkdir(join(app.folder, "Gone"));
	let reads = 0;
	page.on("request", (request) => {
		if (new URL(request.url()).pathname === "/api/directories") reads++;
	});
	await page.goto(app.url);
	await page.getByRole("button", { name: "New project", exact: true }).click();
	const project = page.getByRole("dialog", {
		name: "New project",
		exact: true,
	});
	const picker = page.getByRole("dialog", {
		name: "Select folder",
		exact: true,
	});
	const add = project.getByRole("button", { name: "Add folder" });
	await add.click();
	await expect(
		picker.getByRole("button", { name: "Select current folder" }),
	).toBeEnabled();
	await rm(join(app.folder, "Gone"), { recursive: true });
	await picker.getByRole("button", { name: "Gone", exact: true }).click();
	await expect(picker.getByRole("alert")).toContainText(
		"Target folder does not exist.",
	);
	expect(reads).toBe(2);
	await picker.getByRole("button", { name: "Cancel" }).click();
	await add.click();
	await expect(picker.getByRole("alert")).toContainText(
		"Target folder does not exist.",
	);
	await expect(picker.getByLabel("Current directory")).toHaveText(app.folder);
	await expect(
		picker.getByRole("button", { name: "Select current folder" }),
	).toBeEnabled();
	expect(reads).toBe(2);
	await expect(picker.getByRole("alert")).toContainText(
		`Could not open ${join(app.folder, "Gone")}.`,
	);
	await expect(picker.getByRole("alert")).toContainText(
		`Still showing ${app.folder}.`,
	);
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "zh-CN" },
	});
	const chinese = page.getByRole("dialog", { name: "选择文件夹", exact: true });
	await expect(chinese.getByRole("alert")).toContainText(
		`无法打开 ${join(app.folder, "Gone")}。`,
	);
	await expect(chinese.getByRole("alert")).toContainText(
		`仍显示 ${app.folder}`,
	);
	await expect(chinese.getByRole("button", { name: "返回上级" })).toBeVisible();
	await expect(
		chinese.getByRole("button", { name: "选择当前文件夹" }),
	).toBeEnabled();
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "en" },
	});
	await mkdir(join(app.folder, "Gone"));
	await picker.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(picker.getByRole("alert")).toHaveCount(0);
	await expect(picker.getByLabel("Current directory")).toHaveText(
		join(app.folder, "Gone"),
	);
	await expect(
		picker.getByRole("button", { name: "Select current folder" }),
	).toBeEnabled();
	expect(reads).toBe(3);
});

test("directory list scrolls with fixed controls and long paths remain selectable", async ({
	page,
	app,
}, testInfo) => {
	await page.setViewportSize({ width: 1280, height: 720 });
	for (let i = 0; i < 80; i++)
		await mkdir(join(app.folder, `Folder${String(i).padStart(2, "0")}`));
	const longName = "long-directory-name-".repeat(10);
	const nestedName = "nested-directory-".repeat(7);
	const deepPath = join(app.folder, "Folder79", longName, nestedName);
	await mkdir(join(deepPath, "Last"), { recursive: true });
	await page.goto(app.url);
	await page.getByRole("button", { name: "New project", exact: true }).click();
	const project = page.getByRole("dialog", {
		name: "New project",
		exact: true,
	});
	await project.getByRole("button", { name: "Add folder" }).click();
	const picker = page.getByRole("dialog", {
		name: "Select folder",
		exact: true,
	});
	const list = picker.getByRole("list", { name: "Subdirectories" });
	const path = picker.getByLabel("Current directory");
	const select = picker.getByRole("button", { name: "Select current folder" });
	const cancel = picker.getByRole("button", { name: "Cancel" });
	await expect(list.getByRole("button")).toHaveCount(80);
	await page.screenshot({
		path: testInfo.outputPath("folder-minimum-populated.png"),
	});
	const before = await Promise.all([
		path.boundingBox(),
		select.boundingBox(),
		cancel.boundingBox(),
	]);
	await list.hover();
	await page.mouse.wheel(0, 3000);
	await expect
		.poll(() => list.evaluate((element) => element.scrollTop))
		.toBeGreaterThan(0);
	const after = await Promise.all([
		path.boundingBox(),
		select.boundingBox(),
		cancel.boundingBox(),
	]);
	expect(after).toEqual(before);
	await expect(select).toBeInViewport();
	await expect(cancel).toBeInViewport();
	await list.getByRole("button", { name: "Folder79", exact: true }).click();
	await expect
		.poll(() => list.evaluate((element) => element.scrollTop))
		.toBe(0);
	await list.getByRole("button", { name: longName, exact: true }).click();
	await expect(path).toHaveText(join(app.folder, "Folder79", longName));
	const pathBox = await path.boundingBox();
	const selectBox = await select.boundingBox();
	if (!pathBox || !selectBox) throw new Error("Missing path controls");
	expect(pathBox.height).toBeGreaterThan(24);
	expect(pathBox.y + pathBox.height).toBeLessThan(selectBox.y);
	expect(
		await picker.evaluate(
			(element) => element.scrollWidth <= element.clientWidth,
		),
	).toBe(true);
	await expect(select).toBeInViewport();
	await page.setViewportSize({ width: 1440, height: 900 });
	await list.getByRole("button", { name: nestedName, exact: true }).click();
	await expect(path).toHaveText(deepPath);
	await expect(path).toHaveAttribute("title", deepPath);
	await page.screenshot({
		path: testInfo.outputPath("folder-large-long-path.png"),
	});
	await expect(cancel).toBeInViewport({ ratio: 1 });
	await expect(select).toBeInViewport({ ratio: 1 });
	const listBox = await list.boundingBox();
	if (!listBox) throw new Error("Missing directory list");
	expect(listBox.height).toBeGreaterThanOrEqual(48);
	await expect(
		list.getByRole("button", { name: "Last", exact: true }),
	).toBeInViewport({ ratio: 1 });
	await rm(join(deepPath, "Last"), { recursive: true });
	await list.getByRole("button", { name: "Last", exact: true }).click();
	await expect(picker.getByRole("alert")).toContainText(
		"Target folder does not exist.",
	);
	await page.setViewportSize({ width: 1280, height: 720 });
	await expect(cancel).toBeInViewport({ ratio: 1 });
	await expect(select).toBeInViewport({ ratio: 1 });
	await page.screenshot({
		path: testInfo.outputPath("folder-minimum-failure.png"),
	});
	await picker.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(picker.getByRole("alert")).toContainText(
		`Could not open ${join(deepPath, "Last")}.`,
	);
	await expect(picker.getByRole("alert")).toContainText(
		`Still showing ${deepPath}.`,
	);
	await select.click();
	await expect(
		project.getByRole("region", { name: "Selected folders" }),
	).toContainText(deepPath);
});

test("root parent is disabled and row navigation and cancellation return focus", async ({
	page,
	app,
}) => {
	await page.route("**/api/directories", async (route) => {
		const response = await route.fetch({
			url: `${app.url}/api/directories?path=%2F`,
		});
		await route.fulfill({ response });
	});
	await page.goto(app.url);
	await page.getByRole("button", { name: "New project", exact: true }).click();
	const project = page.getByRole("dialog", {
		name: "New project",
		exact: true,
	});
	const add = project.getByRole("button", { name: "Add folder" });
	await add.click();
	const picker = page.getByRole("dialog", {
		name: "Select folder",
		exact: true,
	});
	await expect(picker.getByLabel("Current directory")).toHaveText("/");
	await expect(
		picker.getByRole("button", { name: "Up one level" }),
	).toBeDisabled();
	const row = picker.getByRole("list").getByRole("button").first();
	await row.focus();
	await expect(row).toBeFocused();
	await row.press("Enter");
	await expect(picker.getByLabel("Current directory")).not.toHaveText("/");
	await expect(
		project
			.getByRole("region", { name: "Selected folders" })
			.getByRole("listitem"),
	).toHaveCount(0);
	await picker.getByRole("button", { name: "Cancel" }).click();
	await expect(add).toBeFocused();
	await expect(project).toBeVisible();
});
