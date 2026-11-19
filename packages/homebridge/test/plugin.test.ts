import { FrameTV, MemoryTokenStore, silentLogger } from 'swiftframe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Homebridge only exports types from its package root; the test needs the real API object and HAP.
import { HomebridgeAPI } from '../../../node_modules/homebridge/dist/api.js';
import { MockTv } from '../../core/test/mock-tv.js';
import { normalizeTvConfigs, type TvConfig } from '../src/config.js';
import { TvAccessory } from '../src/tv-accessory.js';

const api = new HomebridgeAPI();
const { Service, Characteristic } = api.hap;

let tv: MockTv;
let frame: FrameTV;
let accessory: TvAccessory;

const config = (overrides: Partial<TvConfig> = {}): TvConfig => ({
  ...normalizeTvConfigs(
    [
      {
        name: 'Frame',
        ip: '127.0.0.1',
        nextArtworkSwitch: true,
        nextArtworkCollection: 'all',
        slideshowSwitch: true,
        inputs: [
          { name: 'Art', type: 'artmode' },
          { name: 'Netflix', type: 'app', value: '12345' },
          { name: 'HDMI', type: 'key', value: 'KEY_HDMI' },
          { name: 'Sunset', type: 'artwork', value: 'MY_F0002' },
        ],
      },
    ],
    () => {},
  )[0]!,
  ...overrides,
});

const setup = async (overrides: Partial<TvConfig> = {}, token: string | undefined = tv.token) => {
  frame = new FrameTV({
    host: '127.0.0.1',
    tokenStore: new MemoryTokenStore(token),
    transport: { ...tv.transport, readyFallbackMs: 60 },
    pollIntervalMs: 100,
    powerOffHoldMs: 30,
  });

  accessory = new TvAccessory(api, silentLogger, config(overrides), frame);
  await accessory.start();
};

const service = (type: any, subtype?: string) =>
  subtype ? accessory.platformAccessory.getServiceById(type, subtype)! : accessory.platformAccessory.getService(type)!;

const get = (svc: any, characteristic: any) => (svc.getCharacteristic(characteristic) as any).handleGetRequest();
const set = (svc: any, characteristic: any, value: unknown) => (svc.getCharacteristic(characteristic) as any).handleSetRequest(value);

beforeEach(async () => {
  tv = new MockTv();
  await tv.start();
});

afterEach(async () => {
  accessory?.destroy();
  await tv.stop();
});

describe('configuration', () => {
  it('applies defaults and skips entries that cannot work', () => {
    const warnings: string[] = [];
    const tvs = normalizeTvConfigs(
      [
        { ip: '10.0.0.5' },
        { name: 'No address' },
        { name: 'Duplicate', ip: '10.0.0.5' },
        { name: 'Den', ip: '10.0.0.6', tileMode: 'power', pollInterval: 1, inputs: [{ name: 'Bad', type: 'app' }, { name: 'Art', type: 'artmode' }] },
      ],
      (message) => warnings.push(message),
    );

    expect(tvs.map((entry) => entry.name)).toEqual(['Frame TV 1', 'Den']);
    expect(tvs[0]).toMatchObject({ tileMode: 'art', artModeSwitch: true, brightnessLight: true, nextArtworkSwitch: false, pollInterval: 15 });
    expect(tvs[1]).toMatchObject({ tileMode: 'power', pollInterval: 15, inputs: [{ name: 'Art', type: 'artmode' }] });
    expect(warnings).toHaveLength(3);
  });
});

