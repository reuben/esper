/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2018 Reuben Morais
 */

const connectButton = document.getElementById('connect');
const disconnectButton = document.getElementById('disconnect');
const hostInput = document.getElementById('host');
const portInput = document.getElementById('port');
const statusContainerDiv = document.getElementById('status-container');

// Request the current connection status and handle updates from the background.
browser.runtime.onMessage.addListener((request) => {
  console.log('popup: ' + JSON.stringify(request));
  if (request.channel === 'connectionStatus') {
    ['disconnected', 'connected', 'error'].forEach((status) => {
      statusContainerDiv.classList.remove(status);
    });
    statusContainerDiv.classList.add(request.connectionStatus);
  }
});
browser.runtime.sendMessage({
  channel: 'connectionStatusRequest',
});


connectButton.addEventListener('click', () => {
  const port = parseInt(portInput.value, 10);
  const url = `${hostInput.value}:${port}`;
  browser.runtime.sendMessage({
    channel: 'connectionRequest',
    url,
  });
});


disconnectButton.addEventListener('click', () => {
  browser.runtime.sendMessage({
    channel: 'disconnectionRequest',
  });
});
