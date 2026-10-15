import { jiraMcpService } from "../../src/mcp-config.ts";
import { expect, test } from "./fixtures.ts";

for (const chinese of [false, true]) {
	test(`MCP configuration retains invalid and failed drafts and Close retries (${chinese ? "zh" : "en"})`, async ({
		page,
		app,
	}) => {
		if (chinese)
			await page.request.put(`${app.url}/api/language`, {
				data: { language: "zh-CN" },
			});
		const row = jiraMcpService();
		row.env[1].value = "private-test-token";
		expect(
			(
				await page.request.put(`${app.url}/api/mcp-settings`, {
					data: { services: [row] },
				})
			).ok(),
		).toBeTruthy();
		await page.goto(app.url);
		await page
			.getByRole("button", { name: chinese ? "设置" : "Settings", exact: true })
			.click();
		const dialog = page.getByRole("dialog", {
			name: chinese ? "设置" : "Settings",
			exact: true,
		});
		await dialog.getByRole("tab", { name: "MCP", exact: true }).click();
		const panel = dialog.getByRole("tabpanel", { name: "MCP", exact: true });
		const json = panel.getByRole("textbox", {
			name: chinese ? "连接 JSON" : "Connection JSON",
			exact: true,
		});
		const values = panel.getByLabel(
			chinese ? "环境变量值" : "Environment variable value",
			{ exact: true },
		);
		await expect(values.nth(1)).toHaveAttribute("type", "password");
		await expect(values.nth(1)).toHaveValue("private-test-token");
		let writes = 0;
		let fail = false;
		await page.route("**/api/mcp-settings", async (route) => {
			if (route.request().method() !== "PUT") return route.continue();
			writes++;
			if (fail)
				return route.fulfill({
					status: 500,
					contentType: "application/json",
					body: JSON.stringify({ error: "failed" }),
				});
			await route.continue();
		});
		await json.fill("{");
		await json.blur();
		await expect(panel.getByRole("alert")).toContainText(
			chinese ? "连接 JSON 或环境变量无效" : "Invalid connection JSON",
		);
		await dialog
			.getByRole("button", { name: chinese ? "关闭" : "Close", exact: true })
			.click();
		await expect(dialog).toBeVisible();
		await expect(json).toHaveValue("{");
		expect(writes).toBe(0);
		fail = true;
		const config = JSON.stringify({
			command: "docker",
			args: ["<JIRA_PERSONAL_TOKEN>"],
			startup_timeout_sec: 120,
		});
		await json.fill(config);
		await json.blur();
		await expect(panel.getByRole("alert")).toContainText(
			chinese ? "保存 MCP 配置失败" : "Unable to save MCP settings",
		);
		await dialog
			.getByRole("tab", { name: chinese ? "常规" : "General", exact: true })
			.click();
		await dialog
			.getByRole("button", { name: chinese ? "关闭" : "Close", exact: true })
			.click();
		await expect(
			dialog.getByRole("tab", { name: "MCP", exact: true }),
		).toHaveAttribute("aria-selected", "true");
		await expect(json).toHaveValue(config);
		fail = false;
		await dialog
			.getByRole("button", { name: chinese ? "关闭" : "Close", exact: true })
			.click();
		await expect(dialog).not.toBeVisible();
		const saved = await (
			await page.request.get(`${app.url}/api/mcp-settings`)
		).json();
		expect(saved.services[0].config).toBe(config);
		expect(saved.services[0].env[1].value).toBe("private-test-token");
		await page
			.getByRole("button", { name: chinese ? "设置" : "Settings", exact: true })
			.click();
		await dialog.getByRole("tab", { name: "MCP", exact: true }).click();
		await expect(values.nth(1)).toHaveValue("private-test-token");
		await values.nth(1).fill("");
		await values.nth(1).blur();
		await expect
			.poll(
				async () =>
					(await (await page.request.get(`${app.url}/api/mcp-settings`)).json())
						.services[0].env[1].value,
			)
			.toBe("");
		await panel
			.getByRole("button", {
				name: chinese ? "移除服务" : "Remove service",
				exact: true,
			})
			.click();
		await expect(json).toHaveCount(0);
		await expect
			.poll(
				async () =>
					(await (await page.request.get(`${app.url}/api/mcp-settings`)).json())
						.services,
			)
			.toEqual([]);
		await panel
			.getByRole("button", {
				name: chinese ? "添加 Jira 模板" : "Add Jira template",
				exact: true,
			})
			.click();
		await expect(json).toHaveValue(/startup_timeout_sec/);
		await expect
			.poll(
				async () =>
					(await (await page.request.get(`${app.url}/api/mcp-settings`)).json())
						.services.length,
			)
			.toBe(1);
	});
}

