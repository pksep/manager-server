import { readFile, copyFile, mkdir, readdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';

// Подключение проверяемой сборки до публикации версии библиотеки.
const [sourceArgument, ...consumerArguments] = process.argv.slice(2);
if (!sourceArgument || !consumerArguments.length)
  throw new Error('Укажите каталог sep-yui и каталоги потребителей');
const source = resolve(sourceArgument);
const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
if (manifest.name !== '@pksep/yui')
  throw new Error('Источник должен быть репозиторием sep-yui');
const bundle = await readFile(join(source, 'dist/sep-yui.mjs'), 'utf8');
if (!bundle.includes('UserMultiSelect'))
  throw new Error('Сначала соберите sep-yui с компонентом UserMultiSelect');

/** Заменяет пути атомарно: запись поверх файла изменила бы hardlink в кэше Bun. */
async function copyIsolated(sourceDirectory, destinationDirectory) {
  await mkdir(destinationDirectory, { recursive: true });
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    const from = join(sourceDirectory, entry.name);
    const to = join(destinationDirectory, entry.name);
    if (entry.isDirectory()) await copyIsolated(from, to);
    else if (entry.isFile()) {
      const temporary = `${to}.manager-${randomUUID()}.tmp`;
      await copyFile(from, temporary);
      await rename(temporary, to);
    } else throw new Error('В сборке не должно быть символических ссылок');
  }
}
for (const argument of consumerArguments) {
  const consumer = resolve(argument);
  const consumerManifest = JSON.parse(
    await readFile(join(consumer, 'package.json'), 'utf8'),
  );
  if (!['@pksep/chat-core', 'sep_erp_client'].includes(consumerManifest.name))
    throw new Error('Разрешены только клиент чата и клиент ЕРП');
  const destination = join(consumer, 'node_modules/@pksep/yui');
  const installed = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
  if (installed.name !== '@pksep/yui')
    throw new Error('Сначала установите зависимости потребителя');
  await mkdir(join(destination, 'dist'), { recursive: true });
  await copyIsolated(join(source, 'dist'), join(destination, 'dist'));
  console.log(
    `Локальная сборка sep-yui подключена: ${consumerManifest.name}. Перезапустите Vite с --force.`,
  );
}
