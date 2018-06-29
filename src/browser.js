import assert from 'assert';

import fetch from 'isomorphic-fetch';

import { serializeFunction } from './common';
import { Client, ConnectionProxy } from './connections';
import { ConnectionError, RemoteError } from './errors';


class CallableProxy extends Function {
  constructor(handler) {
    super();
    return new Proxy(this, handler);
  }
}


class ApiProxy extends CallableProxy {
  constructor(evaluator, objectName) {
    super({
      apply: async (target, thisArg, argumentsList) => (
        evaluator(
          // eslint-disable-next-line no-template-curly-in-string
          'async (objectName, argumentsList) => eval(`${objectName}(...${JSON.stringify(argumentsList)})`)',
          objectName,
          argumentsList,
        )
      ),
      get: (target, name) => (
        new ApiProxy(evaluator, `${objectName}.${name}`)
      ),
    });
  }
}


export default class Browser extends CallableProxy {
  constructor(options) {
    super({
      apply: (target, thisArg, argumentsList) => (
        this.evaluateInBackground(...argumentsList)
      ),
      get: (target, name) => {
        // Integer indices, refering to tab IDs.
        if (name && name.match && name.match(/^\d+$/)) {
          const evaluator = (...args) => this.evaluateInContent(parseInt(name, 10), ...args);
          evaluator.readyState = async (readyState) => {
            assert(
              ['loading', 'interactive', 'complete'].includes(readyState),
              'Only "loading," "interactive," and "complete" are valid ready states.',
            );
            return evaluator(desiredState => (
              new Promise((resolve) => {
                let resolved = false;
                const states = ['loading', 'interactive', 'complete'];
                const handleReadyStateChange = () => {
                  if (!resolved) {
                    if (states.indexOf(desiredState) <= states.indexOf(document.readyState)) {
                      document.removeEventListener('readystatechange', handleReadyStateChange);
                      resolved = true;
                      resolve(document.readyState);
                    }
                  }
                };
                document.addEventListener('readystatechange', handleReadyStateChange);
                handleReadyStateChange();
              })
            ), readyState);
          };
          return evaluator;
        }
        // Properties that are part of the `Browser` API.
        if (Reflect.has(target, name)) {
          return Reflect.get(target, name);
        }
        // Remote Web Extensions API properties.
        if (typeof name === 'string') {
          return new ApiProxy(this.evaluateInBackground, `browser.${name}`);
        }
        // Fall back to accessing the property, even if it's not defined. The node repl checks
        // some weird symbols and other things that would fail in `ApiProxy`.
        return Reflect.get(target, name);
      },
    });
    Object.defineProperty(this, 'name', { value: 'Browser' });
    this.options = options;
  }

  evaluateInBackground = async (asyncFunction, ...args) => {
    const { error, result } = await this.client.send({
      args,
      asyncFunction: serializeFunction(asyncFunction),
    }, { channel: 'evaluateInBackground' });

    if (error) {
      throw new RemoteError(error.remoteError);
    }

    return result;
  };

  evaluateInContent = async (tabId, asyncFunction, ...args) => {
    const { error, result } = await this.client.send({
      args,
      asyncFunction: serializeFunction(asyncFunction),
      tabId,
    }, { channel: 'evaluateInContent' });

    if (error) {
      throw new RemoteError(error.remoteError);
    }

    return result;
  };

  launch = async () => {
    assert(false, 'unsupported');
  };

  launchRemote = async () => {
    if (!process.env.REMOTE_BROWSER_API_URL) {
      throw new Error((
        'You must specify a remote server using the REMOTE_BROWSER_API_URL environment variable. ' +
        'This should be specified at build-time when building the web client.'
      ));
    }
    // We can use `http` or `https` in node, so we won't coerce anything if this is `null`.
    const secure = typeof window === 'undefined' ? null :
      window.location.protocol.startsWith('https');

    let initializationUrl = process.env.REMOTE_BROWSER_API_URL;
    if (secure && initializationUrl.startsWith('http:')) {
      initializationUrl = `https:${initializationUrl.slice(5)}`;
    } else if (secure === false && initializationUrl.startsWith('https:')) {
      initializationUrl = `http:${initializationUrl.slice(6)}`;
    }

    const response = await (await fetch(initializationUrl)).json();
    this.connectionUrl = response.url;
    if (response.error) {
      throw new ConnectionError(response.error);
    }
    if (!response.url || !response.sessionId) {
      throw new Error('Invalid initialization response from the tour backend');
    }

    if (secure && response.url.startsWith('ws:')) {
      this.connectionUrl = `wss:${response.url.slice(3)}`;
    } else if (secure === false && response.url.startsWith('wss:')) {
      this.connectionUrl = `ws:${response.url.slice(4)}`;
    }
    this.sessionId = response.sessionId;

    await this.negotiateConnection();
  };

  listen = async (port, sessionId = 'default') => {
    // Set up the proxy and connect to it.
    this.proxy = new ConnectionProxy();
    this.port = await this.proxy.listen(port);
    this.connectionUrl = `ws://0.0.0.0:${this.port}/`;
    this.sessionId = sessionId;

    await this.negotiateConnection();

    return this.connectionUrl;
  };

  negotiateConnection = async () => {
    // Note that this function is really for internal use only.
    // Prepare for the initial connection from the browser.
    this.client = new Client();
    let proxyConnection;
    this.connection = new Promise((resolve) => {
      const channel = 'initialConnection';
      const handleInitialConnection = () => {
        this.client.unsubscribe(handleInitialConnection, { channel });
        resolve();
      };
      this.client.subscribe(handleInitialConnection, { channel });
      proxyConnection = this.client.connect(this.connectionUrl, 'user', this.sessionId);
    });
    await proxyConnection;
  };

  quit = async () => {
    // Close all of the windows.
    if (Reflect.has(this, 'client')) {
      // We'll never get a response here, so it needs to be sent off asynchronously.
      this.evaluateInBackground(async () => (
        Promise.all((await browser.windows.getAll())
          .map(({ id }) => browser.windows.remove(id)))
      ));
    }

    if (Reflect.has(this, 'driver')) {
      await this.driver.quit();
    }

    if (Reflect.has(this, 'proxy')) {
      await this.proxy.close();
    }

    if (Reflect.has(this, 'client')) {
      await this.client.close();
    }
  };
}
