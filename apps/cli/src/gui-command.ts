import { createGuiServer, GUI_DEFAULT_PORT, listenGui, type GuiRun } from './gui.ts';
import type { Io } from './main.ts';

export const GUI_USAGE = 'usage: gui [--port <1..65535, default 4173>]  (local dry-run preview, loopback only; starts nothing, writes nothing)\n';

export function parseGuiArgs(args: readonly string[]): number | string {
  if (args.length === 0) return GUI_DEFAULT_PORT;
  const value = Number(args[1]);
  if (args.length !== 2 || args[0] !== '--port' || !Number.isInteger(value) || value < 0 || value > 65535) return GUI_USAGE;
  return value;
}

/** Serves the GUI until the signal aborts; resolves with the exit code. */
export async function startGui(args: readonly string[], io: Io, deps: { readonly run: GuiRun; readonly signal: AbortSignal }): Promise<number> {
  const port = parseGuiArgs(args);
  if (typeof port === 'string') {
    io.error(port);
    return 2;
  }
  const server = createGuiServer({ run: deps.run });
  let bound: number;
  try {
    bound = await listenGui(server, port);
  } catch {
    io.error('gui: could not listen on that port\n');
    return 1;
  }
  io.out(`Agent Control Lab GUI (dry-run preview only): http://127.0.0.1:${String(bound)}/\nPress Ctrl+C to stop. Nothing is stored.\n`);
  await new Promise<void>((resolve) => {
    if (deps.signal.aborted) resolve();
    deps.signal.addEventListener('abort', () => {
      resolve();
    }, { once: true });
  });
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  return 0;
}
