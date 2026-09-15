import 'reflect-metadata';
import { readConfig } from './config';
import { createApplication } from './app';

async function start() {
  const config = readConfig();
  const { app, close } = await createApplication(config);
  await app.listen(config.PORT, config.HOST);
  console.info(`Сервис обращений: http://${config.HOST}:${config.PORT}`);
  process.once('SIGINT', () => {
    void close();
  });
  process.once('SIGTERM', () => {
    void close();
  });
}
void start().catch(() => {
  console.error('Сервис не запущен: проверьте конфигурацию, доступность базы и миграции');
  process.exitCode = 1;
});
