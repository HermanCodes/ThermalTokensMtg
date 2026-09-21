import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.joshhermann.tokenprinter',
  appName: 'Token Printer',
  // Vite's build output; `npx cap sync` copies this into the native shell.
  webDir: 'dist',
  ios: {
    // The label preview is drawn on a white sheet, so a light scroll background
    // avoids a dark flash while the web view boots.
    backgroundColor: '#14161a',
    contentInset: 'always',
  },
  plugins: {
    BluetoothLe: {
      displayStrings: {
        scanning: 'Looking for your printer…',
        cancel: 'Cancel',
        availableDevices: 'Printers found',
        noDeviceFound: 'No printer found',
      },
    },
  },
};

export default config;
