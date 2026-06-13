export type EventPayload = Record<string, unknown>;
export type EventHandler<TPayload extends EventPayload = EventPayload> = (
  payload: TPayload
) => void | Promise<void>;

export class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();

  on<TPayload extends EventPayload>(
    eventName: string,
    handler: EventHandler<TPayload>
  ): () => void {
    const handlers = this.handlers.get(eventName) ?? new Set<EventHandler>();
    handlers.add(handler as EventHandler);
    this.handlers.set(eventName, handlers);

    return () => {
      handlers.delete(handler as EventHandler);
    };
  }

  async emit<TPayload extends EventPayload>(
    eventName: string,
    payload: TPayload = {} as TPayload
  ): Promise<void> {
    const handlers = this.handlers.get(eventName);
    if (!handlers) {
      return;
    }

    await Promise.all([...handlers].map((handler) => handler(payload)));
  }
}
