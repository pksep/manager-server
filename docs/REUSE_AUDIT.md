# manager: аудит существующих решений

Дата: 10.09.2026. Метод: чтение исходников, общих схем, вызывающего кода,
конфигурации пакетов и состояния Git. Это архитектурный аудит исходников;
доступность производственных API и работоспособность сценариев не проверялись.
Ниже отдельно указаны существующее поведение и необходимые доработки.

После аудита выполнен локальный этап виджета. Изменения по его результатам
описаны в [SHARED_COMPONENTS](../../manager-client/docs/SHARED_COMPONENTS.md);
таблицы ниже сохраняют исходные снимки, на которых принимались решения.

## 1. Репозитории и основание анализа

| Репозиторий | Прочитанный снимок | Примечание |
| --- | --- | --- |
| pksep/chat_client | `a82b6d8712b045bb78cd6c185fa983ac14aab30a`, canary | Отдельная рабочая копия `.worktrees/manager-chat-client`, ветка manager |
| pksep/chat_server | `c1ae927f8f6737fc6cbc3e3a5f4ce2484645b3eb`, canary | `.worktrees/manager-chat-server`, ветка manager |
| pksep/sep_yui | `4149d6540d833b62caee4fbd0cb5e8146994b7d5`, main | `.worktrees/manager-yui-audit`, отдельный снимок для чтения, версия 0.1.318 |
| pksep/chat_sync | `501b66945122ae077426678bfe03a2eacc0a99b0` | Изучены авторизация, профиль сотрудника и потребитель событий ЕРП |
| pksep/sep_erp_server | `9dedaa9a55e15e0f3ff8eab4f07e04243da3e3b5` | Локальная ветка feat/ai-artifact-exports; исследованные contact/roles и схемы не имеют локального diff |
| pksep/sep_erp_client | `969588a7ba09d2eb367d500afc4e3a222a7e7a35` | Локальная ветка ai; исследованная папка Comments не имеет локального diff |
| pksep/comments | `26da9559c5a1d48aba7b53c02153555d5f98627b` | Вспомогательный просмотр сервиса комментариев и ссылок файлов |
| @pksep/contracts | Установленный пакет 1.0.2 в chat_server/node_modules | Прочитаны объявления chat/message и erp/user, package.json |

Исходные рабочие копии chat_client, sep_yui и sep_erp_client содержат изменения
других задач. Они не перенесены в manager. Для чата специально получены свежие
canary, поскольку исходные локальные ветки отстают и содержат другой контекст.
Для ЕРП перед реализацией нужно повторить проверку на актуальной принятой базе:
этот этап не обновлял её ветки и не проверял deployment.

Новые `manager-client` и `manager-server` уже созданы на GitHub владельцем,
оба имеют visibility public и были пустыми при проверке. Получены локальные
клоны, HEAD установлен на manager. Существующих manager-веток в чате и PR
с head manager не найдено; поиск manager в заголовках выявил только другие
старые задачи. Новые PR и публикация документов этим этапом не выполнялись.
Для chat_client/chat_server существует canary; для новых пустых репозиториев
фактических базовых веток ещё нет. У sep_yui удалённая основная ветка main,
canary на момент проверки не обнаружена.

## 2. Карта переиспользования

