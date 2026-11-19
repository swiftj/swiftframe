import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArtClient,
  ArtRequestError,
  ArtServiceUnavailableError,
  FrameTV,
  InvalidArgumentError,
  MemoryTokenStore,
  NotAFrameError,
  RemoteClient,
  RequestTimeoutError,
  UnauthorizedError,
  VolumeClient,
  buildMagicPacket,
  detectImageType,
  getDeviceInfo,
  normalizeKey,
  type FrameState,
} from '../src/index.js';
import { MockTv } from './mock-tv.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(5000, 7)]);

const until = async (check: () => boolean, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

let tv: MockTv;
const cleanup: Array<() => void> = [];

beforeEach(async () => {
  tv = new MockTv();
  await tv.start();
});

afterEach(async () => {
  cleanup.splice(0).forEach((fn) => fn());
  await tv.stop();
});

const channelOptions = (store = new MemoryTokenStore()) => ({
  host: '127.0.0.1',
  port: tv.wsPort,
  secure: false,
  tokenStore: store,
});

const artClient = (options: Record<string, unknown> = {}) => {
  const client = new ArtClient({ ...channelOptions(new MemoryTokenStore(tv.token)), ...options });
  cleanup.push(() => client.close());
  return client;
};

const frameTv = (options: Record<string, unknown> = {}) => {
  const frame = new FrameTV({
    host: '127.0.0.1',
    tokenStore: new MemoryTokenStore(tv.token),
    transport: tv.transport,
    pollIntervalMs: 100,
    ...options,
  });
  cleanup.push(() => frame.stop());
  return frame;
};

describe('helpers', () => {
  it('normalises key names', () => {
    expect(normalizeKey('home')).toBe('KEY_HOME');
    expect(normalizeKey('KEY_VOLUP')).toBe('KEY_VOLUP');
    expect(normalizeKey('channel up')).toBe('KEY_CHANNEL_UP');
  });

  it('builds a wake-on-LAN packet', () => {
    const packet = buildMagicPacket('AA:BB:CC:DD:EE:FF');
    expect(packet.length).toBe(102);
    expect(packet.subarray(0, 6)).toEqual(Buffer.alloc(6, 0xff));
    expect(packet.subarray(96).toString('hex')).toBe('aabbccddeeff');
    expect(() => buildMagicPacket('nope')).toThrow(InvalidArgumentError);
  });

  it('detects image types and rejects anything else', () => {
    expect(detectImageType(PNG)).toBe('png');
    expect(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(() => detectImageType(Buffer.from('not an image'))).toThrow(InvalidArgumentError);
  });
});

describe('device info and volume', () => {
  it('reads what the TV reports about itself', async () => {
    const info = await getDeviceInfo('127.0.0.1', { port: tv.restPort });
    expect(info).toMatchObject({ modelName: 'QN55LS03BAFXZA', frameSupport: true, tokenSupport: true, powerState: 'on', firmware: '1720' });
  });

  it('reads and sets volume and mute', async () => {
    const volume = new VolumeClient('127.0.0.1', { port: tv.restPort });
    expect(await volume.getVolume()).toBe(12);
    await volume.setVolume(250);
    expect(tv.volume).toBe(100);
    await volume.setMute(true);
    expect(await volume.getMute()).toBe(true);
  });
});

describe('remote channel', () => {
  it('pairs, saves the token, and reuses it', async () => {
    const store = new MemoryTokenStore();
    const remote = new RemoteClient(channelOptions(store));
    cleanup.push(() => remote.close());

    await remote.pair();
    expect(store.get()).toBe(tv.token);

    await remote.sendKey('home');
    await remote.launchApp('Netflix');
    await until(() => tv.keys.length === 1 && tv.launched.length === 1);
    expect(tv.keys[0]).toEqual({ key: 'KEY_HOME', cmd: 'Click' });
    expect(tv.connections).toBe(1);
  });

  it('presses and releases when holding a key', async () => {
    const remote = new RemoteClient(channelOptions(new MemoryTokenStore(tv.token)));
    cleanup.push(() => remote.close());

    await remote.holdKey('KEY_POWER', 30);
    await until(() => tv.keys.length === 2);
    expect(tv.keys.map((entry) => entry.cmd)).toEqual(['Press', 'Release']);
  });

  it('reports a rejected token clearly', async () => {
    const remote = new RemoteClient(channelOptions(new MemoryTokenStore('stale-token')));
    cleanup.push(() => remote.close());

    await expect(remote.pair()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('reconnects on its own after the TV drops the connection', async () => {
    const remote = new RemoteClient(channelOptions(new MemoryTokenStore(tv.token)));
    cleanup.push(() => remote.close());

    await remote.pair();
    remote.channel.setKeepAlive(true);
    tv.dropConnections();

    await until(() => !remote.channel.isOpen);
    await until(() => remote.channel.isOpen, 6000);
    expect(tv.connections).toBe(2);
  });
});

describe('art channel', () => {
  it('reads and switches Art Mode', async () => {
    const art = artClient();
    const seen: boolean[] = [];
    art.on('artMode', (on) => seen.push(on));

    expect(await art.getArtMode()).toBe(false);
    await art.setArtMode(true);
    expect(tv.artMode).toBe(true);
    expect(await art.getArtMode()).toBe(true);
    expect(seen).toContain(true);
  });

  it('lists, selects and deletes artwork', async () => {
    const art = artClient();

    expect(await art.list()).toHaveLength(3);
    expect((await art.list('MY-C0004')).map((item) => item.content_id)).toEqual(['SAM-F0100']);
    expect((await art.getCurrent()).content_id).toBe('MY_F0001');

    await art.select('MY_F0002');
    expect(tv.current).toBe('MY_F0002');

    await art.delete(['MY_F0001']);
    expect(await art.list()).toHaveLength(2);
  });

  it('reads and sets brightness within the TV range', async () => {
    const art = artClient();

    expect(await art.getBrightness()).toBe(5);
    await art.setBrightness(42);
    expect(tv.brightness).toBe(10);
  });

  it('controls the slideshow using the name this TV understands', async () => {
    const art = artClient();

    await art.setSlideshow({ minutes: 30, shuffle: false, categoryId: 'MY-C0004' });
    expect(tv.slideshow).toEqual({ value: '30', category_id: 'MY-C0004', type: 'slideshow' });
    expect((await art.getSlideshow()).value).toBe('30');

    await art.setSlideshow({ minutes: 0 });
    expect(tv.slideshow.value).toBe('off');
    expect(tv.artRequests).not.toContain('set_auto_rotation_status');
  });

  it('lists mattes', async () => {
    expect(await artClient().getMatteList()).toEqual({ types: ['none', 'shadowbox'], colors: ['polar', 'ink'] });
  });

  it('uploads an image over the transfer socket and returns its id', async () => {
    const art = artClient();
    const id = await art.upload(PNG, { matte: 'shadowbox_polar' });

    expect(id).toBe('MY_F1001');
    expect(tv.uploads[0]?.equals(PNG)).toBe(true);
    expect((await art.list()).at(-1)).toMatchObject({ content_id: 'MY_F1001', matte_id: 'shadowbox_polar' });
  });

  it('downloads thumbnails', async () => {
    const files = await artClient().getThumbnails(['MY_F0001', 'MY_F0002']);

    expect(files.map((file) => file.id)).toEqual(['MY_F0001', 'MY_F0002']);
    expect(files[1]?.data.toString()).toBe('thumbnail:MY_F0002');
  });

  it('turns a TV error reply into a named error', async () => {
    const error = await artClient()
      .request({ request: 'no_such_request' })
      .catch((e) => e);

    expect(error).toBeInstanceOf(ArtRequestError);
    expect(error.message).toContain('no_such_request');
    expect(error.code).toBe(-9);
  });

  it('backs off when the art service stops answering, and recovers', async () => {
    const art = artClient({ responseTimeoutMs: 40 });
    tv.artSilent = true;

    for (let i = 0; i < 3; i++) {
      await expect(art.getArtMode()).rejects.toBeInstanceOf(RequestTimeoutError);
    }

    expect(art.available).toBe(false);
    await expect(art.getArtMode()).rejects.toBeInstanceOf(ArtServiceUnavailableError);

    tv.artSilent = false;
    art.resetAvailability();
    expect(await art.getArtMode()).toBe(false);
  });
});

describe('FrameTV', () => {
  it('tracks on, art, standby and off', async () => {
    const frame = frameTv();
    const states: FrameState['status'][] = [];
    frame.on('state', (state: FrameState) => states.push(state.status));

    await frame.start();
    expect(frame.state).toEqual({ status: 'on', artMode: false, reachable: true });
    expect(frame.isFrame).toBe(true);

    tv.pushArtMode(true);
    await until(() => frame.state.status === 'art');

    tv.powerState = 'standby';
    await until(() => frame.state.status === 'standby');

    tv.online = false;
    await until(() => frame.state.status === 'off');

    expect(states).toEqual(['on', 'art', 'standby', 'off']);
  });

  it('switches Art Mode and leaves it again when turned on', async () => {
    const frame = frameTv();

    await frame.setArtMode(true);
    expect(tv.artMode).toBe(true);
    expect(frame.state.status).toBe('art');

    await frame.turnOn();
    expect(tv.artMode).toBe(false);
    expect(frame.state.status).toBe('on');
  });

  it('wakes from standby with the power key before entering Art Mode', async () => {
    const frame = frameTv();
    tv.powerState = 'standby';

    const done = frame.setArtMode(true);
    await until(() => tv.keys.some((entry) => entry.key === 'KEY_POWER'));
    tv.powerState = 'on';
    await done;

    expect(tv.artMode).toBe(true);
  });

  it('long-presses power to turn a Frame fully off', async () => {
    const frame = frameTv({ powerOffHoldMs: 30 });

    const done = frame.turnOff();
    await until(() => tv.keys.length === 2);
    tv.powerState = 'standby';
    await done;

    expect(tv.keys.map((entry) => `${entry.key}:${entry.cmd}`)).toEqual(['KEY_POWER:Press', 'KEY_POWER:Release']);
    expect(frame.state.status).toBe('standby');
  });

  it('refuses Art Mode on a TV that is not a Frame', async () => {
    tv.frameSupport = false;
    await expect(frameTv().setArtMode(true)).rejects.toBeInstanceOf(NotAFrameError);
  });

  it('explains when a powered-off TV cannot be woken without a MAC address', async () => {
    tv.online = false;
    await expect(frameTv().turnOn()).rejects.toThrow(/MAC address/);
  });
});
