import { mkdir } from "node:fs/promises";
import { expect, test } from "./fixtures.ts";

for (const size of [
	{ width: 1280, height: 720 },
	{ width: 1280, height: 900 },
	{ width: 1600, height: 1000 },
]) {
	test(`candidate popup stays anchored with fixed actions at ${size.width}×${size.height}`, async ({
		page,
		app,
	}) => {
		await page.setViewportSize(size);
		const catalog = Array.from({ length: 100 }, (_, index) => ({
			id: `candidate-${index}-${"id".repeat(35)}`,
			name: `Candidate ${index} ${"Long model name ".repeat(5)}`,
		}));
		app.setCatalog(catalog);
		await page.goto(app.url);
		const loaded = page.waitForResponse("**/api/model-catalog");
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await loaded;
		const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
		const add = dialog.getByRole("button", { name: "Add model", exact: true });
		const title = dialog.getByRole("heading", {
			name: "Settings",
			exact: true,
		});
		const close = dialog.getByRole("button", { name: "Close", exact: true });
		const search = dialog.getByRole("combobox", {
			name: "Search models by name or ID",
		});
		const list = dialog.getByRole("listbox", { name: "Popular models" });
		async function capture(state: string) {
			if (!process.env.MODEL_POPUP_SCREENSHOTS) return;
			await mkdir("/tmp/tyler-agent-80-evidence", { recursive: true });
			await page.screenshot({
				path: `/tmp/tyler-agent-80-evidence/${state}-${size.width}-${size.height}.png`,
			});
		}
		await expect(dialog.getByRole("status")).toHaveCount(0);
		const bounds = await dialog.boundingBox();
		const titleBounds = await title.boundingBox();
		const closeBounds = await close.boundingBox();
		await add.click();
		await expect(search).toBeFocused();
		await expect(search).toHaveAttribute(
			"placeholder",
			"Search models by name or ID",
		);
		await expect(list.getByRole("option")).toHaveCount(100);
		expect(await dialog.boundingBox()).toEqual(bounds);
		expect(await title.boundingBox()).toEqual(titleBounds);
		expect(await close.boundingBox()).toEqual(closeBounds);
		const inputBounds = await search.boundingBox();
		const listBounds = await list.boundingBox();
		if (!inputBounds || !listBounds || !titleBounds)
			throw new Error("Missing popup bounds");
		expect(listBounds.y + listBounds.height).toBeLessThanOrEqual(inputBounds.y);
		expect(listBounds.y).toBeGreaterThan(titleBounds.y + titleBounds.height);
		await search.press("ArrowUp");
		const last = list.getByRole("option").last();
		await expect(last).toHaveAttribute("aria-selected", "true");
		await expect
			.poll(async () => {
				const current = await last.boundingBox();
				return (
					!!current &&
					current.y >= listBounds.y &&
					current.y + current.height <= listBounds.y + listBounds.height + 1
				);
			})
			.toBe(true);
		expect(await title.boundingBox()).toEqual(titleBounds);
		expect(await close.boundingBox()).toEqual(closeBounds);
		await capture("above-long-keyboard");
		await search.fill("missing");
		await expect(dialog.getByRole("status")).toHaveText(
			"No matching models in the popular 100. Enabled models are excluded.",
		);
		expect(await dialog.boundingBox()).toEqual(bounds);
		await capture("no-match");
		await search.fill("candidate-99");
		await page.route("**/api/models", (route) =>
			route.fulfill({ status: 500, json: {} }),
		);
		await search.press("ArrowDown");
		await search.press("Enter");
		await expect(dialog.getByRole("alert")).toHaveText(
			"Unable to save model settings. Please retry.",
		);
		await expect(search).toHaveValue("candidate-99");
		await expect(list.getByRole("option")).toHaveCount(1);
		expect(await dialog.boundingBox()).toEqual(bounds);
		await capture("save-failure");
		await search.press("Escape");
		await expect(add).toBeFocused();
		await expect(dialog).toBeVisible();
		await page.unroute("**/api/models");
		for (const model of catalog.slice(0, 8))
			await page.request.post(`${app.url}/api/models`, {
				data: { id: model.id },
			});
		await expect(
			dialog
				.getByRole("list", { name: "Enabled models" })
				.getByRole("listitem"),
		).toHaveCount(9);
		await add.click();
		await search.evaluate((element) =>
			element.scrollIntoView({ block: "start" }),
		);
		await expect
			.poll(async () => {
				const anchor = await search.boundingBox();
				const candidates = await list.boundingBox();
				return (
					!!anchor && !!candidates && candidates.y > anchor.y + anchor.height
				);
			})
			.toBe(true);
		const below = await list.boundingBox();
		const footer = await close.boundingBox();
		if (!below || !footer) throw new Error("Missing below bounds");
		expect(below.y + below.height).toBeLessThan(footer.y);
		expect(
			await dialog.evaluate(
				(element) => element.scrollWidth <= element.clientWidth,
			),
		).toBe(true);
		await capture("below-long");
		await dialog.locator(".settings-content").evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		await expect(list).toHaveCount(0);
		await expect(title).toBeVisible();
		await expect(close).toBeVisible();
		await search.evaluate((element) =>
			element.scrollIntoView({ block: "start" }),
		);
		await expect(list.getByRole("option")).toHaveCount(92);
		await search.fill("candidate-99");
		await dialog
			.getByLabel("OpenRouter API key", { exact: true })
			.fill("replacement");
		await expect(list).toHaveCount(0);
		await dialog
			.getByRole("button", { name: "Save API key", exact: true })
			.click();
		await expect(
			dialog.getByLabel("OpenRouter API key", { exact: true }),
		).toHaveValue("");
		await search.focus();
		await expect(search).toHaveValue("candidate-99");
		await expect(list.getByRole("option")).toHaveCount(1);
		const restoredInput = await search.boundingBox();
		const restoredPopup = await list.locator("..").boundingBox();
		if (!restoredInput || !restoredPopup)
			throw new Error("Missing restored popup");
		expect(
			Math.min(
				Math.abs(restoredPopup.y - restoredInput.y - restoredInput.height - 5),
				Math.abs(restoredInput.y - restoredPopup.y - restoredPopup.height - 5),
			),
		).toBeLessThan(2);
		await search.press("Escape");
		await page.keyboard.press("Escape");
		await expect(dialog).not.toBeVisible();
	});
}

