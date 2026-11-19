import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * A stand-in for a 2022 Frame (art API 4.3.4.0) that speaks just enough of the TV's protocols
 * to exercise the client: device info, pairing, remote keys, the art service, file transfer and volume.
 */
export class MockTv {
  public readonly token = 'TOKEN-1234';
  public powerState: 'on' | 'standby' = 'on';
  public frameSupport = true;
  public artMode = false;
  public brightness = 5;
  public volume = 12;
  public muted = false;
  public slideshow = { value: 'off', category_id: 'MY-C0002', type: 'shuffleslideshow' };
  public current = 'MY_F0001';
  public artwork = [
    { content_id: 'MY_F0001', category_id: 'MY-C0002', matte_id: 'none' },
    { content_id: 'MY_F0002', category_id: 'MY-C0002', matte_id: 'shadowbox_polar' },
    { content_id: 'SAM-F0100', category_id: 'MY-C0004', matte_id: 'none' },
  ];

  /** When true the art service accepts requests and never answers. */
  public artSilent = false;
  /** When false the HTTP side stops answering, as if the TV lost power. */
  public online = true;

  public readonly keys: Array<{ key: string; cmd: string }> = [];
  public readonly launched: string[] = [];
  public readonly uploads: Buffer[] = [];
  public readonly artRequests: string[] = [];
  public connections = 0;

  private httpServer!: http.Server;
  private wsServer!: WebSocketServer;
  private wsHttp!: http.Server;
  private readonly artSockets = new Set<WebSocket>();
  private readonly allSockets = new Set<WebSocket>();
  private readonly tcpServers = new Set<net.Server>();

  public restPort = 0;
  public wsPort = 0;

