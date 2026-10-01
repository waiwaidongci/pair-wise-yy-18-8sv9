const { createApp } = require('./src/app');
const { config } = require('./src/config');

const PORT = process.env.PORT || config.port;

createApp()
  .then((app) => {
    app.listen(PORT, () => {
      console.log(config.title + ' API running at http://localhost:' + PORT);
    });
  })
  .catch((error) => {
    console.error('启动失败:', error);
    process.exit(1);
  });
