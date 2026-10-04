import {
	Fragment,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";

type Call = {
	id: number;
	url: string;
	method: string;
	requestedAt: string;
	status: string;
	requestBody?: string | null;
	responseBody?: string | null;
	httpStatus: number | null;
	durationMs: number | null;
	error: string | null;
	errorCode?: string;
};
type RecordState = {
	open: boolean;
	scrollTop: number;
	calls?: Call[];
	status?: string;
	sourceRevision?: number;
	error: boolean;
	loading: boolean;
	revision: number;
};
// Page lifetime only: switching chats must not discard downloaded records.
const records = new Map<string, RecordState>();
function pretty(body: string) {
	try {
		return JSON.stringify(JSON.parse(body), null, 2);
	} catch {
		return body;
	}
}
function responseEvents(body: string) {
	if (!/^(?:event|data|id|retry):|^:/m.test(body)) return [pretty(body)];
	return body
		.split(/\r?\n\r?\n|\r\r/)
		.filter(Boolean)
		.map((event) => {
			const lines = event.split(/\r\n|\n|\r/);
			const data = lines
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).replace(/^ /, ""))
				.join("\n");
			try {
				const formatted = JSON.stringify(JSON.parse(data), null, 2);
				let inserted = false;
				return lines
					.flatMap((line) => {
						if (!line.startsWith("data:")) return [line];
						if (inserted) return [];
						inserted = true;
						return [`data: ${formatted}`];
					})
					.join("\n");
			} catch {
				return event;
			}
		});
}
export function TurnCalls({
	turnId,
	callId,
	ordinal,
	status,
	kind,
	revision = 0,
	onLayoutChange,
}: {
	turnId: number;
	callId: number;
	ordinal: number;
	status: string;
	kind: "request" | "response";
	revision?: number;
	onLayoutChange: () => void;
}) {
	const { t } = useTranslation();
	useLayoutEffect(onLayoutChange);
	const key = `${turnId}-${callId}-${kind}`;
	let state = records.get(key);
	if (!state) {
		state = {
			open: false,
			scrollTop: 0,
			error: false,
			loading: false,
			revision: 0,
		};
		records.set(key, state);
	}
	const record = state;
	const [, render] = useState(0);
	const [copyError, setCopyError] = useState(false);
	const [copied, setCopied] = useState(false);
	const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const bodyRef = useRef<HTMLDivElement>(null);
	useEffect(() => () => clearTimeout(copyTimer.current), []);
	useLayoutEffect(() => {
		if (record.open && bodyRef.current)
			bodyRef.current.scrollTop = record.scrollTop;
	});
	const parts = record.calls?.flatMap((call) => {
		const body = kind === "request" ? call.requestBody : call.responseBody;
		const metadata =
			kind === "request"
				? `${call.requestedAt} · ${call.method} ${call.url}`
				: [
						call.httpStatus === null ? "" : `HTTP ${call.httpStatus}`,
						call.durationMs === null ? "" : `${call.durationMs}ms`,
					]
						.filter(Boolean)
						.join(" · ");
		return [
			...(metadata ? [{ text: metadata, body: false }] : []),
			...(kind === "response" && body == null
				? [
						{
							text: t(
								call.status === "pending"
									? "responseNotYetReceived"
									: "noResponse",
							),
							body: false,
						},
					]
				: []),
			...(kind === "response" && call.error
				? [
						{
							text: call.errorCode ? t(call.errorCode) : call.error,
							body: false,
						},
					]
				: []),
			...(typeof body === "string"
				? (kind === "response" ? responseEvents(body) : [pretty(body)]).map(
						(text) => ({ text, body: true }),
					)
				: []),
		];
	});
	const displayParts =
		record.calls?.length === 0 ? [{ text: t("noCalls"), body: false }] : parts;
	const communicationText =
		displayParts?.map((part) => part.text).join("\n\n") ?? "";
	const load = useCallback(async () => {
		const readRevision = ++record.revision;
		record.loading = true;
		record.error = false;
		render((value) => value + 1);
		try {
			const response = await fetch(
				`/api/turns/${turnId}/calls?kind=${kind}&callId=${callId}`,
			);
			if (!response.ok) throw new Error("Unable to read communication");
			const data = await response.json();
			if (readRevision !== record.revision) return;
			record.calls = data.calls;
			record.status = status;
			record.sourceRevision = revision;
		} catch {
			if (readRevision === record.revision) record.error = true;
		} finally {
			if (readRevision === record.revision) {
				record.loading = false;
				render((value) => value + 1);
			}
		}
	}, [record, status, kind, turnId, callId, revision]);
	useEffect(() => {
		if (
			(record.open || record.calls) &&
			(record.status !== status ||
				(record.status === "pending" && record.sourceRevision !== revision))
		)
			void load();
	}, [status, revision, record, load]);
	return (
		<details
			data-reading-anchor={key}
			open={record.open}
			className="mt-2 rounded-md bg-neutral-50 px-3 py-2 text-sm"
			onToggle={(event) => {
				record.open = event.currentTarget.open;
				render((value) => value + 1);
				if (record.open && !record.calls && !record.loading) void load();
			}}
		>
			<summary className="cursor-pointer text-neutral-600 hover:text-neutral-950">
				<span className="inline-flex w-[calc(100%-1.25rem)] items-center gap-2">
					<span>
						{t(kind)} {ordinal}
						{kind === "response" &&
							status === "failed" &&
							` · ${t("callFailed")}`}
					</span>
					{kind === "response" && status === "pending" && (
						<span
							role="status"
							aria-label={t("turnPending")}
							className="h-4 w-4 rounded-full border-2 border-neutral-300 border-t-neutral-600 motion-safe:animate-spin"
						/>
					)}
					{status !== "pending" && record.calls && (
						<button
							type="button"
							aria-label={t("copy")}
							title={t("copy")}
							className="ml-auto rounded p-1 hover:bg-neutral-200"
							onClick={async (event) => {
								event.preventDefault();
								event.stopPropagation();
								try {
									await navigator.clipboard.writeText(communicationText);
									setCopyError(false);
									setCopied(true);
									clearTimeout(copyTimer.current);
									copyTimer.current = setTimeout(() => setCopied(false), 1500);
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
					<span role="alert" className="block whitespace-pre-wrap">
						{t("copyFailed")}
					</span>
				)}
			</summary>
			{record.loading && <p role="status">{t("loading")}</p>}
			{record.error && (
				<div role="alert">
					{t("callsReadFailed")}{" "}
					<button
						type="button"
						className="underline"
						onClick={() => void load()}
					>
						{t("retry")}
					</button>
				</div>
			)}
			<div
				ref={bodyRef}
				className="communication-body"
				onScroll={(event) => {
					if (record.open) record.scrollTop = event.currentTarget.scrollTop;
				}}
			>
				<div className="communication-text mt-3 font-mono text-xs whitespace-pre-wrap">
					{displayParts?.map((part, index) => (
						// Content parts append in display order.
						// biome-ignore lint/suspicious/noArrayIndexKey: parts retain their display order.
						<Fragment key={index}>
							{index > 0 && "\n\n"}
							{part.body ? (
								<pre className="border-l-2 border-neutral-200 pl-2 whitespace-pre-wrap">
									{part.text}
								</pre>
							) : (
								<p>{part.text}</p>
							)}
						</Fragment>
					))}
				</div>
			</div>
		</details>
	);
}
