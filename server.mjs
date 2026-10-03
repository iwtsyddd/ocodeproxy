import express from "express";
import boxen from "boxen";
import pc from "picocolors";
import * as p from "@clack/prompts";
import readline from "node:readline";
import net from "node:net";

const app = express();
app.use(express.json({ limit: "10mb" }));

process.title = "OCodeProxy";
if (process.stdout.isTTY) {
  process.stdout.write("\x1b]0;OCodeProxy\x07");
}

const PROXY_VERSION = "0.1.0";

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", () => {
        tester.once("close", () => resolve(true)).close();
      })
      .listen(port, "0.0.0.0");
  });
}

const args = process.argv.slice(2);
let cliPort = null;
const portIdx = args.findIndex((arg) => arg === "-p" || arg === "--port");
if (portIdx !== -1 && args[portIdx + 1]) {
  const parsed = Number(args[portIdx + 1]);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    cliPort = parsed;
  }
}

let currentPort = cliPort || (process.env.PROXY_PORT ? Number(process.env.PROXY_PORT) : 6446);
let currentServer = null;

async function promptPortSelection(current) {
  const choice = await p.select({
    message: "Select port:",
    initialValue: String(current),
    options: [
      { value: "6446", label: "6446", hint: "default (OCodeProxy)" },
      { value: "8080", label: "8080", hint: "alternative HTTP port" },
      { value: "3000", label: "3000", hint: "standard dev port" },
      { value: "custom", label: "Custom port...", hint: "manual entry" },
    ],
  });

  if (p.isCancel(choice)) return null;

  if (choice === "custom") {
    const customPort = await p.text({
      message: "Enter port number (1-65535):",
      placeholder: String(current),
      defaultValue: String(current),
      validate(value) {
        const num = Number(value);
        if (!Number.isInteger(num) || num < 1 || num > 65535) {
          return "Port must be an integer between 1 and 65535";
        }
      },
    });

    if (p.isCancel(customPort)) return null;
    return Number(customPort);
  }

  return Number(choice);
}

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    const time = new Date().toLocaleTimeString();
    const statusColor =
      res.statusCode >= 500
        ? pc.red
        : res.statusCode >= 400
        ? pc.yellow
        : res.statusCode >= 300
        ? pc.cyan
        : pc.green;

    console.log(
      `${pc.gray(`[${time}]`)} ` +
      `${pc.bold(pc.cyan(req.method.padEnd(6)))} ` +
      `${req.originalUrl.padEnd(20)} ` +
      `${statusColor(String(res.statusCode))} ` +
      `${pc.dim(`${duration}ms`)}`
    );
  });
  next();
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    version: PROXY_VERSION,
    port: currentPort,
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (_req, res) => {
  res.json({
    name: "OCodeProxy",
    status: "running",
    version: PROXY_VERSION,
    port: currentPort,
    endpoints: ["/health"],
  });
});

function renderBanner(port) {
  const localUrl = `http://localhost:${port}`;
  const networkUrl = `http://0.0.0.0:${port}`;

  const content = [
    `${pc.bold(pc.magenta("⚡ OCodeProxy"))} ${pc.dim(`v${PROXY_VERSION}`)}`,
    "",
    `${pc.bold("Status:")}    ${pc.green("● ONLINE")}`,
    `${pc.bold("Local:")}     ${pc.cyan(localUrl)}`,
    `${pc.bold("Network:")}   ${pc.dim(networkUrl)}`,
    "",
    `${pc.bold("Endpoints:")}`,
    `  ${pc.green("GET")}  /health  ${pc.dim("→ Health & status check")}`,
    `  ${pc.green("GET")}  /        ${pc.dim("→ Root info")}`,
    ...(process.stdin.isTTY
      ? [
          "",
          `${pc.bold("Controls (hot-swap):")}`,
          `  ${pc.yellow("[s]")} ⚙️  Hot-swap port on the fly`,
          `  ${pc.gray("[q]")} 🚪 Stop server`,
        ]
      : []),
  ].join("\n");

  console.log(
    boxen(content, {
      padding: 1,
      margin: 1,
      borderStyle: "round",
      borderColor: "cyan",
    })
  );
}

function startServer(port) {
  const srv = app.listen(port, "0.0.0.0", () => {
    renderBanner(port);
  });

  srv.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(pc.red(`\n✖ Error: port ${port} is already in use.\n`));
      if (!isKeyListening && !process.stdin.isTTY) process.exit(1);
    } else {
      console.error(err);
    }
  });

  return srv;
}

let isKeyListening = false;

function setupKeybindings() {
  if (!process.stdin.isTTY || isKeyListening) return;

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on("keypress", onKeypress);
  isKeyListening = true;
}

function pauseKeybindings() {
  if (!isKeyListening) return;

  process.stdin.removeListener("keypress", onKeypress);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  isKeyListening = false;
}

async function hotSwap() {
  pauseKeybindings();

  p.intro(pc.bgCyan(pc.black(" ⚙️ OCodeProxy Port Hot-Swap ")));
  const newPort = await promptPortSelection(currentPort);

  if (!newPort || newPort === currentPort) {
    if (newPort === currentPort) {
      p.log.warn(`Server is already running on port ${currentPort}.`);
    } else {
      p.log.info("Port change cancelled.");
    }
    setupKeybindings();
    return;
  }

  const available = await isPortAvailable(newPort);
  if (!available) {
    p.log.error(pc.red(`Port ${newPort} is in use by another process. Switch cancelled.`));
    setupKeybindings();
    return;
  }

  const s = p.spinner();
  s.start(`Stopping server on port ${currentPort}...`);

  await new Promise((resolve) => currentServer.close(resolve));

  s.message(`Starting server on port ${newPort}...`);
  currentPort = newPort;
  currentServer = startServer(currentPort);

  s.stop(pc.green(`✔ Server switched to port ${newPort}!`));
  setupKeybindings();
}

async function onKeypress(str, key) {
  if (!key) return;

  if ((key.ctrl && key.name === "c") || key.name === "q") {
    pauseKeybindings();
    console.log(pc.dim("\nStopping server..."));
    if (currentServer) {
      currentServer.close(() => process.exit(0));
    } else {
      process.exit(0);
    }
  } else if (key.name === "s" || key.name === "p") {
    await hotSwap();
  }
}

currentServer = startServer(currentPort);
setupKeybindings();
