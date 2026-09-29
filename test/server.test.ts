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

test('valid directory returns a clearly simulated result without changing files', async () => {
  const server = createServer().listen(0, '127.0.0.1');
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

    const response = await fetch(`${base}/api/demo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folder: directory, prompt: 'Fix typos' }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.file, 'example.txt');
    assert.equal(result.before, 'A teh example.');
    assert.equal(result.after, 'A the example.');
    assert.equal(result.notice, '演示结果，未修改文件');
    assert.equal(await readFile(file, 'utf8'), 'A teh example.');
  } finally {
    server.close();
  }
});

test('missing paths and files return clear errors without changing files', async () => {
  const server = createServer().listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    for (const [folder, message] of [
      [join(directory, 'missing'), '目标文件夹不存在'],
      [file, '目标路径不是文件夹'],
    ]) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}/api/demo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folder, prompt: 'Fix typos' }),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: message });
    }
    assert.equal(await readFile(file, 'utf8'), 'A teh example.');
  } finally {
    server.close();
  }
});
