import type { Transport } from './transport';
import { WebBluetoothTransport } from './webBluetooth';

/**
 * Choose a transport for the current platform.
 *
 * The native shell is detected at runtime and the CoreBluetooth transport is
 * imported lazily, so the web build never pulls in the Capacitor plugin and
 * the bundle stays the same size as before.
 */
export async function pickTransport(): Promise<Transport> {
  const native = typeof (window as unknown as { Capacitor?: unknown }).Capacitor !== 'undefined';
  if (native) {
    const { CapacitorBluetoothTransport } = await import('./capacitorBluetooth');
    return new CapacitorBluetoothTransport();
  }
  return new WebBluetoothTransport();
}

/** True when a transport exists for this platform at all. */
export function transportAvailable(): boolean {
  const native = typeof (window as unknown as { Capacitor?: unknown }).Capacitor !== 'undefined';
  return native || WebBluetoothTransport.isSupported();
}
