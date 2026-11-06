const { app } = require('electron');

void app.whenReady().then(() => {
  const finish = (said) => {
    console.error(`[dock] ${said}`);
    app.exit(0);
  };
  const set = app.dock.setIcon.bind(app.dock);
  app.dock.setIcon = (image) => {
    set(image);
    finish(String(image));
  };
  setTimeout(() => finish('none'), 15_000);
});
