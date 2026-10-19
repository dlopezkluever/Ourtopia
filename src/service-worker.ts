export async function registerPublicShell() {
  let manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!manifest) { manifest = document.createElement('link'); manifest.rel = 'manifest'; document.head.append(manifest); }
  manifest.href = '/manifest.webmanifest';
  if ('serviceWorker' in navigator) await navigator.serviceWorker.register('/manifest-service-worker.js', { scope: '/' });
}
