ALTER TABLE channel_connections DROP CONSTRAINT channel_connections_platform_check;
ALTER TABLE channel_connections ADD CONSTRAINT channel_connections_platform_check
  CHECK(platform IN ('vk','avito','telegram','max'));

ALTER TABLE reply_routes DROP CONSTRAINT reply_routes_channel_check;
ALTER TABLE reply_routes ADD CONSTRAINT reply_routes_channel_check
  CHECK(channel IN ('widget','vk','avito','telegram','max'));
