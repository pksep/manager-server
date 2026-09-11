/** Восстанавливает UTF-8 из multipart-заголовка и сохраняет обычные Latin-1 имена. */
export function multipartFilename(value: string) {
  if ([...value].some((char) => char.charCodeAt(0) > 255)) return value;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'latin1'));
  } catch {
    return value;
  }
}
