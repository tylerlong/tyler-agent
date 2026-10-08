import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ text }: { text: string | undefined }) {
	return (
		<div className="markdown">
			<ReactMarkdown skipHtml remarkPlugins={[remarkGfm]}>
				{text ?? ""}
			</ReactMarkdown>
		</div>
	);
}
