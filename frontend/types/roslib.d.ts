declare module 'roslib' {
  export class Ros {
    constructor(options: { url?: string });
    on(event: 'connection' | 'error' | 'close' | string, callback: (data?: any) => void): void;
    off(event: string, callback?: (data?: any) => void): void;
    connect(url: string): void;
    close(): void;
    isConnected: boolean;
  }

  export class Topic {
    constructor(options: {
      ros: Ros;
      name: string;
      messageType: string;
      /** Batasi rate pengiriman di sisi rosbridge (ms). */
      throttle_rate?: number;
      queue_size?: number;
      queue_length?: number;
      compression?: 'none' | 'png' | 'cbor';
    });
    subscribe(callback: (message: any) => void): void;
    unsubscribe(callback?: (message: any) => void): void;
    advertise(): void;
    unadvertise(): void;
    publish(message: Message | Record<string, unknown>): void;
    name: string;
    messageType: string;
  }

  export class Message {
    constructor(data: any);
    [key: string]: any;
  }

  export class Service {
    constructor(options: { ros: Ros; name: string; serviceType: string });
    callService(
      request: ServiceRequest | Record<string, unknown>,
      callback: (response: any) => void,
      failedCallback?: (error: any) => void
    ): void;
  }

  export class ServiceRequest {
    constructor(data?: any);
    [key: string]: any;
  }

  const ROSLIB: {
    Ros: typeof Ros;
    Topic: typeof Topic;
    Message: typeof Message;
    Service: typeof Service;
    ServiceRequest: typeof ServiceRequest;
  };

  export default ROSLIB;
}
