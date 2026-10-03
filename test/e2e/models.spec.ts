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
		.getByRole("button", { name: "Search models", exact: true })
		.click();
	await dialog
		.getByRole("button", { name: "Add model Second", exact: true })
		.click();
	await expect(peer.getByLabel("Default model")).toContainText("Second");
	await dialog.getByLabel("Default model").selectOption("second");
	await expect(peer.getByLabel("Default model")).toHaveValue("second");
	await dialog
		.getByRole("button", { name: "Remove model Second", exact: true })
		.click();
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

test("settings retain input on save failure and offer catalog retry", async ({
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
	await page.route("**/api/model-catalog", (route) =>
		route.fulfill({ status: 500, json: {} }),
	);
	await dialog
		.getByRole("button", { name: "Search models", exact: true })
		.click();
	await expect(
		dialog.getByText("Unable to read model catalog. Please retry."),
	).toBeVisible();
	await page.unroute("**/api/model-catalog");
	await dialog.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(
		dialog.getByRole("button", { name: "Add model Second", exact: true }),
	).toBeVisible();
});
