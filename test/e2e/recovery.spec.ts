import { completedBody, frame } from "../model-fixture.ts";
import { expect, test } from "./fixtures.ts";

test("a late targeted snapshot cannot undo newer focus recovery", async ({
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
			data: { name: "Recovery" },
		})
	).json();
	await page.addInitScript(`
		const listen = EventSource.prototype.addEventListener;
		EventSource.prototype.addEventListener = function(type, listener, options) {
			return listen.call(this, type, type === "turn" ? (event) => {
				if (!window.missTurnEvents) listener(event);
			} : listener, options);
		};
	`);
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await page.getByLabel("Prompt").fill("local draft");
	await expect(
		page.getByRole("button", { name: "Submit", exact: true }),
	).toBeEnabled();
	const stream = app.rawStreamModel();
	const submitted = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "question" },
	});
	stream.push(
		frame("response.output_text.delta", {
			output_index: 0,
			content_index: 0,
			item_id: "m",
			delta: "Test ",
		}),
	);
	await expect(page.getByRole("log")).toContainText("Test ");
	let release!: () => void;
	let arrived!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		arrived = resolve;
	});
	await page.route("**/api/turns/*", async (route) => {
		const response = await route.fetch();
		arrived();
		await held;
		await route.fulfill({ response });
	});
	stream.push(
		frame("response.output_text.delta", {
			output_index: 0,
			content_index: 0,
			item_id: "m",
			delta: "answer",
		}),
	);
	await started;
	await page.evaluate("window.missTurnEvents = true");
	stream.push(
		completedBody({
			output: [
				{
					id: "m",
					type: "message",
					content: [{ type: "output_text", text: "Test answer" }],
				},
			],
		}),
	);
	stream.end();
	await submitted;
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(page.getByRole("log")).toContainText("Test answer");
	await page.getByLabel("Prompt").fill("local draft");
	await expect(
		page.getByRole("button", { name: "Submit", exact: true }),
	).toBeEnabled();
	const delivered = page.waitForResponse((response) =>
		/\/api\/turns\/\d+$/.test(response.url()),
	);
	release();
	await delivered;
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
	await expect(page.getByRole("log")).toContainText("Test answer");
	await page.getByLabel("Prompt").fill("local draft");
	await expect(
		page.getByRole("button", { name: "Submit", exact: true }),
	).toBeEnabled();
});

