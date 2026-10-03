import { expect, test } from "./fixtures.ts";

test("mandatory Settings explains reload recovery after an initial catalog failure", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Setup recovery", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "First chat" },
		})
	).json();
	await page.request.put(`${app.url}/api/model-settings`, {
		data: { removeApiKey: true },
	});
	await page.request.delete(`${app.url}/api/models/test`);
	await page.route("**/api/model-catalog", (route) =>
		route.fulfill({ status: 502, json: {} }),
	);
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const settings = page.getByRole("dialog", { name: "Settings", exact: true });
	await expect(settings.getByRole("alert")).toHaveText(
		"Unable to load popular models. Close and reopen Settings, or reload the page if Settings cannot close, to retry.",
	);
	const close = settings.getByRole("button", { name: "Close", exact: true });
	await expect(close).toBeDisabled();
	await page.keyboard.press("Escape");
	await expect(settings).toBeVisible();
	await expect(
		settings.getByRole("button", { name: /Search|Refresh/ }),
	).toHaveCount(0);
	await page.unroute("**/api/model-catalog");
	await page.reload();
	await settings
		.getByRole("button", { name: "Add model", exact: true })
		.click();
	await expect(
		settings
			.getByRole("listbox", { name: "Popular models" })
			.getByRole("option"),
	).toHaveCount(2);
	await expect(settings.getByRole("alert")).toHaveCount(0);
	const filter = settings.getByRole("combobox", { name: "Filter models" });
	await filter.fill("second");
	await filter.press("Escape");
	await expect(filter).toHaveCount(0);
	await expect(settings).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(settings).toBeVisible();
	await settings
		.getByRole("button", { name: "Add model", exact: true })
		.click();
	await expect(filter).toHaveValue("");
	await settings
		.getByLabel("OpenRouter API key", { exact: true })
		.fill("setup-secret");
	await settings
		.getByRole("button", { name: "Save API key", exact: true })
		.click();
	await expect(close).toBeDisabled();
	await settings
		.getByRole("option", { name: "Second second", exact: true })
		.click();
	await expect(close).toBeEnabled();
	await close.click();
	await expect(
		page.getByRole("combobox", { name: "Model", exact: true }),
	).toHaveValue("second");
	await page.getByLabel("Prompt", { exact: true }).fill("Recovered setup");
	await page.getByRole("button", { name: "Submit", exact: true }).click();
	await expect(page.getByRole("log")).toContainText("Test answer");
});

test("settings save write-only credentials and manage cached model choices across restart", async ({
	page,
	app,
}) => {
	const peer = await page.context().newPage();
	await page.goto(app.url);
	await peer.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await peer.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	const key = dialog.getByLabel("OpenRouter API key", { exact: true });
	await expect(key).toHaveAttribute("type", "password");
	await expect(key).toHaveValue("");
	await key.fill("replacement-secret");
	await dialog
		.getByRole("button", { name: "Save API key", exact: true })
		.click();
	await expect(key).toHaveValue("");
	const settings = await page.request.get(`${app.url}/api/model-settings`);
	expect(await settings.text()).not.toContain("replacement-secret");
	await expect(
		dialog.getByRole("button", { name: "Save API key", exact: true }),
	).toBeDisabled();
	await expect(dialog.getByText("Configured", { exact: true })).toBeVisible();
	await dialog.getByRole("button", { name: "Add model", exact: true }).click();
	await dialog
		.getByRole("option", { name: "Second second", exact: true })
		.click();
	await expect(
		peer.getByRole("list", { name: "Enabled models" }),
	).toContainText("Second");
	await dialog
		.getByRole("list", { name: "Enabled models" })
		.getByRole("listitem")
		.filter({ hasText: "Second" })
		.getByRole("button", { name: "Set default" })
		.click();
	await expect(
		peer
			.getByRole("list", { name: "Enabled models" })
			.getByRole("listitem")
			.filter({ hasText: "Second" }),
	).toContainText("Default");
	await dialog
		.getByRole("list", { name: "Enabled models" })
		.getByRole("listitem")
		.filter({ hasText: "Second" })
		.getByRole("button", { name: "Disable model" })
		.click();
	await expect(
		dialog.getByRole("list", { name: "Enabled models" }),
	).toContainText("Default");
	await expect(
		peer.getByRole("list", { name: "Enabled models" }),
	).toContainText("Default");
	await dialog
		.getByRole("button", { name: "Remove API key", exact: true })
		.click();
	await expect(dialog.getByText("Not configured")).toBeVisible();
	await app.restart();
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(page.getByText("Not configured")).toBeVisible();
	await expect(
		page.getByRole("list", { name: "Enabled models" }),
	).toContainText("Default");
	await peer.close();
});

