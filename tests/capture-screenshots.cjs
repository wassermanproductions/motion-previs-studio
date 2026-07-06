const fs = require('node:fs');
const path = require('node:path');
const { _electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const screenshotDir = path.join(root, 'docs', 'screenshots');
const samplePath = process.env.MPS_SAMPLE || '/tmp/codex-previs-xrefs/josh-followup.mp4';

async function main() {
  if (!fs.existsSync(samplePath)) {
    throw new Error(`Sample video missing. Set MPS_SAMPLE to a local MP4. Tried: ${samplePath}`);
  }

  fs.mkdirSync(screenshotDir, { recursive: true });

  const electronApp = await _electron.launch({
    args: ['.'],
    cwd: root
  });

  try {
    await electronApp.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
    }, samplePath);
    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setSize(1480, 1120);
      window?.center();
    });

    const page = await electronApp.firstWindow();
    page.setDefaultTimeout(30000);
    await page.waitForSelector('text=Motion Previs Studio v2');
    await page.waitForSelector('text=WassermanProductions.com');
    await page.addStyleTag({
      content: 'body { zoom: 0.62; }'
    });

    await page.getByRole('button', { name: 'Import' }).click();
    await page.waitForSelector(`text=${path.basename(samplePath)}`);
    await page.locator('.time-inputs input').nth(1).fill('2.20');
    await setRangeValue(page, 2, 6);
    await page.getByRole('button', { name: 'Run Analysis' }).click();
    await page.waitForSelector('text=Analysis complete', { timeout: 180000 });
    await page.waitForSelector('.pose-canvas', { timeout: 30000 });
    await seekPreviewVideos(page, 0.5);
    await resetPanelScroll(page);

    await page.screenshot({
      path: path.join(screenshotDir, 'app-home.png')
    });

    await page.locator('.shot-plan-panel').evaluate((element) => {
      element.scrollIntoView({ block: 'center' });
    });
    await page.locator('.right-sidebar').evaluate((element) => {
      element.scrollTo({ top: 0 });
    });
    await page.waitForTimeout(200);
    await page.screenshot({
      path: path.join(screenshotDir, 'app-shot-planning.png'),
      clip: { x: 0, y: 0, width: 1240, height: 1050 }
    });

    await page.locator('.left-sidebar').evaluate((element) => {
      element.scrollTo({ top: 0 });
    });
    await page.locator('.exports-panel').evaluate((element) => {
      element.scrollIntoView({ block: 'center' });
    });
    await page.waitForTimeout(200);
    await page.screenshot({
      path: path.join(screenshotDir, 'app-production-pack.png')
    });

    console.log(
      JSON.stringify(
        {
          screenshots: [
            path.join(screenshotDir, 'app-home.png'),
            path.join(screenshotDir, 'app-shot-planning.png'),
            path.join(screenshotDir, 'app-production-pack.png')
          ]
        },
        null,
        2
      )
    );
  } finally {
    await electronApp.close();
  }
}

async function setRangeValue(page, index, value) {
  await page.locator('input[type="range"]').nth(index).evaluate((input, nextValue) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    descriptor?.set?.call(input, String(nextValue));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function resetPanelScroll(page) {
  await page.locator('.left-sidebar').evaluate((element) => {
    element.scrollTo({ top: 0 });
  });
  await page.locator('.right-sidebar').evaluate((element) => {
    element.scrollTo({ top: 0 });
  });
  await page.waitForTimeout(200);
}

async function seekPreviewVideos(page, time) {
  const count = await page.locator('video').count();
  for (let index = 0; index < count; index += 1) {
    await page.locator('video').nth(index).evaluate(
      async (video, targetTime) => {
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : targetTime;
        const nextTime = Math.min(targetTime, Math.max(0, duration - 0.05));
        await new Promise((resolve) => {
          const timeout = window.setTimeout(resolve, 2500);
          video.onseeked = () => {
            window.clearTimeout(timeout);
            resolve();
          };
          video.currentTime = nextTime;
        });
        video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
      },
      time
    );
  }
  await page.waitForTimeout(500);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
