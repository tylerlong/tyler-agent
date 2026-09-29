import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { readFile, stat } from 'node:fs/promises';

const page = new URL('../public/index.html', import.meta.url);

class SafeResponseError extends Error {}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 8192) throw new SafeResponseError('请求过大');
  }
  return JSON.parse(body);
}

export function createServer(fetchModel: typeof fetch = fetch) {
  let debugEnabled = false;
  let callId = 0;
  return createHttpServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(await readFile(page));
      return;
    }

    if (request.url === '/api/debug' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ enabled: debugEnabled }));
      return;
    }

    if (request.url === '/api/debug' && request.method === 'PUT') {
      try {
        const input = await readJson(request);
        if (!input || typeof input !== 'object' || !('enabled' in input) || typeof input.enabled !== 'boolean') {
          throw new SafeResponseError('无效的日志设置');
        }
        debugEnabled = input.enabled;
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ enabled: debugEnabled }));
      } catch {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: '无效的日志设置' }));
      }
      return;
    }

    if (request.method === 'POST' && request.url === '/api/task') {
      try {
        const input = await readJson(request);
        if (!input || typeof input !== 'object' || !('folder' in input) || typeof input.folder !== 'string' || !input.folder.trim() || !('prompt' in input) || typeof input.prompt !== 'string' || !input.prompt.trim()) {
          throw new SafeResponseError('请填写目标文件夹和 prompt');
        }
        let folder;
        try {
          folder = await stat(input.folder);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SafeResponseError('目标文件夹不存在');
          throw new SafeResponseError('无法访问目标文件夹');
        }
        if (!folder.isDirectory()) throw new SafeResponseError('目标路径不是文件夹');
        const apiKey = process.env.OPENROUTER_API_KEY;
        const model = process.env.OPENROUTER_MODEL;
        if (!apiKey || !model) throw new SafeResponseError('OpenRouter 配置缺失');
        const url = 'https://openrouter.ai/api/v1/responses';
        const headers = {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        };
        const body = JSON.stringify({ model, input: input.prompt, stream: false });
        const shouldLog = debugEnabled;
        const id = shouldLog ? ++callId : 0;
        const started = performance.now();
        const escapedKey = JSON.stringify(apiKey).slice(1, -1);
        const redact = (value: unknown) => JSON.stringify(value, (_key, field: unknown) => typeof field === 'string'
          ? field.replaceAll(apiKey, '[REDACTED]').replaceAll(escapedKey, '[REDACTED]')
          : field);
        const responseHeaders = (result: Response) => Object.fromEntries([...result.headers].map(([name, value]) => [
          name.replaceAll(apiKey, '[REDACTED]'),
          /^(?:authorization|proxy-authorization|cookie|set-cookie)$|(?:^|[-_])(?:token|key|secret)$/i.test(name) ? '[REDACTED]' : value,
        ]));
        if (shouldLog) console.log(`[OpenRouter #${id}] request ${redact({ time: new Date().toISOString(), url, method: 'POST', headers: { ...headers, authorization: '[REDACTED]' }, body })}`);
        let upstream: Response | undefined;
        let rawBody: string;
        try {
          upstream = await fetchModel(url, { method: 'POST', headers, body });
          rawBody = await upstream.text();
        } catch (error) {
          if (shouldLog) console.log(`[OpenRouter #${id}] error ${redact({ ...(upstream && { status: upstream.status, headers: responseHeaders(upstream) }), error: String(error), durationMs: Math.round(performance.now() - started) })}`);
          throw error;
        }
        if (shouldLog) {
          console.log(`[OpenRouter #${id}] response ${redact({ status: upstream.status, headers: responseHeaders(upstream), body: rawBody, durationMs: Math.round(performance.now() - started) })}`);
        }
        if (!upstream.ok) throw new SafeResponseError('OpenRouter 请求失败');
        const data: unknown = JSON.parse(rawBody);
        const output = data && typeof data === 'object' && 'output' in data ? data.output : null;
        const answer = Array.isArray(output)
          ? output.flatMap((item) => item.type === 'message' && Array.isArray(item.content)
            ? item.content.filter((part: { type?: string; text?: unknown }) => part.type === 'output_text' && typeof part.text === 'string').map((part: { text: string }) => part.text)
            : []).join('\n').trim()
          : '';
        if (!answer) throw new SafeResponseError('OpenRouter 没有返回文本答案');
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ answer }));
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error instanceof SafeResponseError ? error.message : '请求失败' }));
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
