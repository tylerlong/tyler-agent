import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { APIRequestContext } from "@playwright/test";
import {
	chatPicker,
	expectEffort,
	expectModel,
	openChatPicker,
	selectEffort,
	selectModel,
} from "./chat-picker.ts";
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
	await request.post(`${url}/api/model-catalog`);
	await request.post(`${url}/api/models`, { data: { id: "second" } });
	return { first, second };
}

test("model and effort choices save immediately while busy and persist across refresh", async ({
	page,
	context,
	app,
}) => {
	const { first } = await chats(page.request, app.url);
	await page.goto(`${app.url}/?chat=${first.id}`);
	const peer = await context.newPage();
	await peer.goto(`${app.url}/?chat=${first.id}`);
	await expectModel(page, "test");
	await selectEffort(page, "high");
	await expectEffort(peer, "high");
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
	await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
	await hold.entered;
	try {
		await selectModel(page, "second");
		await expect(chatPicker(page)).not.toContainText(" · ");
		await page.getByLabel("Prompt", { exact: true }).fill("Next draft");
		await expect(
			page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
		).toBeDisabled();
		await page.getByRole("button", { name: "Other", exact: true }).click();
		await expectModel(page, "test");
		await page.getByRole("button", { name: /^First/ }).click();
		await expectModel(page, "second");
		await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
			"Next draft",
		);
		await peer.reload();
		await expectModel(peer, "second");
		expect(submitted).toEqual([{ prompt: "First question" }]);
	} finally {
		hold.release();
	}
	await expect(page.getByRole("log")).toContainText("Test answer");
	await expectModel(page, "second");
	await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
		"Next draft",
	);
	await page.reload();
	await expectModel(page, "second");
	await expect(chatPicker(page)).not.toContainText(" · ");
	await page.screenshot({ path: "/tmp/tyler-agent-67-composer.png" });
	await selectModel(page, "second");
	await selectModel(page, "test");
	await expectEffort(page, "");
	app.failModel();
	await selectEffort(page, "low");
	await page.getByLabel("Prompt", { exact: true }).fill("Fail this call");
	await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
	await expect(page.getByRole("log")).toContainText(
		"OpenRouter request failed.",
	);
	await page.reload();
	await expectEffort(page, "low");
	await peer.close();
});

test("default updates preserve initialized choices and removed selection recovers in composer", async ({
	page,
	app,
}) => {
	const { first } = await chats(page.request, app.url);
	await page.goto(`${app.url}/?chat=${first.id}`);
	await expectModel(page, "test");
	await page.getByLabel("Prompt", { exact: true }).fill("Keep draft");
	await page.request.put(`${app.url}/api/model-settings`, {
		data: { defaultModelId: "second" },
	});
	await expectModel(page, "test");
	await page.request.delete(`${app.url}/api/models/test`);
	await expectModel(page, "second");
	await expect(page.getByRole("dialog")).toBeHidden();
	await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
		"Keep draft",
	);
	await expect(
		page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
	).toBeEnabled();
});

