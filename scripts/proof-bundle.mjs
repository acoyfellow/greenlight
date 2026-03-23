const base = process.argv[2] ?? process.env.GREENLIGHT_BASE_URL ?? "http://localhost:8787";
const project = process.argv[3] ?? process.env.GREENLIGHT_PROJECT ?? "default";

const query = new URLSearchParams({ project }).toString();
const url = `${base.replace(/\/$/, "")}/proof?${query}`;

const response = await fetch(url);
if (!response.ok) {
  throw new Error(`Proof request failed: ${response.status}`);
}

const body = await response.json();
if (!body.ok) {
  throw new Error(body.error?.message ?? "Proof request returned ok=false");
}

process.stdout.write(`${JSON.stringify(body.result, null, 2)}\n`);
