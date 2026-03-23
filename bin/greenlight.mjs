#!/usr/bin/env node

const BASE_URL = (process.env.GREENLIGHT_BASE_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const API_KEY = process.env.GREENLIGHT_API_KEY?.trim() || "";

function usage() {
  process.stdout.write(
    [
      "greenlight CLI",
      "",
      "Commands:",
      "  greenlight create <name>",
      "  greenlight gate <name> \"<assertion>\"",
      "  greenlight gate rm <name> \"<gate-name>\"",
      "  greenlight gates <name>",
      "  greenlight start <name>",
      "  greenlight pause <name>",
      "  greenlight nudge <name> \"<text>\"",
      "  greenlight config <name> <key> <value>",
      "  greenlight logs <name>",
      "  greenlight status <name>",
      "  greenlight destroy <name>",
      "",
      "Env:",
      "  GREENLIGHT_BASE_URL=http://127.0.0.1:8787",
      "  GREENLIGHT_API_KEY=<api-key>",
      "",
    ].join("\n")
  );
}

function fail(message, details) {
  const out = {
    ok: false,
    command: `greenlight ${process.argv.slice(2).join(" ")}`.trim(),
    error: { code: "CLI_ERROR", message },
    details,
    next_actions: [],
  };
  process.stderr.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(1);
}

function parseConfigValue(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

async function request(method, path, project, body) {
  const search = project ? `?${new URLSearchParams({ project }).toString()}` : "";
  const headers = {};
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (API_KEY) {
    headers["x-api-key"] = API_KEY;
  }

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}${search}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    fail("Request failed", String(error));
  }

  const raw = await response.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    fail("Expected JSON response", raw);
  }

  if (!response.ok || !json.ok) {
    process.stderr.write(`${JSON.stringify(json, null, 2)}\n`);
    process.exit(1);
  }
  return json;
}

function print(body) {
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    usage();
    return;
  }

  const command = args[0];
  switch (command) {
    case "create": {
      const name = args[1];
      if (!name) fail("Missing project name");
      await request("GET", "/status", name);
      print({
        ok: true,
        command: `greenlight create ${name}`,
        result: { name },
        next_actions: [
          { command: `greenlight gate ${name} "GET /demo/health returns 200"`, description: "Add first gate" },
          { command: `greenlight start ${name}`, description: "Start loop" },
        ],
      });
      return;
    }
    case "gate": {
      if (args[1] === "rm") {
        const project = args[2];
        const gateName = args.slice(3).join(" ").trim();
        if (!project || !gateName) fail("Usage: greenlight gate rm <name> \"<gate-name>\"");
        const body = await request("DELETE", `/gates/${encodeURIComponent(gateName)}`, project);
        print(body);
        return;
      }
      const project = args[1];
      const assertion = args.slice(2).join(" ").trim();
      if (!project || !assertion) fail("Usage: greenlight gate <name> \"<assertion>\"");
      const body = await request("POST", "/gates", project, { assertion });
      print(body);
      return;
    }
    case "gates": {
      const project = args[1];
      if (!project) fail("Missing project name");
      print(await request("GET", "/gates", project));
      return;
    }
    case "start": {
      const project = args[1];
      if (!project) fail("Missing project name");
      print(await request("POST", "/start", project));
      return;
    }
    case "pause": {
      const project = args[1];
      if (!project) fail("Missing project name");
      print(await request("POST", "/pause", project));
      return;
    }
    case "nudge": {
      const project = args[1];
      const text = args.slice(2).join(" ").trim();
      if (!project || !text) fail("Usage: greenlight nudge <name> \"<text>\"");
      print(await request("POST", "/nudge", project, { text }));
      return;
    }
    case "config": {
      const project = args[1];
      const key = args[2];
      const value = args.slice(3).join(" ").trim();
      if (!project || !key || !value) fail("Usage: greenlight config <name> <key> <value>");
      print(await request("POST", "/config", project, { key, value: parseConfigValue(value) }));
      return;
    }
    case "logs": {
      const project = args[1];
      if (!project) fail("Missing project name");
      print(await request("GET", "/logs", project));
      return;
    }
    case "status": {
      const project = args[1];
      if (!project) fail("Missing project name");
      print(await request("GET", "/status", project));
      return;
    }
    case "destroy": {
      const project = args[1];
      if (!project) fail("Missing project name");
      print(await request("POST", "/destroy", project));
      return;
    }
    default:
      fail(`Unknown command: ${command}`);
  }
}

await main();
