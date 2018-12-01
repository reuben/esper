/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2018 Reuben Morais
 */

class Background {
  constructor() {
    // Maintain a registry of open ports with the content scripts.
    this.tabMessageId = 0;
    this.tabMessageResolves = {};
    this.tabMessageRevokes = {};
    this.tabPorts = {};
    this.tabPortPendingRequests = {};
    this.tabPortResolves = {};
    browser.runtime.onConnect.addListener((port) => {
      if (port.name === 'contentScriptConnection') {
        this.addTabPort(port);
        setTimeout(() => {
            RunInTab(port.sender.tab.id, `() => { setLoaderURL('` + browser.extension.getURL('icons/loader-128.gif') + `'); }`);
        }, 1000);
      }
    });
  }

  addTabPort(port) {
    // Store the port.
    const tabId = port.sender.tab.id;
    this.tabPorts[tabId] = port;

    // Handle incoming messages.
    port.onMessage.addListener((request) => {
      const resolve = this.tabMessageResolves[request.id];
      const revoke = this.tabMessageRevokes[request.id];
      if (revoke && request.error) {
        revoke(new RemoteError(JSON.parse(request.error)));
      } else if (resolve) {
        resolve(request.message);
      }
      delete this.tabMessageResolves[request.id];
      delete this.tabMessageRevokes[request.id];

      this.tabPortPendingRequests[tabId] = this.tabPortPendingRequests[tabId]
        .filter(({ id }) => id !== request.id);
      if (this.tabPortPendingRequests[tabId].length === 0) {
        delete this.tabPortPendingRequests[tabId];
      }
    });

    // Handle any promise resolutions that are waiting for this port.
    if (this.tabPortResolves[tabId]) {
      this.tabPortResolves[tabId].forEach(resolve => resolve(port));
      delete this.tabPortResolves[tabId];
    }

    // Handle disconnects, this will happen on every page navigation.
    port.onDisconnect.addListener(async () => {
      if (this.tabPorts[tabId] === port) {
        delete this.tabPorts[tabId];
      }

      // If there are pending requests, we'll need to resend them. The resolve/revoke callbacks will
      // still be in place, we just need to repost the requests.
      const pendingRequests = this.tabPortPendingRequests[tabId];
      if (pendingRequests && pendingRequests.length) {
        const newPort = await this.getTabPort(tabId);
        pendingRequests.forEach(request => newPort.postMessage(request));
      }
    });
  }

  async getTabPort(tabId) {
    const port = this.tabPorts[tabId];
    if (port) {
      return port;
    }
    return new Promise((resolve) => {
      this.tabPortResolves[tabId] = this.tabPortResolves[tabId] || [];
      this.tabPortResolves[tabId].push(resolve);
    });
  }

  async sendToTab(tabId, message) {
    const port = await this.getTabPort(tabId);
    this.tabMessageId += 1;
    const id = this.tabMessageId;
    return new Promise((resolve, revoke) => {
      const request = { id, message };
      // Store this in case the port disconnects before we get a response.
      this.tabPortPendingRequests[tabId] = this.tabPortPendingRequests[tabId] || [];
      this.tabPortPendingRequests[tabId].push(request);

      this.tabMessageResolves[id] = resolve;
      this.tabMessageRevokes[id] = revoke;
      port.postMessage(request);
    });
  }
}

const background = new Background();

function RunInTab(tabId, asyncFunction) {
    return background.sendToTab(tabId, { args: null, asyncFunction: asyncFunction, channel: 'evaluateInContent' });
}

let CommandHistory = [];
let BookmarkFolderNodeId = null;

const ZoomLevels = [
    0.3,
    0.5,
    0.67,
    0.8,
    0.9,
    1.,
    1.1,
    1.2,
    1.33,
    1.5,
    1.7,
    2.,
    2.4,
    3.
];

class Command {
    constructor(name) {
        this.name = name;
    }

    do() {
        CommandHistory.push(this);
    }

    undo() {
        let lastCommand = CommandHistory.pop();
        if (lastCommand !== this) {
            console.warn('Undo on command that was not on top of command stack');
        }
    }

    warn(msg) {
        console.warn('[' + this.name + '] ' + msg);
    }
}

function HistoryBackAction(tabId) {
    return RunInTab(tabId, `() => { window.history.back() }`);
}

function HistoryForwardAction(tabId) {
    return RunInTab(tabId, `() => { window.history.forward() }`);
}

