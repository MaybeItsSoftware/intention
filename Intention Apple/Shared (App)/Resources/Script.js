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
// Intention Pro (StoreKit)
// ---------------------------------------------------------------------------
//
// The Mac app's window is where a Mac App Store user buys the subscription
// that powers the coach — the Safari extension itself can't run StoreKit. Every
// call here lands in ViewController.handleBillingMessage -> IntentionStore.
// Deliberately: no link out, no mention of a key or a provider.

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
    const manageBtn = document.getElementById("billing-manage");
    setBillingError("");
    plansEl.innerHTML = "";

    const status = await billingCall("status");
    if (status && status.available === false) {
        statusEl.textContent = status.error || "In-app purchases aren't available on this Mac.";
        restoreBtn.hidden = true;
        manageBtn.hidden = true;
        return;
    }

    if (status && status.entitled) {
        const renews = status.expiresAt
            ? ` Renews ${new Date(status.expiresAt).toLocaleDateString()}.`
            : "";
        statusEl.textContent = `Intention Pro is active.${renews}`;
        restoreBtn.hidden = true;
        manageBtn.hidden = false;
        return;
    }

    statusEl.textContent = "Subscribe to turn on your coach in Safari.";
    restoreBtn.hidden = false;
    manageBtn.hidden = true;

    const result = await billingCall("products");
    const products = (result && result.products) || [];
    if (!products.length) {
        setBillingError("Plans are unavailable right now. Please try again in a moment.");
        return;
    }
    for (const product of products) {
        const button = document.createElement("button");
        const price = [product.price, product.period].filter(Boolean).join(" / ");
        button.textContent = price ? `${product.title} — ${price}` : product.title;
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
        setBillingError(result?.error || "No previous purchase found on this Apple Account.");
        return;
    }
    await refreshBilling();
});

document.getElementById("billing-manage").addEventListener("click", () => billingCall("manage"));

refreshBilling();
