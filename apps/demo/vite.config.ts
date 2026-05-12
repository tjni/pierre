import type { GitStatus, GitStatusEntry } from '@pierre/trees';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { execFileSync } from 'node:child_process';
import path, { resolve } from 'path';
import { Readable } from 'stream';
import { ReadableStream } from 'stream/web';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import { createLogger, defineConfig, type Logger } from 'vite';

const projectDir = resolve(__dirname, '../../');

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeFilteredLogger(folder: string): Logger {
  const base = createLogger();

  const folderPattern = escapeRegExp(path.normalize(folder)).replace(
    /\\+/g,
    '[\\\\/]+'
  );

  const noisyMsg = new RegExp(`page reload\\b[\\s\\S]*${folderPattern}`, 'i');

  const passthrough = <T extends keyof Logger>(m: T) =>
    // oxlint-disable-next-line typescript/no-explicit-any, typescript/no-unsafe-return
    ((...args: any[]) => (base[m] as any)(...args)) as Logger[T];

  return {
    ...base,
    info(msg, opts) {
      if (msg.includes('packages/diffs/dist/index.js')) {
        base.info(
          '\x1b[32mpage reload\x1b[0m @pierre/diffs update detected',
          opts
        );
      } else if (noisyMsg.test(msg)) {
        return;
      } else {
        base.info(msg, opts);
      }
    },
    // everything else passes through
    warn: passthrough('warn'),
    error: passthrough('error'),
    warnOnce: passthrough('warnOnce'),
    clearScreen: passthrough('clearScreen'),
    hasWarned: base.hasWarned,
    // oxlint-disable-next-line typescript/no-explicit-any
    hasErrorLogged: (base as any).hasErrorLogged,
  };
}

function readProjectDirSync(dir: string, basePath: string = dir): string[] {
  const fullPath = path.join(projectDir, dir);
  const entries = fs.readdirSync(fullPath, { withFileTypes: true });
  return entries
    .map((entry) => {
      if (
        entry.name.startsWith('.') ||
        entry.name === 'dist' ||
        entry.name === 'node_modules'
      ) {
        return [];
      }
      if (entry.isDirectory()) {
        return readProjectDirSync(path.join(dir, entry.name), basePath);
      }
      const relPath = path.join(dir, entry.name);
      return path.relative(basePath, relPath);
    })
    .flat(Infinity) as string[];
}

function unquoteGitPath(segment: string): string {
  if (segment.length >= 2 && segment.startsWith('"') && segment.endsWith('"')) {
    return segment.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return segment;
}

function getGitStatus(repoRoot: string, pathspec: string): GitStatusEntry[] {
  const args = ['-C', repoRoot, 'status', '--porcelain=v1', '-uall'];
  if (pathspec.length > 0) {
    args.push('--', pathspec);
  }
  const out = execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  const entries: GitStatusEntry[] = [];
  for (const rawLine of out.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith('??')) {
      const p = unquoteGitPath(line.slice(3).trimStart());
      if (p.length > 0) {
        entries.push({ path: p, status: 'untracked' });
      }
      continue;
    }
    if (line.length < 4 || line[2] !== ' ') {
      continue;
    }
    const x = line[0];
    const y = line[1];
    let rest = line.slice(3);
    const renameSep = ' -> ';
    const renameIdx = rest.includes(renameSep)
      ? rest.lastIndexOf(renameSep)
      : -1;
    if (renameIdx >= 0 && (x === 'R' || y === 'R' || x === 'C' || y === 'C')) {
      const newPath = unquoteGitPath(
        rest.slice(renameIdx + renameSep.length).trim()
      );
      if (newPath.length > 0) {
        entries.push({ path: newPath, status: 'renamed' });
      }
      continue;
    }
    rest = rest.trimEnd();
    let filePath = unquoteGitPath(rest);
    if (filePath.length === 0) {
      continue;
    }
    if (filePath.startsWith(pathspec + '/')) {
      filePath = filePath.slice(pathspec.length + 1);
    }
    const letter =
      y !== ' ' && y !== '.' ? y : x !== ' ' && x !== '.' ? x : null;
    let status: GitStatus | null = null;
    switch (letter) {
      case 'M':
        status = 'modified';
        break;
      case 'A':
        status = 'added';
        break;
      case 'D':
        status = 'deleted';
        break;
      case 'R':
      case 'C':
        status = 'renamed';
        break;
      case 'U':
      case 'T':
        status = 'modified';
        break;
    }
    if (status != null) {
      entries.push({ path: filePath, status });
    }
  }
  return entries;
}

