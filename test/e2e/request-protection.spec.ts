import { once } from "node:events";
import { createServer } from "node:http";
import { managementTokens } from "../local-fetch.ts";
import { expect, test } from "./fixtures.ts";

test("ordinary text/plain form from another loopback port cannot submit a task", async ({
	app,
	page,
	browser,
	request,
}) => {
	const project = await (
		await request.post(`${app.url}/api/projects`, {
			data: { name: "Protected", folders: [] },
		})
	).json();
	const chat = await (
		await request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Protected" },
		})
	).json();
	const foreign = createServer((_req, res) => {
		res.setHeader("Content-Type", "text/html");
		res.end(
			`<form method="post" enctype="text/plain" action="${app.url}/api/chats/${chat.id}"><input name='{"prompt":"foreign","padding":"' value='"}'><button>Submit foreign task</button></form>`,
		);
	}).listen(0, "127.0.0.1");
	await once(foreign, "listening");
	const address = foreign.address();
	if (!address || typeof address === "string")
		throw new Error("Missing foreign server address");
	expect(address.port).not.toBe(3000);
	expect(app.url).not.toContain(":3000");
	const context = await browser.newContext();
	try {
		const attacker = await context.newPage();
		await attacker.goto(`http://127.0.0.1:${address.port}`);
		const submitted = attacker.waitForResponse(
			(r) => r.url() === `${app.url}/api/chats/${chat.id}`,
		);
		await attacker.getByRole("button", { name: "Submit foreign task" }).click();
		const rejected = await submitted;
		expect(rejected.request().method()).toBe("POST");
		expect(rejected.request().headers()["content-type"]).toBe("text/plain");
		expect(rejected.request().headers().origin).toBe(
			`http://127.0.0.1:${address.port}`,
		);
		expect(rejected.status()).toBe(403);
		const saved = await (
			await request.get(`${app.url}/api/chats/${chat.id}`)
		).json();
		expect(saved.agents).toEqual([]);
		expect(saved.busy).toBe(false);
		await page.goto(`${app.url}/?chat=${chat.id}`);
		await page.getByLabel("Prompt", { exact: true }).fill("Same origin");
		await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
		await expect(page.getByText("Test answer", { exact: true })).toBeVisible();
	} finally {
		await context.close();
		foreign.closeAllConnections();
		await new Promise<void>((resolve) => foreign.close(() => resolve()));
	}
});

test("startup fragment authorizes every browser API and expired tokens retain Settings drafts", async ({
	app,
	browser,
}) => {
	const token = managementTokens.get(app.url);
	const context = await browser.newContext();
	const page = await context.newPage();
	const observed: { url: string; token?: string }[] = [];
	page.on("request", (req) => {
		if (new URL(req.url()).pathname.startsWith("/api/"))
			observed.push({
				url: req.url(),
				token: req.headers()["x-tyler-management-token"],
			});
	});
	try {
		await page.goto(`${app.url}/#management=${token}`);
		await expect(
			page.getByRole("button", { name: "Settings", exact: true }),
		).toBeVisible();
		await expect.poll(() => new URL(page.url()).hash).toBe("");
		expect(
			await page.evaluate(() =>
				sessionStorage.getItem("tyler-management-token"),
			),
		).toBe(token);
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
		await dialog.getByRole("tab", { name: "Models", exact: true }).click();
		const key = dialog.getByLabel("OpenRouter API key", { exact: true });
		await expect(key).toHaveValue("zkey");
		await key.fill("unsaved-draft");
		await page.evaluate(() =>
			sessionStorage.setItem("tyler-management-token", "f".repeat(64)),
		);
		await key.blur();
		await expect(
			dialog
				.getByRole("alert")
				.filter({ hasText: "Reopen the startup URL" })
				.first(),
		).toBeVisible();
		await expect(key).toHaveValue("unsaved-draft");
		await dialog.getByRole("button", { name: "Close", exact: true }).click();
		await expect(dialog).toBeVisible();
		await expect(key).toHaveValue("unsaved-draft");
		expect(
			observed
				.filter((entry) => entry.token === token)
				.some((entry) => entry.url.endsWith("/api/events")),
		).toBe(true);
		expect(
			observed
				.filter((entry) => entry.url.endsWith("/api/model-catalog"))
				.every((entry) => entry.token === token),
		).toBe(true);
	} finally {
		await context.close();
	}
});

