export function installShippingCryptoWorker(scope: {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  postMessage(value: unknown, transfer?: Transferable[]): void;
}): () => void;
