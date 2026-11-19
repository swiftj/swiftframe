import type { API, PlatformAccessory, Service } from 'homebridge';
import { errorMessage, type FrameState, type FrameTV, type Logger } from 'swiftframe-core';
import { collectionId, PLUGIN_NAME, type InputConfig, type TvConfig } from './config.js';

/** HomeKit gives up on a request after a few seconds, so slower work continues in the background. */
const RESPONSE_BUDGET_MS = 2_500;
const SLOW_REFRESH_MS = 60_000;

/**
 * One TV in Apple Home: a Television tile with inputs, remote and volume, plus optional
 * Art Mode switch, art brightness light, next-artwork button and slideshow switch.
 *
 * Every read answers from cached state so Home never waits on the TV; state is kept current
 * by the core's event stream and polling.
 */
export class TvAccessory {
  public readonly platformAccessory: PlatformAccessory;

  private readonly hap: API['hap'];
  private readonly television: Service;
  private readonly speaker: Service;
  private artSwitch?: Service;
  private brightnessLight?: Service;
  private nextSwitch?: Service;
  private slideshowSwitch?: Service;

  private state: FrameState;
  private volume = 0;
  private muted = false;
  private brightness = 5;
  private slideshowOn = false;
  private activeInput = 0;
  private pairing = false;
  private slowTimer?: NodeJS.Timeout;

  constructor(
    private readonly api: API,
    private readonly log: Logger,
    private readonly config: TvConfig,
    private readonly tv: FrameTV,
  ) {
    this.hap = api.hap;
    this.state = tv.state;

    const { Service, Characteristic, Categories } = this.hap;
    const uuid = this.hap.uuid.generate(`${PLUGIN_NAME}:${config.mac ?? config.ip}`);

    this.platformAccessory = new api.platformAccessory(config.name, uuid, Categories.TELEVISION);

    this.platformAccessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Samsung')
      .setCharacteristic(Characteristic.Model, 'The Frame')
      .setCharacteristic(Characteristic.SerialNumber, config.mac ?? config.ip);

    this.television = this.setupTelevision();
    this.speaker = this.setupSpeaker();
    this.setupInputs();
    this.setupExtras();

    this.tv.on('state', (state: FrameState) => this.onState(state));
  }

  public async start(): Promise<void> {
    await this.tv.start();
    this.onState(this.tv.state);

    this.slowTimer = setInterval(() => void this.refreshDetails(), SLOW_REFRESH_MS);
    this.slowTimer.unref?.();
  }

  public destroy(): void {
    clearInterval(this.slowTimer);
    this.tv.stop();
  }

  // --- Services -----------------------------------------------------------------------------

  private setupTelevision(): Service {
    const { Service, Characteristic } = this.hap;
    const service = this.platformAccessory.addService(Service.Television, this.config.name);

    service
      .setCharacteristic(Characteristic.ConfiguredName, this.config.name)
      .setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE)
      .setCharacteristic(Characteristic.ActiveIdentifier, 0);

    service
      .getCharacteristic(Characteristic.Active)
      .onGet(() => (this.tileIsOn() ? 1 : 0))
      .onSet((value) => this.handle('change power', () => this.setTile(value === 1)));

    service
      .getCharacteristic(Characteristic.ActiveIdentifier)
      .onGet(() => this.currentInput())
      .onSet((value) => this.handle('change input', () => this.selectInput(Number(value))));

    service.getCharacteristic(Characteristic.RemoteKey).onSet((value) => this.handle('send remote key', () => this.remoteKey(Number(value))));

