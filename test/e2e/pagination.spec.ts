import { expect, test } from "./fixtures.ts";

test("ten-turn pages retain history and drafts across chats and reset on refresh", async ({
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
			data: { name: "Alpha" },
		})
	).json();
	const _other = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Beta" },
		})
	).json();
	for (let i = 1; i <= 25; i++)
		await page.request.post(`${app.url}/api/chats/${chat.id}`, {
			data: { modelId: "test", prompt: `Question ${i}.` },
		});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const log = page.getByRole("log");
	await expect(log).toContainText("Question 16.");
	await expect(log).not.toContainText("Question 15.");
	await page.getByRole("button", { name: "Load earlier turns" }).click();
	await expect(log).toContainText("Question 6.");
	await expect(log).not.toContainText("Question 5.");
	await page.getByLabel("Prompt").fill("keep draft");
	await page.getByRole("button", { name: "Beta", exact: true }).click();
	await expect(log).toBeEmpty();
	await page.getByRole("button", { name: "Alpha", exact: true }).click();
	await expect(log).toContainText("Question 6.");
	await expect(page.getByLabel("Prompt")).toHaveValue("keep draft");
	await page.reload();
	await expect(log).toContainText("Question 16.");
	await expect(log).not.toContainText("Question 6.");
	await expect(page.getByLabel("Prompt")).toHaveValue("");
});

test("offline cached history survives and lifecycle synchronization fills more than ten unseen turns", async ({
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
			data: { name: "Alpha" },
		})
	).json();
	await page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "First question" },
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const log = page.getByRole("log");
	await expect(log).toContainText("First question");
	let offline = true;
	await page.route("**/api/chats/*", (route) =>
		offline ? route.abort() : route.continue(),
	);
	await page.route("**/api/turns/*", (route) =>
		offline ? route.abort() : route.continue(),
	);
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(
		page.getByRole("region", { name: "Chat", exact: true }).getByRole("status"),
	).toContainText("Unable to reach the server");
	await expect(log).toContainText("First question");
	for (let i = 1; i <= 23; i++)
		await page.request.post(`${app.url}/api/chats/${chat.id}`, {
			data: { modelId: "test", prompt: `Unseen ${i}.` },
		});
	offline = false;
	await page.evaluate(() =>
		document.dispatchEvent(new Event("visibilitychange")),
	);
	await expect(log).toContainText("Unseen 23.");
	for (let i = 1; i <= 23; i++) await expect(log).toContainText(`Unseen ${i}.`);
	await expect(log).toContainText("First question");
	await expect(
		page.getByRole("region", { name: "Chat", exact: true }).getByRole("status"),
	).toHaveCount(0);
	app.disconnectClients();
	await page.getByLabel("Prompt").fill("local draft");
	await expect(
		page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
	).toBeEnabled();
	await page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "After reconnect" },
	});
	await expect(log).toContainText("After reconnect");
	await expect(log).toContainText("First question");
});

test("older-page errors preserve history and retry the same page", async ({
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
			data: { name: "Alpha" },
		})
	).json();
	for (let i = 1; i <= 11; i++)
		await page.request.post(`${app.url}/api/chats/${chat.id}`, {
			data: { modelId: "test", prompt: `Question ${i}.` },
		});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await expect(page.getByRole("log")).toContainText("Question 11.");
	await page.route("**/api/chats/*?before=*", (route) => route.abort(), {
		times: 1,
	});
	await page.getByRole("button", { name: "Load earlier turns" }).click();
	await expect(
		page.getByRole("region", { name: "Chat", exact: true }).getByRole("status"),
	).toContainText("Unable to reach the server");
	await expect(page.getByRole("log")).toContainText("Question 11.");
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(page.getByRole("log")).toContainText("Question 1.");
	await expect(
		page.getByRole("button", { name: "Load earlier turns" }),
	).toHaveCount(0);
});

test("late snapshots cannot replace completed turns and interrupted catch-up retries without gaps", async ({
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
			data: { name: "Alpha" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await page.getByLabel("Prompt").fill("local draft");
	await expect(
		page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
	).toBeEnabled();
	const gate = app.holdModel();
	const pending = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "Pending snapshot" },
	});
	await gate.entered;
	await expect(page.getByRole("log")).toContainText("Waiting for response");
	let release!: () => void;
	let arrived!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		arrived = resolve;
	});
	await page.route(
		`**/api/chats/${chat.id}`,
		async (route) => {
			const response = await route.fetch();
			arrived();
			await held;
			await route.fulfill({ response });
		},
		{ times: 1 },
	);
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await started;
	gate.release();
	await pending;
	await expect(page.getByRole("log")).toContainText("Test answer");
	release();
	await expect(page.getByRole("log")).not.toContainText("Waiting for response");
	let blocked = true;
	await page.route("**/api/chats/*", (route) =>
		blocked ? route.abort() : route.continue(),
	);
	await page.route("**/api/turns/*", (route) =>
		blocked ? route.abort() : route.continue(),
	);
	for (let i = 1; i <= 24; i++)
		await page.request.post(`${app.url}/api/chats/${chat.id}`, {
			data: { modelId: "test", prompt: `Missed ${i}.` },
		});
	const missedGate = app.holdModel();
	const missedPending = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "Missed 25." },
	});
	await missedGate.entered;
	try {
		blocked = false;
		let forwardReads = 0;
		await page.route("**/api/chats/*?after=*", (route) => {
			forwardReads++;
			return forwardReads === 2 ? route.abort() : route.continue();
		});
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await expect(
			page
				.getByRole("region", { name: "Chat", exact: true })
				.getByRole("status"),
		).toContainText("Unable to reach the server");
		await page.getByRole("button", { name: "Retry", exact: true }).click();
		await expect(page.getByRole("log")).toContainText("Missed 25.");
		for (let i = 1; i <= 25; i++)
			await expect(page.getByRole("log")).toContainText(`Missed ${i}.`);
	} finally {
		missedGate.release();
		await missedPending;
	}
	await expect(page.getByRole("log")).not.toContainText("Waiting for response");
});

test("an initially empty chat catches up every turn after more than one unseen page", async ({
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
			data: { name: "Alpha" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await page.getByLabel("Prompt").fill("local draft");
	await expect(
		page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
	).toBeEnabled();
	let offline = true;
	await page.route("**/api/chats/*", (route) =>
		offline ? route.abort() : route.continue(),
	);
	await page.route("**/api/turns/*", (route) =>
		offline ? route.abort() : route.continue(),
	);
	for (let i = 1; i <= 12; i++)
		await page.request.post(`${app.url}/api/chats/${chat.id}`, {
			data: { modelId: "test", prompt: `Initially unseen ${i}.` },
		});
	offline = false;
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(page.getByRole("log")).toContainText("Initially unseen 1.");
	await expect(page.getByRole("log")).toContainText("Initially unseen 12.");
	await expect(
		page.getByRole("region", { name: "Chat", exact: true }).getByRole("status"),
	).toHaveCount(0);
});
