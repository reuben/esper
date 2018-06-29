import Browser from './browser';
import ConnectionProxy from './connections/proxy';

export default Browser;
export { Browser };
export { ConnectionProxy };
export * from './errors';

global.Browser = Browser;

