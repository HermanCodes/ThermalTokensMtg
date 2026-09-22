import { usePrinter } from './usePrinter';
import { useLayoutChoice } from './useLayoutChoice';
import PhoneApp from './ui/PhoneApp';
import DesktopApp from './ui/DesktopApp';
import './desktop.css';

/**
 * Chooses an interface and hands it the app.
 *
 * Both views are pure presentation over `usePrinter`, so the search, renderer,
 * tone solving and Bluetooth behaviour are identical either way — only the
 * layout differs.
 */
export default function App() {
  const api = usePrinter();
  const { layout, setOverride } = useLayoutChoice();

  return layout === 'desktop' ? (
    <DesktopApp api={api} onUsePhoneLayout={() => setOverride('phone')} />
  ) : (
    <PhoneApp api={api} onUseDesktopLayout={() => setOverride('desktop')} />
  );
}
