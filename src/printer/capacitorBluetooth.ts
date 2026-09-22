import {
  BleClient,
  type BleCharacteristic,
  type BleDevice,
} from '@capacitor-community/bluetooth-le';
import { SERVICE_UUID_STR, NOTIFY_CHAR_UUID_STR } from './protocol';
import {
  pickWritable,
  saveRemembered,
  propsOf,
  type GattEntryOf,
  type MatchPath,
} from './gattPick';
import type { Transport, ConnectOptions } from './transport';

/** One row of the connected device's GATT table, for the diagnostics panel. */
export interface GattEntry {
  service: string;
  characteristic: string;
  props: string;
  chosen: boolean;
}

/**
 * CoreBluetooth transport for the iOS build, via @capacitor-community/bluetooth-le.
 *
 * iOS Safari has no Web Bluetooth and Apple has no plans to add it, so the
 * native shell is the only route to the printer on iPhone. Everything above
 * this file — the protocol, renderer, dithering and UI — is shared with the web
 * build; only the GATT calls differ.
 *
 * Two things this must NOT assume:
 *   - That the printer exposes the documented 0xff00/0xff02 pair. Some units do
 *     not, so services are discovered and a characteristic is chosen by the
 *     same precedence the web transport uses.
 *   - That a scan filter will match. The advertised services need not include
 *     the one used for printing, so the device picker is unfiltered by default
 *     and the user identifies the printer by name.
 *
 * `Info.plist` must carry NSBluetoothAlwaysUsageDescription or the first BLE
 * call terminates the app.
 */
export class CapacitorBluetoothTransport implements Transport {
  readonly name = 'CoreBluetooth';
  private deviceId?: string;
  private pair?: { service: string; characteristic: string };
  private useNoResponse = false;
  private connected = false;
  private disconnectCb?: () => void;
  /** Serialises writes — overlapping GATT writes are rejected. */
  private queue: Promise<unknown> = Promise.resolve();

  gatt: GattEntry[] = [];
  matchPath?: MatchPath;
  notifications: string[] = [];

  /**
   * `without-response` skips the per-write acknowledgement. On iOS the MTU is
   * usually 185, so it is both safe and much faster than the web path — but the
   * caller still has to size chunks for it.
   */
  writeMode: 'with-response' | 'without-response' = 'with-response';

  static isSupported(): boolean {
    return typeof (window as unknown as { Capacitor?: unknown }).Capacitor !== 'undefined';
  }

  isConnected(): boolean {
    return this.connected && !!this.deviceId && !!this.pair;
  }

  isUncertain(): boolean {
    return this.matchPath === 'brute-force';
  }

  async connect(opts: ConnectOptions = {}): Promise<string> {
    await BleClient.initialize({ androidNeverForLocation: true });

    await BleClient.setDisplayStrings({
      scanning: 'Looking for your printer…',
      cancel: 'Cancel',
      availableDevices: 'Printers nearby',
      noDeviceFound: 'No Bluetooth devices found',
    }).catch(() => {
      /* cosmetic only */
    });

    // requestDevice shows the plugin's native picker on iOS, so the printer is
    // chosen by name rather than guessed from signal strength. Filtering by
    // service would hide units that do not advertise it, which is the same
    // failure the web build hits — so only filter when explicitly asked.
    let device: BleDevice;
    try {
      device = await BleClient.requestDevice(
        opts.allDevices === false ? { services: [SERVICE_UUID_STR] } : {},
      );
    } catch (e) {
      throw new Error(
        `No printer selected. ${(e as Error)?.message ?? ''}`.trim() +
          ' Check it is switched on and not still connected to another app.',
      );
    }

    await BleClient.connect(device.deviceId, () => {
      this.connected = false;
      this.pair = undefined;
      this.disconnectCb?.();
    });

    this.deviceId = device.deviceId;
    this.connected = true;

    await this.discover();
    if (!this.pair) {
      throw new Error(
        `Connected, but found no writable characteristic among ${this.gatt.length} entries.`,
      );
    }

    await this.subscribeNotify();
    return device.name || device.deviceId.slice(0, 8);
  }

  /** Enumerate every service, then choose a characteristic to write to. */
  private async discover(): Promise<void> {
    const id = this.deviceId!;
    this.gatt = [];
    this.pair = undefined;
    this.matchPath = undefined;

    // discoverServices forces a fresh interrogation; getServices reads the
    // cached table CoreBluetooth built.
    await BleClient.discoverServices(id).catch(() => {
      /* some firmware only answers getServices */
    });
    const services = await BleClient.getServices(id);

    const entries: GattEntryOf<BleCharacteristic>[] = [];
    for (const svc of services) {
      for (const ch of svc.characteristics) {
        const props = propsOf(ch.properties as unknown as Record<string, unknown>);
        entries.push({
          service: svc.uuid,
          characteristic: ch.uuid,
          writable: ch.properties.write || ch.properties.writeWithoutResponse,
          props,
          ref: ch,
        });
        this.gatt.push({ service: svc.uuid, characteristic: ch.uuid, props, chosen: false });
      }
    }

    const { chosen, matchPath } = pickWritable(entries);
    this.matchPath = matchPath;
    if (!chosen) return;

    this.pair = { service: chosen.service, characteristic: chosen.characteristic };
    // Only use unacknowledged writes if the characteristic actually offers it.
    this.useNoResponse =
      this.writeMode === 'without-response' && chosen.ref.properties.writeWithoutResponse;

    const row = this.gatt.find(
      (g) => g.service === chosen.service && g.characteristic === chosen.characteristic,
    );
    if (row) row.chosen = true;
  }

  /**
   * Subscribe to the notify characteristic if the chosen service has one.
   * Some firmware only accepts raster data once notifications are enabled.
   */
  private async subscribeNotify(): Promise<void> {
    this.notifications = [];
    if (!this.deviceId || !this.pair) return;
    const notify = this.gatt.find(
      (g) =>
        g.service.toLowerCase() === this.pair!.service.toLowerCase() &&
        g.characteristic.toLowerCase() !== this.pair!.characteristic.toLowerCase() &&
        /notify/.test(g.props),
    );
    const uuid = notify?.characteristic ?? NOTIFY_CHAR_UUID_STR;
    try {
      await BleClient.startNotifications(this.deviceId, this.pair.service, uuid, (value) => {
        const hex = [...new Uint8Array(value.buffer)]
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' ');
        this.notifications.push(hex);
      });
    } catch {
      // Not fatal — plenty of units print without it.
    }
  }

  /** Record the pair that worked, so the next connect targets it directly. */
  confirmWorking(): void {
    if (this.pair) saveRemembered(this.pair);
  }

  async disconnect(): Promise<void> {
    const id = this.deviceId;
    this.connected = false;
    this.pair = undefined;
    if (id) {
      try {
        await BleClient.disconnect(id);
      } catch {
        // Already gone.
      }
    }
  }

  write(data: Uint8Array): Promise<void> {
    const id = this.deviceId;
    const pair = this.pair;
    if (!id || !pair || !this.connected) {
      return Promise.reject(new Error('Printer not connected'));
    }

    const run = this.queue.then(async () => {
      // Copy into its own buffer: a subarray view would otherwise send the
      // whole backing ArrayBuffer.
      const buf = new Uint8Array(data.length);
      buf.set(data);
      const view = new DataView(buf.buffer);
      if (this.useNoResponse) {
        await BleClient.writeWithoutResponse(id, pair.service, pair.characteristic, view);
      } else {
        await BleClient.write(id, pair.service, pair.characteristic, view);
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb;
  }
}
