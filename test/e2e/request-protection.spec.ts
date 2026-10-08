import { once } from "node:events";
import { createServer } from "node:http";
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
		await page.getByRole("textbox", { name: "Prompt" }).fill("Same origin");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await expect(page.getByText("Test answer", { exact: true })).toBeVisible();
	} finally {
		await context.close();
		foreign.closeAllConnections();
		await new Promise<void>((resolve) => foreign.close(() => resolve()));
	}
});
