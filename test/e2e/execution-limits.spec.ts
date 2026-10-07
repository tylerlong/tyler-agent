import { expect, test } from "./fixtures.ts";

for (const chinese of [false, true]) {
	test(`execution limits default, save, restart and validation (${chinese ? "zh" : "en"})`, async ({
		page,
		app,
	}) => {
		await page.setViewportSize({ width: 1280, height: 720 });
		if (chinese)
			await page.request.put(`${app.url}/api/language`, {
				data: { language: "zh-CN" },
			});
		const settings = chinese ? "设置" : "Settings";
		const title = chinese ? "执行上限" : "Execution limits";
		const calls = chinese
			? "每个 Agent 的模型调用上限"
			: "Model Calls per Agent";
		const descendants = chinese
			? "每个根 Agent 的子 Agent 总量上限"
			: "Descendants per root Agent";
		await page.goto(app.url);
		await page.getByRole("button", { name: settings, exact: true }).click();
		await page
			.getByRole("tab", { name: chinese ? "执行" : "Execution", exact: true })
			.click();
		const region = page.getByRole("region", { name: title, exact: true });
		await expect(region.getByLabel(calls, { exact: true })).toHaveValue("16");
		await expect(region.getByLabel(descendants, { exact: true })).toHaveValue(
			"32",
		);
		await region.getByLabel(calls, { exact: true }).fill("0");
		await region.getByRole("heading").click();
		expect(
			await region
				.getByLabel(calls, { exact: true })
				.evaluate((input: HTMLInputElement) => input.validity.valid),
		).toBe(false);
		expect(
			await (await page.request.get(`${app.url}/api/execution-limits`)).json(),
		).toEqual({ modelCallLimit: 16, subAgentLimit: 32 });
		await region.getByLabel(calls, { exact: true }).fill("7");
		await region.getByLabel(descendants, { exact: true }).fill("11");
		await region.getByRole("heading").click();
		await expect
			.poll(async () =>
				(await page.request.get(`${app.url}/api/execution-limits`)).json(),
			)
			.toEqual({ modelCallLimit: 7, subAgentLimit: 11 });
		await app.restart();
		await page.goto(app.url);
		await page.getByRole("button", { name: settings, exact: true }).click();
		await page
			.getByRole("tab", { name: chinese ? "执行" : "Execution", exact: true })
			.click();
		await expect(region.getByLabel(calls, { exact: true })).toHaveValue("7");
		await expect(region.getByLabel(descendants, { exact: true })).toHaveValue(
			"11",
		);
		for (const value of [0, -1, 1.5, "2", null, 9007199254740992]) {
			const response = await page.request.patch(
				`${app.url}/api/execution-limits`,
				{ data: { modelCallLimit: 8, subAgentLimit: value } },
			);
			expect(response.status()).toBe(400);
			expect((await response.json()).code).toBe("invalidExecutionLimits");
		}
		for (const data of [{}, { unexpected: 1 }]) {
			expect(
				(
					await page.request.patch(`${app.url}/api/execution-limits`, { data })
				).status(),
			).toBe(400);
		}
		expect(
			await (await page.request.get(`${app.url}/api/execution-limits`)).json(),
		).toEqual({ modelCallLimit: 7, subAgentLimit: 11 });
		const response = await page.request.patch(
			`${app.url}/api/execution-limits`,
			{ data: { modelCallLimit: 9 } },
		);
		expect(await response.json()).toEqual({
			modelCallLimit: 9,
			subAgentLimit: 11,
		});
	});
}

test("execution fields save independently and retain invalid drafts across tabs", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "Execution", exact: true }).click();
	const region = page.getByRole("region", {
		name: "Execution limits",
		exact: true,
	});
	const calls = region.getByLabel("Model Calls per Agent", { exact: true });
	const descendants = region.getByLabel("Descendants per root Agent", {
		exact: true,
	});
	await calls.fill("");
	await descendants.click();
	await expect(calls).toHaveAttribute("aria-invalid", "true");
	await descendants.fill("11");
	await page.getByRole("tab", { name: "General", exact: true }).click();
	await expect
		.poll(async () =>
			(await page.request.get(`${app.url}/api/execution-limits`)).json(),
		)
		.toEqual({ modelCallLimit: 16, subAgentLimit: 11 });
	await page.getByRole("tab", { name: "Execution", exact: true }).click();
	await expect(calls).toHaveValue("");
	await expect(descendants).toHaveValue("11");
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await expect(
		page.getByRole("dialog", { name: "Settings", exact: true }),
	).toBeVisible();
	await calls.fill("7");
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await expect(
		page.getByRole("dialog", { name: "Settings", exact: true }),
	).not.toBeVisible();
});

test("execution saves wait on Close, preserve newer drafts, and retry failures deliberately", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "Execution", exact: true }).click();
	const region = page.getByRole("region", {
		name: "Execution limits",
		exact: true,
	});
	const calls = region.getByLabel("Model Calls per Agent", { exact: true });
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const writes: unknown[] = [];
	await page.route("**/api/execution-limits", async (route) => {
		if (route.request().method() !== "PATCH") return route.continue();
		writes.push(route.request().postDataJSON());
		if (writes.length === 1) await held;
		await route.continue();
	});
	await calls.fill("7");
	await region.getByRole("heading").click();
	await expect.poll(() => writes.length).toBe(1);
	await expect(
		region.getByRole("status").filter({ hasText: "Saving" }),
	).toBeVisible();
	await calls.fill("9");
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await expect(
		page.getByRole("dialog", { name: "Settings", exact: true }),
	).toBeVisible();
	await expect(calls).toHaveValue("9");
	release();
	await expect(
		page.getByRole("dialog", { name: "Settings", exact: true }),
	).not.toBeVisible();
	expect(writes).toEqual([{ modelCallLimit: 7 }, { modelCallLimit: 9 }]);
	await page.unroute("**/api/execution-limits");
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "Execution", exact: true }).click();
	let failures = 0;
	await page.route("**/api/execution-limits", async (route) => {
		if (route.request().method() !== "PATCH") return route.continue();
		failures++;
		await route.fulfill({ status: 500, json: {} });
	});
	await calls.fill("13");
	await region.getByRole("heading").click();
	await expect(region.getByRole("alert")).toBeVisible();
	await expect(calls).toHaveValue("13");
	await page.getByRole("tab", { name: "General", exact: true }).click();
	await page.getByRole("tab", { name: "Execution", exact: true }).click();
	expect(failures).toBe(1);
	await expect(
		region.getByRole("status").filter({ hasText: "Saved" }),
	).toHaveCount(0);
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await expect(region.getByRole("alert")).toBeVisible();
	await expect(
		page.getByRole("dialog", { name: "Settings", exact: true }),
	).toBeVisible();
	expect(failures).toBe(2);
	await expect(calls).toHaveValue("13");
	await page.unroute("**/api/execution-limits");
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await expect(
		page.getByRole("dialog", { name: "Settings", exact: true }),
	).not.toBeVisible();
	expect(
		await (await page.request.get(`${app.url}/api/execution-limits`)).json(),
	).toEqual({ modelCallLimit: 13, subAgentLimit: 32 });
});

test("Close waits for execution limits to finish loading", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let reading = false;
	await page.route("**/api/execution-limits", async (route) => {
		reading = true;
		await held;
		await route.continue();
	});
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect.poll(() => reading).toBe(true);
	await page.getByRole("button", { name: "Close", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	await expect(dialog).toBeVisible();
	release();
	await expect(dialog).not.toBeVisible();
});
