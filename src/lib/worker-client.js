/**
 * Minimal request/response wrapper around a long-lived Worker.
 *
 * Replies are matched by `id`, so one worker instance serves every decode
 * instead of a fresh worker per file. Requests are posted one at a time: the
 * worker runs them in order anyway, and holding the rest back means the
 * timeout measures only the request the worker is running. A timeout or worker
 * error fails that request alone and terminates the instance; queued requests
 * have not been transferred yet, so they continue on a fresh worker.
 */
export const WORKER_TIMEOUT = "WORKER_TIMEOUT";

export function createWorkerClient(createWorker, { timeoutMs = 45_000, label = "worker" } = {}) {
  let worker = null;
  let nextId = 1;
  let running = null;
  const queue = [];

  function stopWorker() {
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    worker = null;
  }

  function settle(entry, error, data) {
    if (running !== entry) return;
    running = null;
    clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve(data);
    pump();
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = createWorker();
    worker.onmessage = (event) => {
      const data = event?.data || {};
      if (!running || data.id !== running.id) return;
      settle(running, data.error ? new Error(data.error) : null, data);
    };
    worker.onerror = (event) => {
      const error = new Error(event?.message || `${label} failed.`);
      stopWorker();
      if (running) settle(running, error);
    };
    return worker;
  }

  function pump() {
    while (!running && queue.length) {
      const entry = queue.shift();
      let target;
      try {
        target = ensureWorker();
      } catch (error) {
        entry.reject(error);
        continue;
      }
      running = entry;
      entry.timer = setTimeout(() => {
        stopWorker();
        const error = new Error(`${label} timed out.`);
        error.code = WORKER_TIMEOUT;
        settle(entry, error);
      }, timeoutMs);
      try {
        target.postMessage({ id: entry.id, ...entry.payload }, entry.transfer);
      } catch (error) {
        settle(entry, error);
      }
    }
  }

  function terminate(error = new Error(`${label} terminated.`)) {
    stopWorker();
    const entries = running ? [running, ...queue] : [...queue];
    running = null;
    queue.length = 0;
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  function request(payload, transfer = []) {
    return new Promise((resolve, reject) => {
      queue.push({ id: nextId++, payload, transfer, resolve, reject, timer: null });
      pump();
    });
  }

  return { request, terminate };
}
