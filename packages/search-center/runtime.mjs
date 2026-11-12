import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
export const DATA = path.resolve(process.env.SEARCH_CENTER_DATA_DIR || path.join(os.homedir(), '.magpie-search-center'));
export const PORT = Number(process.env.SEARCH_CENTER_PORT || 3479);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error('SEARCH_CENTER_PORT must be 1024–65535');
export function pythonCommand() {
  if (process.env.SEARCH_CENTER_PYTHON) return {file:process.env.SEARCH_CENTER_PYTHON,args:[]};
  const local = path.join(DATA, 'venv', 'Scripts', 'python.exe');
  if (fs.existsSync(local)) return {file:local,args:[]};
  return {file:'py',args:['-3']};
}
export const MAGPIE_HOME = path.resolve(process.env.MAGPIE_HOME || path.join(os.homedir(), '.config', 'magpie'));
export const MAGPIE_BIN = process.env.MAGPIE_BIN || 'magpie';
