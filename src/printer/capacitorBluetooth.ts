import { BleClient, numberToUUID, type ScanResult } from '@capacitor-community/bluetooth-le';
import {
  SERVICE_UUID,
  WRITE_CHAR_UUID,
  NOTIFY_CHAR_UUID,
  KNOWN_SERVICE_UUIDS,
} from './protocol';
import type { Transport, ConnectOptions } from './transport';

/**
 * CoreBluetooth transport for the iOS build, via @capacitor-community/bluetooth-le.
 *
 * iOS Safari has no Web Bluetooth and Apple has no plans to add it, so the
 * native shell is the only route to the printer on iPhone. Everything above
 * this file — the protocol, renderer, dithering and UI — is shared with the web
 * build; only the GATT calls differ.
 *
 * iOS specifics worth knowing:
 *   - CoreBluetooth addresses peripherals by an opaque per-app UUID, not a MAC.
 *     The id is stable for this app+device pair, so it can be remembered.
 *   - There is no `requestDevice` chooser. We scan ourselves, which is why the
 *     caller supplies `onDiscover` to drive a picker.
 *   - `Info.plist` must carry NSBluetoothAlwaysUsageDescription or the first
 *     BLE call kills the app.
 */
export class CapacitorBluetoothTransport implements Transport {
  readonly name = 'CoreBluetooth';
  private deviceId?: string;
  private connected = false;
  private disconnectCb?: () => void;
  /** Serialises writes — overlapping GATT writes are rejected. */
  private queue: Promise<unknown> = Promise.resolve();

  notifications: string[] = [];
  /** Remembered so a picker can show what was found. */
  lastScan: { id: string; name?: string }[] = [];

  /** Scan duration when no device id is supplied. */
  private static SCAN_MS = 6000;

  static isSupported(): boolean {
    // The plugin only resolves on a native shell; on the web build the Web
    // Bluetooth transport is used instead.
    return typeof (window as unknown as { Capacitor?: unknown }).Capacitor !== 'undefined';
  }

  isConnected(): boolean {
    return this.connected && !!this.deviceId;
  }

  /**
   * Connect to the printer.
   *
   * With no remembered id, scans for anything advertising a known Phomemo
   * service and takes the strongest signal. `allDevices` scans without a
   * service filter, for units that do not advertise their service UUID — the
   * same failure mode the web build hits.
   */
  async connect(opts: ConnectOptions & { deviceId?: string } = {}): Promise<string> {
    await BleClient.initialize({ androidNeverForLocation: true });

    let id = opts.deviceId ?? this.deviceId;
    let label = 'Phomemo printer';

    if (!id) {
      const found = await this.scan(opts.allDevices === true);
      if (found.length === 0) {
        throw new Error(
          'No printer found. Check it is switched on, has paper, and is not still ' +
            'connected to another app.',
        );
      }
      // Strongest signal first — the printer is usually the nearest device.
      found.sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
      id = found[0].device.deviceId;
      label = found[0].device.name || found[0].localName || label;
    }

    await BleClient.connect(id, () => {
      this.connected = false;
      this.disconnectCb?.();
    });

    this.deviceId = id;
    this.connected = true;

    await this.subscribeNotify();
    return label;
  }

  /** Scan for Phomemo-looking peripherals. */
  private async scan(allDevices: boolean): Promise<ScanResult[]> {
    const results: ScanResult[] = [];
    const seen = new Set<string>();

    await BleClient.requestLEScan(
      allDevices ? {} : { services: [numberToUUID(SERVICE_UUID)] },
      (result) => {
        if (seen.has(result.device.deviceId)) return;
        seen.add(result.device.deviceId);
        // Without a service filter, keep only plausible printers: a known
        // service UUID, or the bare all-caps serial the M110 often advertises.
        if (allDevices && !looksLikePrinter(result)) return;
        results.push(result);
        this.lastScan.push({ id: result.device.deviceId, name: result.device.name });
      },
    );

    await new Promise((r) => setTimeout(r, CapacitorBluetoothTransport.SCAN_MS));
    await BleClient.stopLEScan();
    return results;
  }

  /**
   * Subscribe to the notify characteristic. Some firmware only accepts raster
   * data once notifications are enabled.
   */
  private async subscribeNotify(): Promise<void> {
    this.notifications = [];
    if (!this.deviceId) return;
    try {
      await BleClient.startNotifications(
        this.deviceId,
        numberToUUID(SERVICE_UUID),
        numberToUUID(NOTIFY_CHAR_UUID),
        (value) => {
          const hex = [...new Uint8Array(value.buffer)]
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ');
          this.notifications.push(hex);
        },
      );
    } catch {
      // Not fatal — plenty of units print without it.
    }
  }

  async disconnect(): Promise<void> {
    const id = this.deviceId;
    this.connected = false;
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
    if (!id || !this.connected) return Promise.reject(new Error('Printer not connected'));

    const run = this.queue.then(async () => {
      // Copy into its own buffer: a subarray view would otherwise send the
      // whole backing ArrayBuffer.
      const buf = new Uint8Array(data.length);
      buf.set(data);
      // writeWithoutResponse is faster but cannot exceed the MTU; the caller
      // already chunks to a safe size, and with-response is the reliable path.
      await BleClient.write(
        id,
        numberToUUID(SERVICE_UUID),
        numberToUUID(WRITE_CHAR_UUID),
        new DataView(buf.buffer),
      );
    });
    this.queue = run.catch(() => {});
    return run;
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb;
  }
}

/** A bare all-caps serial (e.g. "Q199E45K1234567") or a known service UUID. */
function looksLikePrinter(result: ScanResult): boolean {
  const name = (result.device.name ?? result.localName ?? '').trim();
  if (/^(M110|M120|M220|M200)/i.test(name)) return true;
  const advertised = (result.uuids ?? []).map((u) => u.toLowerCase());
  if (advertised.some((u) => KNOWN_SERVICE_UUIDS.includes(u))) return true;
  return (
    name.length >= 10 &&
    name.length <= 18 &&
    /^[A-Z0-9]+$/.test(name) &&
    /[0-9]/.test(name) &&
    /[A-Z]/.test(name)
  );
}
