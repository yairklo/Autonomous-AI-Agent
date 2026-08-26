/**
 * Bounded in-process queue so WhatsApp event handlers return immediately.
 */

export function createIngestQueue({
  handler,
  concurrency = 2,
  maxSize = 500,
  onLog = () => {},
} = {}) {
  const q = [];
  let active = 0;
  let dropped = 0;

  function pump() {
    while (active < concurrency && q.length) {
      const item = q.shift();
      active += 1;
      Promise.resolve()
        .then(() => handler(item))
        .catch((err) => onLog(`[whatsapp-ingest] queue handler error: ${err.message}`))
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  return {
    push(item) {
      if (q.length >= maxSize) {
        q.shift();
        dropped += 1;
        onLog(`[whatsapp-ingest] queue full — dropped oldest (dropped=${dropped})`);
      }
      q.push(item);
      pump();
    },
    size: () => q.length,
    active: () => active,
    dropped: () => dropped,
  };
}
