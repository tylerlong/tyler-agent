import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

async function chats(request: APIRequestContext, url: string) {
	const project = await (
		await request.post(`${url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const first = await (
		await request.post(`${url}/api/projects/${project.id}/chats`, {
			data: { name: "First" },
		})
	).json();
	const second = await (
		await request.post(`${url}/api/projects/${project.id}/chats`, {
			data: { name: "Other" },
		})
	).json();
	await request.post(`${url}/api/models`, { data: { id: "second" } });
	return { first, second };
}

test("model and effort choices stay local while busy and restore submitted history after refresh", async ({
	page,
	context,
	app,
}) => {
	const { first } = await chats(page.request, app.url);
	await page.goto(`${app.url}/?chat=${first.id}`);
	const peer = await context.newPage();
	await peer.goto(`${app.url}/?chat=${first.id}`);
	const model = page.getByRole("combobox", { name: "Model", exact: true });
	const effort = page.getByRole("combobox", {
		name: "Reasoning level",
		exact: true,
	});
	await expect(model).toHaveValue("test");
	await effort.selectOption("high");
	await expect(
		peer.getByRole("combobox", { name: "Reasoning level", exact: true }),
	).not.toHaveValue("high");
	const submitted: Record<string, unknown>[] = [];
	page.on("request", (request) => {
		if (
			request.method() === "POST" &&
			request.url().endsWith(`/chats/${first.id}`)
		)
			submitted.push(request.postDataJSON());
	});
	const hold = app.holdModel();
	await page.getByLabel("Prompt", { exact: true }).fill("First question");
	await page.getByRole("button", { name: "Submit", exact: true }).click();
	await hold.entered;
	try {
		await model.selectOption("second");
		await expect(effort).toBeHidden();
		await page.getByLabel("Prompt", { exact: true }).fill("Next draft");
		await expect(
			page.getByRole("button", { name: "Submit", exact: true }),
		).toBeDisabled();
		await page.getByRole("button", { name: "Other", exact: true }).click();
		await expect(model).toHaveValue("test");
		await page.getByRole("button", { name: /^First/ }).click();
		await expect(model).toHaveValue("second");
		await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
			"Next draft",
		);
		await peer.reload();
		await expect(
			peer.getByRole("combobox", { name: "Reasoning level", exact: true }),
		).toHaveValue("high");
		expect(submitted).toEqual([
			{ prompt: "First question", modelId: "test", reasoningEffort: "high" },
		]);
	} finally {
		hold.release();
	}
	await expect(page.getByRole("log")).toContainText("Test answer");
	await expect(model).toHaveValue("second");
	await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
		"Next draft",
	);
	await page.reload();
	await expect(model).toHaveValue("test");
	await expect(effort).toHaveValue("high");
	await page.screenshot({ path: "/tmp/tyler-agent-67-composer.png" });
	await model.selectOption("second");
	await model.selectOption("test");
	await expect(effort.locator("option:checked")).toHaveText("Model default");
	app.failModel();
	await effort.selectOption("low");
	await page.getByLabel("Prompt", { exact: true }).fill("Fail this call");
	await page.getByRole("button", { name: "Submit", exact: true }).click();
	await expect(page.getByRole("log")).toContainText(
		"OpenRouter request failed.",
	);
	await page.reload();
	await expect(effort).toHaveValue("low");
	await peer.close();
});

test("default updates preserve initialized choices and removed selection recovers in composer", async ({
	page,
	app,
}) => {
	const { first } = await chats(page.request, app.url);
	await page.goto(`${app.url}/?chat=${first.id}`);
	const model = page.getByRole("combobox", { name: "Model", exact: true });
	await expect(model).toHaveValue("test");
	await page.getByLabel("Prompt", { exact: true }).fill("Keep draft");
	await page.request.put(`${app.url}/api/model-settings`, {
		data: { defaultModelId: "second" },
	});
	await expect(model).toHaveValue("test");
	await page.request.delete(`${app.url}/api/models/test`);
	await expect(model).toHaveValue("");
	await expect(page.getByRole("dialog")).toBeHidden();
	await expect(
		page.getByRole("button", { name: "Submit", exact: true }),
	).toBeDisabled();
	await model.selectOption("second");
	await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
		"Keep draft",
	);
	await expect(
		page.getByRole("button", { name: "Submit", exact: true }),
	).toBeEnabled();
});

test("empty configuration uses sole mandatory Settings, then explicit composer selection", async ({
	page,
	app,
}) => {
	const { first } = await chats(page.request, app.url);
	await page.request.put(`${app.url}/api/model-settings`, {
		data: { removeApiKey: true },
	});
	await page.request.delete(`${app.url}/api/models/test`);
	await page.request.delete(`${app.url}/api/models/second`);
	await page.goto(`${app.url}/?chat=${first.id}`);
	const settings = page.getByRole("dialog", { name: "Settings", exact: true });
	await expect(settings).toBeVisible();
	await expect(page.locator("dialog[open]")).toHaveCount(1);
	await expect(settings.getByLabel("Model", { exact: true })).toHaveCount(0);
	await expect(
		settings.getByLabel("Reasoning level", { exact: true }),
	).toHaveCount(0);
	const close = settings.getByRole("button", { name: "Close", exact: true });
	await expect(close).toBeDisabled();
	await page.keyboard.press("Escape");
	await page.mouse.click(1, 1);
	await expect(settings).toBeVisible();
	await settings
		.getByLabel("OpenRouter API key", { exact: true })
		.fill("setup-secret");
	await settings
		.getByRole("button", { name: "Save API key", exact: true })
		.click();
	await expect(
		settings.getByLabel("OpenRouter API key", { exact: true }),
	).toHaveValue("");
	await expect(close).toBeDisabled();
	await settings
		.getByRole("checkbox", { name: "Second second", exact: true })
		.check();
	await expect(close).toBeEnabled();
	await expect(
		settings.getByRole("list", { name: "Enabled models" }),
	).not.toContainText("Default");
	await close.click();
	const model = page.getByRole("combobox", { name: "Model", exact: true });
	await expect(model).toHaveValue("");
	await page.getByLabel("Prompt", { exact: true }).fill("First question");
	const submit = page.getByRole("button", { name: "Submit", exact: true });
	await expect(submit).toBeDisabled();
	await model.selectOption("second");
	await submit.click();
	await expect(page.getByRole("log")).toContainText("Test answer");
});

test("mandatory Settings retains failed credential input and becomes closable after saving", async ({
	page,
	app,
}) => {
	const { first } = await chats(page.request, app.url);
	await page.request.put(`${app.url}/api/model-settings`, {
		data: { removeApiKey: true },
	});
	await page.goto(`${app.url}/?chat=${first.id}`);
	const settings = page.getByRole("dialog", { name: "Settings", exact: true });
	await expect(settings).toBeVisible();
	const close = settings.getByRole("button", { name: "Close", exact: true });
	await expect(close).toBeDisabled();
	const key = settings.getByLabel("OpenRouter API key", { exact: true });
	await expect(key).toHaveAttribute("type", "password");
	await page.route("**/api/model-settings", (route) =>
		route.request().method() === "PUT"
			? route.fulfill({
					status: 500,
					json: { code: "configurationSaveFailed" },
				})
			: route.continue(),
	);
	await key.fill("replacement-secret");
	await settings
		.getByRole("button", { name: "Save API key", exact: true })
		.click();
	await expect(key).toHaveValue("replacement-secret");
	await expect(settings.getByRole("alert")).toBeVisible();
	await page.unroute("**/api/model-settings");
	await settings
		.getByRole("button", { name: "Save API key", exact: true })
		.click();
	await expect(key).toHaveValue("");
	await expect(close).toBeEnabled();
	await page.keyboard.press("Escape");
	await expect(settings).toBeHidden();
	expect(
		await (await page.request.get(`${app.url}/api/model-settings`)).text(),
	).not.toContain("replacement-secret");
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(key).toHaveValue("");
});

test("missing configuration does not obstruct archived history", async ({
	page,
	app,
}) => {
	const { first } = await chats(page.request, app.url);
	await page.request.put(`${app.url}/api/chats/${first.id}/archive`, {
		data: { archived: true },
	});
	await page.request.put(`${app.url}/api/model-settings`, {
		data: { removeApiKey: true },
	});
	await page.request.delete(`${app.url}/api/models/test`);
	await page.goto(`${app.url}/?chat=${first.id}`);
	await expect(
		page.getByRole("heading", { name: "First", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("status")).toContainText(
		"Chat is archived and read-only",
	);
	await expect(
		page.getByRole("dialog", { name: "Settings", exact: true }),
	).toBeHidden();
});

test("cross-page removals preserve drafts and distinguish alternative selection from mandatory configuration", async ({
	page,
	context,
	app,
}) => {
	const { first } = await chats(page.request, app.url);
	await page.goto(`${app.url}/?chat=${first.id}`);
	await page.getByLabel("Prompt", { exact: true }).fill("Keep my draft");
	const peer = await context.newPage();
	await peer.goto(app.url);
	await peer.request.delete(`${app.url}/api/models/test`);
	const model = page.getByRole("combobox", { name: "Model", exact: true });
	await expect(model).toHaveValue("");
	const settings = page.getByRole("dialog", { name: "Settings", exact: true });
	await expect(settings).toBeHidden();
	await model.selectOption("second");
	await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
		"Keep my draft",
	);
	await peer.request.delete(`${app.url}/api/models/second`);
	await expect(settings).toBeVisible();
	await expect(
		settings.getByRole("button", { name: "Close", exact: true }),
	).toBeDisabled();
	await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
		"Keep my draft",
	);
	await peer.close();
});

test("configuration read failures show unknown state and retry without losing local draft or override", async ({
	page,
	app,
}) => {
	const { first } = await chats(page.request, app.url);
	let fail = true;
	await page.route("**/api/model-settings", (route) =>
		fail && route.request().method() === "GET"
			? route.fulfill({ status: 503, json: {} })
			: route.continue(),
	);
	await page.goto(`${app.url}/?chat=${first.id}`);
	const alert = page.getByRole("alert");
	await expect(alert).toContainText("Unable to read model settings");
	await expect(
		page.getByRole("dialog", { name: "Settings", exact: true }),
	).toBeHidden();
	fail = false;
	await alert.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(alert).toBeHidden();
	const model = page.getByRole("combobox", { name: "Model", exact: true });
	await model.selectOption("second");
	await page
		.getByLabel("Prompt", { exact: true })
		.fill("Preserve draft on read error");
	fail = true;
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(alert).toContainText("Unable to read model settings");
	await expect(model).toHaveValue("second");
	await expect(
		page.getByRole("button", { name: "Submit", exact: true }),
	).toBeDisabled();
	fail = false;
	await alert.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(alert).toBeHidden();
	await expect(model).toHaveValue("second");
	await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
		"Preserve draft on read error",
	);
	await expect(
		page.getByRole("button", { name: "Submit", exact: true }),
	).toBeEnabled();
});

test("Settings retains inputs through hide/show and becomes mandatory after ordinary removal", async ({
	page,
	app,
}) => {
	const { first } = await chats(page.request, app.url);
	await page.goto(`${app.url}/?chat=${first.id}`);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const settings = page.getByRole("dialog", { name: "Settings", exact: true });
	const key = settings.getByLabel("OpenRouter API key", { exact: true });
	await key.fill("unsaved-draft");
	await settings.getByLabel("Filter models", { exact: true }).fill("Sec");
	await settings.getByRole("button", { name: "Close", exact: true }).click();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(key).toHaveValue("unsaved-draft");
	await expect(
		settings.getByLabel("Filter models", { exact: true }),
	).toHaveValue("Sec");
	await settings
		.getByRole("button", { name: "Remove API key", exact: true })
		.click();
	await expect(
		settings.getByRole("button", { name: "Close", exact: true }),
	).toBeDisabled();
	await page.keyboard.press("Escape");
	await expect(settings).toBeVisible();
	await settings
		.getByRole("button", { name: "Save API key", exact: true })
		.click();
	await expect(
		settings.getByRole("button", { name: "Close", exact: true }),
	).toBeEnabled();
});

test("mandatory Settings waits for an existing management dialog to close", async ({
	page,
	app,
}) => {
	const { first } = await chats(page.request, app.url);
	await page.goto(`${app.url}/?chat=${first.id}`);
	await page.getByRole("button", { name: "New project", exact: true }).click();
	await expect(page.locator("dialog[open]")).toHaveCount(1);
	await page.request.put(`${app.url}/api/model-settings`, {
		data: { removeApiKey: true },
	});
	const settings = page.getByRole("dialog", { name: "Settings", exact: true });
	await expect(settings).toBeHidden();
	await page.keyboard.press("Escape");
	await expect(settings).toBeVisible();
	await expect(page.locator("dialog[open]")).toHaveCount(1);
});

test("restored unsupported effort requires correction and model capabilities control effort choices", async ({
	page,
	app,
}) => {
	const { first } = await chats(page.request, app.url);
	const submitted = await page.request.post(
		`${app.url}/api/chats/${first.id}`,
		{
			data: {
				prompt: "Previously high",
				modelId: "test",
				reasoningEffort: "high",
			},
		},
	);
	expect(submitted.ok()).toBe(true);
	const db = new DatabaseSync(join(app.folder, "db.sqlite"));
	try {
		db.prepare("UPDATE managed_models SET metadata=? WHERE id=?").run(
			JSON.stringify({
				supportedEfforts: ["low"],
				reasoningRequired: false,
				catalogMissing: false,
			}),
			"test",
		);
		db.prepare(
			"INSERT INTO managed_models(id,name,metadata) VALUES(?,?,?)",
		).run(
			"gateway",
			"Gateway",
			JSON.stringify({
				supportedEfforts: null,
				reasoningRequired: true,
				catalogMissing: false,
			}),
		);
	} finally {
		db.close();
	}
	await page.goto(`${app.url}/?chat=${first.id}`);
	const model = page.getByRole("combobox", { name: "Model", exact: true });
	const effort = page.getByRole("combobox", {
		name: "Reasoning level",
		exact: true,
	});
	await expect(model).toHaveValue("test");
	await expect(effort).toHaveValue("high");
	await expect(effort).toHaveAttribute("aria-invalid", "true");
	await expect(effort.locator("option:checked")).toBeDisabled();
	await page.getByLabel("Prompt", { exact: true }).fill("Correct this effort");
	const send = page.getByRole("button", { name: "Submit", exact: true });
	await expect(send).toBeDisabled();
	await effort.selectOption("");
	await expect(send).toBeEnabled();
	await expect(effort.locator("option")).toHaveText(["Model default", "low"]);
	await model.selectOption("gateway");
	await expect(effort.locator("option")).toHaveText([
		"Model default",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
	]);
	await effort.selectOption("xhigh");
	await model.selectOption("test");
	await expect(effort).toHaveValue("");
	await effort.selectOption("low");
	await model.selectOption("gateway");
	await expect(effort).toHaveValue("low");
	await model.selectOption("second");
	await expect(effort).toBeHidden();
	await expect(send).toBeEnabled();
});
