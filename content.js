/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2018 Reuben Morais
 */

let backgroundPort;

const handleMessage = ({ id, message }) => {
  if (message.channel === 'evaluateInContent') {
    const { asyncFunction, args } = message;
    Promise.resolve()
      // eslint-disable-next-line no-eval
      .then(() => eval(`(${asyncFunction}).apply(null, ${JSON.stringify(args)})`))
      .then(result => backgroundPort.postMessage({ id, message: result }))
      .catch((error) => {
        backgroundPort.postMessage({
          id,
          error,
        });
      });
  }
};

const createNewConnection = () => {
  backgroundPort = browser.runtime.connect({ name: 'contentScriptConnection' });
  backgroundPort.onDisconnect.addListener(createNewConnection);
  backgroundPort.onMessage.addListener(handleMessage);
};

createNewConnection();

const TWEET_SELECTOR = '#stream-items-id .tweet';

var currentTweetIdx = -1;

function nextTweet() {
  let allTweets = document.querySelectorAll(TWEET_SELECTOR);
  if (allTweets.length == 0 || currentTweetIdx == allTweets.length-1) {
    return;
  }
  if (currentTweetIdx != -1) {
    let currentTweet = allTweets[currentTweetIdx];
    currentTweet.parentElement.style = '';
  }
  currentTweetIdx = currentTweetIdx + 1;
  let nextTweet = allTweets[currentTweetIdx];
  nextTweet.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
    inline: 'center'
  });
  nextTweet.parentElement.style = 'z-index: 1; box-shadow: 0 0 0 3px rgba(0, 153, 153, 0.4) !important';
}

function previousTweet() {
  if (currentTweetIdx == 0) {
    return;
  }
  let allTweets = document.querySelectorAll(TWEET_SELECTOR);
  let currentTweet = allTweets[currentTweetIdx];
  currentTweet.parentElement.style = '';
  currentTweetIdx = currentTweetIdx - 1;
  let nextTweet = allTweets[currentTweetIdx];
  nextTweet.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
    inline: 'center'
  });
  nextTweet.parentElement.style = 'z-index: 1; box-shadow: 0 0 0 3px rgba(0, 153, 153, 0.4) !important';
}

function openTweet() {
  document.querySelectorAll(TWEET_SELECTOR)[currentTweetIdx].click();
}

function closeTweet() {
  document.querySelector('#permalink-overlay').click();
  document.querySelector('#global-tweet-dialog').click();
  document.querySelector('#retweet-tweet-dialog').click();
}

function replyTweet() {
  document.querySelectorAll(TWEET_SELECTOR)[currentTweetIdx].querySelector('.js-actionReply').click();
}

function retweetTweet() {
  document.querySelectorAll(TWEET_SELECTOR)[currentTweetIdx].querySelector('.js-actionRetweet').click();
}

function favoriteTweet() {
  document.querySelectorAll(TWEET_SELECTOR)[currentTweetIdx].querySelector('.js-actionFavorite').click();
}

function confirm() {
  document.querySelector('.modal-container.tweet-showing .tweet-button > button:not([disabled])').click();
}

let loaderURL = "";

function setLoaderURL(url) {
  loaderURL = url;
  document.getElementById('_________esper_overlay_element').src = loaderURL;
}

function showOverlay() {
  document.getElementById('_________esper_overlay_element').src = loaderURL;
  document.getElementById('_________esper_overlay_element').style.display = 'block';
}

function hideOverlay() {
  document.getElementById('_________esper_overlay_element').src = loaderURL;
  document.getElementById('_________esper_overlay_element').style.display = 'none';
}

window.addEventListener('load', function() {
  if (location.host == 'twitter.com' && !location.pathname.includes("status")) {
    nextTweet();
  }
});

window.addEventListener('DOMContentLoaded', function() {
  var overlay = document.createElement('img');
  overlay.id = '_________esper_overlay_element';
  overlay.style=`
    position: absolute;
    top: 0;
    right: 0;
    width: 128px;
    height: 128px;
    z-index: 9999999999;
    display: none;`;
  document.body.appendChild(overlay);
});
