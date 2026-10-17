import type { Page } from "@playwright/test";
import { completedBody } from "../model-fixture.ts";
import { expect, test } from "./fixtures.ts";

const png =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
const image = {
	name: "pixel.png",
	mimeType: "image/png",
	buffer: Buffer.from(png, "base64"),
};
async function openChat(page: Page, url: string) {
	const project = await (
		await page.request.post(`${url}/api/projects`, {
			data: { name: "Images", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${url}/api/projects/${project.id}/chats`, {
			data: { name: "Image task" },
		})
	).json();
	await page.goto(`${url}/?chat=${chat.id}`);
	return chat;
}

test("uploaded and pasted images preview, remove, submit and persist in history and Agent details", async ({
	page,
	app,
}) => {
	const chat = await openChat(page, app.url);
	await page.getByLabel("Prompt", { exact: true }).fill("Describe this image");
	await page.getByLabel("Attach images", { exact: true }).setInputFiles(image);
	await expect(
		page.getByRole("img", { name: "Attached image 1", exact: true }),
	).toHaveAttribute("src", `data:image/png;base64,${png}`);
	await page
		.getByRole("button", { name: "Remove image 1", exact: true })
		.click();
	await expect(page.getByRole("img")).toHaveCount(0);
	await page.getByLabel("Prompt", { exact: true }).evaluate((element, data) => {
		const clipboardData = new DataTransfer();
		clipboardData.items.add(
			new File(
				[Uint8Array.from(atob(data), (char) => char.charCodeAt(0))],
				"pasted.png",
				{ type: "image/png" },
			),
		);
		element.dispatchEvent(
			new ClipboardEvent("paste", {
				clipboardData,
				bubbles: true,
				cancelable: true,
			}),
		);
	}, png);
	await expect(
		page.getByRole("button", { name: "Remove image 1", exact: true }),
	).toBeVisible();
	let submitted: unknown;
	await page.route(`**/api/chats/${chat.id}`, async (route) => {
		if (route.request().method() === "POST")
			submitted = route.request().postDataJSON();
		await route.continue();
	});
	await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
	await expect(page.getByRole("log")).toContainText("Test answer");
	expect(submitted).toEqual({
		intent: "send",
		submissionId: expect.stringMatching(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		),
		prompt: "Describe this image",
		images: [
			{ type: "input_image", image_url: `data:image/png;base64,${png}` },
		],
	});
	await expect(
		page.getByRole("button", { name: "Remove image 1", exact: true }),
	).toHaveCount(0);
	await page.reload();
	await expect(page.getByRole("log").getByRole("img")).toHaveAttribute(
		"src",
		`data:image/png;base64,${png}`,
	);
	await page.getByRole("button", { name: "Task tree", exact: true }).click();
	await expect(
		page.getByRole("img", { name: "Attached image 1", exact: true }),
	).toBeVisible();
});

test("known text-only models preserve image and prompt drafts before any submission", async ({
	page,
	app,
}) => {
	await page.route("**/api/model-settings", async (route) => {
		const response = await route.fetch();
		const settings = await response.json();
		settings.models = settings.models.map((model: object) => ({
			...model,
			inputModalities: ["text"],
		}));
		await route.fulfill({ response, json: settings });
	});
	const chat = await openChat(page, app.url);
	const prompt = page.getByLabel("Prompt", { exact: true });
	await prompt.fill("Keep this task");
	await page.getByLabel("Attach images", { exact: true }).setInputFiles(image);
	await expect(
		page.getByRole("button", { name: "Remove image 1", exact: true }),
	).toBeVisible();
	let posts = 0;
	page.on("request", (request) => {
		if (
			request.url() === `${app.url}/api/chats/${chat.id}` &&
			request.method() === "POST"
		)
			posts++;
	});
	await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
	await expect(page.getByRole("alert")).toContainText(
		"does not support image input",
	);
	await expect(prompt).toHaveValue("Keep this task");
	await expect(
		page.getByRole("button", { name: "Remove image 1", exact: true }),
	).toBeVisible();
	expect(posts).toBe(0);
});

test("unsupported attachment files show an error without discarding the task", async ({
	page,
	app,
}) => {
	await openChat(page, app.url);
	await page.getByLabel("Prompt", { exact: true }).fill("Keep task");
	await page.getByLabel("Attach images", { exact: true }).setInputFiles({
		name: "text.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("text"),
	});
	await expect(page.getByRole("alert")).toContainText(
		"Could not attach images",
	);
	await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
		"Keep task",
	);
	await expect(page.getByRole("img")).toHaveCount(0);
});

test("tool image results display the saved image and preserve image JSON in Copy", async ({
	page,
	context,
	app,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await openChat(page, app.url);
	const first = app.rawStreamModel();
	const result = [
		{ type: "input_image" as const, image_url: `data:image/png;base64,${png}` },
	];
	const tool = app.holdTool({ status: "succeeded", result });
	tool.release();
	await page.getByLabel("Prompt", { exact: true }).fill("Read local image");
	await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
	const output = [
		{
			id: "image-tool",
			type: "function_call",
			name: "read_image",
			call_id: "image",
			arguments: JSON.stringify({ path: "pixel.png" }),
		},
	];
	first.push(completedBody({ status: "completed", output }));
	first.end();
	const card = page.locator("details[data-tool-call-id]");
	await card.locator("summary").click();
	await expect(card.getByRole("img")).toHaveAttribute(
		"src",
		result[0].image_url,
	);
	await expect(page.getByRole("log")).toContainText("Test answer");
	await card.getByRole("button", { name: "Copy", exact: true }).click();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
		result[0].image_url,
	);
	await page.reload();
	const saved = page.locator("details[data-tool-call-id]");
	await saved.locator("summary").click();
	await expect(saved.getByRole("img")).toHaveAttribute(
		"src",
		result[0].image_url,
	);
});
