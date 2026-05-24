import { EventEmitter } from 'node:events';

export class ResearchEventBus {
  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
  }

  emit(researchId, event) {
    this.emitter.emit(researchId, event);
  }

  subscribe(researchId, listener) {
    this.emitter.on(researchId, listener);
    return () => this.emitter.off(researchId, listener);
  }
}