test("addition loading and initial failure stay local with Chinese search and no-match", async ({
	page,
	app,
}) => {
	await page.setViewportSize({ width: 1280, height: 720 });
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "zh-CN" },
	});
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/model-catalog", async (route) => {
		await gate;
		await route.fulfill({ status: 500, json: {} });
	});
	await page.goto(app.url);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "设置", exact: true });
	await expect(dialog.getByRole("status")).toHaveText("加载中…");
	const loadingBounds = await dialog.boundingBox();
	await dialog.getByRole("button", { name: "添加模型", exact: true }).click();
	expect(await dialog.boundingBox()).toEqual(loadingBounds);
	async function capture(state: string) {
		if (!process.env.MODEL_POPUP_SCREENSHOTS) return;
		await mkdir("/tmp/tyler-agent-80-evidence", { recursive: true });
		await page.screenshot({
			path: `/tmp/tyler-agent-80-evidence/${state}-zh-1280-720.png`,
		});
	}
	const search = dialog.getByRole("combobox", { name: "按名称或 ID 搜索模型" });
	await expect(search).toBeFocused();
	await expect(dialog.getByRole("status")).toHaveText("加载中…");
	await capture("loading");
	release();
	await expect(dialog.getByRole("alert")).toContainText("加载热门模型失败");
	await capture("initial-failure");
	await search.press("Escape");
	await page.keyboard.press("Escape");
	await page.unroute("**/api/model-catalog");
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await dialog.getByRole("button", { name: "添加模型", exact: true }).click();
	await search.fill("absent");
	await expect(dialog.getByRole("status")).toHaveText(
		"前 100 个热门模型中没有匹配模型。已启用的模型不在候选中。",
	);
	await capture("no-match");
});
