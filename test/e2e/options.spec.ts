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

test("default updates preserve initialized choices and removal waits until Settings closes", async ({
	page,
	app,
}) => {
	const { first } = await chats(page.request, app.url);
	await page.goto(`${app.url}/?chat=${first.id}`);
	const model = page.getByRole("combobox", { name: "Model", exact: true });
	await expect(model).toHaveValue("test");
	await page.request.put(`${app.url}/api/model-settings`, {
		data: { defaultModelId: "second" },
	});
	await expect(model).toHaveValue("test");
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const settings = page.getByRole("dialog", { name: "Settings", exact: true });
	await settings
		.getByRole("button", { name: "Remove model Test", exact: true })
		.click();
	await expect(
		page.getByRole("dialog", { name: "Complete setup", exact: true }),
	).toBeHidden();
	await expect(settings).toBeVisible();
	await settings.getByRole("button", { name: "Close", exact: true }).click();
	const setup = page.getByRole("dialog", {
		name: "Complete setup",
		exact: true,
	});
	await expect(setup).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(setup).toBeVisible();
	await setup.getByLabel("Model", { exact: true }).selectOption("second");
	await expect(setup).toBeHidden();
	await expect(model).toHaveValue("second");
});

test("required setup retains failed credential input, retries and never returns saved key", async ({
	page,
	app,
}) => {
	const { first } = await chats(page.request, app.url);
	await page.request.put(`${app.url}/api/model-settings`, {
		data: { removeApiKey: true },
	});
	await page.goto(`${app.url}/?chat=${first.id}`);
	const setup = page.getByRole("dialog", {
		name: "Complete setup",
		exact: true,
	});
	await expect(setup).toBeVisible();
	await expect(
		setup.getByRole("button", { name: "Close", exact: true }),
	).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(setup).toBeVisible();
	const key = setup.getByLabel("OpenRouter API key", { exact: true });
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
	await setup
		.getByRole("button", { name: "Save API key", exact: true })
		.click();
	await expect(key).toHaveValue("replacement-secret");
	await expect(setup.getByRole("alert")).toBeVisible();
	await page.screenshot({ path: "/tmp/tyler-agent-67-setup.png" });
	await page.unroute("**/api/model-settings");
	await setup
		.getByRole("button", { name: "Save API key", exact: true })
		.click();
	await expect(setup).toBeHidden();
	const settings = await page.request.get(`${app.url}/api/model-settings`);
	expect(await settings.text()).not.toContain("replacement-secret");
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(
		page
			.getByRole("dialog", { name: "Settings", exact: true })
			.getByLabel("OpenRouter API key", { exact: true }),
	).toHaveValue("");
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
		page.getByRole("dialog", { name: "Complete setup", exact: true }),
	).toBeHidden();
});

test("another page removing the selected model prompts without changing its independent draft", async ({
	page,
	context,
	app,
}) => {
	const { first } = await chats(page.request, app.url);
	await page.goto(`${app.url}/?chat=${first.id}`);
	await page.getByLabel("Prompt", { exact: true }).fill("Keep my draft");
	const peer = await context.newPage();
	await peer.goto(app.url);
	await peer.getByRole("button", { name: "Settings", exact: true }).click();
	await peer
		.getByRole("dialog", { name: "Settings", exact: true })
		.getByRole("button", { name: "Remove model Test", exact: true })
		.click();
	const setup = page.getByRole("dialog", {
		name: "Complete setup",
		exact: true,
	});
	await expect(setup).toBeVisible();
	await setup.getByLabel("Model", { exact: true }).selectOption("second");
	await expect(setup).toBeHidden();
	await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
		"Keep my draft",
	);
	await expect(
		page.getByRole("combobox", { name: "Model", exact: true }),
	).toHaveValue("second");
	await expect(
		peer.getByRole("dialog", { name: "Complete setup", exact: true }),
	).toBeHidden();
	await peer.close();
});
