import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { jiraMcpService } from "../../src/mcp-config.ts";
import { completedBody } from "../model-fixture.ts";
import { expect, test } from "./fixtures.ts";

test("running command card manually refreshes saved streams without a model call", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Logs", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Command" },
		})
	).json();
	const stream = app.rawStreamModel();
	const held = app.holdTool({ status: "succeeded", result: "{}" });
	const pending = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { prompt: "run" },
	});
	stream.push(
		completedBody({
			status: "completed",
			output: [
				{
					id: "fixture",
					type: "function_call",
					name: "fixture_command",
					call_id: "fixture",
					arguments: "{}",
				},
			],
		}),
	);
	stream.end();
	await held.entered;
	const db = new DatabaseSync(join(app.folder, "db.sqlite"));
	// A controlled running Tool Call avoids invoking a native sandbox in browser tests.
	const row = db.prepare("SELECT id FROM tool_calls").get();
	expect(row).toBeTruthy();
	const toolId = Number(row?.id);
	db.prepare(
		`UPDATE tool_calls SET name='exec_command',command_state='{"running":true,"exitCode":null}' WHERE id=?`,
	).run(toolId);
	db.prepare(
		"INSERT INTO tool_output(tool_call_id,ordinal,stream,text) VALUES(?,1,'stdout','first log')",
	).run(toolId);
	const modelCount = () =>
		Number(
			db.prepare("SELECT COUNT(*) AS count FROM model_calls").get()?.count,
		);
	try {
		await pending;
		await page.goto(`${app.url}/?chat=${chat.id}`);
		const card = page.locator(`[data-tool-call-id='${toolId}']`);
		await card.locator("summary").click();
		await expect(card).toContainText("first log");
		await expect(card).toContainText("Current process state");
		await expect(card).toContainText('"running": true');
		const before = modelCount();
		db.prepare(
			"INSERT INTO tool_output(tool_call_id,ordinal,stream,text) VALUES(?,2,'pty','trailing diagnostic')",
		).run(toolId);
		await expect(card).not.toContainText("trailing diagnostic");
		await card.getByRole("button", { name: "Refresh", exact: true }).click();
		await expect(card).toContainText("trailing diagnostic");
		await expect(card).toContainText("[2 pty]");
		expect(modelCount()).toBe(before);
	} finally {
		held.release();
		db.close();
	}
});

for (const name of ["exec_command", "apply_patch"]) {
	test(`credential values do not hide the ${name} Command Output refresh control`, async ({
		page,
		app,
	}) => {
		const service = jiraMcpService();
		service.env.push(
			{ name: "COMMAND_SECRET", value: "command" },
			{ name: "PATCH_SECRET", value: "patch" },
		);
		expect(
			(
				await page.request.put(`${app.url}/api/mcp-settings`, {
					data: { services: [service] },
				})
			).ok(),
		).toBeTruthy();
		const project = await (
			await page.request.post(`${app.url}/api/projects`, {
				data: { name: "Logs", folders: [] },
			})
		).json();
		const chat = await (
			await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
				data: { name: "Control" },
			})
		).json();
		const held =
			name === "apply_patch"
				? app.holdTool({ status: "succeeded", result: "{}" })
				: undefined;
		held?.release();
		const stream = app.rawStreamModel();
		stream.push(
			completedBody({
				output: [
					{
						id: "probe",
						type: "function_call",
						name,
						call_id: "probe",
						arguments: "{}",
					},
				],
			}),
		);
		stream.end();
		await page.request.post(`${app.url}/api/chats/${chat.id}`, {
			data: { prompt: "run" },
		});
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
		const db = new DatabaseSync(join(app.folder, "db.sqlite"));
		try {
			const toolId = Number(db.prepare("SELECT id FROM tool_calls").get()?.id);
			db.prepare(
				"INSERT INTO tool_output(tool_call_id,ordinal,stream,text) VALUES(?,1,'stdout','first log')",
			).run(toolId);
			await page.goto(`${app.url}/?chat=${chat.id}`);
			const card = page.locator(`[data-tool-call-id='${toolId}']`);
			await card.locator("summary").click();
			await expect(card).toContainText("first log");
			db.prepare(
				"INSERT INTO tool_output(tool_call_id,ordinal,stream,text) VALUES(?,2,'stdout','later log')",
			).run(toolId);
			await card.getByRole("button", { name: "Refresh", exact: true }).click();
			await expect(card).toContainText("later log");
		} finally {
			db.close();
		}
	});
}
