import { expect, test } from "./fixtures.ts";

test("Follow-up default persists, busy override is single-use and idle has only Send", async ({
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
			data: { name: "Steering chat" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await expect(
		page.getByRole("button", { name: "Follow-up action", exact: true }),
	).toHaveCount(0);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const preference = page.getByRole("combobox", {
		name: "Follow-up behavior",
		exact: true,
	});
	await expect(preference).toHaveValue("queue");
	await preference.selectOption("steer");
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await page.reload();
	const held = app.holdModel();
	let releaseReplacement = () => {};
	try {
		const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
		await prompt.fill("Running A");
		await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
		await held.entered;
		await expect(page.getByRole("button", { name: /^Steer \(/ })).toBeVisible();
		await page
			.getByRole("button", { name: "Follow-up action", exact: true })
			.click();
		await page.getByRole("button", { name: "Queue", exact: true }).click();
		await prompt.fill("Queued B");
		await page.getByRole("button", { name: /^Queue \(/ }).click();
		await expect(
			page.getByRole("region", { name: "Pending queue" }),
		).toContainText("Queued B");
		await expect(page.getByRole("button", { name: /^Steer \(/ })).toBeVisible();
		const replacement = app.holdModel();
		releaseReplacement = replacement.release;
		await prompt.fill("Steer D");
		await page.getByRole("button", { name: /^Steer \(/ }).click();
		held.release();
		await replacement.entered;
		await expect(prompt).toHaveValue("");
		await expect(
			page.getByRole("region", { name: "Pending queue" }),
		).toContainText("Queued B");
		await expect(page.getByRole("log")).toContainText("Cancelled");
		replacement.release();
		held.release();
		await expect(
			page.getByRole("region", { name: "Pending queue" }),
		).toHaveCount(0);
		await expect(page.getByRole("button", { name: /^Send \(/ })).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Follow-up action", exact: true }),
		).toHaveCount(0);
	} finally {
		releaseReplacement();
		held.release();
	}
});

test("unconfirmed preference retains its selection, Close retries, and busy sending waits", async ({
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
			data: { name: "Settings failures" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const held = app.holdModel();
	try {
		const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
		await prompt.fill("Running");
		await page.getByRole("button", { name: /^Send \(/ }).click();
		await held.entered;
		let writes = 0;
		let fail = true;
		await page.route("**/api/follow-up-behavior", async (route) => {
			if (route.request().method() !== "PUT") return route.continue();
			writes++;
			if (fail)
				return route.fulfill({
					status: 500,
					json: { code: "followUpBehaviorWriteFailed" },
				});
			await route.continue();
		});
		await prompt.fill("Retained input");
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
		const preference = dialog.getByRole("combobox", {
			name: "Follow-up behavior",
			exact: true,
		});
		await preference.selectOption("steer");
		await expect(dialog.getByRole("alert")).toContainText(
			"Unable to confirm follow-up behavior",
		);
		await expect(preference).toHaveValue("steer");
		await page.getByRole("button", { name: "Close", exact: true }).click();
		await expect(dialog).toBeVisible();
		expect(writes).toBe(2);
		await prompt.fill("Retained input");
		await expect(
			page.getByRole("button", { name: /^Steer \(/ }),
		).toBeDisabled();
		await prompt.evaluate((input: HTMLTextAreaElement) =>
			input.form?.requestSubmit(),
		);
		await expect(prompt).toHaveValue("Retained input");
		fail = false;
		await dialog.getByRole("button", { name: "Retry", exact: true }).click();
		await expect(dialog.getByRole("alert")).toHaveCount(0);
		await page.getByRole("button", { name: "Close", exact: true }).click();
		await expect(dialog).toBeHidden();
		await expect(page.getByRole("button", { name: /^Steer \(/ })).toBeEnabled();
		expect(
			(
				await (
					await page.request.get(`${app.url}/api/follow-up-behavior`)
				).json()
			).behavior,
		).toBe("steer");
	} finally {
		held.release();
	}
});

test("failed preference read blocks busy sending until Retry confirms its action", async ({
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
			data: { name: "Read failure" },
		})
	).json();
	await page.route("**/api/follow-up-behavior", (route) =>
		route.fulfill({
			status: 500,
			json: { code: "followUpBehaviorReadFailed" },
		}),
	);
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const held = app.holdModel();
	try {
		const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
		await prompt.fill("Running");
		await page.getByRole("button", { name: /^Send \(/ }).click();
		await held.entered;
		await prompt.fill("Retained follow-up");
		await expect(
			page.locator("button[type=submit][aria-label]"),
		).toBeDisabled();
		await expect(page.getByRole("alert")).toContainText(
			"Unable to read follow-up behavior",
		);
		await page.unroute("**/api/follow-up-behavior");
		await page.getByRole("button", { name: "Retry", exact: true }).click();
		await expect(page.getByRole("button", { name: /^Queue \(/ })).toBeEnabled();
		await expect(prompt).toHaveValue("Retained follow-up");
	} finally {
		held.release();
	}
});

test("stale Steer preserves the draft and refreshes without stopping the replacement", async ({
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
			data: { name: "Stale steering" },
		})
	).json();
	await page.request.put(`${app.url}/api/follow-up-behavior`, {
		data: { behavior: "steer" },
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const held = app.holdModel();
	const replacement = { release: () => {} };
	let releaseRequest = () => {};
	try {
		const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
		await prompt.fill("Original A");
		await page.getByRole("button", { name: /^Send \(/ }).click();
		await held.entered;
		let arrived!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			arrived = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
			releaseRequest = resolve;
		});
		let posts = 0;
		await page.route(`**/api/chats/${chat.id}`, async (route) => {
			if (route.request().method() !== "POST") return route.continue();
			posts++;
			arrived();
			await gate;
			await route.continue();
		});
		await prompt.fill("Retain D");
		await page.getByRole("button", { name: /^Steer \(/ }).click();
		await entered;
		const state = await (
			await page.request.get(`${app.url}/api/chats/${chat.id}`)
		).json();
		const cancellation = page.request.post(
			`${app.url}/api/agents/${state.agents[0].id}/cancel`,
		);
		held.release();
		await cancellation;
		const next = app.holdModel();
		replacement.release = next.release;
		const accepted = await (
			await page.request.post(`${app.url}/api/chats/${chat.id}`, {
				data: { prompt: "Replacement E" },
			})
		).json();
		await next.entered;
		release();
		await expect(page.getByRole("alert")).toContainText(
			"The active task changed",
		);
		await expect(prompt).toHaveValue("Retain D");
		const refreshed = await (
			await page.request.get(`${app.url}/api/chats/${chat.id}`)
		).json();
		expect(
			refreshed.agents.find(
				(agent: { id: number }) => agent.id === accepted.agentId,
			).status,
		).toBe("pending");
		expect(posts).toBe(1);
	} finally {
		held.release();
		replacement.release();
		releaseRequest();
	}
});