//TODO: handle invalidated tabs in consumers
//      including command history
function GetActiveTab() {
    return browser.tabs.query({active: true, currentWindow: true})
    .then((tabs) => {
        return new Promise((resolve, reject) => {
            if (tabs.length === 0) {
                reject('No open tabs');
            } else {
                resolve(tabs[0]);
            }
        });
    });
}

class HistoryBackCommand extends Command {
    constructor() {
        super("history.back");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return HistoryBackAction(this.tabId);
        }, super.warn)
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return HistoryForwardAction(this.tabId).then(super.undo.bind(this), super.warn.bind(this));
    }
}

class HistoryForwardCommand extends Command {
    constructor() {
        super("history.forward");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return HistoryForwardAction(this.tabId);
        }, super.warn)
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return HistoryBackAction(this.tabId).then(super.undo.bind(this), super.warn.bind(this));
    }
}

class HistoryReopenCommand extends Command {
    constructor() {
        super("history.reopen");
    }

    do() {
        return browser.sessions.getRecentlyClosed({maxResults: 1})
        .then((sessionInfo) => {
            if (!sessionInfo.length) {
                super.warn("No sessions found.");
                return;
            }

            this.info = sessionInfo[0];
            if (this.info.tab) {
                return browser.sessions.restore(this.info.tab.sessionId);
            }
            return browser.sessions.restore(this.info.window.sessionId);
        }, super.warn)
        .then((session) => {
            if (session.tab) {
                this.tabId = session.tab.id;
            } else {
                this.windowId = session.window.id;
            }
        })
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        if (this.info.tab) {
            return browser.tabs.remove(this.tabId).then(super.undo.bind(this), super.warn.bind(this));
        } else {
            return browser.windows.remove(this.windowId).then(super.undo.bind(this), super.warn.bind(this));
        }
    }
}

class OpenTabCommand extends Command {
    constructor() {
        super("tab.open");
    }

    do() {
        return browser.tabs.create({})
        .then((tab) => {
            this.tabid = tab.id;
            super.do();
        });
    }

    undo() {
        return browser.tabs.remove(this.tabid).then(super.undo.bind(this), super.warn.bind(this));
    }
}

class CloseTabCommand extends Command {
    constructor() {
        super("tab.close");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.closedTab = tab;
            return browser.tabs.remove(this.closedTab.id);
        }, super.warn)
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return browser.tabs.create({
            active: true,
            cookieStoreId: this.closedTab.cookieStoreId,
            index: this.closedTab.index,
            openerTabId: this.closedTab.openerTabId,
            pinned: this.closedTab.pinned,
            url: this.closedTab.url,
            windowId: this.closedTab.windowId
        }).then(super.undo.bind(this), super.warn.bind(this));
    }
}

function GetOrCreateBookmarksFolder() {
    if (BookmarkFolderNodeId !== null) {
        return new Promise((resolve, reject) => {
            resolve(BookmarkFolderNodeId);
        });
    }

    return browser.bookmarks.search({
        title: "Esper Bookmarks"
    }).then((nodes) => {
        if (nodes.length === 0) {
            return browser.bookmarks.create({
                title: "Esper Bookmarks",
                type: "folder"
            }).then((node) => {
                BookmarkFolderNodeId = node.id;
                return BookmarkFolderNodeId;
            });
        } else {
            BookmarkFolderNodeId = nodes[0].id;
            if (nodes.length !== 1) {
                console.warn("More than one bookmark folder?");
            }
            return BookmarkFolderNodeId;
        }
    });
}

class BookmarkPageCommand extends Command {
    constructor() {
        super("bookmark");
    }

    do() {
        return Promise.all([GetOrCreateBookmarksFolder(), GetActiveTab()])
        .then(([nodeId, tab]) => {
            return browser.bookmarks.create({
                parentId: nodeId,
                title: tab.title,
                type: "bookmark",
                url: tab.url
            }).then((newNode) => {
                this.createdNodeId = newNode.id;
            }, super.warn.bind(this));
        }, super.warn.bind(this))
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return browser.bookmarks.remove(this.createdNodeId).then(super.undo.bind(this));
    }
}

class ClipboardCutCommand extends Command {
    constructor() {
        super("clipboard.cut");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return RunInTab(this.tabId,
                `()=>{document.execCommand("cut");}`
            );
        }, super.warn)
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return RunInTab(this.tabId,
            `()=>{document.execCommand("paste");}`
        );
    }
}

