/**
 * Compile a one-liner gate assertion into an executable JS function string.
 *
 * Examples:
 *   "GET /api/price returns 200"
 *   "GET /api/price → .price is a number"
 *   "POST /api/submit with {email: 'a@b.com'} returns 201"
 *   "GET /api/price twice within 1s → second .cached is true"
 */
export function compileGate(_assertion: string): string {
  // TODO: implement gate compilation
  throw new Error("compileGate not implemented");
}
