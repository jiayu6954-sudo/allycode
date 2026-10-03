import net from "node:net";

/**
 * Reserve a port the OS says is free right now.
 *
 * Guessing from a random base collided: test files run in parallel worker
 * processes, and a fixed or randomly-based range can overlap another file's —
 * the child then exits with EADDRINUSE and the failure looks like a product
 * bug. Asking the OS for port 0 and reading back what it assigned removes the
 * guesswork. A narrow race remains between closing here and the child binding,
 * so callers should still treat a bind failure as possible rather than
 * impossible.
 */
export async function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close(() => reject(new Error("could not determine the assigned port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}