class ClipboardCopyCommand extends Command {
    constructor() {
        super("clipboard.copy");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return RunInTab(this.tabId,
                `()=>{document.execCommand("copy");}`
            );
        }, super.warn)
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return RunInTab(this.tabId,
            `()=>{document.execCommand("paste");}`
        );
    }
}

class ClipboardPasteCommand extends Command {
    constructor() {
        super("clipboard.paste");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return RunInTab(this.tabId,
                `()=>{document.execCommand("paste");}`
            );
        }, super.warn)
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return RunInTab(this.tabId,
            `()=>{document.execCommand("cut");}`
        );
    }
}

class SavePageAsPDFCommand extends Command {
    constructor() {
        super("page.saveAsPDF");
    }

    do() {
        return browser.tabs.saveAsPDF({
            footerLeft: '',
            footerRight: '',
            headerLeft: '',
            headerRight: ''
        }).then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return new Promise((resolve, reject) => {
            super.warn("Undo unsupported for save as PDF.");
            super.undo();
            reject("Undo unsupported for save as PDF.");
        });
    }
}

class DownloadPageCommand extends Command {
    constructor() {
        super("page.download");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            return browser.downloads.download({
                url: tab.url
            });
        }, super.warn.bind(this))
        .then((downloadId) => {
            this.downloadId = downloadId;
            super.do();
        }, super.warn.bind(this));
    }

    undo() {
        return browser.downloads.removeFile(this.downloadId)
        .then(() => {
            return browser.downloads.erase({
                id: this.downloadId
            });
        }, super.warn.bind(this))
        .then(super.do.bind(this), super.warn.bind(this));
    }
}

class FindTextCommand extends Command {
    constructor() {
        super("find");
    }

    do(text) {
        return browser.find.find(text)
        .then(() => {
            browser.find.highlightResults();
            super.do();
        }, super.warn);
    }

    undo() {
        return browser.find.removeHighlighting()
        .then(super.undo.bind(this), super.warn.bind(this));
    }
}

class FindRemoveHighlightCommand extends Command {
    constructor() {
        super("find.removeHighlight");
    }

    do() {
        return browser.find.removeHighlighting()
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return new Promise((resolve, reject) => {
            super.warn("Undo unsupported");
            super.undo();
            reject("Undo unsupported");
        });
    }
}

class ZoomInCommand extends Command {
    constructor() {
        super("zoom.in");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return browser.tabs.getZoom(this.tabId);
        }).then((zoom) => {
            let levelIndex = ZoomLevels.indexOf(zoom);
            if (levelIndex === -1) {
                levelIndex = ZoomLevels.indexOf(1.);
            }

            this.previousZoom = levelIndex;

            levelIndex += 1;
            levelIndex = Math.min(ZoomLevels.length-1, Math.max(0, levelIndex));
            return browser.tabs.setZoom(this.tabId, ZoomLevels[levelIndex]);
        }, super.warn).then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return browser.tabs.setZoom(this.tabId, this.previousZoom)
        .then(super.undo.bind(this), super.warn.bind(this));
    }
}

class ZoomOutCommand extends Command {
    constructor() {
        super("zoom.out");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return browser.tabs.getZoom(this.tabId);
        }).then((zoom) => {
            let levelIndex = ZoomLevels.indexOf(zoom);
            if (levelIndex === -1) {
                levelIndex = ZoomLevels.indexOf(1.);
            }

            this.previousZoom = levelIndex;

            levelIndex -= 1;
            levelIndex = Math.min(ZoomLevels.length-1, Math.max(0, levelIndex));
            return browser.tabs.setZoom(this.tabId, ZoomLevels[levelIndex]);
        }, super.warn).then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return browser.tabs.setZoom(this.tabId, this.previousZoom)
        .then(super.undo.bind(this), super.warn.bind(this));
    }
}

class YouTubePlayCommand extends Command {
    constructor() {
        super("youtube.play");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return RunInTab(this.tabId,
                `()=>{document.getElementById("movie_player").wrappedJSObject.playVideo();}`
            );
        })
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return RunInTab(this.tabId,
            `()=>{document.getElementById("movie_player").wrappedJSObject.pauseVideo();}`
        )
        .then(super.undo.bind(this), super.warn.bind(this));
    }
}

