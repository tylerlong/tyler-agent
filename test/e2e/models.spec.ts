import {
	chatPicker,
	expectEffort,
	expectModel,
	selectEffort,
} from "./chat-picker.ts";
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
	await expect(close).toBeEnabled();
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
	const filter = settings.getByRole("combobox", {
		name: "Search models by name or ID",
	});
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
	await settings.getByRole("heading", { name: "Models", exact: true }).click();
	await expect(close).toBeEnabled();
	await expect(filter).toBeEnabled();
	await filter.focus();
	await settings
		.getByRole("option", { name: "Second second", exact: true })
		.click();
	await expect(close).toBeEnabled();
	await close.click();
	await expectModel(page, "second");
	await page.getByLabel("Prompt", { exact: true }).fill("Recovered setup");
	await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
	await expect(page.getByRole("log")).toContainText("Test answer");
});

test("settings populate credentials, synchronize clean peers and persist across restart", async ({
	page,
	app,
}) => {
	const peer = await page.context().newPage();
	await page.goto(app.url);
	await peer.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "Models", exact: true }).click();
	await peer.getByRole("button", { name: "Settings", exact: true }).click();
	await peer.getByRole("tab", { name: "Models", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	const key = dialog.getByLabel("OpenRouter API key", { exact: true });
	await expect(key).toHaveAttribute("type", "password");
	await expect(key).toHaveValue("zkey");
	await key.fill("replacement-secret");
	await dialog.getByRole("heading", { name: "Models", exact: true }).click();
	await expect(
		dialog
			.getByRole("region", { name: "Credentials", exact: true })
			.getByRole("status"),
	).toHaveText("Saved");
	await expect(key).toHaveValue("replacement-secret");
	await expect(
		peer.getByLabel("OpenRouter API key", { exact: true }),
	).toHaveValue("replacement-secret");
	const settings = await page.request.get(`${app.url}/api/model-settings`);
	expect(await settings.text()).not.toContain("replacement-secret");
	await expect(
		dialog.getByRole("button", { name: "Save API key", exact: true }),
	).toHaveCount(0);
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
	await app.restart();
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "Models", exact: true }).click();
	await expect(key).toHaveValue("replacement-secret");
	await key.fill("");
	await dialog.getByRole("heading", { name: "Models", exact: true }).click();
	await expect(
		dialog.getByText("Not configured", { exact: true }),
	).toBeVisible();
	await app.restart();
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "Models", exact: true }).click();
	await expect(key).toHaveValue("");
	await expect(
		dialog.getByText("Not configured", { exact: true }),
	).toBeVisible();
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
	await page.getByRole("tab", { name: "Models", exact: true }).click();
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
	await dialog.getByRole("heading", { name: "Models", exact: true }).click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Unable to save API key. Please retry.",
	);
	await expect(
		dialog.getByLabel("OpenRouter API key", { exact: true }),
	).toHaveValue("retry-secret");
	await page.unroute("**/api/model-settings");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeHidden();
	await page.route("**/api/model-catalog", (route) =>
		route.fulfill({ status: 500, json: {} }),
	);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "Models", exact: true }).click();
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
	await page.getByRole("tab", { name: "Models", exact: true }).click();
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
	await page.getByRole("tab", { name: "Models", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	const add = dialog.getByRole("button", { name: "Add model", exact: true });
	await expect(
		dialog.getByRole("combobox", { name: "Search models by name or ID" }),
	).toHaveCount(0);
	await add.click();
	const filter = dialog.getByRole("combobox", {
		name: "Search models by name or ID",
	});
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
		dialog.getByText(
			"No matching models among the 100 most popular models. Enabled models are excluded.",
		),
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
	await page.getByRole("tab", { name: "Models", exact: true }).click();
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
	await page.getByRole("tab", { name: "Models", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	await expect(
		dialog.getByText(
			"Unable to load popular models. Close and reopen Settings, or reload the page if Settings cannot close, to retry.",
		),
	).toBeVisible();
	await dialog.getByRole("button", { name: "Add model", exact: true }).click();
	await expect(
		dialog.getByText(
			"No matching models among the 100 most popular models. Enabled models are excluded.",
		),
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
	await page.getByRole("tab", { name: "Models", exact: true }).click();
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
	await page.request.put(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", reasoningEffort: "high" },
	});
	await page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { prompt: "remember" },
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
	await page.getByRole("tab", { name: "Models", exact: true }).click();
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
	await page.getByRole("tab", { name: "Models", exact: true }).click();
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
	await expectModel(page, "test");
	await expectEffort(page, "high");
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
	const _model = chatPicker(page);
	await selectEffort(page, "high");
	await page.getByLabel("Prompt", { exact: true }).fill("Keep draft");
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "Models", exact: true }).click();
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
	await expectModel(page, "test");
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
	await expectModel(page, "test");
	await expectEffort(page, "high");
	await page.unroute("**/api/models/test");
	await first
		.getByRole("button", { name: "Disable model", exact: true })
		.click();
	await expect(rows).toHaveCount(1);
	await expect(second).toContainText("Default");
	await expectModel(page, "");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(
		page.getByRole("combobox", { name: "Reasoning level", exact: true }),
	).toBeHidden();
	await expect(
		page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
	).toBeDisabled();
	await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
		"Keep draft",
	);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "Models", exact: true }).click();
	await second
		.getByRole("button", { name: "Disable model", exact: true })
		.click();
	await expect(rows).toHaveCount(0);
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeVisible();
});

