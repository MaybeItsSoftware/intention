(function() {
  if (window.chrome && window.chrome.runtime && window.chrome.runtime.sendMessage) {
    return; // Already injected
  }

  // Injected into the visible options.html WKWebView (see ViewController.swift's
  // setUpIOSBridge()). Only needs to shim chrome.runtime.sendMessage/getURL —
  // options.js never touches chrome.storage directly, it always goes through
  // sendBg() -> chrome.runtime.sendMessage() to background.js, which in this
  // app-hosted context runs in the hidden WKWebView owned by BackgroundJSHost.
  window.IntentionCallbacks = {
    _nextId: 1,
    _registry: {},
    register: function(callback) {
      if (!callback) return "";
      const id = "cb_" + (this._nextId++);
      this._registry[id] = callback;
      return id;
    },
    invoke: function(id, payloadJson) {
      if (this._registry[id]) {
        try {
          const parsed = payloadJson ? JSON.parse(payloadJson).value : null;
          this._registry[id](parsed);
        } catch (e) {
          console.error("[IntentionBridge] Error invoking callback " + id, e);
          this._registry[id](null);
        }
        delete this._registry[id];
      }
    }
  };

  window.chrome = {
    runtime: {
      sendMessage: function(message, callback) {
        const cbId = window.IntentionCallbacks.register(callback);
        window.webkit.messageHandlers.intentionNative.postMessage({
          type: 'sendMessage',
          message: message,
          callbackId: cbId
        });
      },
      getURL: function(path) {
        return path;
      },
      lastError: null
    }
  };

  // Native Screen Time app blocking (FamilyControls). The selection itself is
  // opaque and stays native; the web layer only sees counts and status.
  function screenTimeCall(action, extra, callback) {
    const cbId = window.IntentionCallbacks.register(callback);
    window.webkit.messageHandlers.intentionNative.postMessage(Object.assign({
      type: 'screenTime',
      action: action,
      callbackId: cbId
    }, extra || {}));
  }

  window.intentionScreenTime = {
    status: function(callback) { screenTimeCall('status', null, callback); },
    authorize: function(callback) { screenTimeCall('authorize', null, callback); },
    pickApps: function(callback) { screenTimeCall('pickApps', null, callback); },
    grantPass: function(minutes, callback) { screenTimeCall('grantPass', { minutes: minutes }, callback); },
    clear: function(callback) { screenTimeCall('clear', null, callback); },
    // Aggregate-only (no per-app breakdown -- Family Controls keeps app
    // identity opaque outside Apple's own UI). Resolves { minutesByDate }.
    getAppUsageReport: function(callback) { screenTimeCall('getAppUsageReport', null, callback); }
  };
})();
