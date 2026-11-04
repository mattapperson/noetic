/**
 * A {@link FrameLink} over a `ws` WebSocket, one JSON frame per text message.
 */

import type { WebSocket } from 'ws';
import type { FrameLink } from './protocol';

export function webSocketFrameLink(socket: WebSocket): FrameLink {
  const closeListeners: Array<(reason?: Error) => void> = [];
  let failure: Error | undefined;
  socket.on('error', (error: Error) => {
    failure = error;
  });
  socket.on('close', () => {
    for (const listener of closeListeners) {
      listener(failure);
    }
  });
  return {
    send(frame) {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(frame));
      }
    },
    onFrame(listener) {
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          return;
        }
        try {
          listener(JSON.parse(data.toString()));
        } catch {
          // Not a frame.
        }
      });
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
    async close() {
      if (socket.readyState === socket.CLOSED) {
        return;
      }
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.close();
      });
    },
  };
}
