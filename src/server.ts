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

export function createServer() {
  return createHttpServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(await readFile(page));
      return;
    }

    if (request.method === 'POST' && request.url === '/api/demo') {
      try {
        const input = await readJson(request);
        if (!input || typeof input !== 'object' || !('folder' in input) || typeof input.folder !== 'string' || !input.folder.trim() || !('prompt' in input) || typeof input.prompt !== 'string' || !input.prompt.trim()) {
          throw new Error('请填写目标文件夹和 prompt');
        }
        if (!(await stat(input.folder)).isDirectory()) throw new Error('目标路径不是文件夹');
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          notice: '演示结果，未修改文件',
          file: 'example.txt',
          before: 'A teh example.',
          after: 'A the example.',
        }));
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
