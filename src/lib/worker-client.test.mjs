import test from "node:test";
import assert from "node:assert/strict";
import { createWorkerClient, WORKER_TIMEOUT } from "./worker-client.js";

function fakeWorkerFactory(handler) {
  const created = [];
  const factory = () => {
    const worker = {
      onmessage: null,
      onerror: null,
      terminated: false,
      postMessage(message) {
        handler(message, worker);
      },
      terminate() {
        worker.terminated = true;
      },
    };
    created.push(worker);
    return worker;
  };
  return { factory, created };
}

test("one worker instance serves sequential and concurrent requests by id", async () => {
  const { factory, created } = fakeWorkerFactory((message, worker) => {
    setTimeout(() => worker.onmessage({ data: { id: message.id, echo: message.value } }), message.value === 1 ? 10 : 1);
  });
  const client = createWorkerClient(factory, { label: "fake" });
  const [a, b] = await Promise.all([client.request({ value: 1 }), client.request({ value: 2 })]);
  assert.equal(a.echo, 1);
  assert.equal(b.echo, 2);
  const c = await client.request({ value: 3 });
  assert.equal(c.echo, 3);
  assert.equal(created.length, 1, "worker is reused");
});

test("error replies reject only the matching request", async () => {
  const { factory } = fakeWorkerFactory((message, worker) => {
    setTimeout(() => worker.onmessage({ data: { id: message.id, error: message.fail ? "boom" : undefined, ok: !message.fail } }), 1);
  });
  const client = createWorkerClient(factory, { label: "fake" });
  const good = client.request({ fail: false });
  await assert.rejects(client.request({ fail: true }), /boom/);
  assert.equal((await good).ok, true);
});

test("timeout terminates the worker and the next request spawns a new one", async () => {
  let respond = false;
  const { factory, created } = fakeWorkerFactory((message, worker) => {
    if (respond) setTimeout(() => worker.onmessage({ data: { id: message.id, ok: true } }), 1);
  });
  const client = createWorkerClient(factory, { label: "fake", timeoutMs: 5 });
  await assert.rejects(client.request({}), /timed out/);
  assert.equal(created[0].terminated, true);
  respond = true;
  const result = await client.request({});
  assert.equal(result.ok, true);
  assert.equal(created.length, 2);
});

test("worker errors reject pending requests and reset the instance", async () => {
  const { factory, created } = fakeWorkerFactory((message, worker) => {
    setTimeout(() => worker.onerror({ message: "crashed" }), 1);
  });
  const client = createWorkerClient(factory, { label: "fake" });
  await assert.rejects(client.request({}), /crashed/);
  assert.equal(created[0].terminated, true);
});

test("explicit termination releases all pending callers immediately", async () => {
  const { factory, created } = fakeWorkerFactory(() => {});
  const client = createWorkerClient(factory, { label: "fake" });
  const pending = [client.request({}), client.request({})];
  client.terminate();
  const results = await Promise.allSettled(pending);
  assert.ok(results.every((result) => result.status === "rejected" && /terminated/.test(result.reason.message)));
  assert.equal(created[0].terminated, true);
});

test("queued requests wait without their own timeout running", async () => {
  // Each request takes 20 ms; four in a row outlast the 50 ms timeout, but
  // none of them runs longer than it. Like a real worker, it runs one message
  // at a time.
  let busy = Promise.resolve();
  const { factory, created } = fakeWorkerFactory((message, worker) => {
    busy = busy.then(() => new Promise((resolve) => setTimeout(() => {
      worker.onmessage?.({ data: { id: message.id, echo: message.value } });
      resolve();
    }, 20)));
  });
  const client = createWorkerClient(factory, { label: "fake", timeoutMs: 50 });
  const results = await Promise.all([1, 2, 3, 4].map((value) => client.request({ value })));
  assert.deepEqual(results.map((result) => result.echo), [1, 2, 3, 4]);
  assert.equal(created.length, 1);
});

test("requests are posted one at a time, so queued transfers stay with the caller", async () => {
  const posted = [];
  const { factory } = fakeWorkerFactory((message, worker) => {
    posted.push(message.value);
    setTimeout(() => worker.onmessage({ data: { id: message.id } }), 5);
  });
  const client = createWorkerClient(factory, { label: "fake" });
  const pending = [client.request({ value: 1 }), client.request({ value: 2 })];
  assert.deepEqual(posted, [1], "the second request is held until the first settles");
  await Promise.all(pending);
  assert.deepEqual(posted, [1, 2]);
});

test("a timeout fails only the running request; the queue continues on a fresh worker", async () => {
  const { factory, created } = fakeWorkerFactory((message, worker) => {
    if (message.hang) return;
    setTimeout(() => worker.onmessage({ data: { id: message.id, echo: message.value } }), 1);
  });
  const client = createWorkerClient(factory, { label: "fake", timeoutMs: 20 });
  const hung = client.request({ hang: true });
  const next = client.request({ value: 2 });
  const last = client.request({ value: 3 });
  await assert.rejects(hung, (error) => error.code === WORKER_TIMEOUT && /timed out/.test(error.message));
  assert.equal((await next).echo, 2);
  assert.equal((await last).echo, 3);
  assert.equal(created[0].terminated, true);
  assert.equal(created.length, 2);
});

test("a worker crash fails only the running request; queued ones still run", async () => {
  const { factory, created } = fakeWorkerFactory((message, worker) => {
    if (message.crash) setTimeout(() => worker.onerror({ message: "crashed" }), 1);
    else setTimeout(() => worker.onmessage({ data: { id: message.id, ok: true } }), 1);
  });
  const client = createWorkerClient(factory, { label: "fake" });
  const crashing = client.request({ crash: true });
  const queued = client.request({});
  await assert.rejects(crashing, /crashed/);
  assert.equal((await queued).ok, true);
  assert.equal(created.length, 2);
});
