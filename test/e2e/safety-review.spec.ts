import { expect, test } from "./fixtures.ts";

for (const chinese of [false, true]) {
	test(`global safety review saves and survives restart (${chinese ? "zh" : "en"})`, async ({
		page,
		app,
	}) => {
		expect(
			await (await page.request.get(`${app.url}/api/safety-review`)).json(),
		).toEqual({ safetyReview: true });
		if (chinese)
			await page.request.put(`${app.url}/api/language`, {
				data: { language: "zh-CN" },
			});
		await page.goto(app.url);
		await page
			.getByRole("button", { name: chinese ? "设置" : "Settings", exact: true })
			.click();
		await page
			.getByRole("tab", { name: chinese ? "执行" : "Execution", exact: true })
			.click();
		const toggle = page.getByRole("checkbox", {
			name: chinese ? "Jev 安全审核" : "Jev safety review",
			exact: true,
		});
		await expect(toggle).toBeChecked();
		await toggle.uncheck();
		await expect
			.poll(async () =>
				(await page.request.get(`${app.url}/api/safety-review`)).json(),
			)
			.toEqual({ safetyReview: false });
		await app.restart();
		expect(
			await (await page.request.get(`${app.url}/api/safety-review`)).json(),
		).toEqual({ safetyReview: false });
		for (const data of [
			{},
			{ safetyReview: 1 },
			{ safetyReview: "false" },
			{ safetyReview: null },
			{ safetyReview: true, unknown: false },
		]) {
			const response = await page.request.patch(
				`${app.url}/api/safety-review`,
				{ data },
			);
			expect(response.status()).toBe(400);
			expect((await response.json()).code).toBe("invalidSafetyReview");
		}
		expect(
			await (await page.request.get(`${app.url}/api/safety-review`)).json(),
		).toEqual({ safetyReview: false });
	});
}

test("failed safety review saves retain the chosen value and Close retries", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "Execution", exact: true }).click();
	const toggle = page.getByRole("checkbox", {
		name: "Jev safety review",
		exact: true,
	});
	await expect(toggle).toBeChecked();
	let fail = true;
	let writes = 0;
	await page.route("**/api/safety-review", async (route) => {
		if (route.request().method() === "PATCH") {
			writes++;
			if (fail)
				return route.fulfill({
					status: 500,
					json: { code: "safetyReviewSettingsFailed" },
				});
		}
		await route.continue();
	});
	await toggle.uncheck();
	const region = page.getByRole("region", {
		name: "Jev safety review",
		exact: true,
	});
	await expect(region.getByRole("alert")).toBeVisible();
	await expect(toggle).not.toBeChecked();
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await expect.poll(() => writes).toBe(2);
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(toggle).not.toBeChecked();
	fail = false;
	await region.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(region.getByRole("alert")).toHaveCount(0);
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	expect(
		await (await page.request.get(`${app.url}/api/safety-review`)).json(),
	).toEqual({ safetyReview: false });
});