class YouTubePauseCommand extends Command {
    constructor() {
        super("youtube.pause");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return RunInTab(this.tabId,
                `()=>{document.getElementById("movie_player").wrappedJSObject.pauseVideo();}`
            );
        })
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return RunInTab(this.tabId,
            `()=>{document.getElementById("movie_player").wrappedJSObject.playVideo();}`
        )
        .then(super.undo.bind(this), super.warn.bind(this));
    }
}

class YouTubeVolumeUpCommand extends Command {
    constructor() {
        super("youtube.volumeup");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return RunInTab(this.tabId,
                `()=>{let player = document.getElementById("movie_player").wrappedJSObject;
                       player.setVolume(player.getVolume() + 20);}`
            );
        })
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return RunInTab(this.tabId,
            `()=>{let player = document.getElementById("movie_player").wrappedJSObject;
                   player.setVolume(player.getVolume() - 20);}`
        )
        .then(super.undo.bind(this), super.warn.bind(this));
    }
}

class YouTubeMuteCommand extends Command {
    constructor() {
        super("youtube.mute");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return RunInTab(this.tabId,
                `()=>{let player = document.getElementById("movie_player").wrappedJSObject;
                       player.setVolume(0);}`
            );
        })
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return RunInTab(this.tabId,
            `()=>{let player = document.getElementById("movie_player").wrappedJSObject;
                   player.setVolume(100);}`
        )
        .then(super.undo.bind(this), super.warn.bind(this));
    }
}

class YouTubeVolumeDownCommand extends Command {
    constructor() {
        super("youtube.volumedown");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return RunInTab(this.tabId,
                `()=>{let player = document.getElementById("movie_player").wrappedJSObject;
                       player.setVolume(player.getVolume() - 20);}`
            );
        })
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return RunInTab(this.tabId,
            `()=>{let player = document.getElementById("movie_player").wrappedJSObject;
                   player.setVolume(player.getVolume() + 20);}`
        )
        .then(super.undo.bind(this), super.warn.bind(this));
    }
}

class YouTubeNextCommand extends Command {
    constructor() {
        super("youtube.next");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return RunInTab(this.tabId,
                `()=>{let player = document.getElementById("movie_player").wrappedJSObject;
                       player.nextVideo();}`
            );
        })
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return RunInTab(this.tabId,
            `()=>{let player = document.getElementById("movie_player").wrappedJSObject;
                   player.previousVideo();}`
        )
        .then(super.undo.bind(this), super.warn.bind(this));
    }
}

class YouTubePreviousCommand extends Command {
    constructor() {
        super("youtube.previous");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return RunInTab(this.tabId,
                `()=>{let player = document.getElementById("movie_player").wrappedJSObject;
                       player.previousVideo();}`
            );
        })
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return RunInTab(this.tabId,
            `()=>{let player = document.getElementById("movie_player").wrappedJSObject;
                   player.nextVideo();}`
        )
        .then(super.undo.bind(this), super.warn.bind(this));
    }
}

class TwitterNextCommand extends Command {
    constructor() {
        super("twitter.next");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return RunInTab(this.tabId, `() => { nextTweet(); }`);
        })
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return RunInTab(this.tabId, `() => { previousTweet(); }`)
        .then(super.undo.bind(this), super.warn.bind(this));
    }
}

class TwitterPreviousCommand extends Command {
    constructor() {
        super("twitter.previous");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return RunInTab(this.tabId, `() => { previousTweet(); }`);
        })
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return RunInTab(this.tabId, `() => { nextTweet(); }`)
        .then(super.undo.bind(this), super.warn.bind(this));
    }
}

class TwitterOpenCommand extends Command {
    constructor() {
        super("twitter.open");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return RunInTab(this.tabId, `() => { openTweet(); }`);
        })
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return RunInTab(this.tabId, `() => { closeTweet(); }`)
        .then(super.undo.bind(this), super.warn.bind(this));
    }
}

class TwitterConfirmCommand extends Command {
    constructor() {
        super("twitter.confirm");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return RunInTab(this.tabId, `() => { confirm(); }`);
        })
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return new Promise((resolve, reject) => {
            super.warn("Undo unsupported for Twitter confirm.");
            super.undo();
            reject("Undo unsupported for Twitter confirm.");
        });
    }
}