test("pending cached thinking and raw records recover on focus, visibility, reconnect, chat return and refresh", async ({
	page,
	context,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Recovery" },
		})
	).json();
	await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
		data: { name: "Other" },
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const other = await context.newPage();
	await other.goto(`${app.url}/?chat=${chat.id}`);
	const stream = app.rawStreamModel();
	const submitted = page.request
		.post(`${app.url}/api/chats/${chat.id}`, {
			data: { modelId: "test", prompt: "question" },
		})
		.catch(() => undefined);
	stream.push(
		frame("response.output_item.added", {
			output_index: 0,
			item: {
				id: "r",
				type: "reasoning",
				content: [{ type: "reasoning_text", text: "saved" }],
			},
		}),
	);
	for (const browserPage of [page, other]) {
		await expect(browserPage.getByRole("log")).toContainText(
			"Reasoning: saved",
		);
		await browserPage
			.getByRole("log")
			.locator("details")
			.last()
			.locator("summary")
			.click();
		await expect(browserPage.getByRole("log").locator("pre")).toContainText(
			'"saved"',
		);
		await browserPage
			.getByRole("log")
			.getByRole("button", { name: /Thinking/ })
			.click();
		await browserPage
			.getByRole("log")
			.locator("details")
			.last()
			.locator("summary")
			.click();
		await browserPage.getByLabel("Prompt").fill("local draft");
	}
	let block = true;
	for (const browserPage of [page, other])
		await browserPage.route("**/api/turns/*", (route) =>
			block ? route.abort() : route.continue(),
		);
	const advance = async (text: string) => {
		stream.push(
			frame("response.reasoning_text.delta", {
				output_index: 0,
				content_index: 0,
				item_id: "r",
				delta: text,
			}),
		);
		await expect
			.poll(
				async () =>
					(
						await (
							await page.request.get(`${app.url}/api/turns/1/reasoning`)
						).json()
					).output[0].content[0].text,
			)
			.toContain(text);
	};
	await advance(" focus");
	block = false;
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await other.evaluate(() =>
		document.dispatchEvent(new Event("visibilitychange")),
	);
	const show = async (browserPage: typeof page, text: string) => {
		const thinking = browserPage
			.getByRole("log")
			.getByRole("button", { name: /Thinking/ });
		await expect(thinking).toHaveAttribute("aria-expanded", "false");
		await thinking.click();
		await expect(browserPage.getByRole("log")).toContainText(text);
		await browserPage
			.getByRole("log")
			.locator("details")
			.last()
			.locator("summary")
			.click();
		await expect(
			browserPage.getByRole("log").locator("pre").last(),
		).toContainText(text.split(" ").at(-1) ?? "");
		await expect(browserPage.getByLabel("Prompt")).toHaveValue("local draft");
	};
	await show(page, "saved focus");
	await show(other, "saved focus");
	block = true;
	await advance(" reconnect!");
	block = false;
	const connected = page.waitForResponse(
		(response) => response.url() === `${app.url}/api/events`,
	);
	app.disconnectClients();
	await connected;
	await expect(page.getByRole("log")).toContainText("saved focus reconnect!");
	await expect(page.getByRole("log").locator("pre").last()).toContainText(
		"reconnect",
	);
	await page.getByRole("button", { name: "Other", exact: true }).click();
	block = true;
	await advance(" return");
	block = false;
	await page.getByRole("button", { name: /Recovery \(running\)/ }).click();
	await expect(page.getByRole("log")).toContainText(
		"saved focus reconnect! return",
	);
	await expect(page.getByRole("log").locator("pre").last()).toContainText(
		"return",
	);
	await expect(page.getByLabel("Prompt")).toHaveValue("local draft");
	await page.reload();
	await expect(page.getByRole("log")).toContainText(
		"saved focus reconnect! return",
	);
	await expect(
		page.getByRole("log").locator("details").last(),
	).not.toHaveAttribute("open", "");
	await expect(page.getByLabel("Prompt")).toHaveValue("");
	stream.end();
	await submitted;
});

test("late thinking and communication successes or errors cannot replace newer cached downloads", async ({
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
			data: { name: "Races" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const stream = app.rawStreamModel();
	const submitted = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "question" },
	});
	const append = (text: string) =>
		stream.push(
			frame("response.reasoning_text.delta", {
				output_index: 0,
				content_index: 0,
				item_id: "r",
				delta: text,
			}),
		);
	append("base");
	const log = page.getByRole("log");
	await expect(log).toContainText("Reasoning: base");
	const response = log.locator("details").last();
	await response.locator("summary").click();
	await expect(response.locator("pre")).toContainText("base");
	for (const fail of [false, true]) {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const arrived = new Set<string>();
		await page.route("**/api/turns/*/*", async (route) => {
			const path = new URL(route.request().url()).pathname;
			if (arrived.has(path)) return route.continue();
			const saved = await route.fetch();
			arrived.add(path);
			await held;
			if (fail)
				await route.fulfill({
					status: 500,
					body: "{}",
					contentType: "application/json",
				});
			else await route.fulfill({ response: saved });
		});
		append(fail ? " old-error" : " old-success");
		await expect.poll(() => arrived.size).toBe(2);
		append(fail ? " new-error" : " new-success");
		const latest = fail ? "new-error" : "new-success";
		await expect(log).toContainText(` ${latest}`);
		await expect(response.locator("pre").last()).toContainText(latest);
		const finished = new Set<string>();
		page.on("response", (result) => {
			const path = new URL(result.url()).pathname;
			if (arrived.has(path)) finished.add(path);
		});
		release();
		await expect.poll(() => finished.size).toBe(2);
		await page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				),
		);
		await expect(log).toContainText(` ${latest}`);
		await expect(response.locator("pre").last()).toContainText(latest);
		await expect(log).not.toContainText("Unable to read");
		await page.unroute("**/api/turns/*/*");
	}
	stream.end();
	await submitted;
});
