import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { HeadersUtilities } from './utils/nested-headers.js';
import { GgeEmpireSocket } from './utils/ws/empire-socket.js';
import { GgeEmpire4KingdomsSocket } from './utils/ws/empire4kingdoms-socket.js';
import { GgeLiveTemporaryServerSocket } from './utils/ws/live-temporary-server-socket.js';
import { GgeEmpire4KingdomsTcp } from './utils/ws/empire4kingdoms-tcp.js';

interface CommandInterface {
  [key: string]: {
    [key: string]: string;
  };
}

const __dirname = import.meta.dirname;
const commands: CommandInterface = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'commands.json')).toString(),
);
const CONNECTOR_ALLOWED_COMMANDS = new Set(Object.keys(commands));

type ConnectorSocket =
  | GgeEmpire4KingdomsSocket
  | GgeEmpireSocket
  | GgeLiveTemporaryServerSocket
  | GgeEmpire4KingdomsTcp;

interface ConnectorSession {
  socket: ConnectorSocket;
  allowedCommands: Set<string>;
  server: string;
  createdAt: Date;
  expiresAt: Date;
  removalKey: string;
}

export default function createApp(sockets: {
  [x: string]: GgeEmpire4KingdomsSocket | GgeEmpireSocket | GgeLiveTemporaryServerSocket | GgeEmpire4KingdomsTcp;
}): express.Express {
  const app = express();
  app.use(express.json());

  app.use((request, response, next) => {
    response.header('Access-Control-Allow-Origin', '*');
    response.header('Access-Control-Allow-Methods', 'GET, POST, DELETE');
    response.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
  });

  const connectors = new Map<string, ConnectorSession>();
  const connectorsByServer = new Map<string, string[]>();
  const connectorRotation = new Map<string, number>();
  // Limit connector lifetime to six hours to avoid long-lived tokens with stale credentials.
  const CONNECTOR_MAX_AGE_MS = 6 * 60 * 60 * 1000;
  const CONNECTOR_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
  const MAX_ACTIVE_CONNECTORS = 50;
  const SOCKET_COMMAND_TIMEOUT_MILLISECONDS = 1000;

  function addConnectorToServerIndex(server: string, connectorId: string): void {
    const pool = connectorsByServer.get(server) ?? [];
    pool.push(connectorId);
    connectorsByServer.set(server, pool);
    if (!connectorRotation.has(server)) {
      connectorRotation.set(server, 0);
    }
  }

  function removeConnectorFromServerIndex(server: string, connectorId: string): void {
    const pool = connectorsByServer.get(server);
    if (!pool) return;
    const filtered = pool.filter((id) => id !== connectorId);
    if (filtered.length === 0) {
      connectorsByServer.delete(server);
      connectorRotation.delete(server);
    } else {
      connectorsByServer.set(server, filtered);
      const rotation = connectorRotation.get(server) ?? 0;
      connectorRotation.set(server, rotation % filtered.length);
    }
  }

  function deleteConnector(connectorId: string): ConnectorSession | null {
    const session = connectors.get(connectorId);
    if (!session) return null;
    try {
      session.socket.close();
    } catch (error) {
      console.warn(`Failed to close socket during cleanup for connector ${connectorId}:`, error);
    }
    connectors.delete(connectorId);
    removeConnectorFromServerIndex(session.server, connectorId);
    return session;
  }

  function getConnectorSession(connectorId: string): ConnectorSession | null {
    const session = connectors.get(connectorId);
    if (!session) return null;
    const isExpired = Date.now() > session.expiresAt.getTime();
    if (isExpired) {
      deleteConnector(connectorId);
      return null;
    }
    return session;
  }

  function cleanupExpiredConnectors(): void {
    for (const [id, session] of connectors) {
      const expired = Date.now() > session.expiresAt.getTime();
      if (expired) {
        deleteConnector(id);
      }
    }
  }

  const cleanupInterval = setInterval(cleanupExpiredConnectors, CONNECTOR_CLEANUP_INTERVAL_MS);
  cleanupInterval.unref();
  process.once('exit', () => clearInterval(cleanupInterval));
  process.once('SIGINT', () => clearInterval(cleanupInterval));
  process.once('SIGTERM', () => clearInterval(cleanupInterval));

  function getActiveConnectorsForServer(
    server: string,
    command: string,
  ): Array<{ id: string; session: ConnectorSession }> {
    const pool = connectorsByServer.get(server);
    if (!pool) return [];
    const validSessions: Array<{ id: string; session: ConnectorSession }> = [];
    for (const connectorId of pool) {
      const session = getConnectorSession(connectorId);
      if (session) {
        validSessions.push({ id: connectorId, session });
      }
    }
    if (pool.length !== validSessions.length) {
      connectorsByServer.set(
        server,
        validSessions.map((entry) => entry.id),
      );
      if (validSessions.length === 0) {
        connectorsByServer.delete(server);
        connectorRotation.delete(server);
      } else {
        const rotation = connectorRotation.get(server) ?? 0;
        connectorRotation.set(server, rotation % validSessions.length);
      }
    }
    return validSessions.filter((entry) => entry.session.allowedCommands.has(command));
  }

  function getBalancedConnector(server: string, command: string): ConnectorSession | null {
    const candidates = getActiveConnectorsForServer(server, command);
    if (candidates.length === 0) {
      return null;
    }
    const nextIndex = connectorRotation.get(server) ?? 0;
    const chosen = candidates[nextIndex % candidates.length];
    connectorRotation.set(server, (nextIndex + 1) % candidates.length);
    return chosen.session;
  }

  function buildSocketFromRequest(
    server: string,
    socketUrl: string,
    username: string,
    password: string,
    serverType: string,
    autoReconnect: boolean,
  ): ConnectorSocket {
    switch (serverType) {
      case 'ep': {
        return new GgeEmpireSocket('wss://' + socketUrl, server, username, password, autoReconnect);
      }
      case 'e4k': {
        return new GgeEmpire4KingdomsTcp('tcp://' + socketUrl, server, username, password, autoReconnect);
      }
      case 'e4k-legacy': {
        return new GgeEmpire4KingdomsSocket('ws://' + socketUrl, server, username, password, autoReconnect);
      }
      default: {
        return new GgeLiveTemporaryServerSocket('wss://' + socketUrl, server, username, password, autoReconnect);
      }
    }
  }

  function registerConnector({
    server,
    socket_url,
    password,
    username,
    serverType,
    autoReconnect,
    allowedCommands,
  }: {
    server: string;
    socket_url: string;
    password: string;
    username: string;
    serverType: string;
    autoReconnect?: boolean;
    allowedCommands?: string[];
  }): { status: number; body: Record<string, unknown> } {
    if (!(server && socket_url && password && username)) {
      return { status: 400, body: { error: 'Missing parameters' } };
    }
    cleanupExpiredConnectors();
    if (connectors.size >= MAX_ACTIVE_CONNECTORS) {
      return { status: 429, body: { error: 'Connector limit reached, try again later' } };
    }
    const regex = /^[\dA-Za-z-]+\.goodgamestudios\.com$/;
    if (!regex.test(socket_url)) {
      return { status: 400, body: { error: 'Invalid socket URL' } };
    }
    const validatedCommands = new Set<string>();
    if (Array.isArray(allowedCommands)) {
      for (const command of allowedCommands) {
        if (CONNECTOR_ALLOWED_COMMANDS.has(command)) {
          validatedCommands.add(command);
        }
      }
    }
    if (validatedCommands.size === 0) {
      return {
        status: 400,
        body: {
          error: 'At least one allowed command must be provided',
          allowedCommands: [...CONNECTOR_ALLOWED_COMMANDS],
        },
      };
    }
    const connectorSocket = buildSocketFromRequest(
      server,
      socket_url,
      username,
      password,
      serverType,
      autoReconnect ?? false,
    );
    const connectorId = crypto.randomUUID();
    const removalKey = crypto.randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + CONNECTOR_MAX_AGE_MS);
    connectors.set(connectorId, {
      socket: connectorSocket,
      allowedCommands: validatedCommands,
      server,
      createdAt,
      expiresAt,
      removalKey,
    });
    addConnectorToServerIndex(server, connectorId);
    void connectorSocket.connectMethod();
    return {
      status: 201,
      body: {
        connectorId,
        removalKey,
        server,
        allowedCommands: [...validatedCommands],
        expiresAt,
        message: 'Connector registered with restricted command access',
      },
    };
  }

  async function handleSocketCommand(
    socket: ConnectorSocket | null,
    server: string,
    command: string,
    headers: string,
    response: express.Response,
    allowedCommands?: Set<string>,
  ): Promise<void> {
    if (allowedCommands && !allowedCommands.has(command)) {
      response.status(403).json({ error: 'Command not allowed for this connector', command });
      return;
    }
    if (socket !== null && socket.connected.isSet) {
      let responseHeaders = {};
      let messageHeaders: Record<string, unknown> = {};
      // Legacy clients send the literal string "null" in the URL segment to indicate no headers payload.
      // Replace it with an empty string so the parsed headers object defaults to {}.
      const headersInput = headers === 'null' ? '' : headers;
      try {
        const trimmedHeaders = headersInput.trim();
        const payload = trimmedHeaders ? `{${trimmedHeaders}}` : '{}';
        messageHeaders = JSON.parse(payload);
      } catch {
        response.status(400).json({ error: 'Invalid headers JSON' });
        return;
      }
      try {
        socket.sendJsonCommand(command, messageHeaders);

        if (Object.prototype.hasOwnProperty.call(commands, command)) {
          for (const [messageKey, responsePath] of Object.entries(commands[command])) {
            if (Object.prototype.hasOwnProperty.call(messageHeaders, messageKey)) {
              HeadersUtilities.setNestedValue(responseHeaders, responsePath, messageHeaders[messageKey]);
            }
          }
        } else {
          responseHeaders = messageHeaders;
        }
        let targetCommand = command;
        if (command === 'jca') {
          targetCommand = 'jaa';
        }
        const jsonResponse = await socket.waitForJsonResponse(
          targetCommand,
          responseHeaders,
          SOCKET_COMMAND_TIMEOUT_MILLISECONDS,
        );
        response.status(200).json({
          server,
          command: targetCommand,
          return_code: jsonResponse.payload.status,
          content: jsonResponse.payload.data,
        });
      } catch (error) {
        console.warn('Socket command failed', error);
        response.status(504).json({
          error: `Timeout waiting for socket response for command ${command} after ${SOCKET_COMMAND_TIMEOUT_MILLISECONDS}ms`,
          server,
          command,
          response_headers: responseHeaders,
          return_code: -1,
        });
      }
    } else {
      response.status(500).json({ error: 'Server not connected' });
    }
  }

  app.delete('/server/:server', async (request, response) => {
    try {
      const { server } = request.params as { server: string };
      if (!server) {
        response.status(400).json({ error: 'Missing parameters' });
        return;
      }
      if (Object.prototype.hasOwnProperty.call(sockets, server)) {
        try {
          sockets[server].close();
        } catch {}
        delete sockets[server];
        response.status(200).json({ message: 'Server deleted' });
      } else {
        response.status(404).json({ error: 'Server not found' });
      }
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
  });

  app.post('/server', async (request, response) => {
    try {
      const { server, socket_url, password, username, serverType, autoReconnect } = request.body as {
        server: string;
        socket_url: string;
        password: string;
        username: string;
        serverType: string;
        autoReconnect: boolean;
      };
      if (!(server && socket_url && password && username)) {
        response.status(400).json({ error: 'Missing parameters' });
        return;
      }
      if (Object.prototype.hasOwnProperty.call(sockets, server)) {
        try {
          sockets[server].close();
        } catch {}
        delete sockets[server];
      }
      const regex = /^[\dA-Za-z-]+\.goodgamestudios\.com$/;
      if (!regex.test(socket_url)) {
        response.status(400).json({ error: 'Invalid socket URL' });
        return;
      }
      const autoReconnectValue = autoReconnect ?? false;
      const socketServer = buildSocketFromRequest(
        server,
        socket_url,
        username,
        password,
        serverType,
        autoReconnectValue,
      );
      sockets[server] = socketServer;
      void socketServer.connectMethod();
      response.status(200).json({ message: 'Server added' });
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
  });

  app.post('/connector', async (request, response) => {
    try {
      const result = registerConnector(request.body);
      response.status(result.status).json(result.body);
    } catch (error) {
      console.error('Failed to register connector', error);
      response.status(500).json({ error: 'Failed to register connector' });
    }
  });

  app.post('/connector/bulk', async (request, response) => {
    try {
      const payload = Array.isArray(request.body) ? request.body : request.body?.connectors;
      if (!Array.isArray(payload) || payload.length === 0) {
        response.status(400).json({ error: 'Provide an array of connector definitions' });
        return;
      }
      const results: Array<{ status: number; body: Record<string, unknown> }> = [];
      for (const entry of payload) {
        const result = registerConnector(entry as Record<string, string>);
        results.push(result);
      }
      const hasSuccess = results.some((result) => result.status >= 200 && result.status < 300);
      const hasFailure = results.some((result) => result.status >= 400);
      const status = hasSuccess && hasFailure ? 207 : hasFailure ? 400 : 201;
      response.status(status).json({ results });
    } catch (error) {
      console.error('Failed to register connectors', error);
      response.status(500).json({ error: 'Failed to register connectors' });
    }
  });

  app.get('/connector/:connectorId/status', async (request, response) => {
    const session = getConnectorSession(request.params.connectorId);
    if (!session) {
      response.status(404).json({ error: 'Connector not found or expired' });
      return;
    }
    response.status(200).json({
      connectorId: request.params.connectorId,
      server: session.server,
      connected: session.socket.connected.isSet,
      allowedCommands: [...session.allowedCommands],
      since: session.createdAt,
      expiresAt: session.expiresAt,
    });
  });

  app.post('/connector/:connectorId/renew', async (request, response) => {
    const removalKey =
      (request.body?.removalKey as string | undefined) ?? (request.query?.removalKey as string | undefined);
    if (!removalKey) {
      response.status(400).json({ error: 'Removal key is required' });
      return;
    }
    const session = getConnectorSession(request.params.connectorId);
    if (!session) {
      response.status(404).json({ error: 'Connector not found or expired' });
      return;
    }
    if (session.removalKey !== removalKey) {
      response.status(403).json({ error: 'Invalid removal key' });
      return;
    }
    const renewedExpiry = new Date(Date.now() + CONNECTOR_MAX_AGE_MS);
    session.expiresAt = renewedExpiry;
    response.status(200).json({ message: 'Connector renewed', expiresAt: renewedExpiry });
  });

  app.delete('/connector/:connectorId', async (request, response) => {
    const removalKey =
      (request.body?.removalKey as string | undefined) ?? (request.query?.removalKey as string | undefined);
    if (!removalKey) {
      response.status(400).json({ error: 'Removal key is required' });
      return;
    }
    const session = getConnectorSession(request.params.connectorId);
    if (!session) {
      response.status(404).json({ error: 'Connector not found or expired' });
      return;
    }
    if (session.removalKey !== removalKey) {
      response.status(403).json({ error: 'Invalid removal key' });
      return;
    }
    deleteConnector(request.params.connectorId);
    response.status(200).json({ message: 'Connector removed' });
  });

  app.get('/connector/:connectorId/:command/:headers', async (request, response) => {
    const connector = getConnectorSession(request.params.connectorId);
    if (!connector) {
      response.status(404).json({ error: 'Connector not found or expired' });
      return;
    }
    await handleSocketCommand(
      connector.socket,
      connector.server,
      request.params.command,
      request.params.headers,
      response,
      connector.allowedCommands,
    );
  });

  app.get('/:server/:command/:headers', async (request, response) => {
    const { server, command, headers } = request.params as { server: string; command: string; headers: string };
    const connector = getBalancedConnector(server, command);
    if (connector) {
      await handleSocketCommand(
        connector.socket,
        connector.server,
        command,
        headers,
        response,
        connector.allowedCommands,
      );
      return;
    }
    if (Object.prototype.hasOwnProperty.call(sockets, server)) {
      await handleSocketCommand(sockets[server], server, command, headers, response);
    } else {
      response.status(404).json({ error: 'Server not found' });
    }
  });

  app.get('/status', async (request, response) => {
    const status = {};
    for (const [server, socket] of Object.entries(sockets)) {
      status[server] = socket.connected.isSet;
    }
    response.status(200).json(status);
  });

  app.get('/', (request, response) => response.status(200).send('API running'));

  return app;
}