test("missing startup token shows management authorization and SSE does not retry", async ({
	app,
	browser,
}) => {
	const context = await browser.newContext();
	const page = await context.newPage();
	let streams = 0;
	page.on("request", (req) => {
		if (req.url() === `${app.url}/api/events`) streams++;
	});
	try {
		await page.goto(app.url);
		await expect(
			page
				.getByText(
					"Management authorization is required. Reopen the startup URL printed by the server.",
				)
				.first(),
		).toBeVisible();
		await page.waitForTimeout(1500);
		expect(streams).toBe(1);
	} finally {
		await context.close();
	}
});

test("expired authorization remains actionable in lazy communication records", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Records", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Records" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await page.getByLabel("Prompt", { exact: true }).fill("question");
	await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
	await expect(page.getByText("Test answer", { exact: true })).toBeVisible();
	await page.evaluate(() =>
		sessionStorage.setItem("tyler-management-token", "f".repeat(64)),
	);
	const response = page
		.locator("details")
		.filter({ has: page.locator("summary", { hasText: /^Response \d+/ }) });
	await response.locator("summary").click();
	await expect(response.getByRole("alert")).toContainText(
		"Reopen the startup URL",
	);
	await response.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(response.getByRole("alert")).toContainText(
		"Reopen the startup URL",
	);
});

test("initial model-settings authorization failure stays actionable through Models Retry", async ({
	page,
	app,
}) => {
	let reads = 0;
	await page.route("**/api/model-settings", async (route) => {
		reads++;
		await route.fulfill({
			status: 403,
			json: { code: "managementAuthorizationRequired" },
		});
	});
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Configuration", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Configuration" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await expect(page.getByRole("alert")).toContainText("Reopen the startup URL");
	await page
		.getByLabel("Prompt", { exact: true })
		.fill("retained configuration draft");
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	await dialog.getByRole("tab", { name: "Models", exact: true }).click();
	const alert = dialog.getByRole("alert");
	await expect(alert).toContainText("Reopen the startup URL");
	const previous = reads;
	await alert.getByRole("button", { name: "Retry", exact: true }).click();
	await expect.poll(() => reads).toBeGreaterThan(previous);
	await expect(alert).toContainText("Reopen the startup URL");
	await page.unroute("**/api/model-settings");
	await alert.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(
		dialog.getByLabel("OpenRouter API key", { exact: true }),
	).toHaveValue("zkey");
	await expect(alert).toHaveCount(0);
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
		"retained configuration draft",
	);
});

test("Settings Close retains model-settings authorization failure and retries", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	await dialog.getByRole("tab", { name: "Models", exact: true }).click();
	const key = dialog.getByLabel("OpenRouter API key", { exact: true });
	await expect(key).toHaveValue("zkey");
	await page.route("**/api/model-settings", (route) =>
		route.fulfill({
			status: 403,
			json: { code: "managementAuthorizationRequired" },
		}),
	);
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("alert")).toContainText(
		"Reopen the startup URL",
	);
	await expect(key).toHaveValue("zkey");
	await page.unroute("**/api/model-settings");
	await dialog
		.getByRole("alert")
		.getByRole("button", { name: "Retry", exact: true })
		.click();
	await expect(dialog.getByRole("alert")).toHaveCount(0);
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeHidden();
});

