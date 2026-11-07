import { request as httpRequest, createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

type ProxyHandler<T> = (proxyUrl: string) => Promise<T>;

const REGISTRY_HOST = "registry.npmjs.org";

function allowedAuthority(host: string, port: string): boolean {
  return host.toLowerCase() === REGISTRY_HOST && (port === "80" || port === "443");
}

function parseAuthority(authority: string): { host: string; port: string } | undefined {
  const match = authority.trim().match(/^([^:]+):(\d+)$/);
  if (!match) return undefined;
  return { host: match[1], port: match[2] };
}

function rejectResponse(response: ServerResponse): void {
  response.writeHead(403, { "content-type": "text/plain", connection: "close" });
  response.end("Only registry.npmjs.org is allowed during dependency installation.\n");
}

function forwardHttpRequest(request: IncomingMessage, response: ServerResponse): void {
  let target: URL;
  try {
    target = new URL(request.url ?? "");
  } catch {
    response.writeHead(400);
    response.end("Invalid proxy request.\n");
    return;
  }
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  if ((target.protocol !== "http:" && target.protocol !== "https:") || !allowedAuthority(target.hostname, port)) {
    rejectResponse(response);
    return;
  }
  const headers = { ...request.headers };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  headers.host = target.host;
  headers.connection = "close";
  const requestOptions = {
    hostname: target.hostname,
    port,
    path: `${target.pathname}${target.search}`,
    method: request.method,
    headers,
  };
  const forward = target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = forward(requestOptions, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end("Registry proxy upstream request failed.\n");
  });
  request.pipe(upstream);
}

function handleConnect(
  request: IncomingMessage,
  tunnel: Duplex,
  head: Buffer,
  sockets: Set<Socket>,
): void {
  // The server types a CONNECT socket as a Duplex stream; every peer here is a
  // net.Socket, which is what pipe/destroy need.
  const client = tunnel as Socket;
  const authority = parseAuthority(request.url ?? "");
  if (!authority || !allowedAuthority(authority.host, authority.port)) {
    client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  const upstream = connect(Number(authority.port), authority.host);
  // The server's `connection` listener never sees this socket: it is outbound, so
  // shutdown has to know about it explicitly or a tunnel still open when the install
  // finishes keeps the proxy, and the whole operation, alive.
  sockets.add(upstream);
  upstream.once("close", () => sockets.delete(upstream));
  // Tear the pair down from whichever side ends first. Without this a client that
  // closed half of a CONNECT tunnel left the upstream socket writable, and the
  // process waited on it.
  const teardown = () => {
    client.destroy();
    upstream.destroy();
  };
  client.once("close", teardown);
  client.once("error", teardown);
  upstream.once("close", () => client.destroy());
  upstream.on("error", () => client.destroy());
  upstream.once("connect", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
}

async function closeServer(server: ReturnType<typeof createServer>, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Run an operation with a loopback proxy that permits only the public npm registry. */
export async function withRegistryOnlyProxy<T>(handler: ProxyHandler<T>): Promise<T> {
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => forwardHttpRequest(request, response));
  server.on("connect", (request, socket, head) => handleConnect(request, socket, head, sockets));
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("registry proxy did not bind to a TCP port");
    return await handler(`http://127.0.0.1:${address.port}`);
  } finally {
    await closeServer(server, sockets);
  }
}
