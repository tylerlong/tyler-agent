import { expect, test } from "./fixtures.ts";

test("communication is lazy, formatted and copied as original text, retained across chats and updated after completion", async ({
	page,
	context,
	app,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "First" },
		})
	).json();
	await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Other" },
		})
	).json();
	const gate = app.holdModel();
	const pending = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { prompt: "question" },
	});
	await gate.entered;
	let reads = 0;
	page.on("request", (request) => {
		if (request.url().includes("/calls")) reads++;
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const request = page
		.locator("details")
		.filter({ has: page.locator("summary", { hasText: /^Request$/ }) });
	const response = page
		.locator("details")
		.filter({ has: page.locator("summary", { hasText: /^Response$/ }) });
	await expect(request).toHaveCount(1);
	expect(reads).toBe(0);
	await request.locator("summary").click();
	await expect(request.locator("pre")).toContainText('  "model"');
	await request.getByRole("button", { name: "Copy", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(
			'{"model":"[REDACTED]","input":[{"role":"user","content":"question"}],"stream":false}',
		);
	await response.locator("summary").click();
	await expect(response).toContainText("Waiting for response");
	gate.release();
	await pending;
	await expect(response.locator("pre")).toContainText("Test answer");
	await page.getByRole("button", { name: "Other", exact: true }).click();
	await page.getByRole("button", { name: "First", exact: true }).click();
	await expect(request.locator("pre")).toBeVisible();
	await expect(response.locator("pre")).toBeVisible();
	await page.reload();
	await expect(request.locator("pre")).not.toBeVisible();
});

test("failed responses show actual text, retry reading, copy original and remain readable when archived and translated", async ({
	page,
	context,
	app,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Failed" },
		})
	).json();
	app.failModel();
	await page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { prompt: "failure" },
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	let fail = true;
	await page.route("**/calls?kind=response", (route) =>
		fail
			? route.fulfill({ status: 503, json: { error: "offline" } })
			: route.continue(),
	);
	const response = page
		.locator("details")
		.filter({ has: page.locator("summary", { hasText: /^Response$/ }) });
	await response.locator("summary").click();
	await expect(response.getByRole("alert")).toContainText(
		"Unable to read communication",
	);
	fail = false;
	await response.getByRole("button", { name: "Retry" }).click();
	await expect(response).toContainText("HTTP 500");
	await expect(response.locator("pre")).toHaveText("upstream failure");
	await response.getByRole("button", { name: "Copy", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe("upstream failure");
	await page.request.put(`${app.url}/api/chats/${chat.id}/archive`, {
		data: { archived: true },
	});
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "zh-CN" },
	});
	await expect(
		response.getByRole("button", { name: "复制", exact: true }),
	).toBeVisible();
	await expect(response.locator("pre")).toHaveText("upstream failure");
	await response.locator("summary").click();
	await response.locator("summary").click();
	await expect(response.locator("pre")).toHaveText("upstream failure");
});

test("network failures have no copyable response and absent old records are explicit", async ({
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
			data: { name: "Network" },
		})
	).json();
	app.failModel("network");
	await page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { prompt: "failure" },
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const response = page
		.locator("details")
		.filter({ has: page.locator("summary", { hasText: /^Response$/ }) });
	await response.locator("summary").click();
	await expect(response).toContainText("No response body was received");
	await expect(response).toContainText("network disconnected");
	await expect(response.getByRole("button", { name: "Copy" })).toHaveCount(0);
	await page.route("**/calls?kind=request", (route) =>
		route.fulfill({ json: { calls: [] } }),
	);
	const request = page
		.locator("details")
		.filter({ has: page.locator("summary", { hasText: /^Request$/ }) });
	await request.locator("summary").click();
	await expect(request).toContainText("No communication record is available");
});
