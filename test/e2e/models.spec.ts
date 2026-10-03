import { expect, test } from "./fixtures.ts";

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
	await dialog
		.getByRole("button", { name: "Save API key", exact: true })
		.click();
	await expect(
		dialog.getByText("API key configured. Leave empty to keep the saved key."),
	).toBeVisible();
	await dialog
		.getByRole("checkbox", { name: "Second second", exact: true })
		.check();
	await expect(peer.getByLabel("Default model")).toContainText("Second");
	await dialog.getByLabel("Default model").selectOption("second");
	await expect(peer.getByLabel("Default model")).toHaveValue("second");
	await dialog
		.getByRole("checkbox", { name: "Second second", exact: true })
		.uncheck();
	await expect(dialog.getByLabel("Default model")).toHaveValue("");
	await expect(peer.getByLabel("Default model")).toHaveValue("");
	await dialog
		.getByRole("button", { name: "Remove API key", exact: true })
		.click();
	await expect(dialog.getByText("No API key configured.")).toBeVisible();
	await app.restart();
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(page.getByText("No API key configured.")).toBeVisible();
	await expect(page.getByLabel("Default model")).toHaveValue("");
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
		"Unable to save model settings. Please retry.",
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
			"Unable to load popular models. Close and reopen Settings to retry.",
		),
	).toBeVisible();
	await expect(
		dialog.getByRole("checkbox", { name: "Second second", exact: true }),
	).toBeVisible();
	await page.unroute("**/api/model-catalog");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(
		dialog.getByText(
			"Unable to load popular models. Close and reopen Settings to retry.",
		),
	).toHaveCount(0);
	await expect(
		dialog.getByRole("checkbox", { name: "Second second", exact: true }),
	).toBeVisible();
});

test("each opening refreshes once, typing filters ranked rows locally and checkbox failures roll back", async ({
	page,
	app,
}) => {
	let calls = 0;
	await page.route("**/api/model-catalog", async (route) => {
		calls++;
		await route.continue();
	});
	await page.goto(app.url);
	await expect.poll(() => calls).toBe(0);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	await expect(dialog.getByRole("checkbox")).toHaveCount(2);
	expect(calls).toBe(1);
	await expect(
		dialog.getByRole("button", { name: /Search|Refresh/ }),
	).toHaveCount(0);
	const filter = dialog.getByRole("searchbox", { name: "Filter models" });
	await filter.fill("sEcOnD");
	await expect(dialog.getByRole("checkbox")).toHaveCount(1);
	await filter.fill("absent");
	await expect(
		dialog.getByText("No matching models in the top 100."),
	).toBeVisible();
	await filter.fill("second");
	await page.route("**/api/models", (route) =>
		route.fulfill({ status: 500, json: {} }),
	);
	const second = dialog.getByRole("checkbox", {
		name: "Second second",
		exact: true,
	});
	await second.click();
	await expect(
		dialog.getByText("Unable to save model settings. Please retry."),
	).toBeVisible();
	await expect(second).not.toBeChecked();
	await page.unroute("**/api/models");
	await second.check();
	await expect(second).toBeChecked();
	expect(calls).toBe(1);
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect.poll(() => calls).toBe(2);
	await expect(filter).toHaveValue("second");
	await expect(second).toBeChecked();
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
			"Unable to load popular models. Close and reopen Settings to retry.",
		),
	).toBeVisible();
	await expect(
		dialog.getByText("No matching models in the top 100."),
	).toHaveCount(0);
	await expect(
		dialog.getByRole("button", { name: "Remove model Test", exact: true }),
	).toBeVisible();
	await expect(dialog.getByLabel("Default model")).toHaveValue("test");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await page.unroute("**/api/model-catalog");
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(dialog.getByRole("checkbox")).toHaveCount(2);
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
	await dialog
		.getByRole("checkbox", { name: "Second second", exact: true })
		.check();
	await expect(dialog.getByLabel("Default model").locator("option")).toHaveText(
		["No default model", "Second", "Test"],
	);
	await expect(dialog.getByLabel("Default model")).toHaveValue("test");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	app.setCatalog(
		Array.from({ length: 100 }, (_, i) => ({
			id: `rank-${i}`,
			name: `Rank ${i}`,
		})),
	);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(dialog.getByRole("checkbox")).toHaveCount(100);
	await expect(
		dialog.getByRole("button", { name: "Remove model Test", exact: true }),
	).toBeVisible();
	await expect(dialog.getByText(/Not found in latest catalog/)).toHaveCount(0);
	await expect(dialog.getByLabel("Default model")).toHaveValue("test");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await page.reload();
	await expect(
		page.getByRole("combobox", { name: "Model", exact: true }),
	).toHaveValue("test");
	await expect(
		page.getByRole("combobox", { name: "Reasoning level", exact: true }),
	).toHaveValue("high");
});
