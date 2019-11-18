import _Protocol from 'devtools-protocol';
import _Mappings from 'devtools-protocol/types/protocol-mapping';
import {EventEmitter} from 'events';

declare global {
  module Crdp {
    export import Protocol = _Protocol;
    export import Commands = _Mappings.Commands;
    export import Events = _Mappings.Events;
  }

  // TODO: Remove when this lands https://github.com/DefinitelyTyped/DefinitelyTyped/pull/40432
  export interface CDPSession extends EventEmitter {
    /**
     * Detaches session from target. Once detached, session won't emit any events and can't be used
     * to send messages.
     */
    detach(): Promise<void>;
  
    on<T extends keyof Crdp.Events>(event: T, listener: (...args: Crdp.Events[T]) => void): this;
  
    /**
     * @param method Protocol method name
     * @param parameters Protocol parameters
     */
    send<T extends keyof Crdp.Commands>(method: T, parameters?: Crdp.Commands[T]['paramsType'][0]): Promise<Crdp.Commands[T]['returnType']>;
  }
}
