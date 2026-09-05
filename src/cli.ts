import { helpText, parseArgs, readVersion, validateServeArgs } from "./args.ts";
import { CtlError, restartDaemon, startDaemon, statusDaemon, stopDaemon } from "./ctl.ts";
import { runDaemon } from "./daemon.ts";
import { dataDir, ensureDataDir } from "./paths.ts";
import { hasAnyConfigFile, maybeCreateStarterConfig } from "./config.ts";

async function ensureDataDirWarn(): Promise<void> {
  const err = await ensureDataDir();
  if (err) {
    process.stderr.write(
      `Warning: cannot create data dir ${dataDir()}: ${err} (pidfile/logging may fail)\n`,
    );
  }
}

export async function main(argv: string[]): Promise<void> {
  const version = await readVersion();
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`Error: ${parsed.error}\n\n${helpText(version)}`);
    process.exit(2);
  }
  const command = parsed.command;
  if (parsed.help || (!command && !parsed.version)) {
    process.stdout.write(helpText(version));
    process.exit(0);
  }
  if (parsed.version) {
    process.stdout.write(`lightserver v${version}\n`);
    process.exit(0);
  }
  if (!command) {
    process.stdout.write(helpText(version));
    process.exit(0);
  }

  const cwd = process.cwd();

  if (command === "dev") {
    await runDaemon({ mode: "dev", argv, version });
    return;
  }

  if (command === "start") {
    const serveError = validateServeArgs(parsed);
    if (serveError) {
      process.stderr.write(`Error: ${serveError}\n`);
      process.exit(2);
    }
    if (parsed.foreground) {
      await runDaemon({ mode: "foreground", argv, version });
      return;
    }
    await ensureDataDirWarn();
    if (!parsed.explicitConfig && !(await hasAnyConfigFile(cwd))) {
      const created = await maybeCreateStarterConfig(dataDir(), []);
      if (created) {
        process.stdout.write(`Created starter config: ${created}\n`);
      }
    }
    const idx = argv.indexOf("start");
    const serveArgv = [...argv.slice(0, idx), ...argv.slice(idx + 1)];
    try {
      const started = await startDaemon({ cwd, serveArgv });
      process.stdout.write(
        `lightserver started (pid ${started.pid}, http://${started.host}:${started.port})\n` +
          `stop with: lightserver stop\n`,
      );
    } catch (e) {
      if (e instanceof CtlError) {
        process.stderr.write(`Error: ${e.message}\n`);
        process.exit(e.code);
      }
      throw e;
    }
    return;
  }

  if (command === "stop") {
    try {
      process.stdout.write((await stopDaemon()) + "\n");
    } catch (e) {
      if (e instanceof CtlError) {
        process.stderr.write(`Error: ${e.message}\n`);
        process.exit(e.code);
      }
      throw e;
    }
    return;
  }

  if (command === "restart") {
    const idx = argv.indexOf("restart");
    const serveArgv = [...argv.slice(0, idx), ...argv.slice(idx + 1)];
    if (serveArgv.length > 0) {
      const reParsed = parseArgs(serveArgv);
      const err = reParsed.error ?? validateServeArgs(reParsed);
      if (err) {
        process.stderr.write(`Error: ${err}\n`);
        process.exit(2);
      }
    }
    await ensureDataDirWarn();
    try {
      const r = await restartDaemon({ cwd, serveArgv });
      process.stdout.write(
        `lightserver restarted (pid ${r.pid}, http://${r.host}:${r.port})` +
          (r.restarted ? "\n" : " (was not running; started fresh)\n"),
      );
    } catch (e) {
      if (e instanceof CtlError) {
        process.stderr.write(`Error: ${e.message}\n`);
        process.exit(e.code);
      }
      throw e;
    }
    return;
  }

  if (command === "status") {
    const st = statusDaemon();
    process.stdout.write(st.message + "\n");
    process.exit(st.running ? 0 : 1);
  }
}