    return service;
  }

  private setupSpeaker(): Service {
    const { Service, Characteristic } = this.hap;
    const service = this.platformAccessory.addService(Service.TelevisionSpeaker, `${this.config.name} Speaker`);

    service
      .setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
      .setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.ABSOLUTE);

    service
      .getCharacteristic(Characteristic.Mute)
      .onGet(() => this.muted)
      .onSet((value) =>
        this.handle('change mute', async () => {
          await this.tv.volume.setMute(Boolean(value));
          this.muted = Boolean(value);
        }),
      );

    service
      .getCharacteristic(Characteristic.Volume)
      .onGet(() => this.volume)
      .onSet((value) =>
        this.handle('change volume', async () => {
          await this.tv.volume.setVolume(Number(value));
          this.volume = Number(value);
        }),
      );

    service.getCharacteristic(Characteristic.VolumeSelector).onSet((value) =>
      this.handle('change volume', async () => {
        await this.tv.sendKey(value === Characteristic.VolumeSelector.INCREMENT ? 'KEY_VOLUP' : 'KEY_VOLDOWN');
        setTimeout(() => void this.refreshVolume(), 800);
      }),
    );

    this.television.addLinkedService(service);
    return service;
  }

  private setupInputs(): void {
    const { Service, Characteristic } = this.hap;

    for (const [index, input] of this.config.inputs.entries()) {
      const identifier = index + 1;
      const service = this.platformAccessory.addService(Service.InputSource, input.name, `input-${identifier}`);

      service
        .setCharacteristic(Characteristic.Identifier, identifier)
        .setCharacteristic(Characteristic.ConfiguredName, input.name)
        .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
        .setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN)
        .setCharacteristic(
          Characteristic.InputSourceType,
          input.type === 'app' ? Characteristic.InputSourceType.APPLICATION : Characteristic.InputSourceType.OTHER,
        );

      this.television.addLinkedService(service);
    }
  }

  private setupExtras(): void {
    const { Service, Characteristic } = this.hap;
    const name = this.config.name;

    if (this.config.artModeSwitch) {
      this.artSwitch = this.addNamed(Service.Switch, `${name} Art Mode`, 'art-mode');
      this.artSwitch
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.state.artMode === true)
        .onSet((value) => this.handle('change Art Mode', () => this.tv.setArtMode(Boolean(value))));
    }

    if (this.config.brightnessLight) {
      this.brightnessLight = this.addNamed(Service.Lightbulb, `${name} Art Brightness`, 'art-brightness');
      this.brightnessLight
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.state.artMode === true)
        .onSet((value) =>
          this.handle('change Art Mode', async () => {
            // Home sends On together with every brightness change; only act when it is a real change.
            if (Boolean(value) !== (this.state.artMode === true)) {
              await this.tv.setArtMode(Boolean(value));
            }
          }),
        );
      this.brightnessLight
        .getCharacteristic(Characteristic.Brightness)
        .onGet(() => this.brightness * 10)
        .onSet((value) =>
          this.handle('change art brightness', async () => {
            const level = Math.round(Number(value) / 10);
            await this.tv.art.setBrightness(level);
            this.brightness = level;
          }),
        );
    }

    if (this.config.nextArtworkSwitch) {
      this.nextSwitch = this.addNamed(Service.Switch, `${name} Next Artwork`, 'next-artwork');
      this.nextSwitch
        .getCharacteristic(Characteristic.On)
        .onGet(() => false)
        .onSet((value) => {
          if (!value) {
            return;
          }

          // A momentary button: do the work, then pop back off.
          setTimeout(() => this.nextSwitch?.updateCharacteristic(Characteristic.On, false), 1_000);
          return this.handle('show the next artwork', () => this.nextArtwork());
        });
    }

    if (this.config.slideshowSwitch) {
      this.slideshowSwitch = this.addNamed(Service.Switch, `${name} Slideshow`, 'slideshow');
      this.slideshowSwitch
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.slideshowOn)
        .onSet((value) =>
          this.handle('change the slideshow', async () => {
            await this.tv.art.setSlideshow({
              minutes: value ? this.config.slideshowMinutes : 0,
              shuffle: this.config.slideshowShuffle,
              categoryId: collectionId(this.config.nextArtworkCollection),
            });
            this.slideshowOn = Boolean(value);
          }),
        );
    }
  }

  private addNamed(type: typeof Service.Switch | typeof Service.Lightbulb, name: string, subtype: string): Service {
    const { Characteristic } = this.hap;
    const service = this.platformAccessory.addService(type, name, subtype);

    // Without ConfiguredName, Home shows every extra service under the TV's own name.
    service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    service.setCharacteristic(Characteristic.ConfiguredName, name);

    return service;
  }

  // --- Behaviour ----------------------------------------------------------------------------

  /** Whether the TV tile should show as on, according to the configured tile mode. */
  private tileIsOn(): boolean {
    if (this.config.tileMode === 'power') {
      return this.state.status === 'on' || this.state.status === 'art';
    }

    return this.state.status === 'on';
  }

  private async setTile(on: boolean): Promise<void> {
    if (on === this.tileIsOn()) {
      return;
    }

    if (on) {
      await this.tv.turnOn();
    } else if (this.config.tileMode === 'art' && this.tv.isFrame) {
      await this.tv.setArtMode(true);
    } else {
      await this.tv.turnOff();
    }
  }

  private currentInput(): number {
    const artInput = this.config.inputs.findIndex((input) => input.type === 'artmode');

    if (this.state.artMode && artInput >= 0) {
      return artInput + 1;
    }

    return this.activeInput;
  }

  private async selectInput(identifier: number): Promise<void> {
    const input: InputConfig | undefined = this.config.inputs[identifier - 1];

    if (!input) {
      // Home can ask for identifier 0 ("nothing selected") after a restart; there is nothing to do.
      this.log.debug(`Ignoring a request for input ${identifier}, which is not configured.`);
      return;
    }

    switch (input.type) {
      case 'artmode':
        await this.tv.setArtMode(true);
        break;
      case 'artwork':
        await this.tv.setArtMode(true);
        await this.tv.art.select(input.value!, { show: true });
        break;
      case 'app':
        if (this.state.status !== 'on') {
          await this.tv.turnOn();
        }

        await this.tv.launchApp(input.value!);
        this.activeInput = identifier;
        break;
      case 'key':
        await this.tv.sendKeys(
          input
            .value!.split(',')
            .map((key) => key.trim())
            .filter(Boolean),
        );
        // A key press is an action, not a lasting source, so nothing stays selected.
        setTimeout(() => this.television.updateCharacteristic(this.hap.Characteristic.ActiveIdentifier, this.currentInput()), 500);
        break;
    }
  }

  private remoteKey(value: number): Promise<void> {
    const { RemoteKey } = this.hap.Characteristic;

    const keys: Record<number, string> = {
      [RemoteKey.REWIND]: 'KEY_REWIND',
      [RemoteKey.FAST_FORWARD]: 'KEY_FF',
      [RemoteKey.NEXT_TRACK]: 'KEY_FF',
      [RemoteKey.PREVIOUS_TRACK]: 'KEY_REWIND',
      [RemoteKey.ARROW_UP]: 'KEY_UP',
      [RemoteKey.ARROW_DOWN]: 'KEY_DOWN',
      [RemoteKey.ARROW_LEFT]: 'KEY_LEFT',
      [RemoteKey.ARROW_RIGHT]: 'KEY_RIGHT',
      [RemoteKey.SELECT]: 'KEY_ENTER',
      [RemoteKey.BACK]: 'KEY_RETURN',
      [RemoteKey.EXIT]: 'KEY_HOME',
      [RemoteKey.PLAY_PAUSE]: 'KEY_PLAY_BACK',
      [RemoteKey.INFORMATION]: 'KEY_INFO',
    };

    const key = keys[value];
    return key ? this.tv.sendKey(key) : Promise.resolve();
  }

  private async nextArtwork(): Promise<void> {
    const items = await this.tv.art.list(collectionId(this.config.nextArtworkCollection));

    if (items.length === 0) {
      throw new Error(`The "${this.config.nextArtworkCollection}" collection on the TV is empty`);
    }

    const current = await this.tv.art.getCurrent().catch(() => undefined);
    const index = items.findIndex((item) => item.content_id === current?.content_id);
    const next = items[(index + 1) % items.length]!;

    await this.tv.art.select(next.content_id, { show: this.state.status === 'art' });
  }

  // --- State --------------------------------------------------------------------------------

  private onState(state: FrameState): void {
    const { Characteristic } = this.hap;
    const wasOffOrStandby = this.state.status === 'off' || this.state.status === 'standby';

    this.state = state;

    if (state.status !== 'on') {
      this.activeInput = 0;
    }

    this.television.updateCharacteristic(Characteristic.Active, this.tileIsOn() ? 1 : 0);
    this.television.updateCharacteristic(Characteristic.ActiveIdentifier, this.currentInput());
    this.artSwitch?.updateCharacteristic(Characteristic.On, state.artMode === true);
    this.brightnessLight?.updateCharacteristic(Characteristic.On, state.artMode === true);

    if (state.reachable) {
      void this.describe();
    }

    if (state.status === 'on' || state.status === 'art') {
      void this.ensurePaired();

      if (wasOffOrStandby || state.status === 'art') {
        void this.refreshDetails();
      }
    }
  }

  /** Fill in the model and firmware Home shows, once the TV has told us. */
  private async describe(): Promise<void> {
    const { Service, Characteristic } = this.hap;

    try {
      const info = await this.tv.getInfo();
      const service = this.platformAccessory.getService(Service.AccessoryInformation)!;

      if (info.modelName) {
        service.updateCharacteristic(Characteristic.Model, info.modelName);
      }

      if (info.firmware && /^\d+(\.\d+){0,2}$/.test(info.firmware)) {
        service.updateCharacteristic(Characteristic.FirmwareRevision, info.firmware);
      }
    } catch {
      // Cosmetic only.
    }
  }

  /** The first connection makes the TV show an Allow prompt. Keep offering until it is accepted. */
  private async ensurePaired(): Promise<void> {
    if (this.tv.isPaired || this.pairing) {
      return;
    }

    this.pairing = true;
    this.log.info('Pairing: accept the "Homebridge" prompt on the TV with your remote.');

    try {
      await this.tv.pair();
      this.log.info('Paired with the TV.');
      void this.refreshDetails();
    } catch (error) {
      this.log.warn(`Pairing did not complete: ${errorMessage(error)} It will be offered again the next time the TV turns on.`);
    } finally {
      this.pairing = false;
    }
  }

  private async refreshVolume(): Promise<void> {
    const { Characteristic } = this.hap;

    try {
      this.volume = await this.tv.volume.getVolume();
      this.muted = await this.tv.volume.getMute();
      this.speaker.updateCharacteristic(Characteristic.Volume, this.volume);
      this.speaker.updateCharacteristic(Characteristic.Mute, this.muted);
    } catch (error) {
      this.log.debug(`Could not read the volume: ${errorMessage(error)}`);
    }
  }

  /** Values the TV does not push: volume while watching, brightness and slideshow for a Frame. */
  private async refreshDetails(): Promise<void> {
    const { Characteristic } = this.hap;

    if (this.state.status !== 'on' && this.state.status !== 'art') {
      return;
    }

    if (this.state.status === 'on') {
      await this.refreshVolume();
    }

    if (!this.tv.isFrame || !this.tv.isPaired || !this.tv.art.available) {
      return;
    }

    if (this.brightnessLight) {
      try {
        this.brightness = await this.tv.art.getBrightness();
        this.brightnessLight.updateCharacteristic(Characteristic.Brightness, this.brightness * 10);
      } catch (error) {
        this.log.debug(`Could not read the art brightness: ${errorMessage(error)}`);
      }
    }

    if (this.slideshowSwitch) {
      try {
        this.slideshowOn = (await this.tv.art.getSlideshow()).value !== 'off';
        this.slideshowSwitch.updateCharacteristic(Characteristic.On, this.slideshowOn);
      } catch (error) {
        this.log.debug(`Could not read the slideshow setting: ${errorMessage(error)}`);
      }
    }
  }

  /**
   * Run a command for HomeKit. If it finishes quickly, report its real outcome. If it is still
   * running when HomeKit's patience runs out (waking a TV takes a while), answer optimistically
   * and correct the tile from the TV's actual state if the command later fails.
   */
  private async handle(what: string, action: () => Promise<void>): Promise<void> {
    const { HapStatusError, HAPStatus } = this.hap;

    let failure: unknown;
    let finished = false;

    const work = action()
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        finished = true;
      });

    await Promise.race([work, new Promise((resolve) => setTimeout(resolve, RESPONSE_BUDGET_MS))]);

    if (!finished) {
      void work.then(() => {
        if (failure) {
          this.log.warn(`Could not ${what}: ${errorMessage(failure)}`);
          this.onState(this.tv.state);
        }
      });
      return;
    }

    if (failure) {
      this.log.warn(`Could not ${what}: ${errorMessage(failure)}`);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }
}
