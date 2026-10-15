export type McpService = {
	id: string;
	name: string;
	enabled: boolean;
	config: string;
	env: { name: string; value: string }[];
};
export type McpConfig = {
	command: string;
	args: string[];
	startup_timeout_sec: number;
};
export function parseMcpConfig(
	source: string,
	env?: McpService["env"],
): McpConfig {
	const parsed: unknown = JSON.parse(source);
	const variables = new Map(
		(env ?? []).map(({ name, value }) => [name, value]),
	);
	const substitute = (value: unknown): unknown => {
		if (typeof value === "string" && env !== undefined)
			return value.replace(/<([^<>]+)>/g, (_, name: string) => {
				if (!variables.get(name))
					throw new Error(`Missing MCP variable: ${name}`);
				return variables.get(name) ?? "";
			});
		if (Array.isArray(value)) return value.map(substitute);
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, substitute(item)]),
			);
		return value;
	};
	const value = substitute(parsed) as Record<string, unknown> | null;
	if (
		!value ||
		Array.isArray(value) ||
		typeof value !== "object" ||
		Object.keys(value).some(
			(key) => !["command", "args", "startup_timeout_sec"].includes(key),
		) ||
		typeof value.command !== "string" ||
		!value.command.trim() ||
		(value.args !== undefined &&
			(!Array.isArray(value.args) ||
				value.args.some((arg) => typeof arg !== "string"))) ||
		(value.startup_timeout_sec !== undefined &&
			(typeof value.startup_timeout_sec !== "number" ||
				!Number.isFinite(value.startup_timeout_sec) ||
				value.startup_timeout_sec <= 0))
	)
		throw new Error(
			"Expected command, optional string args and positive startup_timeout_sec; store env separately",
		);
	return {
		command: value.command,
		args: (value.args ?? []) as string[],
		startup_timeout_sec: (value.startup_timeout_sec ?? 120) as number,
	};
}
export function validateMcpServices(value: unknown): McpService[] {
	if (!Array.isArray(value)) throw new Error("Expected MCP services array");
	const ids = new Set<string>();
	for (const row of value) {
		if (
			!row ||
			typeof row !== "object" ||
			Object.keys(row).some(
				(key) => !["id", "name", "enabled", "config", "env"].includes(key),
			) ||
			typeof row.id !== "string" ||
			!row.id ||
			ids.has(row.id) ||
			typeof row.name !== "string" ||
			!row.name.trim() ||
			typeof row.enabled !== "boolean" ||
			typeof row.config !== "string" ||
			!Array.isArray(row.env)
		)
			throw new Error("Invalid MCP service");
		ids.add(row.id);
		const names = new Set<string>();
		for (const variable of row.env) {
			if (
				!variable ||
				typeof variable !== "object" ||
				Object.keys(variable).some((key) => !["name", "value"].includes(key)) ||
				typeof variable.name !== "string" ||
				!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name) ||
				names.has(variable.name) ||
				typeof variable.value !== "string"
			)
				throw new Error("Invalid or duplicate MCP environment name");
			names.add(variable.name);
		}
		parseMcpConfig(row.config);
	}
	return value;
}
export const jiraMcpService = (): McpService => ({
	id: crypto.randomUUID(),
	name: "Jira",
	enabled: false,
	config: JSON.stringify(
		{
			command: "docker",
			args: [
				"run",
				"-i",
				"--rm",
				"-e",
				"JIRA_URL",
				"-e",
				"JIRA_PERSONAL_TOKEN",
				"-e",
				"TOOLSETS",
				"-e",
				"READ_ONLY_MODE",
				"ghcr.io/sooperset/mcp-atlassian:latest",
			],
			startup_timeout_sec: 120,
		},
		null,
		2,
	),
	env: [
		{ name: "JIRA_URL", value: "" },
		{ name: "JIRA_PERSONAL_TOKEN", value: "" },
		{ name: "TOOLSETS", value: "jira" },
		{ name: "READ_ONLY_MODE", value: "false" },
	],
});