test("settings retain input on save failure and retry catalog by reopening", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	await page.route("**/api/model-settings", (route) =>
		route.request().method() === "PUT"
			? route.fulfill({
					status: 500,
					json: { code: "configurationSaveFailed" },
				})
			: route.continue(),
	);
	await dialog
		.getByLabel("OpenRouter API key", { exact: true })
		.fill("retry-secret");
	await dialog
		.getByRole("button", { name: "Save API key", exact: true })
		.click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Unable to save API key. Please retry.",
	);
	await expect(
		dialog.getByLabel("OpenRouter API key", { exact: true }),
	).toHaveValue("retry-secret");
	await page.unroute("**/api/model-settings");
	await dialog
		.getByRole("button", { name: "Save API key", exact: true })
		.click();
	await expect(
		dialog.getByLabel("OpenRouter API key", { exact: true }),
	).toHaveValue("");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await page.route("**/api/model-catalog", (route) =>
		route.fulfill({ status: 500, json: {} }),
	);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(
		dialog.getByText(
			"Unable to load popular models. Close and reopen Settings, or reload the page if Settings cannot close, to retry.",
		),
	).toBeVisible();
	await dialog.getByRole("button", { name: "Add model", exact: true }).click();
	await expect(
		dialog.getByRole("option", { name: "Second second", exact: true }),
	).toBeVisible();
	await page.unroute("**/api/model-catalog");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(
		dialog.getByText(
			"Unable to load popular models. Close and reopen Settings, or reload the page if Settings cannot close, to retry.",
		),
	).toHaveCount(0);
	await expect(
		dialog.getByRole("option", { name: "Second second", exact: true }),
	).toBeVisible();
});

