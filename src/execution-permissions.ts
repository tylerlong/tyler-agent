import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

export type ExecutionPermissions = {
	fullFile?: boolean;
	fullNetwork?: boolean;
	paths: { path: string; access: "read" | "write" }[];
	domains: string[];
	localNetwork: boolean;
};
export const emptyPermissions = (): ExecutionPermissions => ({
	paths: [],
	domains: [],
	localNetwork: false,
});

export async function requestedPermissions(value: unknown, reason: unknown) {
	if (value === undefined) {
		if (reason !== undefined)
			throw new Error("Extra permissions are required with a reason");
		return emptyPermissions();
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid extra permissions");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).some(
			(key) => !["paths", "domains", "localNetwork"].includes(key),
		) ||
		(input.paths !== undefined && !Array.isArray(input.paths)) ||
		(input.domains !== undefined && !Array.isArray(input.domains)) ||
		(input.localNetwork !== undefined &&
			typeof input.localNetwork !== "boolean")
	)
		throw new Error("Invalid extra permissions");
	const paths: ExecutionPermissions["paths"] = [];
	for (const item of (input.paths ?? []) as unknown[]) {
		if (!item || typeof item !== "object" || Array.isArray(item))
			throw new Error("Invalid extra path");
		const scope = item as Record<string, unknown>;
		if (
			Object.keys(scope).some((key) => !["path", "access"].includes(key)) ||
			typeof scope.path !== "string" ||
			!isAbsolute(scope.path) ||
			scope.path.includes("\0") ||
			(scope.access !== "read" && scope.access !== "write")
		)
			throw new Error("Invalid extra path");
		paths.push({ path: await realpath(scope.path), access: scope.access });
	}
	const domains: string[] = [];
	for (const domain of (input.domains ?? []) as unknown[]) {
		if (
			typeof domain !== "string" ||
			domain.length > 253 ||
			!domain
				.split(".")
				.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
		)
			throw new Error(
				"Extra domains must be literal hostnames without ports or wildcards",
			);
		domains.push(domain.toLowerCase());
	}
	const permissions = {
		paths,
		domains: [...new Set(domains)],
		localNetwork: input.localNetwork === true,
	};
	if (!paths.length && !domains.length && !permissions.localNetwork)
		throw new Error("Extra permission request must not be empty");
	if (typeof reason !== "string" || !reason.trim() || reason.length > 4000)
		throw new Error(
			"Extra permissions require a nonempty reason (maximum 4000 characters)",
		);
	return permissions;
}

export function unmetPermissions(
	request: ExecutionPermissions,
	granted: ExecutionPermissions,
) {
	return {
		paths: request.paths.filter(
			(scope) =>
				!granted.fullFile &&
				!granted.paths.some((grant) => {
					const within = relative(grant.path, scope.path);
					return (
						(grant.access === "write" || scope.access === "read") &&
						(within === "" ||
							(within !== ".." &&
								!within.startsWith(`..${sep}`) &&
								!isAbsolute(within)))
					);
				}),
		),
		domains: request.domains.filter(
			(domain) => !granted.fullNetwork && !granted.domains.includes(domain),
		),
		localNetwork:
			request.localNetwork && !granted.fullNetwork && !granted.localNetwork,
	};
}
export const needsApproval = (permissions: ExecutionPermissions) =>
	permissions.paths.length > 0 ||
	permissions.domains.length > 0 ||
	permissions.localNetwork;

export const permissionParameters = {
	extra_permissions: {
		type: "object",
		additionalProperties: false,
		properties: {
			paths: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						path: {
							type: "string",
							description: "Absolute existing file or directory",
						},
						access: { type: "string", enum: ["read", "write"] },
					},
					required: ["path", "access"],
				},
			},
			domains: {
				type: "array",
				items: { type: "string" },
				description: "Literal hostnames, no ports or wildcards",
			},
			localNetwork: {
				type: "boolean",
				description:
					"Native local binding, loopback direct access and proxy private-address relaxation; no per-port isolation",
			},
		},
	},
	reason: {
		type: "string",
		description: "Required nonempty reason for explicit extra permissions",
	},
};
