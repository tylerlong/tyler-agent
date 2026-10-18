import { completedBody } from "../model-fixture.ts";
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

test("default-on Jev review uses ordinary API records with Copy and search without changing the task answer", async ({
	page,
	context,
	app,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Reviewed work", folders: [app.folder] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Review records" },
		})
	).json();
	const stream = app.rawStreamModel();
	const tool = app.holdTool({
		status: "succeeded",
		result: "Reviewed file contents",
	});
	const pending = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { prompt: "Read the file" },
	});
	const arguments_ = { path: `${app.folder}/review-evidence.txt` };
	stream.push(
		completedBody({
			output: [
				{
					id: "read",
					type: "function_call",
					name: "read_file",
					call_id: "read",
					arguments: JSON.stringify(arguments_),
				},
			],
		}),
	);
	stream.end();
	await tool.entered;
	tool.release();
	await pending;
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await expect(page.getByRole("log")).toContainText("Test answer");
	const history = await (
		await page.request.get(`${app.url}/api/chats/${chat.id}`)
	).json();
	expect(history.agents[0].answer).toBe("Test answer");
	const records = await (
		await page.request.get(
			`${app.url}/api/agents/${history.agents[0].id}/calls`,
		)
	).json();
	expect(records.calls).toHaveLength(3);
	const review = records.calls[1];
	expect(review.url).toBe("https://openrouter.ai/api/alpha/decisions");
	expect(review.status).toBe("succeeded");
	const request = page
		.locator("details")
		.filter({ has: page.locator("summary", { hasText: /^Request 2$/ }) });
	const response = page
		.locator("details")
		.filter({ has: page.locator("summary", { hasText: /^Response 2$/ }) });
	await request.locator("summary").click();
	await expect(request.locator("pre")).toContainText("~typesafe/jev-latest");
	await expect(request.locator("pre")).toContainText(
		"Determine whether this tool call poses a clear and serious operational risk.",
	);
	await expect(request.locator("pre")).toContainText("read_file");
	await expect(request.locator("pre")).toContainText(arguments_.path);
	await request.getByRole("searchbox").fill("review-evidence.txt");
	await expect(request.locator("mark")).toHaveText("review-evidence.txt");
	await request.getByRole("button", { name: "Copy", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(await request.locator(".communication-text").textContent());
	await response.locator("summary").click();
	await expect(response.locator("pre")).toContainText(
		'"model": "typesafe/jev-mock-version"',
	);
	await expect(response.locator("pre")).toContainText('"input_tokens": 12');
	await expect(response.locator("pre")).toContainText('"cost": 0');
	await response.getByRole("searchbox").fill("jev-mock-version");
	await expect(response.locator("mark")).toHaveText("jev-mock-version");
	await response.getByRole("button", { name: "Copy", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(await response.locator(".communication-text").textContent());
	await page.reload();
	await expect(page.getByRole("log")).toContainText("Test answer");
	await expect(page.getByRole("log")).not.toContainText("jev-mock-version");
});

test("current UI exposes model options and global safety review without old permission controls", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Current controls", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Chat" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await expect(
		page.getByRole("button", { name: /Pending approvals/ }),
	).toHaveCount(0);
	await page
		.getByRole("button", { name: "Test · Model default", exact: true })
		.click();
	const options = page.getByRole("dialog", { name: "Model", exact: true });
	await expect(
		options.getByRole("radiogroup", { name: "Model", exact: true }),
	).toBeVisible();
	await expect(
		options.getByRole("radiogroup", { name: /File access|Network access/ }),
	).toHaveCount(0);
	await page.keyboard.press("Escape");
	const region = page.getByRole("region", {
		name: "Project Current controls",
		exact: true,
	});
	await region
		.getByRole("button", { name: "Project actions", exact: true })
		.click();
	await region
		.getByRole("button", { name: "Edit project", exact: true })
		.click();
	const editor = page.getByRole("dialog", {
		name: "Edit project",
		exact: true,
	});
	await expect(
		editor.getByRole("heading", { name: "Target folders", exact: true }),
	).toBeVisible();
	await expect(
		editor.getByText("Project permissions", { exact: true }),
	).toHaveCount(0);
	await editor.getByRole("button", { name: "Cancel", exact: true }).click();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "Execution", exact: true }).click();
	await expect(
		page.getByRole("checkbox", { name: "Jev safety review", exact: true }),
	).toBeChecked();
	await expect(page.getByLabel("File access", { exact: true })).toHaveCount(0);
	await expect(page.getByLabel("Network access", { exact: true })).toHaveCount(
		0,
	);
	await expect(
		page.getByRole("heading", { name: "Execution limits", exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
});
