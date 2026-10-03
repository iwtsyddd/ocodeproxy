# OCodeProxy

A clean, modern proxy server with terminal UI, request logging, and on-the-fly port hot-swapping.

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm start

# Or start in watch mode for development
npm run dev
```

The server starts by default on `http://localhost:6446`.

## Configuration

- **CLI Flag**: `node server.mjs -p 8080` or `node server.mjs --port 8080`
- **Environment Variable**: `PROXY_PORT=8080 npm start`
- **Hot-Swap**: Press `s` in the terminal while the server is running to switch ports interactively without restarting the process.

## Endpoints

- `GET /health` — Health and status check
- `GET /` — Server info and active endpoints

## Contributing

See [AGENTS.md](./AGENTS.md) for conventions, UI language rules, and styling standards.