export default defineConfig(() => {
  const htmlPlugin = (): Plugin => ({
    name: 'html-fallback',
    configureServer(server: ViteDevServer) {
      const handleRoutes = async (
        req: IncomingMessage,
        res: ServerResponse,
        next: () => void
      ) => {
        // Handle root path - serve vanilla version
        if (req.url === '/' || req.url === '/index.html') {
          const htmlPath = resolve(__dirname, 'index.html');
          try {
            const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
            const html = await server.transformIndexHtml('/', htmlContent);
            res.setHeader('Content-Type', 'text/html');
            res.end(html);
            return;
          } catch (e) {
            console.error('Error transforming HTML:', e);
          }
        }

        next();
      };

      // oxlint-disable-next-line typescript/no-misused-promises
      server.middlewares.use('/', handleRoutes);
    },
    configurePreviewServer(server: PreviewServer) {
      const handleRoutes = async (
        req: IncomingMessage,
        res: ServerResponse,
        next: () => void
        // oxlint-disable-next-line typescript/require-await
      ) => {
        // Handle root path - serve vanilla version
        if (req.url === '/' || req.url === '/index.html') {
          const htmlPath = resolve(__dirname, 'dist/index.html');
          try {
            const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
            res.setHeader('Content-Type', 'text/html');
            res.end(htmlContent);
            return;
          } catch (e) {
            console.error('Error serving HTML:', e);
          }
        }

        next();
      };

      // oxlint-disable-next-line typescript/no-misused-promises
      server.middlewares.use('/', handleRoutes);
    },
  });

  const editorDevPlugin = (): Plugin => ({
    name: 'editor-dev',
    configureServer(server: ViteDevServer) {
      const handleRoutes = async (
        req: IncomingMessage,
        res: ServerResponse,
        next: () => void
      ) => {
        if (req.url === '/editor') {
          const htmlPath = resolve(__dirname, 'editor.html');
          try {
            const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
            const html = await server.transformIndexHtml(
              '/editor',
              htmlContent
            );
            res.setHeader('Content-Type', 'text/html');
            res.end(html);
            return;
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(
              +'Error transforming HTML:' +
                (e instanceof Error ? e.message : String(e))
            );
          }
        }

        const pathname = req.url?.split('?')[0] ?? '';
        if (pathname === '/git-status' || pathname.startsWith('/git-status/')) {
          if (req.method !== 'GET') {
            res.writeHead(405, { 'Content-Type': 'text/plain' });
            res.end('Method not allowed');
            return;
          }
          try {
            const encoded =
              pathname === '/git-status'
                ? ''
                : pathname.slice('/git-status/'.length);
            const rel = decodeURIComponent(encoded);
            const absTarget = path.resolve(projectDir, rel);
            const rootResolved = path.resolve(projectDir);
            const isUnderRoot =
              absTarget === rootResolved ||
              absTarget.startsWith(rootResolved + path.sep);
            if (isUnderRoot !== true) {
              res.writeHead(403, { 'Content-Type': 'text/plain' });
              res.end('Path outside repository root');
              return;
            }
            const pathspec = rel.split(path.sep).join('/');
            const entries: GitStatusEntry[] = getGitStatus(
              projectDir,
              pathspec
            );
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(entries));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(e instanceof Error ? e.message : String(e));
          }
          return;
        }

        if (pathname.startsWith('/fs/')) {
          const reqPath = pathname.slice(4);
          try {
            switch (req.method) {
              case 'GET':
                {
                  const stat = fs.lstatSync(path.join(projectDir, reqPath));
                  if (stat.isDirectory()) {
                    const enties = readProjectDirSync(reqPath);
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify(enties));
                  } else {
                    const stream = fs.createReadStream(
                      path.join(projectDir, reqPath)
                    );
                    res.setHeader('Content-Type', 'text/plain');
                    for await (const chunk of stream) {
                      res.write(chunk);
                    }
                    res.end();
                  }
                }
                break;

              case 'POST':
                {
                  const stream = new ReadableStream({
                    start(controller) {
                      req.on('data', (chunk) => {
                        controller.enqueue(chunk);
                      });
                      req.on('end', () => {
                        controller.close();
                      });
                    },
                  });
                  const writer = fs.createWriteStream(
                    path.join(projectDir, reqPath)
                  );
                  Readable.fromWeb(stream).pipe(writer);
                  res.setHeader('Content-Type', 'text/plain');
                  res.end('File created');
                }
                break;

              case 'DELETE':
                {
                  fs.unlinkSync(path.join(projectDir, reqPath));
                  res.setHeader('Content-Type', 'text/plain');
                  res.end('File deleted');
                }
                break;

              default: {
                res.writeHead(405, { 'Content-Type': 'text/plain' });
                res.end('Method not allowed');
              }
            }
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(e instanceof Error ? e.message : String(e));
          }
          return;
        }

        next();
      };

      // oxlint-disable-next-line typescript/no-misused-promises
      server.middlewares.use('/', handleRoutes);
    },
  });

  return {
    plugins: [react(), htmlPlugin(), editorDevPlugin()],
    customLogger: makeFilteredLogger('packages/diffs'),
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
        },
      },
    },
    server: {
      hmr: !process.env.NO_HMR,
    },
  };
});
