declare module 'roslib' {
  export class Ros {
    constructor(options: { url: string });
    on(event: string, callback: (data?: any) => void): void;
    close(): void;
    isConnected: boolean;
  }

  export class Topic {
    constructor(options: { ros: Ros; name: string; messageType: string });
    subscribe(callback: (message: any) => void): void;
    publish(message: Message): void;
    unsubscribe(): void;
  }

  export class Message {
    constructor(data: any);
    [key: string]: any;
  }

  export class Service {
    constructor(options: { ros: Ros; name: string; serviceType: string });
    callService(request: any, callback: (response: any) => void, failedCallback?: (error: any) => void): void;
  }

  export class ServiceRequest {
    constructor(data?: any);
    [key: string]: any;
  }
}