| Область | Что фактически есть | Решение для manager |
| --- | --- | --- |
| Редактор | ContentEditor из yui; подключён в MessageListInput и CommentsPanel | Переиспользовать общий компонент; собственный транспорт и сохранение черновика |
| Эмодзи и файлы в редакторе | Событие unmount-send с content/files/mediaFiles; отдельное событие прикрепления | Сохранить payload до замены экрана формой; загрузка остаётся ответственностью приложения |
| Сообщения | MessageBubble, Text, Files, Media, AuthorMeta и другие компоненты в chat_client | Выделить отображение в существующую общую библиотеку; оставить действия и состояние в чатовых обёртках |
| Popover | Список с иконками, слот trigger, управление isShow; штатный триггер click | Добавить управление наведением/фокусом у виджета без смены текущего поведения остальных потребителей |
| Токены | semantic.scss содержит точно заданные синие, белые, серые цвета | Использовать semantic-токены, не создавать второй набор цветов |
| Иконки | Enum содержит chat и crossSmall | Проверить размер исходных SVG; иконки соцсетей не найдены в исследованном enum |
| Встраивание | yui импортирует глобальные стили/шрифты; всплывающие компоненты используют Teleport; редактор измеряет window | Проверить iframe и управление размерами; нельзя предполагать изоляцию простым div |
| Топики | GROUP/DM, TopicSetting для доступа, GroupMemberRole для ролей группы | GROUP с новым типизированным назначением; проекция участников из прав ЕРП |
| Создание группы | GroupsService.create транзакционно создаёт топик, группу, настройки и роли, затем уведомляет | Расширить канонический путь для сервисного создания внешнего обращения, не копировать SQL в manager-server |
| Внутренние сообщения | internal/messages/send/edit/delete под x-service-key | Использовать как основу ограниченных команд внешнего обращения, добавить строгие контракты и гарантии повторов |
| Внутренние топики | Чтение топика/участников и добавление/удаление бота | Готового ensureInquiryTopic нет; требуется новая ограниченная команда поверх сервисов чата |
| События | ChatEventsPublisher → RabbitMQ; сохранённый ChatSyncEvent с курсором PTS | Переиспользовать транспорт и изученный журнал, добавить гарантии восстановления и отдельного потребителя |
| Медиа | S3Service, Media, загрузки, multipart, превью и фоновые обработки | Сохранять единое хранение; добавить гостевую область полномочий и защиту всех путей чтения |
| Сотрудники | chat_sync связывает ERP-профиль с пользователем чата и получает erp.user.change.v1 | Переиспользовать доверенную связь ID, расширить передачу/обновление полномочий |
| Контакт ЕРП | ContactService.createContact/updateContact, реквизиты JSONB, ActionsService | Синхронизировать через штатную операцию, добавить точный поиск и повторяемость |
| Роли ЕРП | Объект accesses, общий набор ключей и проверка полного payload | Добавить право раздела во все части контракта; название роли недостаточно |
| Разделы чата | useChatMenu: chats/calls/ai/profile; Menu и MenuBottomNav | Добавить обращения, серверную фильтрацию и учёт кеша/уведомлений |

## 3. Ограничения, влияющие на объём

### UI

На canary чат использует `@pksep/yui` с диапазоном `^0.1.318`; изученный main
yui имеет версию 0.1.318. В исходной рабочей папке другой задачи была 0.1.315.
Версии реализации нужно закрепить совместимо, а не ориентироваться на старую
папку или автоматически брать последнюю версию при каждой сборке.

ContentEditor выбирает мобильную раскладку по `window.innerWidth <= 480` и
имеет собственные ограничения размеров и панели эмодзи. Ширина iframe 418 px
активирует эту логику даже на большом мониторе. Нужна проверка раскладки,
а при необходимости — явный параметр нового потребителя со старыми defaults.

MessageBubble связан с Capacitor, контекстным меню, выбранными сообщениями,
useChat, обработкой файлов и локальным кешем. Его нельзя считать уже готовым
самостоятельным экспортом yui. `@pksep/chat-core` экспортирует весь контейнер
чата; это не эквивалент набора лёгких компонентов сообщений.

Проверка лицензий для открытого релиза: в yui не найден файл лицензии и поле
license; chat_client/LICENSE пуст; установленный @pksep/contracts отмечен
UNLICENSED. Пользователь разрешил переиспользование, но условия открытого
распространения нужно оформить в ходе подготовки релиза. Серверный пакет
contracts не требуется включать в браузерную сборку.

### Доставка и авторы

В MessagesService есть createWithIdempotency и поиск по `ex.clientId`.
Изученный путь делает поиск, затем создаёт запись и отдельно обрабатывает
медиа. Это не доказательство атомарности конкурентных повторов. В рассмотренных
миграциях индекс для clientId не найден. Нужны транзакционный сценарий,
ограничение уникальности или эквивалентная сериализация с тестом гонки.

InternalMessagesController вызывает create и затем broadcastMessageChange,
не ожидая его завершения. Поэтому HTTP-ответ от этого контроллера не подтверждает
публикацию события. Сам publisher публикует отдельно от записи сообщения.
Для manager нужен устойчивый путь восстановления промежутка «сохранили,
но ещё не доставили». Существующий журнал PTS полезен, однако его штатное чтение
ограничено пользователем чата и его топиками; его нельзя открывать гостям целиком.

