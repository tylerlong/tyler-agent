import { expect, test } from "./fixtures.ts";

test("Enter sends once by default and the persisted newline preference keeps both newline shortcuts", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Keyboard", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Keyboard" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
	await prompt.fill("first");
	await prompt.press("Shift+Enter");
	await expect(prompt).toHaveValue("first\n");
	const held = app.holdModel();
	await prompt.press("Enter");
	await held.entered;
	await expect(
		page.getByRole("button", { name: "Submit (Enter)", exact: true }),
	).toBeDisabled();
	await prompt.fill("next");
	await prompt.press("Enter");
	held.release();
	await expect(
		page.getByRole("button", { name: "Submit (Enter)", exact: true }),
	).toBeEnabled();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page
		.getByRole("combobox", { name: "Enter key behavior" })
		.selectOption("newline");
	await expect(
		page.getByRole("combobox", { name: "Enter key behavior" }),
	).toHaveValue("newline");
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await prompt.press("Enter");
	await expect(prompt).toHaveValue("next\n");
	await page.reload();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(
		page.getByRole("combobox", { name: "Enter key behavior" }),
	).toHaveValue("newline");
});

for (const [platform, primary, wrong] of [
	["MacIntel", "Meta", "Control"],
	["Win32", "Control", "Meta"],
	["Linux x86_64", "Control", "Meta"],
]) {
	test(`browser ${platform} chooses its primary modifier independently of server and protects composition/repeats`, async ({
		page,
		app,
	}) => {
		await page.addInitScript(
			(platform) =>
				Object.defineProperty(navigator, "platform", { value: platform }),
			platform,
		);
		const project = await (
			await page.request.post(`${app.url}/api/projects`, {
				data: { name: "Shortcuts", folders: [] },
			})
		).json();
		const chat = await (
			await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
				data: { name: "Shortcuts" },
			})
		).json();
		await page.request.put(`${app.url}/api/enter-behavior`, {
			data: { behavior: "newline" },
		});
		await page.goto(`${app.url}/?chat=${chat.id}`);
		const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
		const send = page.getByRole("button", {
			name:
				platform === "MacIntel" ? "Submit (⌘ Enter)" : "Submit (Ctrl Enter)",
			exact: true,
		});
		await expect(send).toBeVisible();
		let posts = 0;
		page.on("request", (r) => {
			if (r.method() === "POST" && r.url().endsWith(`/chats/${chat.id}`))
				posts++;
		});
		await prompt.fill("preserve");
		await prompt.press(`${wrong}+Enter`);
		expect(posts).toBe(0);
		await page.request.put(`${app.url}/api/enter-behavior`, {
			data: { behavior: "send" },
		});
		await expect(
			page.getByRole("button", { name: "Submit (Enter)", exact: true }),
		).toBeVisible();
		await prompt.evaluate((input: HTMLTextAreaElement) => {
			input.dispatchEvent(
				new CompositionEvent("compositionstart", { bubbles: true }),
			);
			input.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Enter",
					isComposing: true,
					bubbles: true,
				}),
			);
			input.dispatchEvent(
				new CompositionEvent("compositionend", { bubbles: true }),
			);
			input.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
			input.dispatchEvent(
				new KeyboardEvent("keyup", { key: "Enter", bubbles: true }),
			);
			input.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Enter",
					repeat: true,
					ctrlKey: true,
					metaKey: true,
					bubbles: true,
				}),
			);
		});
		expect(posts).toBe(0);
		await page.request.put(`${app.url}/api/enter-behavior`, {
			data: { behavior: "newline" },
		});
		await expect(send).toBeVisible();
		// A mouse/candidate commit must not suppress a later deliberate Enter.
		await page.request.put(`${app.url}/api/enter-behavior`, {
			data: { behavior: "send" },
		});
		await expect(
			page.getByRole("button", { name: "Submit (Enter)", exact: true }),
		).toBeVisible();
		await prompt.evaluate((input: HTMLTextAreaElement) => {
			input.dispatchEvent(
				new CompositionEvent("compositionstart", { bubbles: true }),
			);
			input.dispatchEvent(
				new CompositionEvent("compositionend", { bubbles: true }),
			);
		});
		await page.waitForTimeout(150);
		const mouseCommit = app.holdModel();
		await prompt.press("Enter");
		await mouseCommit.entered;
		mouseCommit.release();
		await prompt.fill("explicit shortcut");
		await expect(
			page.getByRole("button", { name: "Submit (Enter)", exact: true }),
		).toBeEnabled();
		await page.request.put(`${app.url}/api/enter-behavior`, {
			data: { behavior: "newline" },
		});
		await expect(send).toBeVisible();
		posts = 0;
		const held = app.holdModel();
		await prompt.press(`${primary}+Enter`);
		await held.entered;
		await expect(send).toBeDisabled();
		await prompt.fill("next local draft");
		await prompt.press(`${primary}+Enter`);
		expect(posts).toBe(1);
		held.release();
		await expect(send).toBeEnabled();
		await expect(prompt).toHaveValue("next local draft");
	});
}