test("each opening refreshes once; the combobox filters unenabled ranked models and retries additions", async ({
	page,
	app,
}) => {
	app.setCatalog([
		{ id: "second", name: "Second" },
		{ id: "third", name: "Third" },
		{ id: "test", name: "Test" },
	]);
	let calls = 0;
	await page.route("**/api/model-catalog", async (route) => {
		calls++;
		await route.continue();
	});
	await page.goto(app.url);
	await expect.poll(() => calls).toBe(0);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	const add = dialog.getByRole("button", { name: "Add model", exact: true });
	await expect(
		dialog.getByRole("combobox", { name: "Filter models" }),
	).toHaveCount(0);
	await add.click();
	const filter = dialog.getByRole("combobox", { name: "Filter models" });
	const options = dialog
		.getByRole("listbox", { name: "Popular models" })
		.getByRole("option");
	await expect(filter).toBeFocused();
	await expect(options).toHaveText(["Secondsecond", "Thirdthird"]);
	await expect(filter).toHaveAttribute("aria-expanded", "true");
	await filter.press("ArrowDown");
	await filter.press("ArrowDown");
	await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
	await filter.press("ArrowUp");
	await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
	expect(calls).toBe(1);
	await expect(
		dialog.getByRole("button", { name: /Search|Refresh/ }),
	).toHaveCount(0);
	await filter.fill("sEcOnD");
	await expect(options).toHaveCount(1);
	await expect(options).toHaveAttribute("aria-selected", "false");
	await filter.press("Enter");
	await expect(filter).toBeVisible();
	await filter.fill("absent");
	await expect(
		dialog.getByText("No matching unenabled models in the top 100."),
	).toBeVisible();
	await filter.press("Enter");
	await expect(
		dialog.getByRole("list", { name: "Enabled models" }).getByRole("listitem"),
	).toHaveCount(1);
	await filter.fill("second");
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(filter).toHaveCount(0);
	await expect(add).toBeFocused();
	await add.click();
	await expect(filter).toHaveValue("");
	await filter.fill("second");
	await filter.press("Escape");
	await expect(dialog).toBeVisible();
	await expect(filter).toHaveCount(0);
	await expect(add).toBeFocused();
	await add.click();
	await filter.fill("second");
	let releaseAdd = () => {};
	const pendingAdd = new Promise<void>((resolve) => {
		releaseAdd = resolve;
	});
	await page.route("**/api/models", async (route) => {
		await pendingAdd;
		await route.fulfill({ status: 500, json: {} });
	});
	await filter.press("ArrowDown");
	await filter.press("Enter");
	await expect(filter).toBeDisabled();
	await expect(
		dialog.getByRole("button", { name: "Cancel", exact: true }),
	).toBeDisabled();
	await expect(
		dialog.getByRole("option", { name: "Second second", exact: true }),
	).toBeDisabled();
	releaseAdd();
	await expect(
		dialog.getByText("Unable to save model settings. Please retry."),
	).toBeVisible();
	await expect(filter).toHaveValue("second");
	await expect(
		dialog.getByRole("option", { name: "Second second", exact: true }),
	).toBeVisible();
	await expect(
		dialog.getByRole("list", { name: "Enabled models" }).getByRole("listitem"),
	).toHaveCount(1);
	await page.unroute("**/api/models");
	await dialog
		.getByRole("option", { name: "Second second", exact: true })
		.click();
	await expect(add).toBeVisible();
	await expect(add).toBeFocused();
	await expect(filter).toHaveCount(0);
	await expect(
		dialog.getByRole("list", { name: "Enabled models" }),
	).toContainText("Second");
	expect(calls).toBe(1);
	await add.click();
	await expect(options).toHaveText(["Thirdthird"]);
	await filter.press("Escape");
	await expect(dialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect.poll(() => calls).toBe(2);
	await add.click();
	await expect(filter).toHaveValue("");
	await expect(options).toHaveText(["Thirdthird"]);
});

test("initial catalog failure differs from an empty filter and existing models remain usable", async ({
	page,
	app,
}) => {
	await page.route("**/api/model-catalog", (route) =>
		route.fulfill({ status: 502, json: {} }),
	);
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	await expect(
		dialog.getByText(
			"Unable to load popular models. Close and reopen Settings, or reload the page if Settings cannot close, to retry.",
		),
	).toBeVisible();
	await dialog.getByRole("button", { name: "Add model", exact: true }).click();
	await expect(
		dialog.getByText("No matching unenabled models in the top 100."),
	).toHaveCount(0);
	await expect(
		dialog
			.getByRole("list", { name: "Enabled models" })
			.getByRole("listitem")
			.filter({ hasText: "Test" })
			.getByRole("button", { name: "Disable model", exact: true }),
	).toBeVisible();
	await expect(
		dialog
			.getByRole("list", { name: "Enabled models" })
			.getByRole("listitem")
			.filter({ hasText: "Test" }),
	).toContainText("Default");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await page.unroute("**/api/model-catalog");
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(
		dialog.getByRole("listbox", { name: "Popular models" }).getByRole("option"),
	).toHaveCount(1);
});

test("ranking changes preserve selected default and historical model outside top 100", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Ranked", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "History" },
		})
	).json();
	await page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { prompt: "remember", modelId: "test", reasoningEffort: "high" },
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	app.setCatalog([
		{ id: "second", name: "Second" },
		{
			id: "test",
			name: "Test",
			reasoning: { supported_efforts: ["low", "high"] },
		},
	]);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	await dialog.getByRole("button", { name: "Add model", exact: true }).click();
	await dialog
		.getByRole("option", { name: "Second second", exact: true })
		.click();
	await expect(
		dialog.getByRole("list", { name: "Enabled models" }).getByRole("listitem"),
	).toHaveText(["TesttestDefault×", "SecondsecondSet default×"]);
	await expect(
		dialog
			.getByRole("list", { name: "Enabled models" })
			.getByRole("listitem")
			.filter({ hasText: "Test" }),
	).toContainText("Default");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	app.setCatalog(
		Array.from({ length: 100 }, (_, i) => ({
			id: `rank-${i}`,
			name: `Rank ${i}`,
		})),
	);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await dialog.getByRole("button", { name: "Add model", exact: true }).click();
	await expect(
		dialog.getByRole("listbox", { name: "Popular models" }).getByRole("option"),
	).toHaveCount(100);
	await expect(
		dialog
			.getByRole("list", { name: "Enabled models" })
			.getByRole("listitem")
			.filter({ hasText: "Test" })
			.getByRole("button", { name: "Disable model", exact: true }),
	).toBeVisible();
	await expect(dialog.getByText(/Not found in latest catalog/)).toHaveCount(0);
	await expect(
		dialog
			.getByRole("list", { name: "Enabled models" })
			.getByRole("listitem")
			.filter({ hasText: "Test" }),
	).toContainText("Default");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await page.reload();
	await expect(
		page.getByRole("combobox", { name: "Model", exact: true }),
	).toHaveValue("test");
	await expect(
		page.getByRole("combobox", { name: "Reasoning level", exact: true }),
	).toHaveValue("high");
});

