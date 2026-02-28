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

  const connectors = new Map<
    string,
    { socket: ConnectorSocket; allowedCommands: Set<string>; server: string; createdAt: Date }
  >();
  const CONNECTOR_MAX_AGE_MS = 1000 * 60 * 60 * 6;

  function getConnectorSession(connectorId: string): {
    socket: ConnectorSocket;
    allowedCommands: Set<string>;
    server: string;
    createdAt: Date;
  } | null {
    const session = connectors.get(connectorId);
    if (!session) return null;
    const isExpired = Date.now() - session.createdAt.getTime() > CONNECTOR_MAX_AGE_MS;
    if (isExpired) {
      try {
        session.socket.close();
      } catch (error) {
        console.warn(`Connector ${connectorId} cleanup failed:`, error);
      }
      connectors.delete(connectorId);
      return null;
    }
    return session;
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
      try {
        const headersInput = headers === 'null' ? '' : headers;
        const messageHeaders = JSON.parse(`{${headersInput}}`);
        socket.sendJsonCommand(command, messageHeaders);

        if (command in commands) {
          for (const [messageKey, responsePath] of Object.entries(commands[command])) {
            if (messageKey in messageHeaders) {
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
        const jsonResponse = await socket.waitForJsonResponse(targetCommand, responseHeaders, 1000);
        response.status(200).json({
          server,
          command: targetCommand,
          return_code: jsonResponse.payload.status,
          content: jsonResponse.payload.data,
        });
      } catch {
        response.status(200).json({
          error: 'Timeout',
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
      if (server in sockets) {
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
      if (server in sockets) {
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
      const { server, socket_url, password, username, serverType, autoReconnect, allowedCommands } = request.body as {
        server: string;
        socket_url: string;
        password: string;
        username: string;
        serverType: string;
        autoReconnect?: boolean;
        allowedCommands?: string[];
      };
      if (!(server && socket_url && password && username)) {
        response.status(400).json({ error: 'Missing parameters' });
        return;
      }
      const regex = /^[\dA-Za-z-]+\.goodgamestudios\.com$/;
      if (!regex.test(socket_url)) {
        response.status(400).json({ error: 'Invalid socket URL' });
        return;
      }
      const safeCommands = new Set<string>();
      if (Array.isArray(allowedCommands)) {
        for (const command of allowedCommands) {
          if (CONNECTOR_ALLOWED_COMMANDS.has(command)) {
            safeCommands.add(command);
          }
        }
      }
      if (safeCommands.size === 0) {
        CONNECTOR_ALLOWED_COMMANDS.forEach((item) => safeCommands.add(item));
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
      connectors.set(connectorId, {
        socket: connectorSocket,
        allowedCommands: safeCommands,
        server,
        createdAt: new Date(),
      });
      void connectorSocket.connectMethod();
      response.status(201).json({
        connectorId,
        server,
        allowedCommands: [...safeCommands],
        message: 'Connector registered with restricted command access',
      });
    } catch (error) {
      console.error('Failed to register connector', error);
      response.status(500).json({ error: 'Failed to register connector' });
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
    });
  });

  app.delete('/connector/:connectorId', async (request, response) => {
    const session = connectors.get(request.params.connectorId);
    if (!session) {
      response.status(404).json({ error: 'Connector not found' });
      return;
    }
    try {
      session.socket.close();
    } catch (error) {
      console.warn(`Failed to close connector ${request.params.connectorId}:`, error);
    }
    connectors.delete(request.params.connectorId);
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
    if (request.params.server in sockets) {
      await handleSocketCommand(
        sockets[request.params.server],
        request.params.server,
        request.params.command,
        request.params.headers,
        response,
      );
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
