/**
 * Compile a one-liner gate assertion into an executable JS function string.
 *
 * Examples:
 *   "GET /api/price returns 200"
 *   "GET /api/price -> .price is a number"
 *   "POST /api/submit with {email: 'a@b.com'} returns 201"
 *   "GET /api/price twice within 1s -> second .cached is true"
 */
export function compileGate(assertion: string): string {
  if (!assertion || !assertion.trim()) {
    throw new Error("Empty assertion");
  }

  const a = assertion.trim();

  // Pattern: METHOD /path twice within Ns -> second response .field is VALUE
  const twiceMatch = a.match(
    /^(GET|POST|PUT|DELETE|PATCH)\s+(\S+)\s+twice\s+within\s+(\d+)s\s*(?:→|->)\s*second\s+(?:response\s+)?\.(\w+)\s+is\s+(.+)$/i
  );
  if (twiceMatch) {
    const [, method, path, _seconds, field, value] = twiceMatch;
    return `const r1 = await fetch(endpoint + "${path}", { method: "${method}" });
const r2 = await fetch(endpoint + "${path}", { method: "${method}" });
const body = await r2.json();
if (body.${field} !== ${value}) throw new Error("Expected .${field} to be ${value}, got " + body.${field});`;
  }

  // Pattern: METHOD /path with {BODY} returns STATUS
  const withBodyMatch = a.match(
    /^(GET|POST|PUT|DELETE|PATCH)\s+(\S+)\s+with\s+(\{.*\})\s+returns\s+(\d+)$/i
  );
  if (withBodyMatch) {
    const [, method, path, body, status] = withBodyMatch;
    return `const r = await fetch(endpoint + "${path}", { method: "${method}", headers: { "Content-Type": "application/json" }, body: JSON.stringify(${body}) });
if (r.status !== ${status}) throw new Error("Expected status ${status}, got " + r.status);`;
  }

  // Pattern: METHOD /path returns STATUS
  const returnsMatch = a.match(
    /^(GET|POST|PUT|DELETE|PATCH)\s+(\S+)\s+returns\s+(\d+)$/i
  );
  if (returnsMatch) {
    const [, method, path, status] = returnsMatch;
    return `const r = await fetch(endpoint + "${path}", { method: "${method}" });
if (r.status !== ${status}) throw new Error("Expected status ${status}, got " + r.status);`;
  }

  // Pattern: METHOD /path -> .field is a TYPE
  const typeMatch = a.match(
    /^(GET|POST|PUT|DELETE|PATCH)\s+(\S+)\s*(?:→|->)\s*\.(\w+)\s+is\s+a\s+(number|string|boolean|object|array)$/i
  );
  if (typeMatch) {
    const [, method, path, field, type] = typeMatch;
    return `const r = await fetch(endpoint + "${path}", { method: "${method}" });
const body = await r.json();
if (typeof body.${field} !== "${type}") throw new Error("Expected .${field} to be ${type}, got " + typeof body.${field});`;
  }

  // Pattern: METHOD /path -> .field equals VALUE
  const equalsMatch = a.match(
    /^(GET|POST|PUT|DELETE|PATCH)\s+(\S+)\s*(?:→|->)\s*\.(\w+)\s+equals\s+(.+)$/i
  );
  if (equalsMatch) {
    const [, method, path, field, value] = equalsMatch;
    return `const r = await fetch(endpoint + "${path}", { method: "${method}" });
const body = await r.json();
if (body.${field} !== "${value}") throw new Error("Expected .${field} to equal ${value}, got " + body.${field});`;
  }

  // Pattern: METHOD /path -> HEADER header exists
  const headerMatch = a.match(
    /^(GET|POST|PUT|DELETE|PATCH)\s+(\S+)\s*(?:→|->)\s*(\S+)\s+header\s+exists$/i
  );
  if (headerMatch) {
    const [, method, path, header] = headerMatch;
    return `const r = await fetch(endpoint + "${path}", { method: "${method}" });
if (!r.headers.has("${header}")) throw new Error("Expected header ${header} to exist");`;
  }

  // Pattern: METHOD /path -> response time < NUMBERms
  const timeMatch = a.match(
    /^(GET|POST|PUT|DELETE|PATCH)\s+(\S+)\s*(?:→|->)\s*response\s+time\s*<\s*(\d+)ms$/i
  );
  if (timeMatch) {
    const [, method, path, ms] = timeMatch;
    return `const start = Date.now();
const r = await fetch(endpoint + "${path}", { method: "${method}" });
const elapsed = Date.now() - start;
if (elapsed >= ${ms}) throw new Error("Response time " + elapsed + "ms exceeded ${ms}ms");`;
  }

  // Pattern: METHOD /path -> response is array with length > NUMBER
  const arrayMatch = a.match(
    /^(GET|POST|PUT|DELETE|PATCH)\s+(\S+)\s*(?:→|->)\s*response\s+is\s+array\s+with\s+length\s*>\s*(\d+)$/i
  );
  if (arrayMatch) {
    const [, method, path, count] = arrayMatch;
    return `const r = await fetch(endpoint + "${path}", { method: "${method}" });
const body = await r.json();
if (!Array.isArray(body)) throw new Error("Expected array, got " + typeof body);
if (body.length <= ${count}) throw new Error("Expected length > ${count}, got " + body.length);`;
  }

  throw new Error(`Unparseable gate assertion: ${assertion}`);
}
