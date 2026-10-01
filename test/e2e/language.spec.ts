import { expect, test } from "./fixtures.ts";

test("settings language synchronizes hidden dialogs, survives refresh and restart", async ({
	page,
	context,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(
		page.getByRole("combobox", { name: "Interface language" }),
	).toHaveValue("en");
	const other = await context.newPage();
	await other.goto(app.url);
	await page
		.getByRole("combobox", { name: "Interface language" })
		.selectOption("zh-CN");
	await expect(
		page.getByRole("heading", { name: "设置", exact: true }),
	).toBeVisible();
	await other.getByRole("button", { name: "设置", exact: true }).click();
	await expect(other.getByRole("combobox", { name: "界面语言" })).toHaveValue(
		"zh-CN",
	);
	await expect(other.locator("html")).toHaveAttribute("lang", "zh-CN");
	await page.reload();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await expect(page.getByRole("combobox", { name: "界面语言" })).toHaveValue(
		"zh-CN",
	);
	await app.restart();
	await page.goto(app.url);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await expect(page.getByRole("combobox", { name: "界面语言" })).toHaveValue(
		"zh-CN",
	);
});

test("initial saved language waits for its response and initial failure retries without writing defaults", async ({
	page,
	app,
}) => {
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "zh-CN" },
	});
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/language", async (route) => {
		await gate;
		await route.continue();
	});
	await page.goto(app.url);
	await expect(page.getByRole("navigation")).toHaveCount(0);
	await expect(page.getByRole("status")).toHaveText("Loading…");
	release();
	await expect(
		page.getByRole("button", { name: "设置", exact: true }),
	).toBeVisible();
	await page.unroute("**/api/language");
	await page.route("**/api/language", (route) => route.abort());
	await page.reload();
	await expect(page.getByRole("alert")).toHaveText(
		"Unable to read language settings. Please retry.",
	);
	await expect(page.getByRole("navigation")).toHaveCount(0);
	await expect
		.poll(
			async () =>
				(await (await page.request.get(`${app.url}/api/language`)).json())
					.language,
		)
		.toBe("zh-CN");
	await page.unroute("**/api/language");
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "设置", exact: true }),
	).toBeVisible();
});

test("failed and ambiguous language saves reconcile to server and existing errors translate", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await page.route("**/api/debug", (route) =>
		route.request().method() === "GET" ? route.abort() : route.continue(),
	);
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "en" },
	});
	await expect(dialog.getByRole("alert")).toHaveText(
		"Unable to read logging settings. Please retry.",
	);
	await page.route("**/api/language", (route) =>
		route.request().method() === "PUT"
			? route.fulfill({
					status: 500,
					json: { code: "languageWriteFailed", error: "failed" },
				})
			: route.continue(),
	);
	await page
		.getByRole("combobox", { name: "Interface language" })
		.selectOption("zh-CN");
	await expect(page.locator("html")).toHaveAttribute("lang", "en");
	await expect(
		dialog.getByRole("alert").filter({ hasText: "Unable to confirm language" }),
	).toBeVisible();
	await page.unroute("**/api/language");
	await page.route("**/api/language", async (route) => {
		if (route.request().method() === "PUT") {
			await route.fetch();
			await route.abort();
		} else await route.continue();
	});
	await page
		.getByRole("combobox", { name: "Interface language" })
		.selectOption("zh-CN");
	await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
	await expect(
		dialog.getByRole("alert").filter({ hasText: "读取日志设置失败，请重试" }),
	).toBeVisible();
	await page.unroute("**/api/language");
	await page.getByRole("combobox", { name: "界面语言" }).selectOption("en");
	await expect(page.locator("html")).toHaveAttribute("lang", "en");
});