Издатель формирует тип `EDIT`, а установленная схема MessageEditEvent описывает
`CHANGE`. Стандартный тип ChatEventMessage также не описывает вложения.
Перед подключением нового потребителя требуется совместимый явный контракт.

Сообщение обязано ссылаться на User через senderUserId. Поэтому решение
«просто принять anonymous text» недостаточно: нужен ограниченный внешний
профиль автора и отдельная сервисная авторизация без выдачи клиенту прав чата.

### Файлы

MultipartUploadController использует CurrentUser; гостевая сессия сама по себе
с ним несовместима. Внутренний лимит Media составляет 600 MiB.
MediaController.downloadObject отмечен Public и проверяет наличие объекта,
не принадлежность гостевому обращению или роли менеджера. Для нового сценария
потребуется защитить файлы обращений и этот прямой путь. Само хранилище,
шифрование и обработчики можно переиспользовать.
Это вывод о несоответствии будущим требованиям, без runtime-проверки доступа.

### ЕРП и полномочия

Contacts хранят requisites, но getContacts ищет по initial/position и связанным
фильтрам компаний. Точного поиска телефона/email в исследованном ContactService
нет. Схема реального реквизита использует `title: { type, value? }`, поэтому
пример строки title из декоратора модели не является контрактом интеграции.

Создание контакта записывает действие инициатора в транзакции. Прямое создание
из новой базы или отдельного SQL-пути потеряло бы этот сценарий.
Нужна обёртка повторяемой операции вокруг существующего ContactService.

chat_sync передаёт ERP ID и название роли в ex, но не полный accesses.
RolesService.updateAssets проверяет жёсткий список ключей, обновляет роль и кеш.
Изменение доступа самой роли требует отдельной доставки полномочий всем её
сотрудникам. Только добавление участников при создании топика этого не решает.

## 4. Ссылки на исходники

Ссылки фиксируют прочитанные ревизии. Для локальной проверки соответствующие
пути находятся в рабочих копиях из таблицы выше.

