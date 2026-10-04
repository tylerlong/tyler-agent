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
				missing: "未配置",
				remove: "移除 API 密钥",
				close: "关闭",
				language: "语言",
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
				missing: "Not configured",
				remove: "Remove API key",
				close: "Close",
				language: "Language",
				models: "Models",
				error: "Unable to save API key. Please retry.",
			};
	test(`credential states and blank submission guard (${chinese ? "zh" : "en"})`, async ({
		page,
		app,
	}) => {
		await page.setViewportSize({ width: 1280, height: 720 });
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
		const credentials = dialog.getByRole("region", {
			name: chinese ? "凭据" : "Credentials",
			exact: true,
		});
		const key = dialog.getByLabel(words.key, { exact: true });
		const save = dialog.getByRole("button", { name: words.save, exact: true });
		let writes = 0;
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route("**/api/model-settings", async (route) => {
			if (route.request().method() !== "PUT") return route.continue();
			writes++;
			await gate;
			await route.continue();
		});
		if (process.env.SETTINGS_SCREENSHOTS)
			await mkdir("/tmp/tyler-agent-79-evidence", { recursive: true });
		if (process.env.SETTINGS_SCREENSHOTS)
			await page.screenshot({
				path: `/tmp/tyler-agent-79-evidence/settings-normal-${chinese ? "zh" : "en"}.png`,
			});
		await dialog
			.getByRole("button", {
				name: chinese ? "添加模型" : "Add model",
				exact: true,
			})
			.click();
		await expect(dialog.getByRole("listbox").getByRole("option")).toHaveCount(
			1,
		);
		if (process.env.SETTINGS_SCREENSHOTS)
			await page.screenshot({
				path: `/tmp/tyler-agent-79-evidence/settings-expanded-${chinese ? "zh" : "en"}.png`,
			});
		await page.keyboard.press("Escape");
		await expect(save).toBeDisabled();
		await key.fill("   ");
		await expect(save).toBeDisabled();
		await key.press("Enter");
		await key.evaluate((element) =>
			(element as HTMLInputElement).form?.requestSubmit(),
		);
		expect(writes).toBe(0);
		await key.fill("replacement-secret");
		await save.click();
		await expect(
			dialog.getByRole("button", { name: words.saving, exact: true }),
		).toBeDisabled();
		await expect(key).toBeDisabled();
		await expect(
			dialog.getByRole("button", { name: words.remove, exact: true }),
		).toBeDisabled();
		release();
		await expect(key).toHaveValue("");
		await expect(credentials.getByRole("status")).toHaveText(words.saved);
		expect(writes).toBe(1);
		await page.unroute("**/api/model-settings");
		await key.fill("unsaved-draft");
		await page.route("**/api/model-settings", (route) =>
			route.request().method() === "PUT"
				? route.fulfill({ status: 500, json: {} })
				: route.continue(),
		);
		await save.click();
		await expect(credentials.getByRole("alert")).toHaveText(words.error);
		if (process.env.SETTINGS_SCREENSHOTS)
			await page.screenshot({
				path: `/tmp/tyler-agent-79-evidence/settings-failure-${chinese ? "zh" : "en"}.png`,
			});
		await expect(
			credentials.getByText(words.configured, { exact: true }),
		).toBeVisible();
		await expect(key).toHaveValue("unsaved-draft");
		await dialog
			.getByRole("button", { name: words.remove, exact: true })
			.click();
		await expect(credentials.getByRole("alert")).toHaveText(words.error);
		await expect(key).toHaveValue("unsaved-draft");
		await page.unroute("**/api/model-settings");
		await dialog
			.getByRole("button", { name: words.remove, exact: true })
			.click();
		await expect(
			credentials.getByText(words.missing, { exact: true }),
		).toBeVisible();
		await expect(key).toHaveValue("unsaved-draft");
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
		await expect(
			dialog.getByRole("heading", { name: words.models, exact: true }),
		).toBeVisible();
		await expect(dialog.getByRole("alert")).toBeVisible();
		for (const size of [
			{ width: 1280, height: 720 },
			{ width: 1600, height: 1000 },
		]) {
			await page.setViewportSize(size);
			await dialog.locator(".settings-content").evaluate((element) => {
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
	await dialog
		.getByRole("button", { name: "Save API key", exact: true })
		.click();
	await expect(
		dialog.getByText("Enable at least one model to use this chat.", {
			exact: true,
		}),
	).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "Close", exact: true }),
	).toBeDisabled();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeVisible();
});