test("credential read authorization failure can Retry successfully and Close", async ({
	page,
	app,
}) => {
	let failed = true;
	await page.route("**/api/settings/credential", (route) =>
		failed
			? route.fulfill({
					status: 403,
					json: { code: "managementAuthorizationRequired" },
				})
			: route.continue(),
	);
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	await dialog.getByRole("tab", { name: "Models", exact: true }).click();
	const credentials = dialog.getByRole("region", {
		name: "Credentials",
		exact: true,
	});
	const key = credentials.getByLabel("OpenRouter API key", { exact: true });
	await expect(key).toBeDisabled();
	await expect(credentials.getByRole("alert")).toContainText(
		"Reopen the startup URL",
	);
	// Keep an unrelated settings refresh from recovering the read before the Retry click.
	let releaseSettings: () => void = () => {};
	const settingsGate = new Promise<void>((resolve) => {
		releaseSettings = resolve;
	});
	await page.route("**/api/model-settings", async (route) => {
		await settingsGate;
		await route.continue();
	});
	await Promise.all([
		page.waitForRequest("**/api/model-settings"),
		page.evaluate(() => window.dispatchEvent(new Event("focus"))),
	]);
	failed = false;
	await credentials.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(key).toHaveValue("zkey");
	await expect(key).toBeEnabled();
	await expect(credentials.getByRole("alert")).toHaveCount(0);
	releaseSettings();
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeHidden();
});

test("successful settings refresh preserves an unauthorized credential save and draft until Close retries", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	await dialog.getByRole("tab", { name: "Models", exact: true }).click();
	const credentials = dialog.getByRole("region", {
		name: "Credentials",
		exact: true,
	});
	const key = credentials.getByLabel("OpenRouter API key", { exact: true });
	await expect(key).toHaveValue("zkey");
	await page.route("**/api/model-settings", (route) =>
		route.request().method() === "PUT"
			? route.fulfill({
					status: 403,
					json: { code: "managementAuthorizationRequired" },
				})
			: route.continue(),
	);
	await key.fill("retained unauthorized credential");
	await key.blur();
	await expect(credentials.getByRole("alert")).toContainText(
		"Reopen the startup URL",
	);
	const refreshed = page.waitForResponse(
		(response) =>
			response.url().endsWith("/api/model-settings") &&
			response.request().method() === "GET",
	);
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await refreshed;
	await expect(key).toHaveValue("retained unauthorized credential");
	await expect(credentials.getByRole("alert")).toContainText(
		"Reopen the startup URL",
	);
	await expect(
		credentials.getByRole("button", { name: "Retry", exact: true }),
	).toHaveCount(0);
	await page.unroute("**/api/model-settings");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeHidden();
	expect(
		await (await page.request.get(`${app.url}/api/settings/credential`)).json(),
	).toEqual({ apiKey: "retained unauthorized credential" });
});

test("an unrelated model removal preserves a retained default authorization error", async ({
	page,
	app,
}) => {
	app.setCatalog([
		{ id: "second", name: "Second" },
		{ id: "third", name: "Third" },
	]);
	await page.request.post(`${app.url}/api/model-catalog`);
	for (const id of ["second", "third"])
		await page.request.post(`${app.url}/api/models`, { data: { id } });
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	await dialog.getByRole("tab", { name: "Models", exact: true }).click();
	const list = dialog.getByRole("list", { name: "Enabled models" });
	await page.route("**/api/model-settings", (route) =>
		route.request().method() === "PUT"
			? route.fulfill({
					status: 403,
					json: { code: "managementAuthorizationRequired" },
				})
			: route.continue(),
	);
	await list
		.getByRole("listitem")
		.filter({ hasText: "Second" })
		.getByRole("button", { name: /Set .+ as default/ })
		.click();
	await expect(dialog.getByRole("alert")).toContainText(
		"Reopen the startup URL",
	);
	await list
		.getByRole("listitem")
		.filter({ hasText: "Third" })
		.getByRole("button", { name: /Remove model/ })
		.click();
	await expect(
		list.getByRole("listitem").filter({ hasText: "Third" }),
	).toHaveCount(0);
	await expect(dialog.getByRole("alert")).toContainText(
		"Reopen the startup URL",
	);
	await page.unroute("**/api/model-settings");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeHidden();
	expect(
		(await (await page.request.get(`${app.url}/api/model-settings`)).json())
			.defaultModelId,
	).toBe("second");
});
