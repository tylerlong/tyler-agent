import { mkdir } from "node:fs/promises";
import { expect, test } from "./fixtures.ts";

for (const chinese of [false, true]) {
	const words = chinese
		? {
				settings: "设置",
				key: "OpenRouter API 密钥",
				save: "保存 API 密钥",
				saving: "保存中…",
				saved: "已保存",
				configured: "已配置",
				remove: "移除 API 密钥",
				close: "关闭",
				language: "语言",
				general: "常规",
				execution: "执行",
				models: "模型",
				error: "保存 API 密钥失败，请重试。",
			}
		: {
				settings: "Settings",
				key: "OpenRouter API key",
				save: "Save API key",
				saving: "Saving…",
				saved: "Saved",
				configured: "Configured",
				remove: "Remove API key",
				close: "Close",
				language: "Language",
				general: "General",
				execution: "Execution",
				models: "Models",
				error: "Unable to save API key. Please retry.",
			};
	test(`credential autosaves replacement and clearing (${chinese ? "zh" : "en"})`, async ({
		page,
		app,
	}) => {
		if (chinese)
			await page.request.put(`${app.url}/api/language`, {
				data: { language: "zh-CN" },
			});
		await page.goto(app.url);
		await page
			.getByRole("button", { name: words.settings, exact: true })
			.click();
		const dialog = page.getByRole("dialog", {
			name: words.settings,
			exact: true,
		});
		await dialog.getByRole("tab", { name: words.models, exact: true }).click();
		const credentials = dialog.getByRole("region", {
			name: chinese ? "凭据" : "Credentials",
			exact: true,
		});
		const key = dialog.getByLabel(words.key, { exact: true });
		await expect(key).toHaveAttribute("type", "password");
		await expect(key).toHaveValue("zkey");
		await expect(
			credentials.getByText(words.configured, { exact: true }),
		).toHaveCount(0);
		const inputBox = await key.boundingBox();
		const modelsBox = await dialog
			.getByRole("heading", { name: words.models, exact: true })
			.boundingBox();
		if (!inputBox || !modelsBox) throw new Error("Missing settings fields");
		expect(modelsBox.y - inputBox.y - inputBox.height).toBeLessThan(100);
		await expect(
			dialog.getByRole("button", { name: words.save, exact: true }),
		).toHaveCount(0);
		await expect(
			dialog.getByRole("button", { name: words.remove, exact: true }),
		).toHaveCount(0);
		let writes = 0;
		await page.route("**/api/model-settings", async (route) => {
			if (route.request().method() === "PUT") writes++;
			await route.continue();
		});
		await key.click();
		await dialog
			.getByRole("heading", { name: words.models, exact: true })
			.click();
		expect(writes).toBe(0);
		await key.fill("replacement-secret");
		expect(writes).toBe(0);
		await dialog
			.getByRole("heading", { name: words.models, exact: true })
			.click();
		await expect(credentials.getByRole("status")).toHaveText(words.saved);
		await expect(key).toHaveValue("replacement-secret");
		expect(
			(
				await dialog
					.getByRole("heading", { name: words.models, exact: true })
					.boundingBox()
			)?.y,
		).toBe(modelsBox.y);
		expect(writes).toBe(1);
		if (process.env.SETTINGS_SCREENSHOTS) {
			await mkdir("/tmp/tyler-agent-122-evidence", { recursive: true });
			await page.screenshot({
				path: `/tmp/tyler-agent-122-evidence/credential-saved-${chinese ? "zh" : "en"}.png`,
			});
		}
		const failure = async (route: import("@playwright/test").Route) => {
			if (route.request().method() === "PUT")
				await route.fulfill({ status: 500, json: {} });
			else await route.fallback();
		};
		await page.route("**/api/model-settings", failure);
		await key.fill("failed-secret");
		await dialog
			.getByRole("heading", { name: words.models, exact: true })
			.click();
		await expect(credentials.getByRole("alert")).toHaveText(words.error);
		await expect(key).toHaveValue("failed-secret");
		if (process.env.SETTINGS_SCREENSHOTS)
			await page.screenshot({
				path: `/tmp/tyler-agent-122-evidence/credential-failure-${chinese ? "zh" : "en"}.png`,
			});
		await page.unroute("**/api/model-settings", failure);
		await key.fill("");
		await dialog
			.getByRole("heading", { name: words.models, exact: true })
			.click();
		await expect(credentials.getByRole("status")).toHaveText(words.saved);
		await expect(key).toHaveValue("");
		expect(writes).toBe(2);
	});

	test(`fixed Settings actions with long models and notices (${chinese ? "zh" : "en"})`, async ({
		page,
		app,
	}) => {
		const models = Array.from({ length: 14 }, (_, index) => ({
			id: `model-${index}-${"id".repeat(55)}`,
			name: `Model ${index} ${"long name ".repeat(15)}`,
		}));
		app.setCatalog(models);
		await page.request.post(`${app.url}/api/model-catalog`);
		for (const model of models)
			await page.request.post(`${app.url}/api/models`, {
				data: { id: model.id },
			});
		if (chinese)
			await page.request.put(`${app.url}/api/language`, {
				data: { language: "zh-CN" },
			});
		await page.route("**/api/model-catalog", (route) =>
			route.fulfill({ status: 500, json: {} }),
		);
		await page.goto(app.url);
		await page
			.getByRole("button", { name: words.settings, exact: true })
			.click();
		const dialog = page.getByRole("dialog", {
			name: words.settings,
			exact: true,
		});
		await expect(
			dialog.getByRole("heading", { name: words.language, exact: true }),
		).toBeVisible();
		await dialog.getByRole("tab", { name: words.models, exact: true }).click();
		await expect(
			dialog.getByRole("heading", { name: words.models, exact: true }),
		).toBeVisible();
		await expect(dialog.getByRole("alert")).toBeVisible();
		for (const size of [
			{ width: 1280, height: 720 },
			{ width: 1600, height: 1000 },
		]) {
			await page.setViewportSize(size);
			const bounds = await dialog.boundingBox();
			for (const tab of [words.general, words.execution, words.models]) {
				await dialog.getByRole("tab", { name: tab, exact: true }).click();
				expect(await dialog.boundingBox()).toEqual(bounds);
				if (process.env.SETTINGS_SCREENSHOTS) {
					await mkdir("/tmp/tyler-agent-121-evidence", { recursive: true });
					await page.screenshot({
						path: `/tmp/tyler-agent-121-evidence/${chinese ? "zh" : "en"}-${tab}-${size.width}.png`,
					});
				}
			}
			await dialog.locator(".settings-content:visible").evaluate((element) => {
				element.scrollTop = element.scrollHeight;
			});
			const heading = await dialog
				.getByRole("heading", { name: words.settings, exact: true })
				.boundingBox();
			const close = await dialog
				.getByRole("button", { name: words.close, exact: true })
				.boundingBox();
			if (!heading || !close) throw new Error("Missing dialog controls");
			expect(heading.y).toBeGreaterThan(0);
			expect(close.y + close.height).toBeLessThan(size.height);
			expect(
				await dialog.evaluate(
					(element) => element.scrollWidth <= element.clientWidth,
				),
			).toBe(true);
			if (process.env.SETTINGS_SCREENSHOTS)
				await mkdir("/tmp/tyler-agent-79-evidence", { recursive: true });
			if (process.env.SETTINGS_SCREENSHOTS)
				await page.screenshot({
					path: `/tmp/tyler-agent-79-evidence/settings-${chinese ? "zh" : "en"}-${size.width}.png`,
				});
		}
	});
}

