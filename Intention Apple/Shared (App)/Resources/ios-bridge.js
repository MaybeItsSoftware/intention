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

  // In-app purchases (StoreKit 2, IntentionStore.swift). The presence of this
  // object is what puts billing.js into 'store' mode, where the subscription is
  // the only thing on offer and it can only be bought through Apple.
  function billingCall(action, extra, callback) {
    const cbId = window.IntentionCallbacks.register(callback);
    window.webkit.messageHandlers.intentionNative.postMessage(Object.assign({
      type: 'billing',
      action: action,
      callbackId: cbId
    }, extra || {}));
  }

  // Safari Web Extension enablement. iOS can neither flip that switch nor
  // link straight to the page it lives on, so this exposes: "has Safari
  // actually run the extension recently" (a heartbeat, see ViewController),
  // the exact Settings path for this iOS version, a way to jump to the
  // Settings app (openSettingsURLString — close, not exact), and a way out to
  // Safari to trigger the heartbeat once it's on — enough for the setup
  // wizard to guide the steps it can't perform itself.
  function extensionCall(action, extra, callback) {
    const cbId = window.IntentionCallbacks.register(callback);
    window.webkit.messageHandlers.intentionNative.postMessage(Object.assign({
      type: 'extension',
      action: action,
      callbackId: cbId
    }, extra || {}));
  }

  window.intentionExtension = {
    // Resolves { active, settingsPath, lastSeenAt }.
    status: function(callback) { extensionCall('status', null, callback); },
    openSettings: function(callback) { extensionCall('openSettings', null, callback); },
    openSafari: function(callback) { extensionCall('openSafari', null, callback); },
    // Lets the web layer own the enable-the-extension prompt during setup, so
    // the native banner doesn't say the same thing over the top of it.
    setSetupComplete: function(value, callback) { extensionCall('setSetupComplete', { value: !!value }, callback); }
  };

  window.intentionBilling = {
    products: function(callback) { billingCall('products', null, callback); },
    purchase: function(productId, callback) { billingCall('purchase', { productId: productId }, callback); },
    restore: function(callback) { billingCall('restore', null, callback); },
    status: function(callback) { billingCall('status', null, callback); },
    manage: function(callback) { billingCall('manage', null, callback); }
  };

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
