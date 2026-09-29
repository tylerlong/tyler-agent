import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { readFile, stat } from 'node:fs/promises';

const page = new URL('../public/index.html', import.meta.url);

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 8192) throw new Error('请求过大');
  }
  return JSON.parse(body);
}

export function createServer(fetchModel: typeof fetch = fetch) {
  return createHttpServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(await readFile(page));
      return;
    }

    if (request.method === 'POST' && request.url === '/api/task') {
      try {
        const input = await readJson(request);
        if (!input || typeof input !== 'object' || !('folder' in input) || typeof input.folder !== 'string' || !input.folder.trim() || !('prompt' in input) || typeof input.prompt !== 'string' || !input.prompt.trim()) {
          throw new Error('请填写目标文件夹和 prompt');
        }
        let folder;
        try {
          folder = await stat(input.folder);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('目标文件夹不存在');
          throw error;
        }
        if (!folder.isDirectory()) throw new Error('目标路径不是文件夹');
        const apiKey = process.env.OPENROUTER_API_KEY;
        const model = process.env.OPENROUTER_MODEL;
        if (!apiKey || !model) throw new Error('OpenRouter 配置缺失');
        const upstream = await fetchModel('https://openrouter.ai/api/v1/responses', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model, input: input.prompt, stream: false }),
        });
        if (!upstream.ok) throw new Error('OpenRouter 请求失败');
        const data: unknown = await upstream.json();
        const output = data && typeof data === 'object' && 'output' in data ? data.output : null;
        const answer = Array.isArray(output)
          ? output.flatMap((item) => item.type === 'message' && Array.isArray(item.content)
            ? item.content.filter((part: { type?: string; text?: unknown }) => part.type === 'output_text' && typeof part.text === 'string').map((part: { text: string }) => part.text)
            : []).join('\n').trim()
          : '';
        if (!answer) throw new Error('OpenRouter 没有返回文本答案');
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ answer }));
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : '请求无效' }));
      }
      return;
    }

    response.writeHead(404);
    response.end();
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`Open http://127.0.0.1:${port}`);
  });
}