test("required Settings identifies missing key, models and both", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Setup", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Setup" },
		})
	).json();
	await page.request.put(`${app.url}/api/model-settings`, {
		data: { removeApiKey: true },
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	await expect(
		dialog.getByRole("tab", { name: "Models", exact: true }),
	).toHaveAttribute("aria-selected", "true");
	await expect(
		dialog.getByText("An API key is required to use this chat.", {
			exact: true,
		}),
	).toBeVisible();
	await page.request.delete(`${app.url}/api/models/test`);
	await expect(
		dialog.getByText(
			"An API key and at least one enabled model are required to use this chat.",
			{ exact: true },
		),
	).toBeVisible();
	await dialog
		.getByLabel("OpenRouter API key", { exact: true })
		.fill("new-secret");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(
		dialog.getByText("Enable at least one model to use this chat.", {
			exact: true,
		}),
	).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "Close", exact: true }),
	).toBeEnabled();
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeVisible();
});

test("tabs retain failed credential drafts and Close deliberately retries on the affected tab", async ({
	page,
	app,
}) => {
	let discoveries = 0;
	await page.route("**/api/model-catalog", async (route) => {
		discoveries++;
		await route.continue();
	});
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	const general = dialog.getByRole("tab", { name: "General", exact: true });
	const models = dialog.getByRole("tab", { name: "Models", exact: true });
	const execution = dialog.getByRole("tab", { name: "Execution", exact: true });
	await models.click();
	const key = dialog.getByLabel("OpenRouter API key", { exact: true });
	let writes = 0;
	await page.route("**/api/model-settings", async (route) => {
		if (route.request().method() !== "PUT") return route.continue();
		writes++;
		await route.fulfill({ status: 500, json: {} });
	});
	await key.fill("retained-draft");
	await execution.click();
	await expect(execution).toHaveAttribute("aria-selected", "true");
	await models.click();
	await expect(key).toHaveValue("retained-draft");
	await expect(dialog.getByRole("alert")).toHaveText(
		"Unable to save API key. Please retry.",
	);
	const synchronized = page.waitForResponse(
		(response) =>
			response.url().endsWith("/api/model-settings") &&
			response.request().method() === "GET",
	);
	await page.request.put(`${app.url}/api/model-settings`, {
		data: { apiKey: "peer-secret" },
	});
	await synchronized;
	await expect(key).toHaveValue("retained-draft");
	await expect(dialog.getByRole("alert")).toHaveText(
		"Unable to save API key. Please retry.",
	);
	await general.click();
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(models).toHaveAttribute("aria-selected", "true");
	await expect(dialog).toBeVisible();
	await expect(key).toHaveValue("retained-draft");
	expect(writes).toBe(2);
	expect(discoveries).toBe(1);
	if (process.env.SETTINGS_SCREENSHOTS) {
		await mkdir("/tmp/tyler-agent-122-evidence", { recursive: true });
		await page.screenshot({
			path: "/tmp/tyler-agent-122-evidence/credential-failure-en.png",
		});
	}
	await page.unroute("**/api/model-settings");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeHidden();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(general).toHaveAttribute("aria-selected", "true");
	await models.click();
	await expect(key).toHaveValue("retained-draft");
	await expect.poll(() => discoveries).toBe(2);
});

