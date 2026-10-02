import { useCallback, useEffect, useState } from "react";
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
export function TurnCalls({
	turnId,
	status,
	kind,
}: {
	turnId: number;
	status: string;
	kind: "request" | "response";
}) {
	const { t } = useTranslation();
	const key = `${turnId}-${kind}`;
	let state = records.get(key);
	if (!state) {
		state = { open: false, error: false, loading: false, revision: 0 };
		records.set(key, state);
	}
	const record = state;
	const [, render] = useState(0);
	const [copyError, setCopyError] = useState(false);
	const load = useCallback(async () => {
		const revision = ++record.revision;
		record.loading = true;
		record.error = false;
		render((value) => value + 1);
		try {
			const response = await fetch(`/api/turns/${turnId}/calls?kind=${kind}`);
			if (!response.ok) throw new Error("Unable to read communication");
			const data = await response.json();
			if (revision !== record.revision) return;
			record.calls = data.calls;
			record.status = status;
		} catch {
			if (revision === record.revision) record.error = true;
		} finally {
			if (revision === record.revision) {
				record.loading = false;
				render((value) => value + 1);
			}
		}
	}, [record, status, kind, turnId]);
	useEffect(() => {
		if ((record.open || record.calls) && record.status !== status) void load();
	}, [status, record, load]);
	return (
		<details
			open={record.open}
			className="mt-2 rounded-md bg-neutral-50 px-3 py-2 text-sm"
			onToggle={(event) => {
				record.open = event.currentTarget.open;
				render((value) => value + 1);
				if (record.open && !record.calls && !record.loading) void load();
			}}
		>
			<summary className="cursor-pointer text-neutral-600 hover:text-neutral-950">
				{t(kind)}
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
						{record.calls && record.calls.length > 1 && (
							<p>Model Call #{call.id}</p>
						)}
						<p className="break-all font-mono text-xs">
							{kind === "request"
								? `${call.requestedAt} · ${call.method} ${call.url}`
								: `${call.httpStatus === null ? "" : `HTTP ${call.httpStatus} · `}${call.durationMs === null ? "" : `${call.durationMs}ms`}`}
						</p>
						{kind === "response" && call.status === "pending" && (
							<p>{t("turnPending")}</p>
						)}
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
								<pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs">
									{pretty(body)}
								</pre>
							</>
						)}
					</div>
				);
			})}
			{copyError && <p role="alert">{t("copyFailed")}</p>}
		</details>
	);
}