class TwitterCloseCommand extends Command {
    constructor() {
        super("twitter.close");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return RunInTab(this.tabId, `() => { closeTweet(); }`);
        })
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return RunInTab(this.tabId, `() => { openTweet(); }`)
        .then(super.undo.bind(this), super.warn.bind(this));
    }
}

class TwitterFavoriteCommand extends Command {
    constructor() {
        super("twitter.favorite");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return RunInTab(this.tabId, `() => { favoriteTweet(); }`);
        })
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return RunInTab(this.tabId, `() => { favoriteTweet(); }`)
        .then(super.undo.bind(this), super.warn.bind(this));
    }
}

class TwitterReplyCommand extends Command {
    constructor() {
        super("twitter.reply");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return RunInTab(this.tabId, `() => { replyTweet(); }`);
        })
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return new Promise((resolve, reject) => {
            super.warn("Undo unsupported for Twitter reply.");
            super.undo();
            reject("Undo unsupported for Twitter reply.");
        });
    }
}

class TwitterRetweetCommand extends Command {
    constructor() {
        super("twitter.retweet");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return RunInTab(this.tabId, `() => { retweetTweet(); }`);
        })
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return RunInTab(this.tabId, `() => { retweetTweet(); }`)
        .then(super.undo.bind(this), super.warn.bind(this));
    }
}

class WindowScrollDownCommand extends Command {
    constructor() {
        super("scroll.down");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return RunInTab(this.tabId, `() => { window.scrollBy({top: 500, behavior: 'smooth'}); }`)
        })
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return RunInTab(this.tabId, `() => { window.scrollBy({top: -500, behavior: 'smooth'}); }`)
        .then(super.undo.bind(this), super.warn.bind(this));
    }
}

class WindowScrollUpCommand extends Command {
    constructor() {
        super("scroll.up");
    }

    do() {
        return GetActiveTab()
        .then((tab) => {
            this.tabId = tab.id;
            return RunInTab(this.tabId, `() => { window.scrollBy({top: -500, behavior: 'smooth'}); }`)
        })
        .then(super.do.bind(this), super.warn.bind(this));
    }

    undo() {
        return RunInTab(this.tabId, `() => { window.scrollBy({top: 500, behavior: 'smooth'}); }`)
        .then(super.undo.bind(this), super.warn.bind(this));
    }
}

const CommandRegistry = {
    "history.back": HistoryBackCommand,
    "history.forward": HistoryForwardCommand,
    "history.reopen": HistoryReopenCommand,
    "tab.open": OpenTabCommand,
    "tab.close": CloseTabCommand,
    "bookmark": BookmarkPageCommand,
    "clipboard.cut": ClipboardCutCommand,
    "clipboard.copy": ClipboardCopyCommand,
    "clipboard.paste": ClipboardPasteCommand,
    "page.saveAsPDF": SavePageAsPDFCommand,
    "page.download": DownloadPageCommand,
    "find": FindTextCommand,
    "find.removeHighlight": FindRemoveHighlightCommand,
    "zoom.in": ZoomInCommand,
    "zoom.out": ZoomOutCommand,
    "youtube.play": YouTubePlayCommand,
    "youtube.pause": YouTubePauseCommand,
    "youtube.volumeup": YouTubeVolumeUpCommand,
    "youtube.volumedown": YouTubeVolumeDownCommand,
    "youtube.mute": YouTubeMuteCommand,
    "youtube.next": YouTubeNextCommand,
    "youtube.previous": YouTubePreviousCommand,
    "twitter.next": TwitterNextCommand,
    "twitter.previous": TwitterPreviousCommand,
    "twitter.open": TwitterOpenCommand,
    "twitter.close": TwitterCloseCommand,
    "twitter.favorite": TwitterFavoriteCommand,
    "twitter.reply": TwitterReplyCommand,
    "twitter.retweet": TwitterRetweetCommand,
    "twitter.confirm": TwitterConfirmCommand,
    "scroll.down": WindowScrollDownCommand,
    "scroll.up": WindowScrollUpCommand
}

let IconNotificationTimeout;

const DEFAULT_ICONS = {
    path: {
        16: "icons/icon-16.png",
        32: "icons/icon-32.png",
        48: "icons/icon-48.png",
        64: "icons/icon-64.png",
        96: "icons/icon-96.png",
    }
}

