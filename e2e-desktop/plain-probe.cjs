const { app, webContents } = require('electron');

const steps = JSON.parse(process.env.PROBE_STEPS);
const finish = (result) => {
  console.error(`[probe] ${result}`);
  app.exit(0);
};
app.relaunch = () => finish('started again');
const findButton = (name) => `[...document.querySelectorAll('button')].reverse().find((b) =>
  (b.getAttribute('aria-label') ?? b.textContent).trim() === ${JSON.stringify(name)})`;
const check = (step) => {
  if (step.state)
    return `document.querySelector('[data-testid="connection-state"]')?.dataset.state === ${JSON.stringify(step.state)}`;
  if (step.button) return `!!${findButton(step.button)}`;
  if (step.text) return `document.body.innerText.includes(${JSON.stringify(step.text)})`;
  if (step.absent) return `!document.body.innerText.includes(${JSON.stringify(step.absent)})`;
  return `(() => { const b = ${findButton(step.click)}; if (!b) return false; b.click(); return true; })()`;
};

async function run() {
  await app.whenReady();
  const end = Date.now() + Number(process.env.PROBE_TIMEOUT_MS ?? 60000);
  for (const [index, step] of steps.entries()) {
    for (;;) {
      if (Date.now() > end) return finish(`timed out at step ${index}`);
      const page = webContents.getAllWebContents().find((c) => c.getURL().includes('index.html'));
      const done = page
        ? await Promise.race([
            page.executeJavaScript(check(step)).catch(() => false),
            new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
          ])
        : false;
      if (done) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  finish('done');
}
void run();