test("Close waits for a credential save and preserves a newer draft without duplicate writes", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	await dialog.getByRole("tab", { name: "Models", exact: true }).click();
	const key = dialog.getByLabel("OpenRouter API key", { exact: true });
	const writes: string[] = [];
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/model-settings", async (route) => {
		if (route.request().method() !== "PUT") return route.continue();
		writes.push(route.request().postDataJSON().apiKey);
		if (writes.length === 1) await gate;
		await route.continue();
	});
	await key.fill("first-secret");
	await dialog.getByRole("heading", { name: "Models", exact: true }).click();
	await expect.poll(() => writes.length).toBe(1);
	await expect(
		dialog
			.getByRole("region", { name: "Credentials", exact: true })
			.getByRole("status"),
	).toHaveText("Saving…");
	await expect(key).toBeEnabled();
	await key.fill("newer-secret");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeVisible();
	await expect(key).toHaveValue("newer-secret");
	expect(writes).toEqual(["first-secret"]);
	release();
	await expect(dialog).toBeHidden();
	expect(writes).toEqual(["first-secret", "newer-secret"]);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await dialog.getByRole("tab", { name: "Models", exact: true }).click();
	await expect(key).toHaveValue("newer-secret");
});

test("initial setup saves a still-focused first credential through Close before gating", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Initial", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Initial" },
		})
	).json();
	await page.request.put(`${app.url}/api/model-settings`, {
		data: { removeApiKey: true },
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	const key = dialog.getByLabel("OpenRouter API key", { exact: true });
	await key.fill("first-setup-secret");
	await expect(key).toBeFocused();
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeHidden();
	expect(
		await (await page.request.get(`${app.url}/api/settings/credential`)).json(),
	).toEqual({ apiKey: "first-setup-secret" });
});

test("backdrop waits for credential persistence and keeps a failed draft open", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	await dialog.getByRole("tab", { name: "Models", exact: true }).click();
	const key = dialog.getByLabel("OpenRouter API key", { exact: true });
	let writes = 0;
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/model-settings", async (route) => {
		if (route.request().method() !== "PUT") return route.continue();
		writes++;
		if (writes === 1) {
			await gate;
			await route.fulfill({ status: 500, json: {} });
		} else await route.continue();
	});
	await key.fill("failed-backdrop-secret");
	await page.mouse.click(1, 1);
	await expect.poll(() => writes).toBe(1);
	await expect(dialog).toBeVisible();
	release();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Unable to save API key. Please retry.",
	);
	await expect(key).toHaveValue("failed-backdrop-secret");
	await key.fill("corrected-backdrop-secret");
	await page.mouse.click(1, 1);
	await expect(dialog).toBeHidden();
	expect(writes).toBe(2);
	expect(
		await (await page.request.get(`${app.url}/api/settings/credential`)).json(),
	).toEqual({ apiKey: "corrected-backdrop-secret" });
});

test("Close hides the candidate portal while waiting for another tab to save", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let writes = 0;
	await page.route("**/api/execution-limits", async (route) => {
		if (route.request().method() !== "PATCH") return route.continue();
		writes++;
		await gate;
		await route.continue();
	});
	await dialog.getByRole("tab", { name: "Execution", exact: true }).click();
	await dialog.getByLabel("Model Calls per Agent", { exact: true }).fill("7");
	await dialog.getByRole("tab", { name: "Models", exact: true }).click();
	await expect.poll(() => writes).toBe(1);
	await dialog.getByRole("button", { name: "Add model", exact: true }).click();
	await expect(
		dialog.getByRole("listbox", { name: "Popular models", exact: true }),
	).toBeVisible();
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeVisible();
	await expect(
		dialog.getByRole("listbox", { name: "Popular models", exact: true }),
	).toHaveCount(0);
	expect(writes).toBe(1);
	release();
	await expect(dialog).toBeHidden();
	expect(writes).toBe(1);
});