- [ContentEditor и его контракт](https://github.com/pksep/sep_yui/blob/4149d6540d833b62caee4fbd0cb5e8146994b7d5/src/components/ContentEditor/interfaces/content-editor.ts),
  [реализация](https://github.com/pksep/sep_yui/blob/4149d6540d833b62caee4fbd0cb5e8146994b7d5/src/components/ContentEditor/ContentEditor.vue).
- [Popover](https://github.com/pksep/sep_yui/blob/4149d6540d833b62caee4fbd0cb5e8146994b7d5/src/components/Popover/Popover.vue),
  [семантические цвета](https://github.com/pksep/sep_yui/blob/4149d6540d833b62caee4fbd0cb5e8146994b7d5/src/assets/scss/semantic.scss),
  [иконки](https://github.com/pksep/sep_yui/blob/4149d6540d833b62caee4fbd0cb5e8146994b7d5/src/components/Icon/enum/enum.ts).
- [Редактор в чате](https://github.com/pksep/chat_client/blob/a82b6d8712b045bb78cd6c185fa983ac14aab30a/src/components/Messages/MessageListInput.vue),
  [MessageBubble](https://github.com/pksep/chat_client/blob/a82b6d8712b045bb78cd6c185fa983ac14aab30a/src/components/Messages/MessageBubble.vue),
  [кеш и пути медиа](https://github.com/pksep/chat_client/blob/a82b6d8712b045bb78cd6c185fa983ac14aab30a/src/components/Messages/composables/useMessageMedia.ts).
- [Редактор в комментариях](https://github.com/pksep/sep_erp_client/blob/969588a7ba09d2eb367d500afc4e3a222a7e7a35/src/components/Comments/CommentsPanel.vue).
- [Разделы](https://github.com/pksep/chat_client/blob/a82b6d8712b045bb78cd6c185fa983ac14aab30a/src/composables/useChatMenu.ts),
  [MenuBottomNav](https://github.com/pksep/chat_client/blob/a82b6d8712b045bb78cd6c185fa983ac14aab30a/src/components/Menu/MenuBottomNav.vue).
- [Модель топика](https://github.com/pksep/chat_server/blob/c1ae927f8f6737fc6cbc3e3a5f4ce2484645b3eb/src/modules/topics/model/topic.model.ts),
  [создание группы](https://github.com/pksep/chat_server/blob/c1ae927f8f6737fc6cbc3e3a5f4ce2484645b3eb/src/modules/groups/groups.service.ts),
  [доступ к топику](https://github.com/pksep/chat_server/blob/c1ae927f8f6737fc6cbc3e3a5f4ce2484645b3eb/src/modules/topics/topic-access.service.ts).
- [Внутренние топики](https://github.com/pksep/chat_server/blob/c1ae927f8f6737fc6cbc3e3a5f4ce2484645b3eb/src/modules/topics/internal-topics.controller.ts),
  [внутренние сообщения](https://github.com/pksep/chat_server/blob/c1ae927f8f6737fc6cbc3e3a5f4ce2484645b3eb/src/modules/messages/internal-messages.controller.ts),
  [сохранение сообщений](https://github.com/pksep/chat_server/blob/c1ae927f8f6737fc6cbc3e3a5f4ce2484645b3eb/src/modules/messages/messages.service.ts).
- [События чата](https://github.com/pksep/chat_server/blob/c1ae927f8f6737fc6cbc3e3a5f4ce2484645b3eb/src/modules/messages/messages.gateway.ts),
  [RabbitMQ publisher](https://github.com/pksep/chat_server/blob/c1ae927f8f6737fc6cbc3e3a5f4ce2484645b3eb/src/modules/rabbitmq/chat-events.publisher.ts),
  [чтение журнала](https://github.com/pksep/chat_server/blob/c1ae927f8f6737fc6cbc3e3a5f4ce2484645b3eb/src/modules/messages/chat-sync.controller.ts).
- [Файлы](https://github.com/pksep/chat_server/blob/c1ae927f8f6737fc6cbc3e3a5f4ce2484645b3eb/src/modules/media/media.controller.ts),
  [multipart](https://github.com/pksep/chat_server/blob/c1ae927f8f6737fc6cbc3e3a5f4ce2484645b3eb/src/modules/media/multipart-upload.controller.ts),
  [лимит](https://github.com/pksep/chat_server/blob/c1ae927f8f6737fc6cbc3e3a5f4ce2484645b3eb/src/modules/media/media.constants.ts).
- [Синхронизация сотрудников](https://github.com/pksep/chat_sync/blob/501b66945122ae077426678bfe03a2eacc0a99b0/src/services/chat.service.ts),
  [события ЕРП](https://github.com/pksep/chat_sync/blob/501b66945122ae077426678bfe03a2eacc0a99b0/src/core/kafka/kafka.consumer.ts).
- [Сервис контактов](https://github.com/pksep/sep_erp_server/blob/9dedaa9a55e15e0f3ff8eab4f07e04243da3e3b5/src/modules/contact/contact.service.ts),
  [контроллер контактов](https://github.com/pksep/sep_erp_server/blob/9dedaa9a55e15e0f3ff8eab4f07e04243da3e3b5/src/modules/contact/contacts.controller.ts),
  [контракт реквизитов](https://github.com/pksep/sep_erp_server/blob/9dedaa9a55e15e0f3ff8eab4f07e04243da3e3b5/packages/zod-shared/src/contact/interfaces/interface.ts).
- [Права ролей](https://github.com/pksep/sep_erp_server/blob/9dedaa9a55e15e0f3ff8eab4f07e04243da3e3b5/src/modules/roles/roles.service.ts),
  [общие типы прав](https://github.com/pksep/sep_erp_server/blob/9dedaa9a55e15e0f3ff8eab4f07e04243da3e3b5/packages/zod-shared/src/role/types/role.ts).

## 5. Объём изменений по итогам аудита

Два новых репозитория достаточны. Дополнительно понадобятся связанные изменения
существующих chat_client, chat_server, sep_yui, sep_erp_server и sep_erp_client.
chat_sync и общие серверные контракты меняются в зависимости от выбранного
пути передачи полномочий/событий. Сервис comments и bot-api не являются
обязательными участниками нового транспортного пути.

Изменения кода и дизайн-системы на этапе аудита не выполнялись. Проверки
производительности, сборки и сквозные тесты относятся к этапам реализации;
эта документация не подменяет их успешным чтением файлов.
