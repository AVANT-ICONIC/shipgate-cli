import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export function tempRepo() { return fs.mkdtempSync(path.join(os.tmpdir(), 'green-room-')); }
export function put(root, rel, text) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; }
