import { useTranslation } from "react-i18next";
import { AgentCalls } from "./agent-calls.tsx";
import { AgentOutput, type ReaderItem } from "./agent-output.tsx";
import type { ImageInput } from "./image-attachments.tsx";
import type { McpConnection } from "./mcp-client.ts";
import { type ToolCall, ToolCallCard } from "./tool-calls.tsx";

export type AgentDetail = {
	id: number;
	question: string;
	images?: ImageInput[];
	mcpConnections?: McpConnection[];
	context: string;
	status: string;
	parentAgentId: number | null;
	createdByToolCallId: number | null;
	creationArguments: Record<string, unknown> | null;
	answer?: string | null;
	errorCode?: string;
	errorDetails?: string;
	calls: { id: number; ordinal: number; status: string; errorCode?: string }[];
	toolCalls: ToolCall[];
	output: ReaderItem[];
};

export function AgentContent({
	agent,
	onSelectAgent,
	revision,
	onLayoutChange,
	stopping,
	stopError,
	onStop,
}: {
	agent: AgentDetail | undefined;
	onSelectAgent: (id: number) => void;
	revision: number;
	onLayoutChange: () => void;
	stopping: boolean;
	stopError?: string;
	onStop: () => void;
}) {
	const { t } = useTranslation();
	if (!agent) return null;
	return (
		<>
			{!!agent.mcpConnections?.length && (
				<section
					aria-label={t("mcpConnections")}
					className="mb-4 rounded-md border border-neutral-200 p-3"
				>
					<h3 className="font-semibold">{t("mcpConnections")}</h3>
					{agent.mcpConnections.map((connection) => (
						<div key={connection.id} className="mt-2 break-words">
							<p>
								{connection.name}: {t(`mcpStatus_${connection.status}`)}
							</p>
							{connection.error && (
								<p role="alert" className="whitespace-pre-wrap text-red-700">
									{connection.error}
								</p>
							)}
							{connection.stderr && (
								<details onToggle={onLayoutChange}>
									<summary>{t("mcpDiagnostics")}</summary>
									<pre className="mt-2 whitespace-pre-wrap text-sm">
										{connection.stderr}
									</pre>
								</details>
							)}
						</div>
					))}
				</section>
			)}
			{agent.calls.map((call) => (
				<div key={call.id} data-model-call-id={call.id}>
					<AgentCalls
						agentId={agent.id}
						callId={call.id}
						ordinal={call.ordinal}
						kind="request"
						status={call.status}
						revision={revision}
						onLayoutChange={onLayoutChange}
					/>
					<AgentOutput
						agentId={agent.id}
						callId={call.id}
						status={call.status}
						output={agent.output.filter((item) => item.callId === call.id)}
						revision={revision}
						onLayoutChange={onLayoutChange}
					/>
					<AgentCalls
						agentId={agent.id}
						callId={call.id}
						ordinal={call.ordinal}
						kind="response"
						status={call.status}
						errorCode={call.errorCode}
						revision={revision}
						onLayoutChange={onLayoutChange}
					/>
					{agent.toolCalls
						.filter((tool) => tool.modelCallId === call.id)
						.map((tool) => (
							<ToolCallCard
								key={tool.id}
								call={tool}
								onSelectAgent={onSelectAgent}
								onLayoutChange={onLayoutChange}
							/>
						))}
				</div>
			))}
			{agent.status === "pending" && (
				<span>
					<span role="status">
						{t(stopping ? "agentStopping" : "agentPending")}
					</span>{" "}
					<button
						type="button"
						className="rounded-md border border-neutral-300 px-3 py-2 hover:bg-neutral-100 disabled:opacity-50"
						disabled={stopping}
						onClick={onStop}
					>
						{t("stopAgent")}
					</button>
					{stopError && (
						<span role="alert" className="text-red-700">
							{stopError}
						</span>
					)}
				</span>
			)}
			{agent.status === "cancelled" && (
				<span role="status">{t("agentCancelled")}</span>
			)}
			{agent.status === "failed" && (
				<span role="alert" className="text-red-700">
					{agent.answer && <>{t("agentIncomplete")} </>}
					{t(agent.errorCode ?? "modelRequestFailed")}
					{agent.errorDetails && `\n${agent.errorDetails}`}
				</span>
			)}
		</>
	);
}
