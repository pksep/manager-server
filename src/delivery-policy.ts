import { ChatRequestFailed } from './chat-adapter';

interface DeliveryFailure {
  state: 'pending' | 'failed';
  delaySeconds: number;
  code: 'CHAT_DELIVERY_FAILED' | 'CHAT_MESSAGE_REJECTED';
}

/** Сбой связи не исчерпывает доставку; явно отклонённые данные остаются в журнале ошибок. */
export function deliveryFailure(cause: unknown, attempts: number): DeliveryFailure {
  const rejected =
    cause instanceof ChatRequestFailed &&
    (cause.remoteStatus === 400 || cause.remoteStatus === 422);

  return {
    state: rejected ? 'failed' : 'pending',
    delaySeconds: Math.min(60, 2 ** Math.min(attempts, 6)),
    code: rejected ? 'CHAT_MESSAGE_REJECTED' : 'CHAT_DELIVERY_FAILED',
  };
}
