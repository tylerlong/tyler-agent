import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export type ToolCall = {
	id: number;
	agentId: number;
	modelCallId: number;
	callId: string;
	name: string;
	ordinal: number;
	status:
		| "waiting"
		| "running"
		| "succeeded"
		| "failed"
		| "not_executed"
		| "interrupted";
	reason: string | null;
	child?: {
		id: number;
		status: string;
		promptSummary: string;
		preview: string | null;
	} | null;
};

import { useToolReader } from "./reader-lifetime.ts";
// Indent original tokens: parsing and reserializing would round numbers and drop duplicate fields.
export function prettyToolContent(text: string) {
	try {
		JSON.parse(text);
	} catch {
		return text;
	}
	const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}[\],:]|[^\s{}[\],:]+/g) ?? [];
	let depth = 0;
	let result = "";
	const newline = () => `\n${"  ".repeat(depth)}`;
	for (const [index, token] of tokens.entries()) {
		if (token === "{" || token === "[") {
			depth++;
			result += token;
			if (tokens[index + 1] !== "}" && tokens[index + 1] !== "]")
				result += newline();
		} else if (token === "}" || token === "]") {
			depth--;
			if (tokens[index - 1] !== "{" && tokens[index - 1] !== "[")
				result += newline();
			result += token;
		} else if (token === ",") result += token + newline();
		else if (token === ":") result += ": ";
		else result += token;
	}
	return result;
}
type ReadingChoice = { open: boolean; scrollTop: number };
// Page lifetime only: explicit reading choices remain with the display.
const records = new Map<number, ReadingChoice>();
export function ToolCallCard({
	call,
	onSelectAgent,
	onLayoutChange,
}: {
	call: ToolCall;
	onSelectAgent: (id: number) => void;
	onLayoutChange: () => void;
}) {
	const { t } = useTranslation();
	let state = records.get(call.id);
	if (!state) {
		state = {
			open: false,
			scrollTop: 0,
		};
		records.set(call.id, state);
	}
	const choice = state;
	const { record, load } = useToolReader(call, choice);
	const [, render] = useState(0);
	const [copyError, setCopyError] = useState(false);
	const [copied, setCopied] = useState(false);
	const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const bodyRef = useRef<HTMLDivElement>(null);
	useEffect(() => () => clearTimeout(copyTimer.current), []);
	useLayoutEffect(() => {
		if (choice.open && bodyRef.current)
			bodyRef.current.scrollTop = choice.scrollTop;
		onLayoutChange();
	});
	const child = call.child;
	const content = record.content;
	const terminal = call.status !== "waiting" && call.status !== "running";
	const current =
		content?.status === call.status && content.reason === call.reason;
	const parts = content
		? [
				{ text: t("toolArguments"), body: false },
				{ text: prettyToolContent(content.arguments), body: true },
				{ text: t("toolResult"), body: false },
				...(content.result !== null
					? [{ text: prettyToolContent(content.result), body: true }]
					: []),
				...(call.reason ? [{ text: t(call.reason), body: false }] : []),
			]
		: [];
	const toolText = parts.map((part) => part.text).join("\n\n");
	const loading = (
		<span
			role="status"
			aria-label={t("agentPending")}
			className="inline-block h-4 w-4 shrink-0 rounded-full border-2 border-neutral-300 border-t-neutral-600 motion-safe:animate-spin"
		/>
	);
	return (
		<div className="mt-2 rounded-md bg-neutral-50 text-sm">
			<details
				data-tool-call-id={call.id}
				data-reading-anchor={`tool-${call.id}`}
				open={choice.open}
				className="mt-2 rounded-md bg-neutral-50 px-3 py-2 text-sm"
				onToggle={(event) => {
					choice.open = event.currentTarget.open;
					render((value) => value + 1);
					if (choice.open && !record.content && !record.loading) void load();
				}}
			>
				<summary className="cursor-pointer text-neutral-600 hover:text-neutral-950">
					<span className="inline-flex w-[calc(100%-1.25rem)] items-center gap-2">
						<span className="min-w-0 break-words">
							{t("toolCallTitle", { name: call.name })}
							{call.status === "waiting" && ` · ${t("toolWaiting")}`}
							{call.status === "failed" && ` · ${t("toolFailed")}`}
							{call.status === "not_executed" && ` · ${t("toolNotExecuted")}`}
							{call.status === "interrupted" && ` · ${t("toolInterrupted")}`}
						</span>
						{call.status === "running" && loading}
						{terminal && current && !record.loading && !record.error && (
							<button
								type="button"
								aria-label={t("copy")}
								title={t("copy")}
								className="ml-auto shrink-0 rounded p-1 hover:bg-neutral-200"
								onClick={async (event) => {
									event.preventDefault();
									event.stopPropagation();
									try {
										await navigator.clipboard.writeText(toolText);
										setCopyError(false);
										setCopied(true);
										clearTimeout(copyTimer.current);
										copyTimer.current = setTimeout(
											() => setCopied(false),
											1500,
										);
									} catch {
										setCopied(false);
										setCopyError(true);
									}
								}}
							>
								{copied ? (
									<span aria-hidden="true">✓</span>
								) : (
									<svg
										aria-hidden="true"
										width="16"
										height="16"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="1.5"
									>
										<rect x="8" y="8" width="12" height="12" rx="2" />
										<path d="M16 8V4H4v12h4" />
									</svg>
								)}
							</button>
						)}
					</span>
					{copyError && (
						<span
							role="alert"
							className="block whitespace-pre-wrap text-red-700"
						>
							{t("copyFailed")}
						</span>
					)}
				</summary>
				{record.loading && <p role="status">{t("loading")}</p>}
				{record.error && (
					<p role="alert" className="text-red-700">
						{t("toolReadFailed")}{" "}
						<button
							type="button"
							className="underline"
							onClick={() => void load()}
						>
							{t("retry")}
						</button>
					</p>
				)}
				<div
					ref={bodyRef}
					className="communication-body tool-body mt-3"
					onScroll={(event) => {
						if (choice.open) choice.scrollTop = event.currentTarget.scrollTop;
					}}
				>
					<div className="communication-text font-mono text-xs whitespace-pre-wrap">
						{parts.map((part, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: sections keep their display order.
							<Fragment key={index}>
								{index > 0 ? "\n\n" : ""}
								{part.body ? (
									<pre className="whitespace-pre-wrap">{part.text}</pre>
								) : (
									<p>{part.text}</p>
								)}
							</Fragment>
						))}
					</div>
					{call.status === "running" && loading}
				</div>
			</details>
			{child && (
				<div
					data-child-agent-id={child.id}
					className="border-t border-neutral-200 px-3 py-2"
				>
					<button
						type="button"
						onClick={() => onSelectAgent(child.id)}
						className="text-left underline hover:text-blue-800"
					>
						{t("agent")} #{child.id} · {t(`taskStatus_${child.status}`)} ·{" "}
						{t("agentDetails")}
					</button>
					<p className="mt-1 break-words">{child.promptSummary}</p>
					{child.status !== "pending" && (
						<>
							{child.status !== "succeeded" && (
								<p className="mt-1 text-neutral-600">{t("agentIncomplete")}</p>
							)}
							{child.preview && (
								<p
									className="mt-1 line-clamp-2 whitespace-pre-wrap break-words"
									data-child-preview
								>
									{child.preview}
								</p>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}
