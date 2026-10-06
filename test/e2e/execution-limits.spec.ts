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
			? "每个根 Agent 的累计后代上限"
			: "Descendants per root Agent";
		const save = chinese ? "保存执行上限" : "Save execution limits";
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
		await region.getByRole("button", { name: save, exact: true }).click();
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
		await region.getByRole("button", { name: save, exact: true }).click();
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