test("empty configuration uses sole mandatory Settings, then initializes the composer with its first model", async ({
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
		.getByRole("button", { name: "Add model", exact: true })
		.click();
	await settings
		.getByRole("option", { name: "Second second", exact: true })
		.click();
	await expect(close).toBeEnabled();
	await expect(
		settings.getByRole("list", { name: "Enabled models" }),
	).toContainText("Default");
	await close.click();
	await expectModel(page, "second");
	await page.getByLabel("Prompt", { exact: true }).fill("First question");
	const submit = page.getByRole("button", { name: /^Send(?: \(.+\))?$/ });
	await expect(submit).toBeEnabled();
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
	await expectModel(page, "second");
	const settings = page.getByRole("dialog", { name: "Settings", exact: true });
	await expect(settings).toBeHidden();
	await selectModel(page, "second");
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
	await selectModel(page, "second");
	await page
		.getByLabel("Prompt", { exact: true })
		.fill("Preserve draft on read error");
	fail = true;
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(alert).toContainText("Unable to read model settings");
	await expectModel(page, "second");
	await expect(
		page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
	).toBeDisabled();
	fail = false;
	await alert.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(alert).toBeHidden();
	await expectModel(page, "second");
	await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
		"Preserve draft on read error",
	);
	await expect(
		page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
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
	await settings
		.getByRole("button", { name: "Add model", exact: true })
		.click();
	await settings
		.getByRole("combobox", { name: "Search models by name or ID", exact: true })
		.fill("Sec");
	await settings.getByRole("button", { name: "Close", exact: true }).click();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(key).toHaveValue("unsaved-draft");
	await expect(
		settings.getByLabel("Search models by name or ID", { exact: true }),
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

test("saved unsupported effort silently resets to Default and model capabilities control effort choices", async ({
	page,
	app,
}) => {
	const { first } = await chats(page.request, app.url);
	await page.request.put(`${app.url}/api/chats/${first.id}`, {
		data: { modelId: "test", reasoningEffort: "high" },
	});
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
	await expectModel(page, "test");
	await expectEffort(page, "");
	await page.getByLabel("Prompt", { exact: true }).fill("Use restored default");
	const send = page.getByRole("button", { name: /^Send(?: \(.+\))?$/ });
	await expect(send).toBeEnabled();
	let popup = await openChatPicker(page);
	await expect(
		popup.getByRole("radiogroup", { name: "Reasoning level" }).locator("label"),
	).toHaveText(["Default", "low"]);
	await page.keyboard.press("Escape");
	await send.click();
	await expect(page.getByRole("log")).toContainText("Test answer");
	const history = new DatabaseSync(join(app.folder, "db.sqlite"));
	try {
		const calls = history
			.prepare("SELECT request_body FROM model_calls ORDER BY id")
			.all();
		expect(JSON.parse(String(calls[0]?.request_body)).reasoning.effort).toBe(
			"high",
		);
		expect(
			JSON.parse(String(calls[calls.length - 1]?.request_body)).reasoning,
		).toBeUndefined();
	} finally {
		history.close();
	}
	await selectModel(page, "gateway");
	popup = await openChatPicker(page);
	await expect(
		popup.getByRole("radiogroup", { name: "Reasoning level" }).locator("label"),
	).toHaveText(["Default", "minimal", "low", "medium", "high", "xhigh"]);
	await page.keyboard.press("Escape");
	await selectEffort(page, "xhigh");
	await selectModel(page, "test");
	await expectEffort(page, "");
	await selectEffort(page, "low");
	await selectModel(page, "gateway");
	await expectEffort(page, "low");
	await selectModel(page, "second");
	await expect(chatPicker(page)).not.toContainText(" · ");
	await page.getByLabel("Prompt", { exact: true }).fill("Next draft");
	await expect(send).toBeEnabled();
});

test("combined picker applies immediately, keeps focus on keyboard dismissal and never submits from its options", async ({
	page,
	app,
}) => {
	const { first } = await chats(page.request, app.url);
	await page.goto(`${app.url}/?chat=${first.id}`);
	await page.getByLabel("Prompt", { exact: true }).fill("Keep this draft");
	const posts: string[] = [];
	page.on("request", (request) => {
		if (
			request.method() === "POST" &&
			request.url().endsWith(`/chats/${first.id}`)
		)
			posts.push(request.url());
	});
	const trigger = chatPicker(page);
	const popup = await openChatPicker(page);
	const high = popup.getByRole("radio", { name: "high", exact: true });
	await high.focus();
	await high.press("Enter");
	await expect(high).toBeChecked();
	await expect(popup).toBeVisible();
	await expectEffort(page, "high");
	expect(posts).toEqual([]);
	await high.press("Escape");
	await expect(popup).toBeHidden();
	await expect(trigger).toBeFocused();
	await trigger.click();
	await trigger.click();
	await expect(popup).toBeHidden();
	await expect(trigger).toBeFocused();
	await trigger.click();
	const prompt = page.getByLabel("Prompt", { exact: true });
	const promptBounds = await prompt.boundingBox();
	await prompt.click({ position: { x: (promptBounds?.width ?? 0) - 8, y: 8 } });
	await expect(popup).toBeHidden();
	await expect(prompt).toBeFocused();
	await expectEffort(page, "high");
	await page.request.put(`${app.url}/api/chats/${first.id}/archive`, {
		data: { archived: true },
	});
	await expect(trigger).toHaveCount(0);
});

test("catalog capability changes normalize saved Chat choices without rewriting submitted history", async ({
	page,
	app,
}) => {
	const { first } = await chats(page.request, app.url);
	await page.goto(`${app.url}/?chat=${first.id}`);
	await selectEffort(page, "high");
	await page.getByLabel("Prompt", { exact: true }).fill("First high agent");
	await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
	await expect(page.getByRole("log")).toContainText("Test answer");
	await page.getByLabel("Prompt", { exact: true }).fill("Preserve my draft");
	app.setCatalog([
		{ id: "test", name: "Test", reasoning: { supported_efforts: ["low"] } },
		{ id: "second", name: "Second" },
	]);
	await page.request.post(`${app.url}/api/model-catalog`);
	await expectEffort(page, "");
	await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
		"Preserve my draft",
	);
	await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
	await expect
		.poll(
			async () =>
				(
					await (
						await page.request.get(`${app.url}/api/chats/${first.id}`)
					).json()
				).busy,
		)
		.toBe(false);
	const history = new DatabaseSync(join(app.folder, "db.sqlite"));
	try {
		const calls = history
			.prepare("SELECT request_body FROM model_calls ORDER BY id")
			.all();
		expect(JSON.parse(String(calls[0]?.request_body)).reasoning.effort).toBe(
			"high",
		);
		expect(
			JSON.parse(String(calls[calls.length - 1]?.request_body)).reasoning,
		).toBeUndefined();
	} finally {
		history.close();
	}
});

test("unsent Chat choices persist independently through refresh, navigation and service restart", async ({
	page,
	app,
}) => {
	const { first, second } = await chats(page.request, app.url);
	await page.goto(`${app.url}/?chat=${first.id}`);
	await selectEffort(page, "high");
	await selectModel(page, "second");
	await expect
		.poll(
			async () =>
				(
					await (
						await page.request.get(`${app.url}/api/chats/${first.id}`)
					).json()
				).chatOptions,
		)
		.toEqual({ modelId: "second", reasoningEffort: null });
	await page.reload();
	await expectModel(page, "second");
	await page.getByRole("button", { name: "Other", exact: true }).click();
	await expectModel(page, "test");
	await selectEffort(page, "low");
	await expect
		.poll(
			async () =>
				(
					await (
						await page.request.get(`${app.url}/api/chats/${second.id}`)
					).json()
				).chatOptions,
		)
		.toEqual({ modelId: "test", reasoningEffort: "low" });
	await app.restart();
	await page.goto(`${app.url}/?chat=${first.id}`);
	await expectModel(page, "second");
	await page.goto(`${app.url}/?chat=${second.id}`);
	await expectEffort(page, "low");
	expect(
		(await (await page.request.get(`${app.url}/api/chats/${first.id}`)).json())
			.agents,
	).toEqual([]);
});

test("pending or failed option saves cannot submit an unsaved selection", async ({
	page,
	app,
}) => {
	const { first } = await chats(page.request, app.url);
	await page.goto(`${app.url}/?chat=${first.id}`);
	await page.getByLabel("Prompt", { exact: true }).fill("Keep question");
	let release!: () => void, entered!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	const started = new Promise<void>((resolve) => (entered = resolve));
	let posts = 0;
	page.on("request", (request) => {
		if (
			request.method() === "POST" &&
			request.url().endsWith(`/api/chats/${first.id}`)
		)
			posts++;
	});
	await page.route(`**/api/chats/${first.id}`, async (route) => {
		if (route.request().method() !== "PUT") return route.continue();
		entered();
		await held;
		return route.fulfill({
			status: 500,
			json: { code: "configurationSaveFailed" },
		});
	});
	await selectEffort(page, "high", false);
	await started;
	const send = page.getByRole("button", { name: /^Send(?: \(.+\))?$/ });
	try {
		await expect(send).toBeDisabled();
		expect(posts).toBe(0);
	} finally {
		release();
	}
	await expect(page.getByRole("alert")).toBeVisible();
	await expectEffort(page, "");
	expect(
		(await (await page.request.get(`${app.url}/api/chats/${first.id}`)).json())
			.chatOptions,
	).toEqual({ modelId: "test", reasoningEffort: null });
	expect(posts).toBe(0);
	await page.unroute(`**/api/chats/${first.id}`);
	await selectEffort(page, "low");
	await expect(send).toBeEnabled();
	await send.click();
	await expect(page.getByRole("log")).toContainText("Test answer");
	expect(posts).toBe(1);
	expect(
		(await (await page.request.get(`${app.url}/api/chats/${first.id}`)).json())
			.chatOptions,
	).toEqual({ modelId: "test", reasoningEffort: "low" });
});

test("returning to a cached Chat waits for fresh choices before filling a deleted model", async ({
	page,
	app,
}) => {
	const { first } = await chats(page.request, app.url);
	app.setCatalog([
		{
			id: "test",
			name: "Test",
			reasoning: { supported_efforts: ["low", "high"] },
		},
		{ id: "second", name: "Second" },
		{ id: "third", name: "Third" },
	]);
	await page.request.post(`${app.url}/api/model-catalog`);
	await page.request.post(`${app.url}/api/models`, { data: { id: "third" } });
	await page.request.put(`${app.url}/api/model-settings`, {
		data: { defaultModelId: "third" },
	});
	await page.goto(`${app.url}/?chat=${first.id}`);
	await expectModel(page, "test");
	await page.getByRole("button", { name: "Other", exact: true }).click();
	await expectModel(page, "test");
	let release!: () => void, entered!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	const reading = new Promise<void>((resolve) => (entered = resolve));
	const saves: unknown[] = [];
	await page.route(`**/api/chats/${first.id}`, async (route) => {
		if (route.request().method() === "PUT") {
			saves.push(route.request().postDataJSON());
			return route.continue();
		}
		if (route.request().method() !== "GET") return route.continue();
		entered();
		await held;
		return route.continue();
	});
	try {
		await page.request.put(`${app.url}/api/chats/${first.id}`, {
			data: { modelId: "second" },
		});
		await page.request.delete(`${app.url}/api/models/test`);
		await page.getByRole("button", { name: "First", exact: true }).click();
		await reading;
		const popup = await openChatPicker(page);
		await expect(
			popup.getByRole("radio", { name: "Test", exact: true }),
		).toHaveCount(0);
		await expect(
			popup.getByRole("radio", { name: "Third", exact: true }),
		).toHaveCount(1);
		await page.keyboard.press("Escape");
		// Let render effects run while the authoritative Chat read remains held.
		await page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				),
		);
		expect(saves).toEqual([]);
		expect(
			(
				await (
					await page.request.get(`${app.url}/api/chats/${first.id}`)
				).json()
			).chatOptions,
		).toEqual({ modelId: "second", reasoningEffort: null });
	} finally {
		release();
	}
	await expectModel(page, "second");
	expect(saves).toEqual([]);
	expect(
		(await (await page.request.get(`${app.url}/api/chats/${first.id}`)).json())
			.chatOptions,
	).toEqual({ modelId: "second", reasoningEffort: null });
});
