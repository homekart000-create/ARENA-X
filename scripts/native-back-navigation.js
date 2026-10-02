import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';

if (Capacitor.isNativePlatform()) {
  App.addListener('backButton', ({ canGoBack }) => {
    if (canGoBack && history.length > 1) {
      history.back();
      return;
    }
    App.exitApp();
  });

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest('a[href]');
    if (!link) return;

    const targetUrl = new URL(link.href);
    if (targetUrl.origin === location.origin || targetUrl.protocol !== 'https:') return;

    event.preventDefault();
    void Browser.open({ url: targetUrl.href }).catch((error) => {
      console.warn('ARENA X could not open the external link.', error);
    });
  });
}
