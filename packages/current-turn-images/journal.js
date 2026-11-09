import {appendFile, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';

const pageDir = fileURLToPath(new URL('./page/', import.meta.url));
let queue = Promise.resolve();
const histories = new Map();

export function defaultDataDir() {
  const base = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'magpie', 'current-turn-images');
}

export function recordRequest(record, options = {}) {
  const operation = queue.then(async () => {
    const directory = options.dataDir || defaultDataDir();
    const day = record.time.slice(0, 10);
    const path = join(directory, day + '.jsonl');
    await mkdir(directory, {recursive: true});
    let history = histories.get(path);
    if (!history) {
      let rows = [];
      try {
        const text = await readFile(path, 'utf8');
        rows = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      history = {total: rows.length, rows: rows.slice(-500)};
      histories.set(path, history);
    }
    // One append per request, serialized with snapshot updates.
    await appendFile(path, JSON.stringify(record) + '\n', 'utf8');
    history.total++;
    history.rows.push(record);
    if (history.rows.length > 500) history.rows.shift();
    const snapshot = {day, totalRecorded: history.total, records: history.rows.slice().reverse()};
    const temporary = join(pageDir, 'snapshot.' + process.pid + '.tmp');
    await writeFile(temporary, 'window.receiveImageMetrics(' + JSON.stringify(snapshot) + ');\n', 'utf8');
    await rename(temporary, join(pageDir, 'snapshot.js'));
  });
  queue = operation.catch(() => {});
  return operation;
}
