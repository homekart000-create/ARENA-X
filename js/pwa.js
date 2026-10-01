(() => {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js', { scope: './' })
      .catch((error) => {
        console.warn('ARENA-X offline support could not be enabled.', error);
      });
  }, { once: true });
})();
