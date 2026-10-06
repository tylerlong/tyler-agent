import { frame } from "../model-fixture.ts";
import { expect, test } from "./fixtures.ts";

test("ambiguous acknowledgement keeps Send disabled while busy reconciliation is delayed", async ({
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
			data: { name: "Submission" },
		})
	).json();
	await page.addInitScript(`
		const NativeEventSource = window.EventSource;
		window.EventSource = class extends NativeEventSource {
			addEventListener(type, listener, options) {
				if (type !== "agent") return super.addEventListener(type, listener, options);
			}
			set onmessage(listener) {}
			get onmessage() { return null; }
		};
	`);
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const prompt = page.getByLabel("Prompt", { exact: true });
	const send = page.getByRole("button", { name: /^Send(?: \(.+\))?$/ });
	await prompt.fill("Preserve ambiguous draft");
	await expect(send).toBeEnabled();
	let posts = 0;
	let releaseRead!: () => void;
	const readGate = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	let readStarted!: () => void;
	const reading = new Promise<void>((resolve) => {
		readStarted = resolve;
	});
	const held = app.holdModel();
	await page.route(`**/api/chats/${chat.id}`, async (route) => {
		if (route.request().method() === "POST") {
			posts++;
			const accepted = await route.fetch();
			expect(accepted.status()).toBe(202);
			await route.abort("connectionfailed");
		} else if (posts > 0) {
			readStarted();
			await readGate;
			await route.continue();
		} else await route.continue();
	});
	await send.click();
	await held.entered;
	await reading;
	await expect(page.getByRole("alert")).toBeVisible();
	await expect(prompt).toBeEditable();
	await expect(prompt).toHaveValue("Preserve ambiguous draft");
	await expect(send).toBeDisabled();
	releaseRead();
	await expect(page.getByRole("log")).toContainText("Preserve ambiguous draft");
	await expect(send).toBeDisabled();
	held.release();
	await expect
		.poll(
			async () =>
				(
					await (
						await page.request.get(`${app.url}/api/chats/${chat.id}`)
					).json()
				).busy,
		)
		.toBe(false);
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(page.getByRole("log")).toContainText("Test answer");
	await expect(send).toBeEnabled();
	await expect(prompt).toHaveValue("Preserve ambiguous draft");
	expect(posts).toBe(1);
});

for (const outcome of ["success", "failure"] as const) {
	test(`acknowledgement unlocks the next draft and ${outcome} preserves it`, async ({
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
				data: { name: "Submission" },
			})
		).json();
		await page.goto(`${app.url}/?chat=${chat.id}`);
		const prompt = page.getByLabel("Prompt", { exact: true });
		const send = page.getByRole("button", { name: /^Send(?: \(.+\))?$/ });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let posts = 0;
		await page.route(`**/api/chats/${chat.id}`, async (route) => {
			if (route.request().method() !== "POST") return route.continue();
			posts++;
			const response = await route.fetch();
			expect(response.status()).toBe(202);
			await gate;
			await route.fulfill({ response });
		});
		const stream = app.rawStreamModel();
		await prompt.fill("Accepted question");
		await prompt.evaluate((input: HTMLTextAreaElement) => {
			input.form?.requestSubmit();
			input.form?.requestSubmit();
		});
		await expect(page.getByRole("log")).toContainText("Accepted question");
		await expect(prompt).toBeDisabled();
		await expect(prompt).toHaveValue("Accepted question");
		await expect(send).toBeDisabled();
		release();
		await expect(prompt).toBeEditable();
		await expect(prompt).toHaveValue("");
		await prompt.fill("Next local draft");
		await expect(send).toBeDisabled();
		await prompt.evaluate((input: HTMLTextAreaElement) =>
			input.form?.requestSubmit(),
		);
		expect(posts).toBe(1);
		if (outcome === "success")
			stream.push(
				frame("response.completed", {
					response: {
						status: "completed",
						output: [
							{
								id: "answer",
								type: "message",
								content: [{ type: "output_text", text: "Finished answer" }],
							},
						],
					},
				}),
			);
		else
			stream.push(
				frame("response.failed", {
					response: { status: "failed", error: { message: "fake failure" } },
				}),
			);
		stream.end();
		await expect(send).toBeEnabled();
		await expect(prompt).toHaveValue("Next local draft");
		await expect(page.getByRole("log")).toContainText(
			outcome === "success"
				? "Finished answer"
				: "OpenRouter returned an invalid response.",
		);
		expect(posts).toBe(1);
	});
}

