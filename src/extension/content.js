import { RemoteError } from '../errors';


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
          error: JSON.stringify((new RemoteError(error)).toJSON()),
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
  document.querySelectorAll(TWEET_SELECTOR)[currentTweetIdx].parentElement.click();
}

function closeTweet() {
  document.querySelector('#permalink-overlay').click();
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