test("row removal failures preserve default and composer, successful removal replaces only the global default", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Rows", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Draft" },
		})
	).json();
	await page.request.post(`${app.url}/api/model-catalog`);
	await page.request.post(`${app.url}/api/models`, { data: { id: "second" } });
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const model = page.getByRole("combobox", { name: "Model", exact: true });
	await page
		.getByRole("combobox", { name: "Reasoning level", exact: true })
		.selectOption("high");
	await page.getByLabel("Prompt", { exact: true }).fill("Keep draft");
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	const rows = dialog
		.getByRole("list", { name: "Enabled models" })
		.getByRole("listitem");
	const first = rows.filter({ hasText: "Test" });
	const second = rows.filter({ hasText: "Second" });
	await second
		.getByRole("button", { name: "Set default", exact: true })
		.click();
	await expect(second).toContainText("Default");
	await expect(model).toHaveValue("test");
	await first.getByRole("button", { name: "Set default", exact: true }).click();
	await expect(first).toContainText("Default");
	await page.route("**/api/models/test", (route) =>
		route.fulfill({ status: 500, json: {} }),
	);
	await first
		.getByRole("button", { name: "Disable model", exact: true })
		.click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Unable to save model settings. Please retry.",
	);
	await expect(rows).toHaveCount(2);
	await expect(first).toContainText("Default");
	await expect(model).toHaveValue("test");
	await expect(
		page.getByRole("combobox", { name: "Reasoning level", exact: true }),
	).toHaveValue("high");
	await page.unroute("**/api/models/test");
	await first
		.getByRole("button", { name: "Disable model", exact: true })
		.click();
	await expect(rows).toHaveCount(1);
	await expect(second).toContainText("Default");
	await expect(model).toHaveValue("");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(
		page.getByRole("combobox", { name: "Reasoning level", exact: true }),
	).toBeHidden();
	await expect(
		page.getByRole("button", { name: "Submit", exact: true }),
	).toBeDisabled();
	await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
		"Keep draft",
	);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await second
		.getByRole("button", { name: "Disable model", exact: true })
		.click();
	await expect(rows).toHaveCount(0);
	await expect(
		dialog.getByRole("button", { name: "Close", exact: true }),
	).toBeDisabled();
});
