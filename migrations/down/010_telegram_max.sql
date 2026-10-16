-- Откат не должен удалять подключения и переписку клиентов.
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM channel_connections WHERE platform IN ('telegram','max'))
    OR EXISTS(SELECT 1 FROM reply_routes WHERE channel IN ('telegram','max')) THEN
    RAISE EXCEPTION 'Нельзя откатить схему: существуют подключения Telegram или MAX';
  END IF;
END $$;

ALTER TABLE reply_routes DROP CONSTRAINT reply_routes_channel_check;
ALTER TABLE reply_routes ADD CONSTRAINT reply_routes_channel_check
  CHECK(channel IN ('widget','vk','avito'));

ALTER TABLE channel_connections DROP CONSTRAINT channel_connections_platform_check;
ALTER TABLE channel_connections ADD CONSTRAINT channel_connections_platform_check
  CHECK(platform IN ('vk','avito'));
