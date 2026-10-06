import {
	chatPicker,
	expectEffort,
	openChatPicker,
	selectEffort,
} from "./chat-picker.ts";
import { expect, test } from "./fixtures.ts";

test("desktop boundary preserves drafts, modal addition and focus without preference writes", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Desktop" },
		})
	).json();
	await page.setViewportSize({ width: 1280, height: 720 });
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const notice = page.getByRole("dialog", { name: "Enlarge your window" });
	const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
	await expect(notice).toBeHidden();
	await expect(chatPicker(page)).toContainText(" · Default");
	await expectEffort(page, "");
	await selectEffort(page, "high");
	await prompt.fill("Future draft");
	const writes: string[] = [];
	page.on("request", (request) => {
		if (
			request.method() === "PUT" &&
			request.url().endsWith("/api/sidebar-width")
		)
			writes.push(request.url());
	});
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const settings = page.getByRole("dialog", { name: "Settings", exact: true });
	await settings
		.getByLabel("OpenRouter API key", { exact: true })
		.fill("replacement draft");
	await settings
		.getByRole("button", { name: "Add model", exact: true })
		.click();
	const search = settings.getByRole("combobox", {
		name: "Search models by name or ID",
		exact: true,
	});
	await search.fill("Sec");
	for (const viewport of [
		{ width: 1279, height: 720 },
		{ width: 1280, height: 719 },
	]) {
		await page.setViewportSize(viewport);
		await expect(notice).toBeVisible();
		await expect(notice).toContainText("1280×720");
		await page.keyboard.press("Escape");
		await page.keyboard.press("Tab");
		expect(
			await notice.evaluate((el) => el.contains(document.activeElement)),
		).toBe(true);
		await settings
			.getByRole("button", { name: "Close", exact: true })
			.click({ timeout: 300 })
			.then(
				() => {
					throw new Error("Underlying dialog was interactive");
				},
				() => {},
			);
		await page.setViewportSize({ width: 1280, height: 720 });
		await expect(notice).toBeHidden();
		await expect(search).toHaveValue("Sec");
		await expect(search).toBeFocused();
		await expect(
			settings.getByLabel("OpenRouter API key", { exact: true }),
		).toHaveValue("replacement draft");
	}
	await search.press("Escape");
	await settings.getByRole("button", { name: "Close", exact: true }).click();
	await expect(prompt).toHaveValue("Future draft");
	await expectEffort(page, "high");
	await page.getByRole("button", { name: "New project", exact: true }).click();
	const create = page.getByRole("dialog", { name: "New project", exact: true });
	await create.getByLabel("Name", { exact: true }).fill("Project draft");
	await page.setViewportSize({ width: 1279, height: 720 });
	await expect(notice).toBeVisible();
	await page.setViewportSize({ width: 1600, height: 900 });
	await expect(create.getByLabel("Name", { exact: true })).toHaveValue(
		"Project draft",
	);
	await create.getByRole("button", { name: "Cancel", exact: true }).click();
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "zh-CN" },
	});
	await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
	await page.setViewportSize({ width: 1280, height: 719 });
	await expect(page.getByRole("dialog", { name: "请扩大窗口" })).toContainText(
		"1280×720",
	);
	expect(writes).toEqual([]);
});