const OK_ICONS = {
    path: {
        16: "icons/icon-ok-16.png",
        32: "icons/icon-ok-32.png",
        48: "icons/icon-ok-48.png",
        64: "icons/icon-ok-64.png",
        96: "icons/icon-ok-96.png",
    }
}

const FAIL_ICONS = {
    path: {
        16: "icons/icon-fail-16.png",
        32: "icons/icon-fail-32.png",
        48: "icons/icon-fail-48.png",
        64: "icons/icon-fail-64.png",
        96: "icons/icon-fail-96.png",
    }
}

const LOADER_ICONS = {
    path: {
        48: "icons/loader-48.png",
        96: "icons/loader-96.png",
    }
}

function ResetIcon() {
    return browser.browserAction.setIcon(DEFAULT_ICONS);
}

function PlayAudio(path) {
    let audio = new Audio();
    audio.src = path;
    audio.play();
}

function ConfirmationNotification() {
    clearTimeout(IconNotificationTimeout);
    PlayAudio("audio/ok.mp3");
    browser.browserAction.setIcon(OK_ICONS).then(() => {
        IconNotificationTimeout = setTimeout(ResetIcon, 1500);
    }, console.warn);
}

function ErrorNotification() {
    clearTimeout(IconNotificationTimeout);
    PlayAudio("audio/err.mp3");
    browser.browserAction.setIcon(FAIL_ICONS).then(() => {
        IconNotificationTimeout = setTimeout(ResetIcon, 1500);
    }, console.warn);
}

function RunCmd(name, ...args) {
    console.log("running " + name);
    let cmdClass = CommandRegistry[name];
    if (cmdClass) {
        let cmd = new cmdClass();
        cmd.do(...args).then(ConfirmationNotification).catch(ErrorNotification);
    } else {
        console.warn('Invalid command: ' + name);
    }
}

function UndoLast() {
    let last = CommandHistory[CommandHistory.length-1];
    last.undo().then(ConfirmationNotification).catch(ErrorNotification);
}

function RedoLast() {
    let last = CommandHistory[CommandHistory.length-1];
    last.do().then(ConfirmationNotification).catch(ErrorNotification);
}

function ProcessSpokenCommand(cmd) {
    console.log("command: " + cmd);
    if (cmd.includes("again")) {
        if (CommandHistory.length > 0) {
            RedoLast();
        } else {
            ErrorNotification();
        }
    } else if (cmd.includes("volume")) {
        if (cmd.includes("up")) {
            RunCmd("youtube.volumeup");
        } else if (cmd.includes("down")) {
            RunCmd("youtube.volumedown");
        }
    } else if (cmd.includes("louder")) {
        RunCmd("volume.up");
    } else if (cmd.includes("quieter")) {
        RunCmd("volume.down");
    } else if (cmd.includes("mute")) {
        RunCmd("youtube.mute");
    } else if (cmd.includes("down")) {
        RunCmd("scroll.down");
    } else if (cmd.includes("up")) {
        RunCmd("scroll.up");
    } else if (cmd.includes("back")) {
        RunCmd("history.back");
    } else if (cmd.includes("confirm")) {
        RunCmd("twitter.confirm");
    } else if (cmd.includes("forward")) {
        RunCmd("history.forward");
    } else if (cmd.includes("reopen")) {
        RunCmd("history.reopen");
    } else if (!!cmd.match(/open +tab/)) {
        RunCmd("tab.open");
    } else if (!!cmd.match(/close +tab/)) {
        RunCmd("tab.close");
    } else if (cmd.includes("close")) {
        GetActiveTab().then((tab) => {
            if (tab.url.includes("twitter.com")) {
                RunCmd("twitter.close");
            } else {
                RunCmd("tab.close");
            }
        });
    } else if (cmd.includes("tab")) {
        RunCmd("tab.open");
    } else if (cmd.includes("bookmark")) {
        RunCmd("bookmark");
    } else if (cmd.includes("cut")) {
        RunCmd("clipboard.cut");
    } else if (cmd.includes("copy")) {
        RunCmd("clipboard.copy");
    } else if (cmd.includes("paste")) {
        RunCmd("clipboard.paste");
    } else if (cmd.includes("save")) {
        RunCmd("page.download");
    } else if (cmd.includes("find")) {
        RunCmd("find");
    } else if (cmd.includes("zoom")) {
        if (cmd.includes("out")) {
            RunCmd("zoom.out");
        } else {
            RunCmd("zoom.in");
        }
    } else if (cmd.includes("play")) {
        RunCmd("youtube.play");
    } else if (cmd.includes("stop")) {
        RunCmd("youtube.pause");
    } else if (cmd.includes("next") || cmd.includes("previous")) {
        let next = cmd.includes("next");
        GetActiveTab().then((tab) => {
            if (tab.url.includes("youtube.com")) {
                RunCmd(next ? "youtube.next" : "youtube.previous");
            } else if (tab.url.includes("twitter.com")) {
                RunCmd(next ? "twitter.next" : "twitter.previous");
            }
        });
    } else if (cmd.includes("like")) {
        RunCmd("twitter.favorite");
    } else if (cmd.includes("reply")) {
        RunCmd("twitter.reply");
    } else if (cmd.includes("retweet")) {
        RunCmd("twitter.retweet");
    } else if (cmd.includes("go to") || cmd.includes("open")) {
        GetActiveTab().then((tab) => {
            console.log("go to, tab: " + tab.url);
            let func = browser.tabs.create;
            if (tab.url == "about:blank" || tab.url == "about:newtab") {
                func = browser.tabs.update;
            }

            if (cmd.includes("twitter")) {
                func({url: "https://twitter.com"}).then(ConfirmationNotification);
            } else if (cmd.includes("google")) {
                func({url: "https://www.google.com"}).then(ConfirmationNotification);
            }else if (cmd.includes("youtube")) {
                func({url: "https://www.youtube.com"}).then(ConfirmationNotification);
            } else if (cmd.includes("facebook")) {
                func({url: "https://www.facebook.com"}).then(ConfirmationNotification);
            } else if (cmd.includes("reddit")) {
                func({url: "https://www.reddit.com"}).then(ConfirmationNotification);
            } else if (cmd.includes("hacker")) {
                func({url: "https://news.ycombinator.com"}).then(ConfirmationNotification);
            } else if (cmd.includes("open") && tab.url.includes("twitter.com")) {
                RunCmd("twitter.open");
            } else {
                ErrorNotification();
            }
        });
    } else if (cmd.includes("undo")) {
        UndoLast();
    } else if (cmd.includes("again")) {
        RedoLast();
    } else {
        ErrorNotification();
    }
}