test("Close waits for a failed default change and the next Close retries that exact action", async ({
	page,
	app,
}) => {
	await page.request.post(`${app.url}/api/model-catalog`);
	await page.request.post(`${app.url}/api/models`, { data: { id: "second" } });
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	await dialog.getByRole("tab", { name: "Models", exact: true }).click();
	const second = dialog
		.getByRole("list", { name: "Enabled models" })
		.getByRole("listitem")
		.filter({ hasText: "Second" });
	const writes: unknown[] = [];
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const failure = async (route: import("@playwright/test").Route) => {
		if (route.request().method() !== "PUT") return route.continue();
		writes.push(route.request().postDataJSON());
		await gate;
		await route.fulfill({ status: 500, json: {} });
	};
	await page.route("**/api/model-settings", failure);
	await second
		.getByRole("button", { name: "Set default", exact: true })
		.click();
	await expect.poll(() => writes.length).toBe(1);
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeVisible();
	expect(writes).toEqual([{ defaultModelId: "second" }]);
	release();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Unable to save model settings. Please retry.",
	);
	await expect(
		dialog.getByRole("button", { name: "Close", exact: true }),
	).toBeEnabled();
	await expect(dialog).toBeVisible();
	expect(writes).toHaveLength(1);
	await page.unroute("**/api/model-settings", failure);
	await page.route("**/api/model-settings", async (route) => {
		if (route.request().method() === "PUT")
			writes.push(route.request().postDataJSON());
		await route.continue();
	});
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeHidden();
	expect(writes).toEqual([
		{ defaultModelId: "second" },
		{ defaultModelId: "second" },
	]);
	expect(
		(await (await page.request.get(`${app.url}/api/model-settings`)).json())
			.defaultModelId,
	).toBe("second");
});

for (const action of ["default", "removal"] as const) {
	for (const addition of ["cancel", "success"] as const) {
		test(`${addition} addition retains a failed ${action} action for Close retry`, async ({
			page,
			app,
		}) => {
			app.setCatalog([
				{ id: "second", name: "Second" },
				{ id: "third", name: "Third" },
			]);
			await page.request.post(`${app.url}/api/model-catalog`);
			await page.request.post(`${app.url}/api/models`, {
				data: { id: "second" },
			});
			await page.goto(app.url);
			await page.getByRole("button", { name: "Settings", exact: true }).click();
			const dialog = page.getByRole("dialog", {
				name: "Settings",
				exact: true,
			});
			await dialog.getByRole("tab", { name: "Models", exact: true }).click();
			const second = dialog
				.getByRole("list", { name: "Enabled models" })
				.getByRole("listitem")
				.filter({ hasText: "Second" });
			const path =
				action === "default" ? "**/api/model-settings" : "**/api/models/second";
			const method = action === "default" ? "PUT" : "DELETE";
			let writes = 0;
			let fail = true;
			await page.route(path, async (route) => {
				if (route.request().method() !== method) return route.continue();
				writes++;
				if (fail) await route.fulfill({ status: 500, json: {} });
				else await route.continue();
			});
			await second
				.getByRole("button", {
					name: action === "default" ? "Set default" : "Disable model",
					exact: true,
				})
				.click();
			await expect(dialog.getByRole("alert")).toHaveText(
				"Unable to save model settings. Please retry.",
			);
			await dialog
				.getByRole("button", { name: "Add model", exact: true })
				.click();
			if (addition === "cancel")
				await dialog
					.getByRole("button", { name: "Cancel", exact: true })
					.click();
			else {
				await dialog.getByRole("combobox").fill("Third");
				await dialog
					.getByRole("option", { name: "Third third", exact: true })
					.click();
				await expect(
					dialog.getByRole("button", { name: "Add model", exact: true }),
				).toBeVisible();
			}
			await dialog.getByRole("button", { name: "Close", exact: true }).click();
			await expect.poll(() => writes).toBe(2);
			await expect(
				dialog.getByRole("button", { name: "Close", exact: true }),
			).toBeEnabled();
			await expect(dialog).toBeVisible();
			fail = false;
			await dialog.getByRole("button", { name: "Close", exact: true }).click();
			await expect(dialog).toBeHidden();
			expect(writes).toBe(3);
			const saved = await (
				await page.request.get(`${app.url}/api/model-settings`)
			).json();
			if (action === "default") expect(saved.defaultModelId).toBe("second");
			else
				expect(
					saved.models.some((model: { id: string }) => model.id === "second"),
				).toBe(false);
		});
	}
}

