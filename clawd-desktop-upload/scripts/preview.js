#!/usr/bin/env node
// Static server for working on the sprite without launching Electron.
//
//   npm run preview
//   open http://localhost:4176/?demo=1&color=%23D97757&scale=7
//
// `demo=1` cycles the states on a timer. `window.__clawdSetState({status:'waiting'})`
// drives it directly from the console.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'renderer');
const PORT = Number(process.env.PORT) || 4176;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

http
  .createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const file = path.join(ROOT, url === '/' ? 'index.html' : url);

    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  })
  .listen(PORT, '127.0.0.1', () =>
    console.log(`clawd sprite preview on http://localhost:${PORT}/?demo=1&scale=7`)
  );