test("running work finishes behind notice; maximum sidebar and long model keep composer usable", async ({
	page,
	app,
}) => {
	const longName = "A very long model display name ".repeat(12);
	app.setCatalog([
		{
			id: "test",
			name: longName,
			reasoning: { supported_efforts: ["low", "high"] },
		},
	]);
	await page.request.post(`${app.url}/api/model-catalog`);
	await page.request.put(`${app.url}/api/sidebar-width`, {
		data: { width: 600 },
	});
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Desktop" },
		})
	).json();
	await page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { prompt: "Long question\n".repeat(160), modelId: "test" },
	});
	await page.setViewportSize({ width: 1280, height: 720 });
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const prompt = page.getByLabel("Prompt", { exact: true });
	const send = page.getByRole("button", { name: /^Send(?: \(.+\))?$/ });
	const content = page.getByRole("region", { name: "Chat", exact: true });
	await prompt.fill("Second question");
	await expect(send).toBeInViewport();
	await expect(chatPicker(page)).toBeInViewport();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
		1280,
	);
	const hold = app.streamModel();
	await send.click();
	await hold.entered;
	try {
		await prompt.fill("Next draft\n".repeat(20));
		await selectEffort(page, "low");
		await content.evaluate((el) => {
			el.scrollTop = 100;
			el.dispatchEvent(new Event("scroll"));
		});
		const scroll = await content.evaluate((el) => el.scrollTop);
		await page.setViewportSize({ width: 1279, height: 720 });
		await expect(
			page.getByRole("dialog", { name: "Enlarge your window" }),
		).toBeVisible();
		hold.release();
		await expect
			.poll(
				async () =>
					(
						await (
							await page.request.get(`${app.url}/api/chats/${chat.id}`)
						).json()
					).busy,
			)
			.toBe(false);
		await page.setViewportSize({ width: 1280, height: 720 });
		await expect(prompt).toHaveValue("Next draft\n".repeat(20));
		await expectEffort(page, "low");
		await expect(page.getByRole("log")).toContainText("Test answer");
		await expect(send).toBeEnabled();
		expect(await content.evaluate((el) => el.scrollTop)).toBe(scroll);
	} finally {
		hold.release();
	}
	await page.setViewportSize({ width: 1600, height: 900 });
	await expect(send).toBeInViewport();
});

test("undersized notice isolates initial language loading and failure until recovery", async ({
	page,
	app,
}) => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/language", async (route) => {
		await gate;
		await route.fulfill({ status: 500, json: { code: "languageReadFailed" } });
	});
	await page.setViewportSize({ width: 1279, height: 720 });
	await page.goto(app.url);
	const notice = page.getByRole("dialog", { name: "Enlarge your window" });
	await expect(notice).toContainText("1280×720");
	release();
	await expect(page.getByRole("alert")).toContainText(
		"Unable to read language settings",
	);
	await expect(notice).toBeVisible();
	await page.setViewportSize({ width: 1280, height: 720 });
	await expect(notice).toBeHidden();
	await page.unroute("**/api/language");
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Settings", exact: true }),
	).toBeVisible();
});

test("combined picker remains bounded with a long enabled list and exposes Reasoning while models scroll", async ({
	page,
	app,
}) => {
	const longName = "Very long model name ".repeat(8);
	app.setCatalog(
		Array.from({ length: 30 }, (_, index) => ({
			id: index === 0 ? "test" : `extra-${index}`,
			name: index === 0 ? longName : `Extra ${index}`,
			reasoning: { supported_efforts: ["low", "high"] },
		})),
	);
	await page.request.post(`${app.url}/api/model-catalog`);
	for (let index = 1; index < 30; index++)
		await page.request.post(`${app.url}/api/models`, {
			data: { id: `extra-${index}` },
		});
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Picker layout", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Long options" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	for (const width of [240, 600]) {
		await page.request.put(`${app.url}/api/sidebar-width`, { data: { width } });
		await page.reload();
		for (const size of [
			{ width: 1280, height: 720 },
			{ width: 1600, height: 900 },
		]) {
			await page.setViewportSize(size);
			const prompt = page.getByLabel("Prompt", { exact: true });
			const before = await prompt.boundingBox();
			const popup = await openChatPicker(page);
			await expect(popup).toBeInViewport();
			await expect(
				popup.getByRole("radio", { name: longName, exact: true }),
			).toBeVisible();
			const models = popup.getByRole("radiogroup", {
				name: "Model",
				exact: true,
			});
			await models.evaluate((el) => {
				el.scrollTop = el.scrollHeight;
			});
			await expect(
				popup.getByRole("radio", { name: "high", exact: true }),
			).toBeInViewport();
			const bounds = await popup.boundingBox();
			expect(bounds?.x).toBeGreaterThanOrEqual(0);
			expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(
				size.height,
			);
			expect(await prompt.boundingBox()).toEqual(before);
			await page.screenshot({
				path: `/tmp/tyler-agent-85-picker-${size.width}-${width}.png`,
			});
			await page.keyboard.press("Escape");
		}
	}
});
