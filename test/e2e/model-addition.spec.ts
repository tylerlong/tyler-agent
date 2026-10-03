import { expect, test } from "./fixtures.ts";

async function chats(page: import("@playwright/test").Page, url: string) {
	const project = await (
		await page.request.post(`${url}/api/projects`, {
			data: { name: "Addition", folders: [] },
		})
	).json();
	const first = await (
		await page.request.post(`${url}/api/projects/${project.id}/chats`, {
			data: { name: "First" },
		})
	).json();
	const second = await (
		await page.request.post(`${url}/api/projects/${project.id}/chats`, {
			data: { name: "Other" },
		})
	).json();
	return [first.id, second.id] as number[];
}

test("first addition fills the initiating empty composer even with history; passive windows stay empty", async ({
	page,
	app,
}) => {
	const [id] = await chats(page, app.url);
	await page.request.post(`${app.url}/api/chats/${id}`, {
		data: { modelId: "test", reasoningEffort: "high", prompt: "History" },
	});
	await page.request.delete(`${app.url}/api/models/test`);
	await page.goto(`${app.url}/?chat=${id}`);
	const peer = await page.context().newPage();
	await peer.goto(`${app.url}/?chat=${id}`);
	const model = page.getByRole("combobox", { name: "Model", exact: true });
	const peerModel = peer.getByRole("combobox", { name: "Model", exact: true });
	await expect(model).toHaveValue("");
	await expect(peerModel).toHaveValue("");
	const settings = page.getByRole("dialog", { name: "Settings", exact: true });
	await settings
		.getByRole("button", { name: "Add model", exact: true })
		.click();
	await settings
		.getByRole("option", { name: "Second second", exact: true })
		.click();
	await expect(
		settings.getByRole("button", { name: "Add model", exact: true }),
	).toBeFocused();
	await expect(model).toHaveValue("second");
	await expect(peerModel).toBeEnabled();
	await expect(peerModel).toHaveValue("");
	await expect(
		page.getByRole("combobox", { name: "Reasoning level" }),
	).toHaveCount(0);
	await expect(
		settings.getByRole("list", { name: "Enabled models" }),
	).toContainText("Default");
});

for (const action of ["navigation", "selection"] as const) {
	test(`delayed first-add completion preserves later ${action}`, async ({
		page,
		app,
	}) => {
		const [first, second] = await chats(page, app.url);
		await page.goto(`${app.url}/?chat=${first}`);
		await page.getByRole("button", { name: "Other", exact: true }).click();
		await expect(page).toHaveURL(`${app.url}/?chat=${second}`);
		await page.request.delete(`${app.url}/api/models/test`);
		const model = page.getByRole("combobox", { name: "Model", exact: true });
		await expect(model).toHaveValue("");
		const peer = await page.context().newPage();
		await peer.goto(`${app.url}/?chat=${second}`);
		await expect(
			peer.getByRole("combobox", { name: "Model", exact: true }),
		).toHaveValue("");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route("**/api/models", async (route) => {
			const response = await route.fetch();
			await gate;
			await route.fulfill({ response });
		});
		const settings = page.getByRole("dialog", {
			name: "Settings",
			exact: true,
		});
		await settings
			.getByRole("button", { name: "Add model", exact: true })
			.click();
		await settings
			.getByRole("option", { name: "Second second", exact: true })
			.click();
		await expect(
			settings.getByRole("button", { name: "Cancel", exact: true }),
		).toBeDisabled();
		await page.keyboard.press("Escape");
		await expect(settings).toBeVisible();
		// The committed membership arrives by SSE while its initiating response is held.
		await expect(model).toBeEnabled();
		await settings.getByRole("button", { name: "Close", exact: true }).click();
		if (action === "navigation") {
			await page.goBack();
			await expect(page).toHaveURL(`${app.url}/?chat=${first}`);
			await expect(model).toHaveValue("");
			await page.goForward();
			await expect(page).toHaveURL(`${app.url}/?chat=${second}`);
		} else {
			await model.selectOption("second");
			await model.selectOption("");
		}
		release();
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await expect(
			settings.getByRole("button", { name: "Add model", exact: true }),
		).toBeEnabled();
		await settings.getByRole("button", { name: "Close", exact: true }).click();
		await expect(model).toHaveValue("");
		if (action === "navigation") {
			await page.goBack();
			await expect(page).toHaveURL(`${app.url}/?chat=${first}`);
			await expect(model).toHaveValue("");
		}
		await expect(
			peer.getByRole("combobox", { name: "Model", exact: true }),
		).toHaveValue("");
	});
}