  async start(): Promise<void> {
    this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));
    await new Promise<void>((resolve) => this.httpServer.listen(0, '127.0.0.1', resolve));
    this.restPort = (this.httpServer.address() as AddressInfo).port;

    this.wsHttp = http.createServer();
    this.wsServer = new WebSocketServer({ server: this.wsHttp });
    this.wsServer.on('connection', (socket, req) => this.handleSocket(socket, req));
    await new Promise<void>((resolve) => this.wsHttp.listen(0, '127.0.0.1', resolve));
    this.wsPort = (this.wsHttp.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const socket of this.allSockets) {
      socket.terminate();
    }

    for (const server of this.tcpServers) {
      server.close();
    }

    this.wsServer.close();
    await new Promise<void>((resolve) => this.wsHttp.close(() => resolve()));
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
  }

  get transport() {
    return { restPort: this.restPort, wsPort: this.wsPort, upnpPort: this.restPort, secure: false };
  }

  /** Drop every open WebSocket, as the TV does when it reboots its network stack. */
  dropConnections(): void {
    for (const socket of this.allSockets) {
      socket.terminate();
    }
  }

  /** Push an Art Mode change as if someone used the physical remote. */
  pushArtMode(on: boolean): void {
    this.artMode = on;
    this.pushArt({ event: 'art_mode_changed', status: on ? 'on' : 'off' });
  }

  private pushArt(data: Record<string, unknown>): void {
    for (const socket of this.artSockets) {
      socket.send(JSON.stringify({ event: 'd2d_service_message', data: JSON.stringify(data) }));
    }
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.online) {
      req.socket.destroy();
      return;
    }

    if (req.url === '/api/v2/') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          name: 'Mock Frame',
          version: '2.0.25',
          device: {
            name: 'Mock Frame',
            model: '22_PONTUSM_FTV',
            modelName: 'QN55LS03BAFXZA',
            wifiMac: 'AA:BB:CC:DD:EE:FF',
            firmwareVersion: '1720',
            FrameTVSupport: String(this.frameSupport),
            TokenAuthSupport: 'true',
            PowerState: this.powerState,
          },
        }),
      );
      return;
    }

    if (req.url === '/upnp/control/RenderingControl1' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const action = /#(\w+)"/.exec(String(req.headers.soapaction))?.[1] ?? '';
        let inner = '';

        if (action === 'GetVolume') {
          inner = `<CurrentVolume>${this.volume}</CurrentVolume>`;
        } else if (action === 'SetVolume') {
          this.volume = Number(/<DesiredVolume>(\d+)</.exec(body)?.[1]);
        } else if (action === 'GetMute') {
          inner = `<CurrentMute>${this.muted ? 1 : 0}</CurrentMute>`;
        } else if (action === 'SetMute') {
          this.muted = /<DesiredMute>1</.test(body);
        }

        res.setHeader('Content-Type', 'text/xml');
        res.end(`<s:Envelope><s:Body><u:${action}Response>${inner}</u:${action}Response></s:Body></s:Envelope>`);
      });
      return;
    }

    res.statusCode = 404;
    res.end();
  }

  private handleSocket(socket: WebSocket, req: http.IncomingMessage): void {
    const url = new URL(req.url ?? '/', 'http://tv');
    const endpoint = url.pathname.split('/').pop();
    const token = url.searchParams.get('token');

    this.connections += 1;
    this.allSockets.add(socket);
    socket.on('close', () => {
      this.allSockets.delete(socket);
      this.artSockets.delete(socket);
    });

    if (token && token !== this.token) {
      socket.send(JSON.stringify({ event: 'ms.channel.unauthorized' }));
      return;
    }

    socket.send(JSON.stringify({ event: 'ms.channel.connect', data: { id: 'client-1', ...(token ? {} : { token: this.token }) } }));

    if (endpoint === 'com.samsung.art-app') {
      this.artSockets.add(socket);
      socket.send(JSON.stringify({ event: 'ms.channel.ready' }));
    }

    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());

      if (message.method === 'ms.remote.control') {
        this.keys.push({ key: message.params.DataOfCmd, cmd: message.params.Cmd });
      } else if (message.params?.event === 'ed.apps.launch') {
        this.launched.push(message.params.data.appId);
      } else if (message.params?.event === 'art_app_request') {
        this.handleArt(socket, JSON.parse(message.params.data));
      }
    });
  }

  private handleArt(socket: WebSocket, request: Record<string, any>): void {
    this.artRequests.push(request.request);

    if (this.artSilent) {
      return;
    }

    const reply = (data: Record<string, unknown>) => {
      socket.send(
        JSON.stringify({
          event: 'd2d_service_message',
          data: JSON.stringify({ request_id: request.request_id, ...data }),
        }),
      );
    };

    switch (request.request) {
      case 'api_version':
        reply({ event: 'api_version', version: '4.3.4.0' });
        break;
      case 'get_artmode_status':
        reply({ event: 'artmode_status', value: this.artMode ? 'on' : 'off' });
        break;
      case 'set_artmode_status':
        this.artMode = request.value === 'on';
        reply({ event: 'artmode_status', value: request.value });
        this.pushArt({ event: 'art_mode_changed', status: request.value });
        break;
      case 'get_content_list':
        reply({ event: 'content_list', content_list: JSON.stringify(this.artwork) });
        break;
      case 'get_current_artwork':
        reply({ event: 'current_artwork', content_id: this.current, matte_id: 'none' });
        break;
      case 'select_image':
        this.current = request.content_id;
        reply({ event: 'image_selected', content_id: request.content_id });
        break;
      case 'delete_image_list': {
        const ids = new Set(request.content_id_list.map((item: any) => item.content_id));
        this.artwork = this.artwork.filter((item) => !ids.has(item.content_id));
        reply({ event: 'image_deleted' });
        break;
      }
      case 'get_artmode_settings':
        reply({
          event: 'artmode_settings',
          data: JSON.stringify([
            { item: 'brightness', value: String(this.brightness), min: '0', max: '10' },
            { item: 'color_temperature', value: '0', min: '-5', max: '5' },
          ]),
        });
        break;
      case 'set_brightness':
        this.brightness = Number(request.value);
        reply({ event: 'brightness', value: String(request.value) });
        break;
      case 'get_slideshow_status':
        reply({ event: 'slideshow_status', ...this.slideshow });
        break;
      case 'set_slideshow_status':
        this.slideshow = { value: request.value, category_id: request.category_id, type: request.type };
        reply({ event: 'slideshow_status', ...this.slideshow });
        break;
      case 'get_matte_list':
        reply({
          event: 'matte_list',
          matte_type_list: JSON.stringify([{ matte_type: 'none' }, { matte_type: 'shadowbox' }]),
          matte_color_list: JSON.stringify([{ color: 'polar' }, { color: 'ink' }]),
        });
        break;
      case 'change_matte':
        reply({ event: 'matte_changed', content_id: request.content_id, matte_id: request.matte_id });
        break;
      case 'send_image':
        void this.acceptUpload(reply, request);
        break;
      case 'get_thumbnail_list':
        void this.serveThumbnails(reply, request);
        break;
      default:
        // What a real TV sends for a request its art API does not know.
        reply({ event: 'error', error_code: -9, request_data: JSON.stringify(request) });
    }
  }

  private listenOnce(onConnection: (socket: net.Socket) => void): Promise<number> {
    return new Promise((resolve) => {
      const server = net.createServer((socket) => {
        onConnection(socket);
        server.close();
        this.tcpServers.delete(server);
      });

      this.tcpServers.add(server);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
  }

  private async acceptUpload(reply: (data: Record<string, unknown>) => void, request: Record<string, any>): Promise<void> {
    const port = await this.listenOnce((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('end', () => {
        const all = Buffer.concat(chunks);
        const headerLength = all.readUInt32BE(0);
        const header = JSON.parse(all.subarray(4, 4 + headerLength).toString());
        const data = all.subarray(4 + headerLength);

        if (header.secKey !== 'SECRET' || data.length !== header.fileLength) {
          return;
        }

        this.uploads.push(Buffer.from(data));

        const content_id = `MY_F${String(1000 + this.uploads.length)}`;
        this.artwork.push({ content_id, category_id: 'MY-C0002', matte_id: request.matte_id });

        // 2022 Frames send image_added with no request id.
        this.pushArt({ event: 'image_added', content_id });
      });
    });

    reply({ event: 'ready_to_use', conn_info: JSON.stringify({ ip: '127.0.0.1', port, key: 'SECRET', secured: false }) });
  }

  private async serveThumbnails(reply: (data: Record<string, unknown>) => void, request: Record<string, any>): Promise<void> {
    const ids: string[] = request.content_id_list.map((item: any) => item.content_id);

    const port = await this.listenOnce((socket) => {
      ids.forEach((id, index) => {
        const data = Buffer.from(`thumbnail:${id}`);
        const header = Buffer.from(JSON.stringify({ fileLength: data.length, num: index, total: ids.length, fileID: id, fileType: 'jpg' }));
        const length = Buffer.alloc(4);
        length.writeUInt32BE(header.length);
        socket.write(Buffer.concat([length, header, data]));
      });
      socket.end();
    });

    reply({ event: 'thumbnail_list', conn_info: JSON.stringify({ ip: '127.0.0.1', port, secured: false }) });
  }
}
