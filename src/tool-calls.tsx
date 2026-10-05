import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";

export type ToolCall = {
	id: number;
	turnId: number;
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
};
type ToolContent = ToolCall & { arguments: string; result: string | null };
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
export function ToolCallCard({
	call,
	onLayoutChange,
}: {
	call: ToolCall;
	onLayoutChange: () => void;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(true);
	const [content, setContent] = useState<ToolContent>();
	const [error, setError] = useState(false);
	const revision = useRef(0);
	useLayoutEffect(onLayoutChange);
	const load = useCallback(async () => {
		const reading = ++revision.current;
		setError(false);
		try {
			const response = await fetch(
				`/api/turns/${call.turnId}/tools?toolId=${call.id}`,
			);
			if (!response.ok) throw new Error("Unable to read tool record");
			const data = await response.json();
			if (reading === revision.current) setContent(data.toolCalls[0]);
		} catch {
			if (reading === revision.current) setError(true);
		}
	}, [call.turnId, call.id]);
	useEffect(() => {
		if (content?.status !== call.status) void load();
		return () => {
			revision.current++;
		};
	}, [load, call.status, content?.status]);
	const loading = (
		<span
			role="status"
			aria-label={t("turnPending")}
			className="inline-block h-4 w-4 rounded-full border-2 border-neutral-300 border-t-neutral-600 motion-safe:animate-spin"
		/>
	);
	return (
		<details
			data-tool-call-id={call.id}
			data-reading-anchor={`tool-${call.id}`}
			open={open}
			className="mt-2 rounded-md bg-neutral-50 px-3 py-2 text-sm"
			onToggle={(event) => setOpen(event.currentTarget.open)}
		>
			<summary className="cursor-pointer text-neutral-600 hover:text-neutral-950">
				<span className="inline-flex items-center gap-2">
					<span>{call.name}</span>
					{call.status === "waiting" && ` · ${t("toolWaiting")}`}
					{call.status === "running" && loading}
					{call.status === "failed" && ` · ${t("toolFailed")}`}
				</span>
			</summary>
			{error && (
				<p role="alert">
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
			<div className="communication-body tool-body mt-3">
				<p>{t("toolArguments")}</p>
				<pre className="font-mono text-xs whitespace-pre-wrap">
					{content ? prettyToolContent(content.arguments) : t("loading")}
				</pre>
				<p className="mt-3">{t("toolResult")}</p>
				{call.status === "running" ? (
					loading
				) : content?.result !== null && content?.result !== undefined ? (
					<pre className="font-mono text-xs whitespace-pre-wrap">
						{prettyToolContent(content.result)}
					</pre>
				) : null}
			</div>
		</details>
	);
}
