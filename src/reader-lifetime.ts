import { useCallback, useEffect, useState } from "react";
import type { ToolCall } from "./tool-calls.tsx";

type Call = {
	id: number;
	url: string;
	method: string;
	requestedAt: string;
	status: string;
	requestBody?: string | null;
	responseBody?: string | null;
	partialOutput?: unknown[];
	httpStatus: number | null;
	durationMs: number | null;
	error: string | null;
	errorCode?: string;
};
export type ReaderItem = {
	id: string;
	callId: number;
	index: number;
	type: string;
	content: { index: number; type: string; text?: string }[];
};
type ReadState = { error: boolean; loading: boolean; revision: number };
function initialRead(): ReadState {
	return { error: false, loading: false, revision: 0 };
}
function cached<K, V>(cache: Map<K, V>, key: K, create: () => V): V {
	let record = cache.get(key);
	if (!record) {
		record = create();
		cache.set(key, record);
	}
	return record;
}
// Every body read shares sequence protection; each concrete reader owns its lifetime.
async function read<T>(
	record: ReadState,
	download: () => Promise<T>,
	accept: (data: T) => void,
	render: () => void,
	clearError = true,
) {
	const reading = ++record.revision;
	record.loading = true;
	if (clearError) record.error = false;
	render();
	try {
		const data = await download();
		if (reading !== record.revision) return;
		accept(data);
		record.error = false;
	} catch {
		if (reading === record.revision) record.error = true;
	} finally {
		if (reading === record.revision) {
			record.loading = false;
			render();
		}
	}
}
async function json(url: string) {
	const response = await fetch(url);
	if (!response.ok) throw new Error("Unable to read record");
	return response.json();
}
type Communication = ReadState & {
	calls?: Call[];
	status?: string;
	sourceRevision?: number;
};
// Page-local downloads and communication/tool errors survive navigation until refresh.
const communications = new Map<string, Communication>();
export function useCommunicationReader(
	agentId: number,
	callId: number,
	kind: "request" | "response",
	status: string,
	revision: number,
	choice: { open: boolean },
) {
	const record = cached<string, Communication>(
		communications,
		`${agentId}-${callId}-${kind}`,
		initialRead,
	);
	const [, update] = useState(0);
	const load = useCallback(
		() =>
			read(
				record,
				() =>
					json(`/api/agents/${agentId}/calls?kind=${kind}&callId=${callId}`),
				(data) => {
					record.calls = data.calls;
					record.status = status;
					record.sourceRevision = revision;
				},
				() => update((value) => value + 1),
			),
		[record, agentId, callId, kind, status, revision],
	);
	useEffect(() => {
		if (
			(choice.open || record.calls) &&
			(record.status !== status ||
				(record.status === "pending" && record.sourceRevision !== revision))
		)
			void load();
		// Communication reads may still populate the page cache after unmount.
	}, [status, revision, record, load, choice]);
	return { record, load };
}
type ReasoningDownload = {
	output: ReaderItem[];
	status: string;
	stamp: string;
};
const reasoningDownloads = new Map<string, ReasoningDownload>();
export function useReasoningReader(
	agentId: number,
	callId: number,
	status: string,
	revision: number,
	expanded: boolean,
	count: number,
) {
	const cacheKey = `${agentId}-${callId}`;
	const [download, setDownload] = useState(() =>
		reasoningDownloads.get(cacheKey),
	);
	// Errors and Retry stamps belong to this mount; only accepted content is page-local.
	const [record] = useState(initialRead);
	const [, update] = useState(0);
	const [retry, setRetry] = useState(0);
	useEffect(() => {
		const downloaded = reasoningDownloads.get(cacheKey);
		if (!count || (!expanded && !downloaded)) return;
		const stamp = `${revision}-${retry}`;
		if (
			downloaded &&
			downloaded.status === status &&
			(downloaded.status !== "pending" || downloaded.stamp === stamp)
		)
			return;
		void read(
			record,
			() => json(`/api/agents/${agentId}/reasoning?callId=${callId}`),
			(data) => {
				const next = { output: data.output as ReaderItem[], status, stamp };
				reasoningDownloads.set(cacheKey, next);
				setDownload(next);
			},
			() => update((value) => value + 1),
			false,
		);
		return () => {
			record.revision++;
		};
	}, [
		agentId,
		callId,
		cacheKey,
		status,
		revision,
		expanded,
		count,
		retry,
		record,
	]);
	return {
		download,
		error: record.error,
		retry: () => setRetry((value) => value + 1),
	};
}
type ToolContent = ToolCall & {
	arguments: string;
	result: string | null;
	output?: { ordinal: number; stream: string; text: string }[];
};
type ToolRecord = ReadState & { content?: ToolContent };
const tools = new Map<number, ToolRecord>();
export function useToolReader(call: ToolCall, choice: { open: boolean }) {
	const record = cached<number, ToolRecord>(tools, call.id, initialRead);
	const [, update] = useState(0);
	const load = useCallback(
		() =>
			read(
				record,
				async () => {
					const data = await json(
						`/api/agents/${call.agentId}/tools?toolId=${call.id}`,
					);
					if (!data.toolCalls?.[0]) throw new Error("Missing tool record");
					return data.toolCalls[0] as ToolContent;
				},
				(content) => {
					record.content = content;
				},
				() => update((value) => value + 1),
			),
		[call.agentId, call.id, record],
	);
	useEffect(() => {
		if (
			(choice.open || record.content) &&
			(record.content?.status !== call.status ||
				record.content?.reason !== call.reason)
		)
			void load();
		return () => {
			record.revision++;
			record.loading = false;
		};
	}, [load, call.status, call.reason, record, choice]);
	return { record, load };
}
