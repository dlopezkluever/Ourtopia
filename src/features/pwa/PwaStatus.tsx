import { useEffect, useState } from 'react';
import { registerPublicShell } from '../../service-worker';

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
export function PwaStatus() {
  const [online, setOnline] = useState(navigator.onLine);
  const [install, setInstall] = useState<InstallPrompt | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void registerPublicShell().catch(() => setError('Offline shell unavailable. Retry while connected.'));
    const update = () => setOnline(navigator.onLine);
    const prompt = (event: Event) => { event.preventDefault(); setInstall(event as InstallPrompt); };
    window.addEventListener('online', update); window.addEventListener('offline', update); window.addEventListener('beforeinstallprompt', prompt);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); window.removeEventListener('beforeinstallprompt', prompt); };
  }, []);
  return <aside className="pwa-status" aria-label="App connection and installation">
    {!online && <p role="status">You're offline. Reconnect before opening private content or saving changes. <button type="button" onClick={() => location.reload()}>Retry connection</button></p>}
    {install ? <button type="button" onClick={() => void install.prompt().then(() => install.userChoice).then(() => setInstall(null))}>Install Ourtopia</button> : <details><summary>Use Ourtopia as an app</summary><p>In Chrome or Edge, use the browser's Install app menu. On iPhone or iPad, use Safari's Share menu, then Add to Home Screen. Installation is optional.</p></details>}
    {error && <p role="alert">{error} <button type="button" onClick={() => location.reload()}>Retry offline setup</button></p>}
  </aside>;
}
