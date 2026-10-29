import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

const installProbe = () => {
  const commits: { pages: Record<string, number>; components: number }[] = [];
  (window as any).__commits = commits;
  const pageNames = new Set(['App', 'HomePage', 'EupPage', 'PropStudioPage', 'PhotoModePage', 'VariantsPage', 'TemplateGenerationPage']);
  const nameOf = (fiber: any) => {
    const type = fiber.type;
    if (!type) return '';
    if (typeof type === 'function') return type.displayName || type.name || '';
    if (type.type) return type.type.displayName || type.type.name || '';
    return '';
  };
  (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject() { return 1; },
    checkDCE() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id: number, root: any) {
      const pages: Record<string, number> = {};
      let components = 0;
      const stack = [root.current.child];
      while (stack.length) {
        const fiber = stack.pop();
        if (!fiber) continue;
        if (fiber.sibling) stack.push(fiber.sibling);
        const isComponent = fiber.tag === 0 || fiber.tag === 1 || fiber.tag === 11 || fiber.tag === 14 || fiber.tag === 15;
        const rendered = !fiber.alternate || (fiber.flags & 1) === 1;
        if (isComponent && rendered) {
          components += 1;
          const name = nameOf(fiber);
          if (pageNames.has(name)) pages[name] = (pages[name] || 0) + 1;
        }
        const bailedOut = fiber.alternate && fiber.child === fiber.alternate.child;
        if (!bailedOut && fiber.child) stack.push(fiber.child);
      }
      commits.push({ pages, components });
    },
  };
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('switching tabs re-renders only the switched panes', { video: 'on' }, async ({ app, browser, screen }) => {
  await browser.addInitScript(installProbe);
  await app.open('/');
  await screen.getByRole('button', { name: 'Done' }).click().catch(() => {});
  await screen.getByRole('button', { name: /^Skip/ }).click().catch(() => {});
  await expect(browser.locator('.hp-mode').first()).toBeVisible();

  const modes = await browser.locator('.hp-mode').count();
  for (let index = 0; index < modes; index += 1) {
    await browser.locator('.shell-tab-home').click();
    await browser.locator('.hp-mode').nth(index).click();
    await pause(1500);
  }
  await pause(3000);
  const tabCount = await browser.locator('.shell-content > .shell-pane').count();

  const measure = (index: number) => browser.evaluate(async (index) => {
    const commits = (window as any).__commits as { pages: Record<string, number>; components: number }[];
    const tabs = [...document.querySelectorAll('.shell-tab')] as HTMLElement[];
    const target = tabs[index % tabs.length];
    const start = commits.length;
    const frames: number[] = [];
    let last = performance.now();
    let running = true;
    const tick = (now: number) => {
      frames.push(now - last);
      last = now;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const t0 = performance.now();
    target.click();
    const handled = performance.now() - t0;
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    const painted = performance.now() - t0;
    await new Promise((resolve) => setTimeout(resolve, 700));
    running = false;
    const slice = commits.slice(start);
    const pages: Record<string, number> = {};
    for (const commit of slice) for (const [name, count] of Object.entries(commit.pages)) pages[name] = (pages[name] || 0) + count;
    return {
      handled: Math.round(handled),
      painted: Math.round(painted),
      worstFrame: Math.round(Math.max(...frames.slice(1))),
      commits: slice.length,
      components: slice.reduce((sum, commit) => sum + commit.components, 0),
      pages,
    };
  }, index);

  const results = [];
  for (let round = 0; round < 3; round += 1) {
    for (let index = 0; index < tabCount; index += 1) results.push(await measure(index));
  }
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const pageRenders = results.map((result) => Object.values(result.pages).reduce((sum, count) => sum + count, 0));
  const summary = {
    tabs: tabCount,
    switches: results.length,
    medianHandledMs: median(results.map((result) => result.handled)),
    medianPaintedMs: median(results.map((result) => result.painted)),
    medianWorstFrameMs: median(results.map((result) => result.worstFrame)),
    maxWorstFrameMs: Math.max(...results.map((result) => result.worstFrame)),
    medianComponentsRendered: median(results.map((result) => result.components)),
    medianPageRenders: median([...pageRenders]),
    maxPageRenders: Math.max(...pageRenders),
    perSwitch: results.map((result) => `${result.painted}ms/${result.worstFrame}ms/${result.commits}c ${Object.entries(result.pages).map(([name, count]) => `${name}x${count}`).join(',')}`),
  };
  console.log(`TAB_SWITCH_SUMMARY ${JSON.stringify(summary)}`);
  expect(summary.switches).toBeGreaterThan(0);
  expect(summary.maxPageRenders).toBeLessThanOrEqual(3);
});