describe('TV accessory', () => {
  it('exposes a television with inputs, speaker and the optional extras', async () => {
    await setup();

    expect(accessory.platformAccessory.category).toBe(api.hap.Categories.TELEVISION);
    expect(accessory.platformAccessory.services.filter((svc) => svc.UUID === Service.InputSource.UUID)).toHaveLength(4);
    expect(service(Service.TelevisionSpeaker)).toBeDefined();

    for (const subtype of ['art-mode', 'next-artwork', 'slideshow']) {
      expect(service(Service.Switch, subtype)).toBeDefined();
    }

    expect(service(Service.Lightbulb, 'art-brightness')).toBeDefined();
    await vi.waitFor(() =>
      expect(service(Service.AccessoryInformation).getCharacteristic(Characteristic.Model).value).toBe('QN55LS03BAFXZA'),
    );
  });

  it('by default treats the tile as TV versus Art Mode', async () => {
    await setup();
    const television = service(Service.Television);

    expect(await get(television, Characteristic.Active)).toBe(1);

    await set(television, Characteristic.Active, 0);
    expect(tv.artMode).toBe(true);
    expect(tv.keys).toHaveLength(0);
    expect(television.getCharacteristic(Characteristic.Active).value).toBe(0);
    expect(service(Service.Switch, 'art-mode').getCharacteristic(Characteristic.On).value).toBe(true);

    await set(television, Characteristic.Active, 1);
    expect(tv.artMode).toBe(false);
  });

  it('in power mode turns the screen fully off and counts Art Mode as on', async () => {
    await setup({ tileMode: 'power' });
    const television = service(Service.Television);

    tv.pushArtMode(true);
    await vi.waitFor(() => expect(frame.state.status).toBe('art'));
    expect(await get(television, Characteristic.Active)).toBe(1);

    const done = set(television, Characteristic.Active, 0);
    await vi.waitFor(() => expect(tv.keys.map((entry) => entry.cmd)).toEqual(['Press', 'Release']));
    tv.powerState = 'standby';
    await done;

    await vi.waitFor(() => expect(television.getCharacteristic(Characteristic.Active).value).toBe(0));
  });

  it('follows changes made with the physical remote', async () => {
    await setup();

    tv.pushArtMode(true);

    await vi.waitFor(() => {
      expect(service(Service.Switch, 'art-mode').getCharacteristic(Characteristic.On).value).toBe(true);
      expect(service(Service.Television).getCharacteristic(Characteristic.Active).value).toBe(0);
      // The Art Mode input shows as the active source.
      expect(service(Service.Television).getCharacteristic(Characteristic.ActiveIdentifier).value).toBe(1);
    });
  });

  it('handles each kind of input', async () => {
    await setup();
    const television = service(Service.Television);

    await set(television, Characteristic.ActiveIdentifier, 2);
    await vi.waitFor(() => expect(tv.launched).toEqual(['12345']));
    expect(await get(television, Characteristic.ActiveIdentifier)).toBe(2);

    await set(television, Characteristic.ActiveIdentifier, 3);
    await vi.waitFor(() => expect(tv.keys.map((entry) => entry.key)).toEqual(['KEY_HDMI']));

    await set(television, Characteristic.ActiveIdentifier, 4);
    expect(tv.artMode).toBe(true);
    expect(tv.current).toBe('MY_F0002');
  });

  it('quietly ignores a request for an input that does not exist', async () => {
    await setup();
    await expect(set(service(Service.Television), Characteristic.ActiveIdentifier, 0)).resolves.toBeUndefined();
  });

  it('maps the brightness light onto the 0-10 art brightness', async () => {
    await setup();
    const light = service(Service.Lightbulb, 'art-brightness');

    await set(light, Characteristic.Brightness, 70);
    expect(tv.brightness).toBe(7);
    expect(await get(light, Characteristic.Brightness)).toBe(70);

    // Home sends On alongside brightness; that must not toggle Art Mode by itself.
    await set(light, Characteristic.On, false);
    expect(tv.artRequests).not.toContain('set_artmode_status');
  });

  it('steps through artwork with the Next Artwork button and wraps around', async () => {
    await setup();
    const next = service(Service.Switch, 'next-artwork');

    await set(next, Characteristic.On, true);
    expect(tv.current).toBe('MY_F0002');
    await set(next, Characteristic.On, true);
    expect(tv.current).toBe('SAM-F0100');
    await set(next, Characteristic.On, true);
    expect(tv.current).toBe('MY_F0001');
  });

  it('turns the slideshow on with the configured interval and off again', async () => {
    await setup({ slideshowMinutes: 45, slideshowShuffle: false });
    const slideshow = service(Service.Switch, 'slideshow');

    await set(slideshow, Characteristic.On, true);
    expect(tv.slideshow).toMatchObject({ value: '45', type: 'slideshow' });

    await set(slideshow, Characteristic.On, false);
    expect(tv.slideshow.value).toBe('off');
  });

  it('sets volume and mute and sends remote keys', async () => {
    await setup();
    const speaker = service(Service.TelevisionSpeaker);

    await set(speaker, Characteristic.Volume, 33);
    await set(speaker, Characteristic.Mute, true);
    expect(tv.volume).toBe(33);
    expect(tv.muted).toBe(true);

    await set(service(Service.Television), Characteristic.RemoteKey, Characteristic.RemoteKey.ARROW_UP);
    await vi.waitFor(() => expect(tv.keys.at(-1)?.key).toBe('KEY_UP'));
  });

  it('pairs by itself when the TV is on and no token is saved', async () => {
    await setup({}, undefined);
    await vi.waitFor(() => expect(frame.isPaired).toBe(true));
  });

  it('keeps the Art Mode switch and tile working when the TV art service is missing', async () => {
    tv.artHost = false;
    await setup();
    const artSwitch = service(Service.Switch, 'art-mode');
    const television = service(Service.Television);

    await set(artSwitch, Characteristic.On, true);
    await vi.waitFor(() => expect(tv.artMode).toBe(true));
    expect(artSwitch.getCharacteristic(Characteristic.On).value).toBe(true);
    expect(television.getCharacteristic(Characteristic.Active).value).toBe(0);

    await set(television, Characteristic.Active, 1);
    await vi.waitFor(() => expect(tv.artMode).toBe(false));
    expect(artSwitch.getCharacteristic(Characteristic.On).value).toBe(false);

    // Brightness needs the art service, so Home is told it failed.
    await expect(set(service(Service.Lightbulb, 'art-brightness'), Characteristic.Brightness, 50)).rejects.toBe(
      api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  });

  it('reports an error to Home when a command fails', async () => {
    tv.frameSupport = false;
    await setup();

    // HAP surfaces a failed write as its status code.
    await expect(set(service(Service.Switch, 'art-mode'), Characteristic.On, true)).rejects.toBe(
      api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  });
});
