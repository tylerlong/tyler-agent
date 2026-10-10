import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { completedBody } from "../model-fixture.ts";
import { expect, test } from "./fixtures.ts";

test("approval inbox discovers background calls without navigation and survives page closure", async ({
	app,
	page,
	context,
	request,
}) => {
	const root = join(app.folder, "project");
	await mkdir(root);
	const secret = join(app.folder, "private.txt");
	await writeFile(secret, "private input");
	const project = await (
		await request.post(`${app.url}/api/projects`, {
			data: { name: "Approval project", folders: [root] },
		})
	).json();
	const pendingChat = await (
		await request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Pending chat" },
		})
	).json();
	const foreground = await (
		await request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Foreground chat" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${foreground.id}`);
	const stream = app.rawStreamModel();
	const work = app.holdTool({
		status: "succeeded",
		result: JSON.stringify({ text: "private input" }),
	});
	work.release();
	const started = await (
		await request.post(`${app.url}/api/chats/${pendingChat.id}`, {
			data: { prompt: "Read extra file" },
		})
	).json();
	stream.push(
		completedBody({
			status: "completed",
			output: [
				{
					id: "read",
					call_id: "read",
					type: "function_call",
					name: "read_file",
					arguments: JSON.stringify({
						path: secret,
						reason: "Read requested fixture",
						extra_permissions: { paths: [{ path: secret, access: "read" }] },
					}),
				},
			],
		}),
	);
	stream.end();
	await expect(
		page.getByRole("button", { name: "Pending approvals (1)" }),
	).toBeVisible();
	await expect(page).toHaveURL(`${app.url}/?chat=${foreground.id}`);
	const pending = await (await request.get(`${app.url}/api/approvals`)).json();
	expect(pending.approvals[0].agentId).toBe(started.agentId);
	await page.close();
	const again = await context.newPage();
	await again.goto(`${app.url}/?chat=${foreground.id}`);
	await again.getByRole("button", { name: "Pending approvals (1)" }).click();
	const dialog = again.getByRole("dialog");
	await expect(dialog).toContainText("Approval project");
	await expect(dialog).toContainText("Pending chat");
	await expect(dialog).toContainText("Read requested fixture");
	await expect(dialog).toContainText(secret);
	await dialog.getByRole("button", { name: "Allow once", exact: true }).click();
	await expect(
		again.getByRole("button", { name: /Pending approvals/ }),
	).toContainText("(0)");
	await expect
		.poll(
			async () =>
				(
					await (
						await request.get(`${app.url}/api/agents/${started.agentId}`)
					).json()
				).agents[0].status,
		)
		.toBe("succeeded");
	await again.goto(`${app.url}/?chat=${pendingChat.id}`);
	await expect(again.getByRole("log")).toContainText("Approved once");
});

test("deny settles waiting request and leaves no executable pending action", async ({
	app,
	page,
	request,
}) => {
	const root = join(app.folder, "project");
	await mkdir(root);
	const path = join(app.folder, "private.txt");
	await writeFile(path, "preserved");
	const project = await (
		await request.post(`${app.url}/api/projects`, {
			data: { name: "Deny project", folders: [root] },
		})
	).json();
	const chat = await (
		await request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Deny chat" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const stream = app.rawStreamModel();
	await page.getByLabel("Prompt", { exact: true }).fill("Read requested file");
	await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
	stream.push(
		completedBody({
			status: "completed",
			output: [
				{
					id: "read",
					call_id: "read",
					type: "function_call",
					name: "read_file",
					arguments: JSON.stringify({
						path,
						reason: "Read requested fixture",
						extra_permissions: { paths: [{ path, access: "read" }] },
					}),
				},
			],
		}),
	);
	stream.end();
	await page.getByRole("button", { name: "Pending approvals (1)" }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Deny", exact: true })
		.click();
	await expect(page.getByRole("log")).toContainText("Approval denied");
	expect(
		(await (await request.get(`${app.url}/api/approvals`)).json()).approvals,
	).toEqual([]);
});
