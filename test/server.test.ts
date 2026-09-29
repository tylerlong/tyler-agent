import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createServer } from '../src/server.ts';

const directory = await mkdtemp(join(tmpdir(), 'tyler-agent-'));
const file = join(directory, 'note.txt');
await writeFile(file, 'A teh example.');
after(() => rm(directory, { recursive: true, force: true }));

test('a prompt returns the model answer without sending the folder or changing files', async () => {
  const requests: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const upstream: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return Response.json({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '2' }] }] });
  };
  const server = createServer(upstream).listen(0, '127.0.0.1');
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousModel = process.env.OPENROUTER_MODEL;
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.OPENROUTER_MODEL = 'test-model';
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const page = await fetch(base);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /name="folder"/);
    assert.match(html, /name="prompt"/);
    assert.match(html, /Tyler Agent/);

    const response = await fetch(`${base}/api/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folder: directory, prompt: '1 + 1 = ?' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { answer: '2' });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, 'https://openrouter.ai/api/v1/responses');
    assert.equal(requests[0]?.headers.get('authorization'), 'Bearer test-key');
    assert.deepEqual(requests[0]?.body, { model: 'test-model', input: '1 + 1 = ?', stream: false });
    assert.equal(await readFile(file, 'utf8'), 'A teh example.');
  } finally {
    server.close();
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = previousModel;
  }
});

test('invalid folders are rejected before the model request', async () => {
  let requests = 0;
  const server = createServer(async () => {
    requests++;
    throw new Error('model should not be called');
  }).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    for (const [folder, message] of [
      [join(directory, 'missing'), '目标文件夹不存在'],
      [file, '目标路径不是文件夹'],
    ]) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}/api/task`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folder, prompt: '1 + 1 = ?' }),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: message });
    }
    assert.equal(requests, 0);
    assert.equal(await readFile(file, 'utf8'), 'A teh example.');
  } finally {
    server.close();
  }
});