let speechServerConn;
let connectionStatus = 'disconnected';

function connect(url) {
    speechServerConn = new WebSocket(url);
    connectionStatus = 'connected';

    speechServerConn.onmessage = (e) => {
        let evt = JSON.parse(e.data);
        console.log('ws msg: ' + e.data);
        if (evt.type === 'result') {
            ProcessSpokenCommand(evt.result);
            browser.tabs.executeScript({
                code: `hideOverlay();`
            });
        } else if (evt.type === 'listening') {
            browser.browserAction.setIcon(LOADER_ICONS);
            browser.tabs.executeScript({
                code: `showOverlay();`
            });
        } else if (evt.type == 'no_voice') {
            ResetIcon();
        }
    }

    speechServerConn.onclose = (e) => {
        if (connectionStatus == 'connected') {
            connectionStatus = 'disconnected';
            speechServerConn = null;
            broadcastConnectionStatus();
            ResetIcon();
        }
    }

    speechServerConn.onerror = (e) => {
        if (connectionStatus == 'connected') {
            connectionStatus = 'error';
            speechServerConn = null;
            broadcastConnectionStatus();
            ResetIcon();
        }
    }

    setTimeout(() => {
        if (connectionStatus == 'connected') {
            broadcastConnectionStatus();
            console.log('broadcasting connected');
            ResetIcon();
        }
    }, 150);
}

function close() {
    if (connectionStatus == 'connected') {
        connectionStatus = 'disconnected';
        speechServerConn.close();
        speechServerConn = null;
        broadcastConnectionStatus();
    }
}

function broadcastConnectionStatus() {
    browser.runtime.sendMessage({
        channel: 'connectionStatus',
        connectionStatus,
    });
}

// Listen for connection status requests from the popup.
browser.runtime.onMessage.addListener((request) => {
    console.log(request);
    if (request.channel === 'connectionStatusRequest') {
      broadcastConnectionStatus();
    } else if (request.channel === 'connectionRequest') {
      connect(request.url);
    } else if (request.channel === 'disconnectionRequest') {
      close();
    }
});

// browser.browserAction.onClicked.addListener(OnBrowserActionClicked);    
