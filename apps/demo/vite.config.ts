import react from '@vitejs/plugin-react';
import fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
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
    name: 'dev-fs',
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

        // mock fs API
        if (req.url?.startsWith('/fs/') === true) {
          const reqPath = req.url.slice(4);
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
  };
});
