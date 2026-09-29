import { type FormEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Message = { role: "user" | "assistant"; content: string };
type ChatState = { messages: Message[]; folder: string | null };

async function fetchChat(): Promise<ChatState> {
	const response = await fetch("/api/chat");
	if (!response.ok) throw new Error("读取对话失败");
	return response.json();
}

async function fetchDebug(): Promise<boolean> {
	const response = await fetch("/api/debug");
	if (!response.ok) throw new Error("读取日志设置失败");
	const data: { enabled: boolean } = await response.json();
	return data.enabled;
}

function App() {
	const [folder, setFolder] = useState("");
	const folderEdited = useRef(false);
	const [prompt, setPrompt] = useState("");
	const [messages, setMessages] = useState<Message[]>([]);
	const [debugEnabled, setDebugEnabled] = useState<boolean | null>(null);
	const [debugPending, setDebugPending] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		fetchChat()
			.then(({ messages, folder }) => {
				setMessages(messages);
				if (!folderEdited.current) setFolder(folder ?? "");
			})
			.catch(() => setError("读取对话失败，请刷新页面重试"));
		fetchDebug()
			.then(setDebugEnabled)
			.catch(() => setError("读取日志设置失败，请刷新页面重试"));
	}, []);

	async function changeDebug(enabled: boolean) {
		setDebugPending(true);
		setError("");
		try {
			const response = await fetch("/api/debug", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ enabled }),
			});
			if (!response.ok) throw new Error("更新日志设置失败");
			const data: { enabled: boolean } = await response.json();
			setDebugEnabled(data.enabled);
		} catch {
			try {
				setDebugEnabled(await fetchDebug());
				setError("更新日志设置失败，请重试");
			} catch {
				setDebugEnabled(null);
				setError("无法确认日志设置，请刷新页面");
			}
		} finally {
			setDebugPending(false);
		}
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setSubmitting(true);
		setError("");
		try {
			const response = await fetch("/api/task", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ folder, prompt }),
			});
			const data: { error?: string } = await response.json();
			if (!response.ok) throw new Error(data.error || "请求失败");
			setMessages((await fetchChat()).messages);
			setPrompt("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "请求失败");
		} finally {
			setSubmitting(false);
		}
	}

	const control =
		"mt-2 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";

	return (
		<main className="mx-auto max-w-2xl px-4 py-10 text-slate-900">
			<h1 className="text-3xl font-semibold">Tyler Agent</h1>
			<p className="mt-3 text-slate-700">
				输入
				prompt，可在同一段共享对话中继续追问。目标文件夹目前只用于确认路径有效，不会读取或修改文件。
			</p>
			<fieldset
				className="mt-6 rounded-md border border-slate-300 p-4 disabled:opacity-60"
				disabled={debugEnabled === null || debugPending}
			>
				<legend className="px-1 font-medium">
					OpenRouter 调试日志（服务端 terminal）
				</legend>
				<div className="flex gap-6">
					{[
						{ label: "关闭", enabled: false },
						{ label: "开启", enabled: true },
					].map(({ label, enabled }) => (
						<label key={label} className="flex items-center gap-2">
							<input
								type="radio"
								name="debug"
								value={String(enabled)}
								checked={debugEnabled === enabled}
								onChange={() => changeDebug(enabled)}
							/>
							{label}
						</label>
					))}
				</div>
			</fieldset>
			<form className="mt-6 space-y-4" onSubmit={submit}>
				<label className="block font-medium">
					目标文件夹（运行服务的电脑上的路径）
					<input
						className={control}
						name="folder"
						value={folder}
						onChange={(event) => {
							folderEdited.current = true;
							setFolder(event.target.value);
						}}
						required
					/>
				</label>
				<label className="block font-medium">
					Prompt
					<textarea
						className={control}
						name="prompt"
						value={prompt}
						onChange={(event) => setPrompt(event.target.value)}
						required
						rows={4}
					/>
				</label>
				<button
					className="rounded-md bg-blue-700 px-4 py-2 font-medium text-white hover:bg-blue-800 disabled:opacity-60"
					type="submit"
					disabled={submitting}
				>
					{submitting ? "提交中…" : "提交"}
				</button>
			</form>
			<p className="mt-4 text-red-700" role="alert">
				{error}
			</p>
			<section className="mt-8" aria-live="polite">
				<h2 className="text-xl font-semibold">对话</h2>
				<ol className="mt-3 space-y-4">
					{messages.map((message, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: History is append-only and the API has no message ID.
						<li key={`${index}-${message.role}`}>
							<strong>{message.role === "user" ? "你" : "Agent"}</strong>
							<pre className="mt-1 whitespace-pre-wrap break-words rounded-md bg-slate-100 p-3 font-sans">
								{message.content}
							</pre>
						</li>
					))}
				</ol>
			</section>
		</main>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(<App />);
