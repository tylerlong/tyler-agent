import { expect, test } from "./fixtures.ts";
import { expectModel, selectModel, turnPicker } from "./turn-picker.ts";

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
	const _model = turnPicker(page);
	const peerModel = turnPicker(peer);
	await expectModel(page, "");
	await expectModel(peer, "");
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
	await expectModel(page, "second");
	await expect(peerModel).toBeEnabled();
	await expectModel(peer, "");
	await expect(
		page.getByRole("combobox", { name: "Reasoning level" }),
	).toHaveCount(0);
	await expect(
		settings.getByRole("list", { name: "Enabled models" }),
	).toContainText("Default");
});

test("first addition initializes its composer before a delayed historical read completes", async ({
	page,
	app,
}) => {
	const [id] = await chats(page, app.url);
	await page.request.post(`${app.url}/api/chats/${id}`, {
		data: { modelId: "test", reasoningEffort: "high", prompt: "History" },
	});
	await page.request.delete(`${app.url}/api/models/test`);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(`**/api/chats/${id}`, async (route) => {
		const response = await route.fetch();
		await gate;
		await route.fulfill({ response });
	});
	await page.goto(`${app.url}/?chat=${id}`);
	const settings = page.getByRole("dialog", { name: "Settings", exact: true });
	await settings
		.getByRole("button", { name: "Add model", exact: true })
		.click();
	await settings
		.getByRole("option", { name: "Second second", exact: true })
		.click();
	await expect(
		settings.getByRole("button", { name: "Add model", exact: true }),
	).toBeEnabled();
	release();
	await expect(page.getByRole("log", { name: "Chat history" })).toContainText(
		"History",
	);
	await expectModel(page, "second");
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
		const model = turnPicker(page);
		await expectModel(page, "");
		const peer = await page.context().newPage();
		await peer.goto(`${app.url}/?chat=${second}`);
		await expectModel(peer, "");
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
		// Membership is committed by SSE while the initiating save is still pending.
		await expect(model).toBeEnabled();
		// Native cancellation must be isolated even if the disabled option lost focus.
		expect(
			await settings.evaluate((element) =>
				element.dispatchEvent(new Event("cancel", { cancelable: true })),
			),
		).toBe(false);
		// A disabled focused option can leave focus on the document on Chromium/Linux.
		await page.evaluate(() => {
			if (document.activeElement instanceof HTMLElement)
				document.activeElement.blur();
		});
		await page.keyboard.press("Escape");
		await expect(settings).toBeVisible();
		// The committed membership arrives by SSE while its initiating response is held.
		await expect(model).toBeEnabled();
		await settings.getByRole("button", { name: "Close", exact: true }).click();
		if (action === "navigation") {
			await page.goBack();
			await expect(page).toHaveURL(`${app.url}/?chat=${first}`);
			await expectModel(page, "");
			await page.goForward();
			await expect(page).toHaveURL(`${app.url}/?chat=${second}`);
		} else {
			await selectModel(page, "second");
		}
		release();
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await expect(
			settings.getByRole("button", { name: "Add model", exact: true }),
		).toBeEnabled();
		await settings.getByRole("button", { name: "Close", exact: true }).click();
		await expectModel(page, action === "selection" ? "second" : "");
		if (action === "navigation") {
			await page.goBack();
			await expect(page).toHaveURL(`${app.url}/?chat=${first}`);
			await expectModel(page, "");
		}
		await expectModel(peer, "");
	});
}
