import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, appError } from "./api.ts";

export type Approval = {
	toolCallId: number;
	requestId: string;
	status: "pending" | "denied" | "once" | "covered" | "interrupted";
	projectId: number;
	projectName: string;
	chatId: number;
	chatName: string;
	agentId: number;
	name: string;
	arguments: string;
	cwd: string;
	reason: string;
	permissions: {
		paths: { path: string; access: "read" | "write" }[];
		domains: string[];
		localNetwork: boolean;
	};
};

export function ApprovalActions({ approval }: { approval: Approval }) {
	const { t } = useTranslation();
	const [busy, setBusy] = useState(false);
	const [settled, setSettled] = useState(false);
	const [error, setError] = useState("");
	const deciding = useRef(false);
	const statusLabel =
		approval.status === "pending"
			? "approvalWaiting"
			: `approvalStatus_${approval.status}`;
	async function decide(decision: "deny" | "once") {
		if (deciding.current || settled) return;
		deciding.current = true;
		setBusy(true);
		setError("");
		try {
			await api(`/api/approvals/${approval.toolCallId}`, "POST", {
				requestId: approval.requestId,
				decision,
			});
			setSettled(true);
		} catch (cause) {
			setError(appError(cause).code);
		} finally {
			deciding.current = false;
			setBusy(false);
			window.dispatchEvent(new Event("approvals-changed"));
		}
	}
	return (
		<section
			aria-label={t(statusLabel)}
			className="space-y-2 border-t border-neutral-200 p-3 text-sm"
		>
			<p className="font-semibold">{t(statusLabel)}</p>
			<p className="break-words">
				{t("approvalOwner", {
					project: approval.projectName,
					chat: approval.chatName,
					agent: approval.agentId,
				})}
			</p>
			<p>
				{t("toolCallTitle", { name: approval.name })} #{approval.toolCallId}
			</p>
			<p className="whitespace-pre-wrap break-words">
				{t("approvalReason")}: {approval.reason}
			</p>
			<p className="break-words">
				{t("approvalCwd")}: {approval.cwd}
			</p>
			<p>{t("toolArguments")}</p>
			<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
				{approval.arguments}
			</pre>
			<p className="font-semibold">{t("approvalPermissions")}</p>
			<ul className="list-inside list-disc break-words">
				{approval.permissions.paths.map(({ path, access }) => (
					<li key={`${access}:${path}`}>
						{t(`approvalAccess_${access}`)}: {path}
					</li>
				))}
				{approval.permissions.domains.map((domain) => (
					<li key={domain}>
						{t("approvalDomain")}: {domain}
					</li>
				))}
				{approval.permissions.localNetwork && (
					<li>{t("approvalLocalNetwork")}</li>
				)}
			</ul>
			<p className="text-neutral-600">{t("approvalOnceHelp")}</p>
			{error && (
				<p role="alert" className="text-red-700">
					{t(error, { defaultValue: t("requestFailed") })}
				</p>
			)}
			{settled || approval.status !== "pending" ? (
				<p role="status">{t(settled ? "approvalSettled" : statusLabel)}</p>
			) : (
				<div className="flex gap-2">
					<button
						type="button"
						disabled={busy}
						className="rounded border px-3 py-2 disabled:opacity-50"
						onClick={() => void decide("deny")}
					>
						{t("approvalDeny")}
					</button>
					<button
						type="button"
						disabled={busy}
						className="rounded border px-3 py-2 disabled:opacity-50"
						onClick={() => void decide("once")}
					>
						{t("approvalOnce")}
					</button>
				</div>
			)}
		</section>
	);
}

export function ApprovalInbox({
	approvals,
	error,
	refresh,
}: {
	approvals: Approval[];
	error: string;
	refresh: () => void;
}) {
	const { t } = useTranslation();
	const dialog = useRef<HTMLDialogElement>(null);
	return (
		<>
			<button
				type="button"
				className="mt-2 rounded px-3 py-2 text-left hover:bg-neutral-100"
				onClick={() => {
					refresh();
					dialog.current?.showModal();
				}}
			>
				{t("approvalEntry", { count: approvals.length })}
			</button>
			<dialog
				ref={dialog}
				closedby="any"
				aria-labelledby="approvals-title"
				className="m-auto max-h-[85dvh] w-full max-w-2xl overflow-auto rounded-lg border border-neutral-300 bg-white p-4 backdrop:bg-black/40"
			>
				<header className="mb-3 flex items-center justify-between gap-3">
					<h2 id="approvals-title" className="text-lg font-semibold">
						{t("approvalEntry", { count: approvals.length })}
					</h2>
					<button
						type="button"
						className="rounded border px-3 py-2"
						onClick={() => dialog.current?.close()}
					>
						{t("close")}
					</button>
				</header>
				{error ? (
					<p role="alert" className="text-red-700">
						{t(error, { defaultValue: t("requestFailed") })}{" "}
						<button type="button" className="underline" onClick={refresh}>
							{t("retry")}
						</button>
					</p>
				) : (
					approvals.length === 0 && <p>{t("approvalEmpty")}</p>
				)}
				{approvals.map((approval) => (
					<ApprovalActions key={approval.requestId} approval={approval} />
				))}
			</dialog>
		</>
	);
}