for (const failure of ["rejection", "network"] as const) {
	test(`${failure} during acknowledgement preserves the draft without retry`, async ({
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
				data: { name: "Submission" },
			})
		).json();
		await page.goto(`${app.url}/?chat=${chat.id}`);
		const prompt = page.getByLabel("Prompt", { exact: true });
		const send = page.getByRole("button", { name: /^Send(?: \(.+\))?$/ });
		let posts = 0;
		const held = failure === "network" ? app.holdModel() : undefined;
		await page.route(`**/api/chats/${chat.id}`, async (route) => {
			if (route.request().method() !== "POST") return route.continue();
			posts++;
			if (failure === "network") {
				const accepted = await route.fetch();
				expect(accepted.status()).toBe(202);
				await route.abort("connectionfailed");
			} else
				await route.fulfill({
					status: 400,
					contentType: "application/json",
					body: JSON.stringify({ error: "invalidModel" }),
				});
		});
		await prompt.fill("Keep this draft");
		await send.click();
		await expect(prompt).toBeEditable();
		await expect(page.getByRole("alert")).toBeVisible();
		await expect(prompt).toHaveValue("Keep this draft");
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		if (held) {
			await held.entered;
			await expect(page.getByRole("log")).toContainText("Keep this draft");
			await expect(send).toBeDisabled();
			held.release();
			await expect(page.getByRole("log")).toContainText("Test answer");
		} else await expect(page.getByRole("log")).toBeEmpty();
		await expect(send).toBeEnabled();
		await expect(prompt).toHaveValue("Keep this draft");
		expect(posts).toBe(1);
	});
}

test("terminal event before acknowledgement cannot leave Send disabled", async ({
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
			data: { name: "Submission" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(`**/api/chats/${chat.id}`, async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		const response = await route.fetch();
		expect(response.status()).toBe(202);
		await gate;
		await route.fulfill({ response });
	});
	const prompt = page.getByLabel("Prompt", { exact: true });
	const send = page.getByRole("button", { name: /^Send(?: \(.+\))?$/ });
	await prompt.fill("Question");
	await send.click();
	await expect(page.getByRole("log")).toContainText("Test answer");
	await expect(prompt).toBeDisabled();
	await expect(send).toBeDisabled();
	release();
	await expect(prompt).toBeEditable();
	await expect(prompt).toHaveValue("");
	await prompt.fill("Next question");
	await expect(send).toBeEnabled();
});

test("acknowledgement only clears the submitting page and chat draft", async ({
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
			data: { name: "Submission" },
		})
	).json();
	await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
		data: { name: "Other" },
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const other = await context.newPage();
	await other.goto(`${app.url}/?chat=${chat.id}`);
	await other.getByLabel("Prompt", { exact: true }).fill("Other page draft");
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(`**/api/chats/${chat.id}`, async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		const response = await route.fetch();
		await gate;
		await route.fulfill({ response });
	});
	const held = app.holdModel();
	const prompt = page.getByLabel("Prompt", { exact: true });
	await prompt.fill("Question");
	await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
	await held.entered;
	await page.getByRole("button", { name: "Other", exact: true }).click();
	await prompt.fill("Other chat draft");
	const ack = page.waitForResponse(
		(response) =>
			response.request().method() === "POST" &&
			response.url().endsWith(`/chats/${chat.id}`),
	);
	release();
	await ack;
	await expect(prompt).toHaveValue("Other chat draft");
	await expect(other.getByLabel("Prompt", { exact: true })).toHaveValue(
		"Other page draft",
	);
	await expect(other.getByLabel("Prompt", { exact: true })).toBeEditable();
	await page.getByRole("button", { name: "Submission", exact: true }).click();
	await expect(prompt).toHaveValue("");
	await prompt.fill("Next draft");
	held.release();
	await expect(page.getByRole("log")).toContainText("Test answer");
	await expect(prompt).toHaveValue("Next draft");
	await expect(other.getByLabel("Prompt", { exact: true })).toHaveValue(
		"Other page draft",
	);
});
