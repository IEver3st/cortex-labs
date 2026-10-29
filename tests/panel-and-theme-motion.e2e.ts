import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('sidebars slide and the theme cross-fades', { video: 'on' }, async ({ app, browser, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Done' }).click();
  await screen.getByRole('button', { name: /^Skip/ }).click();
  await screen.getByRole('button', { name: /^Vehicle/ }).first().click();
  await expect(browser.locator('.lv-root')).toBeVisible();
  await pause(800);

  const regions = await browser.evaluate(() => {
    const region = (element: Element | null) => element ? getComputedStyle(element).getPropertyValue('-webkit-app-region') || getComputedStyle(element).getPropertyValue('app-region') : 'missing';
    return {
      bar: region(document.querySelector('.ctx-bar-inner')),
      toggles: [...document.querySelectorAll('.lv-layout-half')].map(region),
    };
  });
  console.log(JSON.stringify(regions));
  expect(regions.bar).toBe('drag');
  expect(regions.toggles.length).toBeGreaterThan(0);
  expect(regions.toggles.every((value) => value === 'no-drag')).toBe(true);

  const watch = () => browser.evaluate(() => {
    const root = document.querySelector('.lv-root')!;
    const samples: { cols: string; dock: number; insp: number }[] = [];
    const offset = (selector: string) => {
      const pane = root.querySelector(selector);
      const transform = pane ? getComputedStyle(pane).transform : 'none';
      return transform === 'none' ? 0 : Math.round(new DOMMatrixReadOnly(transform).m41);
    };
    const tick = () => {
      samples.push({ cols: getComputedStyle(root).gridTemplateColumns, dock: offset(':scope > .lv-dock'), insp: offset(':scope > .lv-inspector') });
      if (samples.length < 40) requestAnimationFrame(tick);
    };
    (window as any).__paneSamples = samples;
    requestAnimationFrame(tick);
    return true;
  });
  const report = (label: string) => browser.evaluate((label) => {
    const samples = (window as any).__paneSamples as { cols: string; dock: number; insp: number }[];
    const root = document.querySelector('.lv-root')!;
    const leftovers = [...root.querySelectorAll(':scope > .lv-dock, :scope > .lv-inspector')].map((pane) => (pane as HTMLElement).style.cssText).join('');
    return {
      label,
      layouts: [...new Set(samples.map((sample) => sample.cols))].length,
      dock: [...new Set(samples.map((sample) => sample.dock))],
      insp: [...new Set(samples.map((sample) => sample.insp))],
      leftovers,
    };
  }, label);

  const run = async (label: string, act: () => Promise<void>, toggles = 1) => {
    await watch();
    await act();
    await pause(700);
    const result = await report(label);
    console.log(JSON.stringify(result));
    expect(result.layouts).toBeLessThanOrEqual(toggles + 1);
    expect(result.leftovers).toBe('');
    return result;
  };
  const click = (name: string) => () => screen.getByRole('button', { name }).click();

  const hideInsp = await run('hide inspector', click('Hide the inspector'));
  expect(hideInsp.insp.some((x) => x > 20)).toBe(true);
  const showInsp = await run('show inspector', click('Show the inspector'));
  expect(showInsp.insp.some((x) => x > 20)).toBe(true);
  const hideDock = await run('hide dock', click('Hide the dock'));
  expect(hideDock.dock.some((x) => x < -20)).toBe(true);
  const showDock = await run('show dock', click('Show the dock'));
  expect(showDock.dock.some((x) => x < -20)).toBe(true);
  const overlap = await run('inspector keeps sliding when the dock toggles', async () => {
    await click('Hide the inspector')();
    await pause(60);
    await click('Hide the dock')();
  }, 2);
  expect(overlap.insp.filter((x) => x > 20 && x < 280).length).toBeGreaterThan(3);
  await run('both back', async () => {
    await click('Show the inspector')();
    await click('Show the dock')();
  }, 2);
  await browser.locator('canvas').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
  const focus = await run('focus mode', () => browser.keyboard.press('Backslash'));
  expect(focus.dock.some((x) => x < -20) && focus.insp.some((x) => x > 20)).toBe(true);
  await run('focus rapid', async () => {
    await browser.keyboard.press('Backslash');
    await pause(80);
    await browser.keyboard.press('Backslash');
    await pause(80);
    await browser.keyboard.press('Backslash');
  }, 3);

  await screen.getByRole('button', { name: 'Settings' }).click();
  await screen.getByRole('button', { name: /^Appearance/ }).first().click();
  const startDark = await browser.evaluate(() => document.documentElement.classList.contains('dark'));
  await browser.locator('.settings-theme-choice').filter({ hasText: startDark ? 'Light' : 'Dark' }).click();
  await pause(60);
  const fading = await browser.evaluate(() => document.getAnimations().some((animation) => String((animation.effect as KeyframeEffect | null)?.pseudoElement ?? '').startsWith('::view-transition')));
  await pause(600);
  const nowDark = await browser.evaluate(() => document.documentElement.classList.contains('dark'));
  console.log(JSON.stringify({ startDark, fading, nowDark }));
  expect(fading).toBe(true);
  expect(nowDark).toBe(!startDark);
  await pause(400);
});
