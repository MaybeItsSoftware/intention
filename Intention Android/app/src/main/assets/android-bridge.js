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
    }
  };
})();
