/// <reference lib="webworker" />

import { BulkExperimentModel } from '../_lib/bulkExperimentModel';
import type {
  BulkExperimentWorkerMessage,
  BulkExperimentWorkerRequest,
  BulkExperimentWorkerResponse,
} from '../_lib/bulkExperimentProtocol';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

let model: BulkExperimentModel | null = null;
let unsubscribe: (() => void) | null = null;

function postMessage(message: BulkExperimentWorkerMessage): void {
  workerScope.postMessage(message);
}

function postAck(id: number): void {
  postMessage({ id, type: 'ack' });
}

function postError(id: number, error: unknown): void {
  const message =
    error instanceof Error
      ? error.message
      : `Worker request failed: ${String(error)}`;
  const response: BulkExperimentWorkerResponse = {
    error: message,
    id,
    type: 'error',
  };
  postMessage(response);
}

function replaceModel(nextModel: BulkExperimentModel): void {
  unsubscribe?.();
  model?.destroy();
  model = nextModel;
  unsubscribe = nextModel.subscribe((snapshot) => {
    postMessage({ snapshot, type: 'snapshot' });
  });
}

function requireModel(): BulkExperimentModel {
  if (model == null) {
    throw new Error('Bulk experiment worker has not been initialized yet.');
  }

  return model;
}

workerScope.onmessage = async (
  event: MessageEvent<BulkExperimentWorkerRequest>
): Promise<void> => {
  const message = event.data;

  try {
    switch (message.type) {
      case 'initialize': {
        replaceModel(new BulkExperimentModel(message.options));
        postAck(message.id);
        return;
      }
      case 'startIngest': {
        await requireModel().startIngest();
        postAck(message.id);
        return;
      }
      case 'cancelIngest': {
        requireModel().cancelIngest();
        postAck(message.id);
        return;
      }
      case 'expandPath': {
        requireModel().expandPath(message.path);
        postAck(message.id);
        return;
      }
      case 'collapsePath': {
        requireModel().collapsePath(message.path);
        postAck(message.id);
        return;
      }
      case 'getVisibleIndex': {
        postMessage({
          id: message.id,
          index: requireModel().getVisibleIndex(message.path),
          type: 'visibleIndex',
        });
        return;
      }
      case 'getVisibleRows': {
        postMessage({
          id: message.id,
          rows: requireModel().getVisibleRows(message.start, message.end),
          type: 'visibleRows',
        });
        return;
      }
      case 'dispose': {
        unsubscribe?.();
        unsubscribe = null;
        model?.destroy();
        model = null;
        postAck(message.id);
        return;
      }
    }
  } catch (error) {
    postError(message.id, error);
  }
};
