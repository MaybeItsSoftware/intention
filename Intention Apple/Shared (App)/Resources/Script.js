function show(platform, enabled, useSettingsInsteadOfPreferences) {
    document.body.classList.add(`platform-${platform}`);

    if (useSettingsInsteadOfPreferences) {
        document.getElementsByClassName('platform-mac state-on')[0].innerText = "Intention Safari’s extension is currently on. You can turn it off in the Extensions section of Safari Settings.";
        document.getElementsByClassName('platform-mac state-off')[0].innerText = "Intention Safari’s extension is currently off. You can turn it on in the Extensions section of Safari Settings.";
        document.getElementsByClassName('platform-mac state-unknown')[0].innerText = "You can turn on Intention Safari’s extension in the Extensions section of Safari Settings.";
        document.getElementsByClassName('platform-mac open-preferences')[0].innerText = "Quit and Open Safari Settings…";
    }

    if (typeof enabled === "boolean") {
        document.body.classList.toggle(`state-on`, enabled);
        document.body.classList.toggle(`state-off`, !enabled);
    } else {
        document.body.classList.remove(`state-on`);
        document.body.classList.remove(`state-off`);
    }
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

document.querySelector("button.open-preferences").addEventListener("click", openPreferences);

// ---------------------------------------------------------------------------
// Coaching credit (StoreKit)
// ---------------------------------------------------------------------------
//
// The Mac app's window is where a Mac App Store user buys the coaching-credit
// top-up that powers the coach — the Safari extension itself can't run
// StoreKit. Every call here lands in ViewController.handleBillingMessage ->
// IntentionStore, which verifies-and-credits the purchase against the backend
// directly (this window doesn't need to, and has no local balance to show —
// the full paywall with a live balance lives in the extension's own
// preferences page, via shared/billing.js). Deliberately: no link out, no
// mention of a key or a provider.

const billingCallbacks = {
    _nextId: 1,
    _registry: {},
    register(callback) {
        if (!callback) return "";
        const id = `cb_${this._nextId++}`;
        this._registry[id] = callback;
        return id;
    },
    invoke(id, payloadJson) {
        const callback = this._registry[id];
        if (!callback) return;
        delete this._registry[id];
        try {
            callback(payloadJson ? JSON.parse(payloadJson).value : null);
        } catch (e) {
            callback(null);
        }
    }
};
window.IntentionCallbacks = billingCallbacks;

function billingCall(action, extra) {
    return new Promise((resolve) => {
        if (!window.webkit || !webkit.messageHandlers || !webkit.messageHandlers.intentionNative) {
            resolve({ available: false });
            return;
        }
        const callbackId = billingCallbacks.register(resolve);
        webkit.messageHandlers.intentionNative.postMessage(
            Object.assign({ type: "billing", action, callbackId }, extra || {})
        );
    });
}

function setBillingError(message) {
    const el = document.getElementById("billing-error");
    el.textContent = message || "";
    el.hidden = !message;
}

async function refreshBilling() {
    const statusEl = document.getElementById("billing-status");
    const plansEl = document.getElementById("billing-plans");
    const restoreBtn = document.getElementById("billing-restore");
    setBillingError("");
    plansEl.innerHTML = "";

    const result = await billingCall("products");
    if (result && result.available === false) {
        statusEl.textContent = result.error || "In-app purchases aren't available on this Mac.";
        restoreBtn.hidden = true;
        return;
    }

    statusEl.textContent = "Buy coaching credit to turn on your coach in Safari.";
    restoreBtn.hidden = false;

    const list = (result && result.products) || [];
    if (!list.length) {
        setBillingError("Top-ups are unavailable right now. Please try again in a moment.");
        return;
    }
    for (const product of list) {
        const button = document.createElement("button");
        button.textContent = product.price ? `${product.title} — ${product.price}` : product.title;
        button.addEventListener("click", () => purchase(product.id, button));
        plansEl.appendChild(button);
    }
}

async function purchase(productId, button) {
    setBillingError("");
    button.disabled = true;
    const result = await billingCall("purchase", { productId });
    button.disabled = false;
    if (!result || result.status === "cancelled") return;
    if (result.status === "pending") {
        setBillingError("Your purchase is pending approval. It will unlock automatically once approved.");
        return;
    }
    if (result.status !== "purchased") {
        setBillingError(result.error || "The purchase didn't complete.");
        return;
    }
    await refreshBilling();
}

document.getElementById("billing-restore").addEventListener("click", async () => {
    setBillingError("");
    const result = await billingCall("restore");
    if (!result || result.status !== "purchased") {
        setBillingError(result?.error || "No pending purchase found.");
        return;
    }
    await refreshBilling();
});

refreshBilling();