test("MCP read failure retries and custom service rejects duplicate env names", async ({
	page,
	app,
}) => {
	let fail = true;
	await page.route("**/api/mcp-settings", (route) =>
		route.request().method() === "GET" && fail
			? route.fulfill({
					status: 500,
					contentType: "application/json",
					body: '{"error":"failed"}',
				})
			: route.continue(),
	);
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	await dialog.getByRole("tab", { name: "MCP", exact: true }).click();
	const panel = dialog.getByRole("tabpanel", { name: "MCP", exact: true });
	await expect(panel.getByRole("alert")).toContainText(
		"Unable to read MCP settings",
	);
	await expect(
		panel.getByRole("button", { name: "Add service", exact: true }),
	).toBeDisabled();
	fail = false;
	await panel.getByRole("button", { name: "Retry", exact: true }).click();
	await panel.getByRole("button", { name: "Add service", exact: true }).click();
	await panel
		.getByRole("textbox", { name: "Service name", exact: true })
		.fill("Custom");
	const json = panel.getByRole("textbox", {
		name: "Connection JSON",
		exact: true,
	});
	await json.fill('{"command":"example","args":[]}');
	await json.blur();
	await expect(panel.getByRole("status")).toHaveText("Saved");
	await panel
		.getByRole("button", { name: "Add environment variable", exact: true })
		.click();
	await panel
		.getByRole("textbox", { name: "Environment variable name", exact: true })
		.fill("TOKEN");
	await panel
		.getByRole("textbox", { name: "Environment variable value", exact: true })
		.fill("first");
	await panel
		.getByRole("button", { name: "Add environment variable", exact: true })
		.click();
	await panel
		.getByRole("textbox", { name: "Environment variable name", exact: true })
		.nth(1)
		.fill("TOKEN");
	await panel
		.getByRole("textbox", { name: "Environment variable value", exact: true })
		.nth(1)
		.fill("second");
	await panel
		.getByRole("textbox", { name: "Environment variable value", exact: true })
		.nth(1)
		.blur();
	await expect(panel.getByRole("alert")).toContainText(
		"Invalid connection JSON or environment variables",
	);
	await panel
		.getByRole("button", {
			name: "Remove environment variable TOKEN",
			exact: true,
		})
		.nth(1)
		.click();
	await expect(panel.getByRole("alert")).toHaveCount(0);
	await expect
		.poll(
			async () =>
				(await (await page.request.get(`${app.url}/api/mcp-settings`)).json())
					.services[0].env,
		)
		.toEqual([{ name: "TOKEN", value: "first" }]);
});

test("Agent detail shows its MCP connection error and diagnostics", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "MCP", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "MCP" },
		})
	).json();
	const accepted = await (
		await page.request.post(`${app.url}/api/chats/${chat.id}`, {
			data: { modelId: "test", prompt: "Connection details" },
		})
	).json();
	await page.route(`**/api/agents/${accepted.agentId}`, async (route) => {
		const response = await route.fetch();
		const body = await response.json();
		body.agents[0].mcpConnections = [
			{
				id: "fixture",
				name: "Example MCP",
				status: "error",
				error: "Controlled connection failure",
				stderr: "Controlled startup diagnostic",
			},
		];
		await route.fulfill({ response, json: body });
	});
	await page.goto(`${app.url}/?chat=${chat.id}&agent=${accepted.agentId}`);
	const connections = page.getByRole("region", {
		name: "MCP connections",
		exact: true,
	});
	await expect(connections).toContainText("Example MCP: Connection error");
	await expect(connections.getByRole("alert")).toHaveText(
		"Controlled connection failure",
	);
	await connections
		.getByText("Connection diagnostics", { exact: true })
		.click();
	await expect(connections.locator("pre")).toHaveText(
		"Controlled startup diagnostic",
	);
});