test("unknown keyboard preference preserves draft and explicit Send, retries without writing defaults", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Unknown", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Unknown" },
		})
	).json();
	await page.request.put(`${app.url}/api/enter-behavior`, {
		data: { behavior: "newline" },
	});
	let readFails = true;
	await page.route("**/api/enter-behavior", (route) =>
		readFails ? route.abort() : route.continue(),
	);
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
	await prompt.fill("draft");
	await prompt.press("Enter");
	await expect(prompt).toHaveValue("draft\n");
	await expect(
		page.getByRole("button", { name: "Submit", exact: true }),
	).toBeEnabled();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(
		page.getByRole("combobox", { name: "Enter key behavior" }),
	).toBeDisabled();
	await expect(page.getByRole("alert")).toContainText(
		"Unable to read Enter key behavior",
	);
	readFails = false;
	await page
		.getByRole("button", { name: "Retry", exact: true })
		.dispatchEvent("click");
	await expect(
		page.getByRole("combobox", { name: "Enter key behavior" }),
	).toHaveValue("newline");
});

test("Enter preference synchronizes hidden pages, reconnects and restarts, with failed and ambiguous saves reconciled", async ({
	page,
	context,
	app,
}) => {
	await page.goto(app.url);
	const other = await context.newPage();
	await other.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const choice = page.getByRole("combobox", { name: "Enter key behavior" });
	await page.route("**/api/enter-behavior", (route) =>
		route.request().method() === "PUT"
			? route.fulfill({
					status: 500,
					json: { code: "enterBehaviorWriteFailed" },
				})
			: route.continue(),
	);
	await choice.selectOption("newline");
	await expect(choice).toHaveValue("send");
	await expect(page.getByRole("alert")).toContainText(
		"Unable to confirm Enter key behavior",
	);
	await page.unroute("**/api/enter-behavior");
	await page.route("**/api/enter-behavior", async (route) => {
		if (route.request().method() === "PUT") {
			await route.fetch();
			await route.abort();
		} else await route.continue();
	});
	await choice.selectOption("newline");
	await expect(choice).toHaveValue("newline");
	await other.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(
		other.getByRole("combobox", { name: "Enter key behavior" }),
	).toHaveValue("newline");
	await page.unroute("**/api/enter-behavior");
	app.disconnectClients();
	await page.request.put(`${app.url}/api/enter-behavior`, {
		data: { behavior: "send" },
	});
	await expect(
		other.getByRole("combobox", { name: "Enter key behavior" }),
	).toHaveValue("send");
	await app.restart();
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(choice).toHaveValue("send");
});

test("an older delayed Enter preference read cannot replace the confirmed newer value", async ({
	page,
	app,
}) => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let enter!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	let first = true;
	await page.route("**/api/enter-behavior", async (route) => {
		if (first && route.request().method() === "GET") {
			first = false;
			const response = await route.fetch();
			enter();
			await gate;
			await route.fulfill({ response });
		} else await route.continue();
	});
	await page.goto(app.url);
	await entered;
	await page.request.put(`${app.url}/api/enter-behavior`, {
		data: { behavior: "newline" },
	});
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const choice = page.getByRole("combobox", { name: "Enter key behavior" });
	await expect(choice).toHaveValue("newline");
	release();
	await expect(choice).toHaveValue("newline");
	await page.setViewportSize({ width: 1280, height: 720 });
	await expect(choice).toBeInViewport();
	await page.screenshot({ path: "/tmp/tyler-agent-87-settings-1280.png" });
	await page.setViewportSize({ width: 1600, height: 1000 });
	await page.screenshot({ path: "/tmp/tyler-agent-87-settings-1600.png" });
});