for (const scenario of [
	"independent default",
	"multiple removals",
	"newer default",
	"removed default",
	"superseded retry",
	"addition failure",
]) {
	test(`Close retains or supersedes model failures: ${scenario}`, async ({
		page,
		app,
	}) => {
		app.setCatalog([
			{ id: "second", name: "Second" },
			{ id: "third", name: "Third" },
			{ id: "fourth", name: "Fourth" },
		]);
		await page.request.post(`${app.url}/api/model-catalog`);
		for (const id of ["second", "third"])
			await page.request.post(`${app.url}/api/models`, { data: { id } });
		await page.goto(app.url);
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
		await dialog.getByRole("tab", { name: "Models", exact: true }).click();
		const row = (name: string) =>
			dialog
				.getByRole("list", { name: "Enabled models" })
				.getByRole("listitem")
				.filter({ hasText: name });
		let failing = true;
		const writes: string[] = [];
		await page.route("**/api/**", async (route) => {
			const request = route.request();
			const path = new URL(request.url()).pathname;
			const mutation =
				(path === "/api/model-settings" && request.method() === "PUT") ||
				(path.startsWith("/api/models/") && request.method() === "DELETE") ||
				(path === "/api/models" && request.method() === "POST");
			if (!mutation) return route.continue();
			const identity = path + (request.postData() ?? "");
			writes.push(identity);
			const fail =
				scenario === "independent default"
					? request.method() === "DELETE"
					: scenario === "removed default"
						? request.method() === "PUT"
						: true;
			if (
				(failing && fail) ||
				(scenario === "superseded retry" && request.method() === "PUT")
			)
				await route.fulfill({ status: 500, json: {} });
			else await route.continue();
		});
		const remove = async (name: string) => {
			await row(name)
				.getByRole("button", { name: "Disable model", exact: true })
				.click();
			await expect(
				dialog.getByRole("button", { name: "Add model", exact: true }),
			).toBeEnabled();
		};
		const makeDefault = async (name: string) => {
			await row(name)
				.getByRole("button", { name: "Set default", exact: true })
				.click();
			await expect(
				dialog.getByRole("button", { name: "Add model", exact: true }),
			).toBeEnabled();
		};
		if (
			scenario === "newer default" ||
			scenario === "removed default" ||
			scenario === "superseded retry"
		)
			await makeDefault("Second");
		else await remove("Second");
		await expect(dialog.getByRole("alert").first()).toHaveText(
			"Unable to save model settings. Please retry.",
		);
		const first = writes[0];
		if (scenario === "independent default") await makeDefault("Third");
		if (scenario === "multiple removals") await remove("Third");
		if (scenario === "newer default") await makeDefault("Third");
		if (scenario === "removed default" || scenario === "superseded retry")
			await remove("Second");
		if (scenario === "addition failure") {
			await dialog
				.getByRole("button", { name: "Add model", exact: true })
				.click();
			await dialog.getByRole("combobox").fill("Fourth");
			await dialog
				.getByRole("option", { name: "Fourth fourth", exact: true })
				.click();
			await expect(dialog.getByRole("alert")).toHaveCount(2);
		}
		const second = writes[1];
		failing = false;
		await dialog.getByRole("button", { name: "Close", exact: true }).click();
		await expect(dialog).toBeHidden();
		if (scenario === "independent default")
			expect(writes).toEqual([first, second, first]);
		if (
			scenario === "multiple removals" ||
			scenario === "addition failure" ||
			scenario === "superseded retry"
		)
			expect(writes).toEqual([first, second, first, second]);
		if (scenario === "newer default")
			expect(writes).toEqual([first, second, second]);
		if (scenario === "removed default") expect(writes).toEqual([first, second]);
		const saved = await (
			await page.request.get(`${app.url}/api/model-settings`)
		).json();
		if (scenario === "independent default" || scenario === "newer default")
			expect(saved.defaultModelId).toBe("third");
		if (scenario !== "newer default")
			expect(
				saved.models.some((model: { id: string }) => model.id === "second"),
			).toBe(false);
		if (scenario === "multiple removals")
			expect(
				saved.models.some((model: { id: string }) => model.id === "third"),
			).toBe(false);
		if (scenario === "addition failure")
			expect(
				saved.models.some((model: { id: string }) => model.id === "fourth"),
			).toBe(true);
	});
}
