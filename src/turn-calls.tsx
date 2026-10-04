import { useCallback, useEffect, useLayoutEffect, useState } from "react";
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
};
type RecordState = {
	open: boolean;
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
		state = { open: false, error: false, loading: false, revision: 0 };
		records.set(key, state);
	}
	const record = state;
	const [, render] = useState(0);
	const [copyError, setCopyError] = useState(false);
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
				{t(kind)} {ordinal}
				{kind === "response" &&
					` · ${t(status === "pending" ? "turnPending" : status === "failed" ? "callFailed" : "callCompleted")}`}
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
			{record.calls?.length === 0 && <p>{t("noCalls")}</p>}
			{record.calls?.map((call) => {
				const body = kind === "request" ? call.requestBody : call.responseBody;
				return (
					<div key={call.id} className="mt-3 min-w-0">
						<p className="break-all font-mono text-xs">
							{kind === "request"
								? `${call.requestedAt} · ${call.method} ${call.url}`
								: `${call.httpStatus === null ? "" : `HTTP ${call.httpStatus} · `}${call.durationMs === null ? "" : `${call.durationMs}ms`}`}
						</p>
						{kind === "response" &&
							call.status === "pending" &&
							body == null && <p>{t("responseNotYetReceived")}</p>}
						{kind === "response" &&
							call.status !== "pending" &&
							body === null && <p>{t("noResponse")}</p>}
						{kind === "response" && call.error && (
							<p className="whitespace-pre-wrap break-words">{call.error}</p>
						)}
						{typeof body === "string" && (
							<>
								<button
									type="button"
									className="my-2 rounded px-2 py-1 hover:bg-neutral-200"
									onClick={async () => {
										try {
											await navigator.clipboard.writeText(body);
											setCopyError(false);
										} catch {
											setCopyError(true);
										}
									}}
								>
									{t("copy")}
								</button>
								{(kind === "response"
									? responseEvents(body)
									: [pretty(body)]
								).map((event, index) => (
									<pre
										data-reading-anchor={`${key}-${call.id}-${index}`}
										// SSE frames only append; their position is their identity.
										// biome-ignore lint/suspicious/noArrayIndexKey: existing frames never reorder.
										key={`${call.id}-${index}`}
										className="mb-2 border-l-2 border-neutral-200 pl-2 overflow-x-auto whitespace-pre-wrap break-words text-xs"
									>
										{event}
									</pre>
								))}
							</>
						)}
					</div>
				);
			})}
			{copyError && <p role="alert">{t("copyFailed")}</p>}
		</details>
	);
}
