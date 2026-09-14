(function() {
  if (window.chrome && window.chrome.runtime && window.chrome.runtime.sendMessage) {
    return; // Already injected
  }

  // Set up callback registry for asynchronous Android-to-JS evaluation
  window.AndroidCallbacks = {
    _nextId: 1,
    _registry: {},
    register: function(callback) {
      if (!callback) return "";
      const id = "cb_" + (this._nextId++);
      this._registry[id] = callback;
      return id;
    },
    invoke: function(id, resultJson) {
      if (this._registry[id]) {
        try {
          const parsed = resultJson ? JSON.parse(resultJson) : null;
          this._registry[id](parsed);
        } catch (e) {
          console.error("[IntentionBridge] Error invoking callback " + id, e);
          this._registry[id](resultJson);
        }
        delete this._registry[id];
      }
    }
  };

  // Create mock chrome object
  window.chrome = {
    storage: {
      local: {
        get: function(keys, callback) {
          const cbId = window.AndroidCallbacks.register(callback);
          const keysStr = typeof keys === 'string' ? JSON.stringify([keys]) : JSON.stringify(keys);
          AndroidInterface.getStorage(keysStr, cbId);
        },
        set: function(items, callback) {
          const cbId = window.AndroidCallbacks.register(callback);
          AndroidInterface.setStorage(JSON.stringify(items), cbId);
        }
      }
    },
    runtime: {
      sendMessage: function(message, callback) {
        const cbId = window.AndroidCallbacks.register(callback);
        AndroidInterface.sendMessage(JSON.stringify(message), cbId);
      },
      getURL: function(path) {
        return "file:///android_asset/" + path;
      },
      lastError: null
    },
    alarms: {
      create: function(name, info) {
        AndroidInterface.createAlarm(name, JSON.stringify(info));
      },
      clear: function(name, callback) {
        AndroidInterface.clearAlarm(name);
        if (callback) callback(true);
      }
    }
  };

  // In-app purchases (Google Play Billing, BillingManager.kt). The presence of
  // this object is what puts billing.js into 'store' mode: the subscription is
  // the only thing on offer, and it can only be bought through Play.
  window.intentionBilling = {
    products: function(callback) {
      AndroidInterface.billingProducts(window.AndroidCallbacks.register(callback));
    },
    purchase: function(productId, callback) {
      AndroidInterface.billingPurchase(productId, window.AndroidCallbacks.register(callback));
    },
    restore: function(callback) {
      AndroidInterface.billingRestore(window.AndroidCallbacks.register(callback));
    },
    redeem: function(callback) {
      AndroidInterface.billingRedeem(window.AndroidCallbacks.register(callback));
    },
    accountToken: function(callback) {
      AndroidInterface.billingAccountToken(window.AndroidCallbacks.register(callback));
    },
    status: function(callback) {
      AndroidInterface.billingStatus(window.AndroidCallbacks.register(callback));
    },
    manage: function(callback) {
      AndroidInterface.billingManage(window.AndroidCallbacks.register(callback));
    }
  };

  // App-blocking helpers, only available on Android. Shared JS feature-detects
  // window.intentionApps to show the Apps UI and launch apps after a grant.
  window.intentionApps = {
    getInstalledApps: function(callback) {
      const cbId = window.AndroidCallbacks.register(callback);
      AndroidInterface.getInstalledApps(cbId);
    },
    launchApp: function(packageName) {
      AndroidInterface.launchApp(packageName);
    },
    hasUsageAccess: function() {
      return AndroidInterface.hasUsageAccess();
    },
    requestUsageAccess: function() {
      AndroidInterface.openUsageAccessSettings();
    },
    getAppUsageStats: function(days, callback) {
      const cbId = window.AndroidCallbacks.register(callback);
      AndroidInterface.getAppUsageStats(days, cbId);
    },
    // One blocked app's last `days` days of foreground time, for the gate's
    // strip. Resolves { granted: false } without Usage Access, otherwise
    // { granted: true, days: [{ date, minutes }] } oldest first ending today.
    getAppUsageHistory: function(packageName, days, callback) {
      const cbId = window.AndroidCallbacks.register(callback);
      AndroidInterface.getAppUsageHistory(packageName, days, cbId);
    },
    // Leaving Intention, from the page side.
    //
    // Deliberately NOT a straight call to AndroidInterface.requestUninstall().
    // Removal is two things — recording that the leaving conversation ended,
    // and actually taking the app off the device — and the first of them is
    // background.js's job on every platform (completeRemoval -> beginLeave,
    // which writes the fifteen-minute stand-down). Sending the same message
    // the browser build sends keeps one definition of that, and
    // WebAppInterface.sendMessage turns it into the system uninstaller on the
    // way past. So both doors — this one and shared/options.js's own
    // `completeRemoval` — end up in exactly the same place.
    //
    // Handoff: shared/options.js currently reaches the uninstaller through
    // that message rather than through this function, which is why this file
    // is the only thing that has to know Android is different. If a later
    // package does feature-detect `window.intentionApps.requestUninstall`,
    // this is the shape to call: it is the whole sequence, not just the last
    // step of it.
    requestUninstall: function(callback) {
      window.chrome.runtime.sendMessage({ action: 'completeRemoval' }, callback);
    }
  };
})();
